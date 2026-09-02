import {
  type MeltPreview,
  type MintPreview,
  OutputData,
  type OutputDataLike,
  type Proof,
  Wallet,
} from "@cashu/cashu-ts";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { fetchPublicHttpUrl } from "../utils/public-http.ts";
import { withPaymentTimeout } from "./timeout.ts";

export interface PreparedTreasuryPayout {
  meltPreviewJson: string;
  forwardedAmountSats: number;
  feeReserveSats: number;
}

export interface CompletedTreasuryPayout {
  paid: boolean;
  changeProofsJson: string;
  paymentPreimage: string | null;
}

export interface TreasuryForwarder {
  prepareClaim(amountSats: number, providerQuoteId: string): Promise<string>;
  completeClaim(mintPreviewJson: string): Promise<string>;
  preparePayout(
    proofsJson: string,
    destination: string,
    grossAmountSats: number,
  ): Promise<PreparedTreasuryPayout>;
  completePayout(meltPreviewJson: string): Promise<CompletedTreasuryPayout>;
  isPayoutTerminallyFailed(meltPreviewJson: string): Promise<boolean>;
}

interface LightningAddressDetails {
  callback: URL;
  minSendableMsats: number;
  maxSendableMsats: number;
  commentAllowed: number;
}

/** Claims paid mint quotes and melts the resulting Cashu proofs to an operator Lightning Address. */
export class CashuTreasuryForwarder implements TreasuryForwarder {
  private walletPromise: Promise<Wallet> | null = null;

  constructor(
    private readonly mintUrl: string,
    private readonly walletFactory: (mintUrl: string) => Wallet = (url) =>
      new Wallet(url, { unit: "sat" }),
    private readonly operationTimeoutMs = 15_000,
  ) {}

  async prepareClaim(
    amountSats: number,
    providerQuoteId: string,
  ): Promise<string> {
    const wallet = await this.getWallet();
    const preview = await withPaymentTimeout(
      wallet.prepareMint("bolt11", amountSats, providerQuoteId),
      this.operationTimeoutMs,
      "Cashu treasury claim preparation",
    );
    return serializePreview(preview);
  }

  async completeClaim(mintPreviewJson: string): Promise<string> {
    const wallet = await this.getWallet();
    const proofs = await withPaymentTimeout(
      wallet.completeMint(deserializeMintPreview(mintPreviewJson)),
      this.operationTimeoutMs,
      "Cashu treasury claim completion",
    );
    return JSON.stringify(proofs);
  }

  async preparePayout(
    proofsJson: string,
    destination: string,
    grossAmountSats: number,
  ): Promise<PreparedTreasuryPayout> {
    const wallet = await this.getWallet();
    const proofs = JSON.parse(proofsJson) as Proof[];
    const available = proofs.reduce((sum, proof) => sum + proof.amount, 0);
    if (available < grossAmountSats) {
      throw new Error(
        "Mint returned fewer proofs than the settled purchase amount",
      );
    }

    const details = await resolveLightningAddress(destination);
    if (details.maxSendableMsats < grossAmountSats * 1000) {
      throw new Error(
        "Treasury destination cannot receive the full settled purchase amount",
      );
    }
    let amountSats = grossAmountSats;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (amountSats * 1000 < details.minSendableMsats) {
        throw new Error(
          "Purchase is too small to cover the destination minimum and Lightning routing fee",
        );
      }
      const invoice = await requestLightningInvoice(
        details,
        amountSats,
        destination,
      );
      const quote = await withPaymentTimeout(
        wallet.createMeltQuoteBolt11(invoice),
        this.operationTimeoutMs,
        "Cashu treasury melt quote",
      );
      if (quote.amount !== amountSats) {
        throw new Error(
          "Treasury invoice amount does not match its Cashu melt quote",
        );
      }
      const required = quote.amount + quote.fee_reserve;
      if (required <= available) {
        const preview = await withPaymentTimeout(
          wallet.prepareMelt("bolt11", quote, proofs),
          this.operationTimeoutMs,
          "Cashu treasury melt preparation",
        );
        return {
          meltPreviewJson: serializePreview(preview),
          forwardedAmountSats: quote.amount,
          feeReserveSats: quote.fee_reserve,
        };
      }
      amountSats -= Math.max(1, required - available);
    }
    throw new Error(
      "Unable to reserve enough of the settled amount for Lightning routing fees",
    );
  }

  async completePayout(
    meltPreviewJson: string,
  ): Promise<CompletedTreasuryPayout> {
    const wallet = await this.getWallet();
    const result = await withPaymentTimeout(
      wallet.completeMelt(deserializeMeltPreview(meltPreviewJson)),
      this.operationTimeoutMs,
      "Cashu treasury melt completion",
    );
    const state = String(result.quote.state).toUpperCase();
    return {
      paid: state === "PAID",
      changeProofsJson: JSON.stringify(result.change),
      paymentPreimage: result.quote.payment_preimage ?? null,
    };
  }

  /**
   * Reports whether a persisted melt attempt can never complete, so its preview
   * may be discarded and a fresh invoice prepared from the same proofs.
   * Only an UNPAID quote past its own expiry is terminal; PENDING and PAID must
   * keep replaying the persisted preview so a payout can never be duplicated.
   */
  async isPayoutTerminallyFailed(meltPreviewJson: string): Promise<boolean> {
    const parsed = parsePreview(meltPreviewJson);
    const quote = parsed.quote as { quote?: unknown } | undefined;
    const quoteId = typeof quote?.quote === "string" ? quote.quote : null;
    if (!quoteId) return false;
    const wallet = await this.getWallet();
    const status = await withPaymentTimeout(
      wallet.checkMeltQuoteBolt11(quoteId),
      this.operationTimeoutMs,
      "Cashu treasury melt status check",
    );
    const state = String(status.state).toUpperCase();
    const expiry = Number(status.expiry);
    return state === "UNPAID" && Number.isFinite(expiry) &&
      expiry <= Math.floor(Date.now() / 1000);
  }

  /** Loads the configured Cashu mint once for all quote claims and treasury melts. */
  private async getWallet(): Promise<Wallet> {
    if (!this.walletPromise) {
      const wallet = this.walletFactory(this.mintUrl);
      this.walletPromise = withPaymentTimeout(
        wallet.loadMint(),
        this.operationTimeoutMs,
        "Cashu mint initialization",
      ).then(() => wallet);
    }
    const pending = this.walletPromise;
    try {
      return await pending;
    } catch (error) {
      if (this.walletPromise === pending) this.walletPromise = null;
      throw error;
    }
  }
}

