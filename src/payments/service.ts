import type { Context } from "@hono/hono";
import type { Client } from "@libsql/client";
import { getTokenMetadata, Wallet } from "@cashu/cashu-ts";
import type { Config, PaymentConfig } from "../config/schema.ts";
import { insertPaymentReceipt } from "../db/payments.ts";

export type PaidEndpoint = "upload" | "media";

interface PaymentInput {
  endpoint: PaidEndpoint;
  sizeBytes: number;
  mimeType: string;
  pubkey?: string;
  sha256?: string | null;
}

interface PaymentChallenge {
  xCashu: string;
  xLightning?: string;
  paymentId?: string;
  reason?: string;
  expiresAt?: number;
}

interface VerifyResult {
  ok: boolean;
  reason?: string;
}

interface RequestResponse {
  xCashu?: string;
  xLightning?: string;
  paymentId?: string;
  reason?: string;
  expiresAt?: number;
}

interface VerifyResponse {
  ok?: boolean;
  reason?: string;
}

export interface PaymentCheckResult {
  ok: boolean;
  response?: Response;
}

export class PaymentService {
  private readonly cfg: PaymentConfig;
  private walletLoadPromise: Promise<Wallet> | null = null;

  constructor(private readonly config: Config, private readonly db: Client) {
    this.cfg = config.payment;
  }

  isEnabledFor(endpoint: PaidEndpoint): boolean {
    if (!this.cfg.enabled || !this.cfg.cashu.enabled) return false;
    if (this.cfg.cashu.mode === "bridge") {
      if (!this.cfg.cashu.requestUrl || !this.cfg.cashu.verifyUrl) return false;
    } else {
      if (!this.cfg.cashu.mintUrl || !this.cfg.cashu.payoutLightningAddress) {
        return false;
      }
    }
    return endpoint === "upload" ? this.cfg.chargeUpload : this.cfg.chargeMedia;
  }

  shouldBypass(pubkey?: string): boolean {
    if (!pubkey) return false;
    return this.cfg.bypassPubkeys.includes(pubkey);
  }

  async requireForHead(
    ctx: Context,
    input: PaymentInput,
    paymentIdHeader?: string | null,
  ): Promise<PaymentCheckResult> {
    if (!this.isEnabledFor(input.endpoint) || this.shouldBypass(input.pubkey)) {
      return { ok: true };
    }

    if (this.cfg.cashu.mode === "direct" && paymentIdHeader) {
      try {
        const wallet = await this.getDirectWallet();
        const mintQuote = await wallet.checkMintQuoteBolt11(paymentIdHeader);
        const quoteState = String(mintQuote.state ?? "").toUpperCase();
        const amountSats = this.computeAmountSats(input.sizeBytes);
        const quoteAmount = this.toInt(mintQuote.amount);

        if (quoteState === "PAID" && quoteAmount >= amountSats) {
          return { ok: true };
        }

        const reason = quoteState === "PAID"
          ? `Payment amount too small (${quoteAmount} < ${amountSats})`
          : "Waiting for payment verification";

        return {
          ok: false,
          response: this.paymentRequiredResponse(ctx, {
            xCashu: this.directCashuRequest(amountSats),
            xLightning: String(mintQuote.request ?? "") || undefined,
            paymentId: paymentIdHeader,
            reason,
            expiresAt: this.toInt(mintQuote.expiry),
          }),
        };
      } catch {
        // Fall through to creating a fresh challenge when payment id is invalid
        // or unknown at the mint.
      }
    }

    const challenge = await this.requestChallenge(input);
    return {
      ok: false,
      response: this.paymentRequiredResponse(ctx, challenge),
    };
  }