/** Resolves a Lightning Address using its public HTTPS LNURL-pay metadata endpoint. */
async function resolveLightningAddress(
  address: string,
): Promise<LightningAddressDetails> {
  const [name, domain, extra] = address.split("@");
  if (!name || !domain || extra) {
    throw new Error("Treasury destination is not a valid Lightning Address");
  }
  const endpoint = new URL(
    `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`,
  );
  const response = await fetchPublicHttpUrl(endpoint, {
    connectTimeoutMs: 10_000,
  });
  if (!response.ok) {
    throw new Error(
      `Lightning Address metadata returned HTTP ${response.status}`,
    );
  }
  const body = await response.json() as Record<string, unknown>;
  const callback = new URL(String(body.callback ?? ""));
  if (callback.protocol !== "https:") {
    throw new Error("Lightning Address callback must use HTTPS");
  }
  const minSendableMsats = Number(body.minSendable);
  const maxSendableMsats = Number(body.maxSendable);
  if (
    !Number.isSafeInteger(minSendableMsats) ||
    !Number.isSafeInteger(maxSendableMsats)
  ) {
    throw new Error("Lightning Address returned invalid payment limits");
  }
  return {
    callback,
    minSendableMsats,
    maxSendableMsats,
    commentAllowed: Number.isSafeInteger(Number(body.commentAllowed))
      ? Number(body.commentAllowed)
      : 0,
  };
}

/** Requests the exact BOLT11 invoice that the Cashu mint will pay for one treasury attempt. */
async function requestLightningInvoice(
  details: LightningAddressDetails,
  amountSats: number,
  destination: string,
): Promise<string> {
  const callback = new URL(details.callback);
  callback.searchParams.set("amount", String(amountSats * 1000));
  const comment = "Fanfares Blossom paid storage";
  if (details.commentAllowed >= comment.length) {
    callback.searchParams.set("comment", comment);
  }
  const response = await fetchPublicHttpUrl(callback, {
    connectTimeoutMs: 10_000,
  });
  if (!response.ok) {
    throw new Error(
      `Lightning Address invoice callback returned HTTP ${response.status}`,
    );
  }
  const body = await response.json() as Record<string, unknown>;
  if (body.status === "ERROR") {
    throw new Error(
      `Lightning Address rejected payout: ${
        String(body.reason ?? destination)
      }`,
    );
  }
  if (typeof body.pr !== "string" || body.pr.length < 20) {
    throw new Error("Lightning Address did not return a BOLT11 invoice");
  }
  return body.pr;
}

/** Serializes Cashu previews while preserving bigint and byte-array blinding material for replay. */
function serializePreview(preview: MintPreview | MeltPreview): string {
  return JSON.stringify(preview, (_key, value) => {
    if (typeof value === "bigint") return { __cashuBigInt: value.toString() };
    if (value instanceof Uint8Array) {
      return { __cashuBytes: encodeBase64(value) };
    }
    return value;
  });
}

/** Restores the concrete OutputData objects required by cashu-ts to complete a persisted preview. */
function restoreOutputData(value: unknown): OutputDataLike[] {
  if (!Array.isArray(value)) {
    throw new Error("Persisted Cashu preview has invalid output data");
  }
  return value.map((entry) => {
    const item = entry as {
      blindedMessage: OutputDataLike["blindedMessage"];
      blindingFactor: bigint;
      secret: Uint8Array;
    };
    return new OutputData(
      item.blindedMessage,
      item.blindingFactor,
      item.secret,
    );
  });
}

/** Parses persisted Cashu JSON and revives bigint and byte-array values without regenerating secrets. */
function parsePreview(json: string): Record<string, unknown> {
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === "object" && "__cashuBigInt" in value) {
      return BigInt(value.__cashuBigInt);
    }
    if (value && typeof value === "object" && "__cashuBytes" in value) {
      return decodeBase64(value.__cashuBytes);
    }
    return value;
  }) as Record<string, unknown>;
}

/** Rehydrates a persisted mint preview at the claim-completion call site. */
function deserializeMintPreview(json: string): MintPreview {
  const parsed = parsePreview(json);
  parsed.outputData = restoreOutputData(parsed.outputData);
  return parsed as unknown as MintPreview;
}

/** Rehydrates a persisted melt preview at the Lightning-payment call site. */
function deserializeMeltPreview(json: string): MeltPreview {
  const parsed = parsePreview(json);
  parsed.outputData = restoreOutputData(parsed.outputData);
  return parsed as unknown as MeltPreview;
}