  async requireForPut(
    ctx: Context,
    input: PaymentInput,
    proofHeader: string | null,
    paymentIdHeader: string | null,
  ): Promise<PaymentCheckResult> {
    if (!this.isEnabledFor(input.endpoint) || this.shouldBypass(input.pubkey)) {
      return { ok: true };
    }

    if (this.cfg.cashu.mode === "direct") {
      if (!paymentIdHeader) {
        const challenge = await this.requestChallenge(input);
        return {
          ok: false,
          response: this.paymentRequiredResponse(ctx, challenge),
        };
      }

      const verify = await this.verifyProofDirect(
        input,
        proofHeader,
        paymentIdHeader,
      );
      if (!verify.ok) {
        const reason = verify.reason ?? "Invalid or unpaid payment";
        const reasonLower = reason.toLowerCase();
        const pending = reasonLower.includes("not paid") ||
          reasonLower.includes("pending") ||
          reasonLower.includes("await");

        const headers: Record<string, string> = {
          "X-Reason": reason,
          "Content-Type": "text/plain",
        };
        if (paymentIdHeader) headers["X-Payment-Id"] = paymentIdHeader;

        return {
          ok: false,
          response: ctx.body(reason, pending ? 402 : 400, headers),
        };
      }

      return { ok: true };
    }

    if (!proofHeader) {
      const challenge = await this.requestChallenge(input);
      return {
        ok: false,
        response: this.paymentRequiredResponse(ctx, challenge),
      };
    }

    const verify = await this.verifyProof(input, proofHeader, paymentIdHeader);
    if (!verify.ok) {
      const reason = verify.reason ?? "Invalid or unpaid Cashu proof";
      return {
        ok: false,
        response: ctx.body(reason, 400, {
          "X-Reason": reason,
          "Content-Type": "text/plain",
        }),
      };
    }

    return { ok: true };
  }

  private paymentRequiredResponse(
    ctx: Context,
    challenge: PaymentChallenge,
  ): Response {
    const reason = challenge.reason ?? "Payment required";
    const headers: Record<string, string> = {
      "X-Cashu": challenge.xCashu,
      "X-Reason": reason,
      "Content-Type": "text/plain",
    };

    if (challenge.xLightning) headers["X-Lightning"] = challenge.xLightning;
    if (challenge.paymentId) headers["X-Payment-Id"] = challenge.paymentId;
    if (challenge.expiresAt) {
      headers["X-Payment-Expires"] = String(challenge.expiresAt);
    }

    return ctx.body(reason, 402, headers);
  }

  private computeAmountSats(sizeBytes: number): number {
    const sizeMiB = Math.max(1, Math.ceil(sizeBytes / (1024 * 1024)));
    const amount = this.cfg.pricing.baseSats +
      (sizeMiB * this.cfg.pricing.satsPerMiB);
    return Math.max(this.cfg.pricing.minSats, amount);
  }

  private async requestChallenge(
    input: PaymentInput,
  ): Promise<PaymentChallenge> {
    if (this.cfg.cashu.mode === "direct") {
      return await this.requestChallengeDirect(input);
    }

    const amountSats = this.computeAmountSats(input.sizeBytes);
    const payload = {
      endpoint: input.endpoint,
      amountSats,
      unit: "sat",
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      pubkey: input.pubkey,
      sha256: input.sha256 ?? undefined,
    };

    const data = await this.postJson<RequestResponse>(
      this.cfg.cashu.requestUrl,
      payload,
    );
    if (!data.xCashu) {
      throw new Error("Cashu request endpoint did not return xCashu");
    }

    return {
      xCashu: data.xCashu,
      xLightning: data.xLightning,
      paymentId: data.paymentId,
      reason: data.reason,
      expiresAt: data.expiresAt,
    };
  }

  private async requestChallengeDirect(
    input: PaymentInput,
  ): Promise<PaymentChallenge> {
    const amountSats = this.computeAmountSats(input.sizeBytes);
    const wallet = await this.getDirectWallet();

    const quote = await wallet.createMintQuoteBolt11(
      amountSats,
      this.cfg.cashu.payoutComment,
    );

    return {
      // This is an in-band request descriptor for clients. The actual invoice is
      // returned in X-Lightning and paid against the configured mint.
      xCashu: this.directCashuRequest(amountSats),
      xLightning: String(quote.request ?? ""),
      paymentId: String(quote.quote ?? ""),
      reason: `Payment required: ${amountSats} sat`,
      expiresAt: this.toInt(quote.expiry),
    };
  }

  private directCashuRequest(amountSats: number): string {
    return JSON.stringify({
      a: amountSats,
      u: "sat",
      m: [this.normalizeMintUrl(this.cfg.cashu.mintUrl)],
    });
  }

  private async verifyProof(
    input: PaymentInput,
    proof: string | null,
    paymentId?: string | null,
  ): Promise<VerifyResult> {
    if (this.cfg.cashu.mode === "direct") {
      return await this.verifyProofDirect(input, proof, paymentId);
    }

    if (!proof) {
      return {
        ok: false,
        reason: "Missing X-Cashu header",
      };
    }

    const payload = {
      endpoint: input.endpoint,
      amountSats: this.computeAmountSats(input.sizeBytes),
      unit: "sat",
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      pubkey: input.pubkey,
      sha256: input.sha256 ?? undefined,
      paymentId: paymentId ?? undefined,
      proof,
    };

    const data = await this.postJson<VerifyResponse>(
      this.cfg.cashu.verifyUrl,
      payload,
    );
    return {
      ok: data.ok === true,
      reason: data.reason,
    };
  }

  private async verifyProofDirect(
    input: PaymentInput,
    proof: string | null,
    paymentId?: string | null,
  ): Promise<VerifyResult> {
    const amountSats = this.computeAmountSats(input.sizeBytes);
    const expectedMint = this.normalizeMintUrl(this.cfg.cashu.mintUrl);

    try {
      if (!paymentId) {
        return {
          ok: false,
          reason: "Missing X-Payment-Id header",
        };
      }

      const wallet = await this.getDirectWallet();

      // Verify the original mint quote invoice has been paid at the mint.
      const mintQuote = await wallet.checkMintQuoteBolt11(paymentId);
      const quoteState = String(mintQuote.state ?? "").toUpperCase();
      if (quoteState !== "PAID") {
        return {
          ok: false,
          reason: `Mint quote is not paid (state=${quoteState || "unknown"})`,
        };
      }

      const quoteAmount = this.toInt(mintQuote.amount);
      if (quoteAmount < amountSats) {
        return {
          ok: false,
          reason:
            `Mint quote amount is too small (${quoteAmount} < ${amountSats})`,
        };
      }

      let sourceProofs: Parameters<Wallet["send"]>[1] | null = null;
      let sourceAmount = 0;
      let sourceLabel = "Mint quote";

      const providedProof = proof?.trim() ?? "";
      if (providedProof) {
        try {
          const metadata = getTokenMetadata(providedProof);
          const tokenMint = this.normalizeMintUrl(String(metadata.mint ?? ""));
          if (tokenMint !== expectedMint) {
            return {
              ok: false,
              reason: `Wrong mint. Expected ${expectedMint}`,
            };
          }

          const tokenAmount = this.toInt(metadata.amount);
          const token = wallet.decodeToken(providedProof);
          sourceProofs = token.proofs;
          sourceAmount = tokenAmount;
          sourceLabel = "Provided Cashu token";
        } catch {
          // If token parsing fails (e.g. different token version), fall back to
          // minting proofs directly from the paid quote.
        }
      }

      if (!sourceProofs) {
        const mintedProofs = await wallet.mintProofsBolt11(
          quoteAmount,
          paymentId,
        );
        sourceProofs = mintedProofs;
        sourceAmount = quoteAmount;
      }

      const meltPlan = await this.createAffordableMeltPlan(
        wallet,
        sourceAmount,
        amountSats,
      );

      const selected = await wallet.send(
        BigInt(meltPlan.totalNeeded),
        sourceProofs,
        { includeFees: true },
      );

      const meltResult = await wallet.meltProofsBolt11(
        meltPlan.quote,
        selected.send,
      );
      let state = String(meltResult.quote.state ?? "").toUpperCase();

      if (state === "PENDING") {
        for (let i = 0; i < this.cfg.cashu.payoutPollMaxAttempts; i++) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.cfg.cashu.payoutPollIntervalMs)
          );
          const updated = await wallet.checkMeltQuoteBolt11(
            meltResult.quote.quote,
          );
          state = String(updated.state ?? "").toUpperCase();
          if (state === "PAID") break;
          if (state === "UNPAID") break;
        }
      }

      if (state !== "PAID") {
        return {
          ok: false,
          reason: "Melt did not complete successfully",
        };
      }

      const now = Math.floor(Date.now() / 1000);
      await insertPaymentReceipt(this.db, {
        paymentId,
        endpoint: input.endpoint,
        amountSats,
        quoteAmountSats: quoteAmount,
        mintUrl: expectedMint,
        payerPubkey: input.pubkey ?? null,
        uploaderPubkey: input.pubkey ?? null,
        meltQuoteId: String(meltResult.quote.quote ?? "") || null,
        meltState: state || null,
        paidAt: now,
        createdAt: now,
      });

      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error
          ? err.message
          : "Cashu verification failed",
      };
    }
  }

  private async getDirectWallet(): Promise<Wallet> {
    if (this.walletLoadPromise) return this.walletLoadPromise;

    const mintUrl = this.normalizeMintUrl(this.cfg.cashu.mintUrl);
    const wallet = new Wallet(mintUrl, { unit: "sat" });
    this.walletLoadPromise = (async () => {
      await wallet.loadMint();
      return wallet;
    })();

    return this.walletLoadPromise;
  }

  private normalizeMintUrl(url: string): string {
    const u = new URL(url.trim());
    u.pathname = u.pathname.replace(/\/+$/, "");
    u.search = "";
    u.hash = "";
    return u.toString();
  }

  private async createLnAddressInvoice(
    lightningAddress: string,
    amountSats: number,
  ): Promise<string> {
    const [name, domain] = lightningAddress.trim().toLowerCase().split("@");
    if (!name || !domain) {
      throw new Error("Invalid payoutLightningAddress");
    }

    const lnurlRes = await fetch(
      `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(this.cfg.cashu.timeoutMs) },
    );
    if (!lnurlRes.ok) {
      throw new Error(`LNURL pay endpoint failed (${lnurlRes.status})`);
    }

    const lnurl = await lnurlRes.json() as {
      callback?: string;
      minSendable?: number;
      maxSendable?: number;
      commentAllowed?: number;
      status?: string;
      reason?: string;
    };

    if (lnurl.status === "ERROR") {
      throw new Error(lnurl.reason || "LNURL pay metadata error");
    }
    if (!lnurl.callback || !lnurl.minSendable || !lnurl.maxSendable) {
      throw new Error("Invalid LNURL pay metadata");
    }

    const amountMsat = amountSats * 1000;
    if (amountMsat < lnurl.minSendable || amountMsat > lnurl.maxSendable) {
      throw new Error(
        `Payout amount ${amountSats} sat is outside LNURL range`,
      );
    }

    const cb = new URL(lnurl.callback);
    cb.searchParams.set("amount", String(amountMsat));
    if ((lnurl.commentAllowed ?? 0) > 0 && this.cfg.cashu.payoutComment) {
      cb.searchParams.set("comment", this.cfg.cashu.payoutComment);
    }

    const invoiceRes = await fetch(cb, {
      signal: AbortSignal.timeout(this.cfg.cashu.timeoutMs),
    });
    if (!invoiceRes.ok) {
      throw new Error(`LNURL invoice request failed (${invoiceRes.status})`);
    }

    const invoiceBody = await invoiceRes.json() as {
      pr?: string;
      status?: string;
      reason?: string;
    };
    if (invoiceBody.status === "ERROR") {
      throw new Error(invoiceBody.reason || "LNURL invoice error");
    }

    if (!invoiceBody.pr) {
      throw new Error("LNURL callback did not return an invoice");
    }

    return invoiceBody.pr;
  }

  private async createAffordableMeltPlan(
    wallet: Wallet,
    sourceAmount: number,
    desiredPayoutSats: number,
  ): Promise<{
    quote: Awaited<ReturnType<Wallet["createMeltQuoteBolt11"]>>;
    payoutSats: number;
    totalNeeded: number;
  }> {
    let payoutSats = Math.max(1, desiredPayoutSats);

    for (let i = 0; i < 4; i++) {
      const payoutInvoice = await this.createLnAddressInvoice(
        this.cfg.cashu.payoutLightningAddress,
        payoutSats,
      );
      const quote = await wallet.createMeltQuoteBolt11(payoutInvoice);
      const totalNeeded = this.toInt(quote.amount) +
        this.toInt(quote.fee_reserve);

      if (totalNeeded <= sourceAmount) {
        return { quote, payoutSats, totalNeeded };
      }

      const reserve = this.toInt(quote.fee_reserve);
      const nextPayout = Math.max(1, sourceAmount - reserve);
      if (nextPayout >= payoutSats) break;
      payoutSats = nextPayout;
    }

    throw new Error(
      "Payment amount is too small to cover Lightning payout fees",
    );
  }

  private toInt(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === "bigint") {
      return value > 0n ? Number(value) : 0;
    }
    if (value && typeof value === "object") {
      const maybe = value as {
        toNumber?: () => number;
        toBigInt?: () => bigint;
      };
      if (typeof maybe.toNumber === "function") {
        const n = maybe.toNumber();
        return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
      }
      if (typeof maybe.toBigInt === "function") {
        const n = maybe.toBigInt();
        return n > 0n ? Number(n) : 0;
      }
    }
    return 0;
  }

  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.cfg.cashu.timeoutMs,
    );
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.cfg.cashu.bearerToken) {
        headers["Authorization"] = `Bearer ${this.cfg.cashu.bearerToken}`;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Payment bridge error (${res.status}): ${text || "empty body"}`,
        );
      }

      return await res.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
