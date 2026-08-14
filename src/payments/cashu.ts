import { Wallet } from "@cashu/cashu-ts";

export interface LightningQuote {
  providerQuoteId: string;
  invoice: string;
  expiresAt: number | null;
  amountSats: number;
  unit: string;
}

export type LightningQuoteState = "pending" | "paid" | "expired" | "issued";

export interface LightningQuoteStatus {
  state: LightningQuoteState;
  amountSats: number;
  unit: string;
}

export interface LightningQuoteProvider {
  createQuote(amountSats: number, memo: string): Promise<LightningQuote>;
  checkQuote(providerQuoteId: string): Promise<LightningQuoteStatus>;
}

/** Creates and checks Lightning mint quotes used as the Cashu payment intermediary. */
export class CashuPaymentProvider implements LightningQuoteProvider {
  private walletPromise: Promise<Wallet> | null = null;

  constructor(private readonly mintUrl: string) {}

  async createQuote(amountSats: number, memo: string): Promise<LightningQuote> {
    const wallet = await this.getWallet();
    const quote = await wallet.createMintQuoteBolt11(amountSats, memo);
    return {
      providerQuoteId: String(quote.quote),
      invoice: String(quote.request),
      expiresAt: this.toOptionalInt(quote.expiry),
      amountSats: this.toRequiredInt(quote.amount, "mint quote amount"),
      unit: String(quote.unit),
    };
  }

  async checkQuote(providerQuoteId: string): Promise<LightningQuoteStatus> {
    const wallet = await this.getWallet();
    const quote = await wallet.checkMintQuoteBolt11(providerQuoteId);
    const state = String(quote.state ?? "").toUpperCase();
    return {
      state: state === "PAID"
        ? "paid"
        : state === "ISSUED"
        ? "issued"
        : state === "EXPIRED"
        ? "expired"
        : "pending",
      amountSats: this.toRequiredInt(quote.amount, "mint quote amount"),
      unit: String(quote.unit),
    };
  }

  private async getWallet(): Promise<Wallet> {
    if (!this.walletPromise) {
      const wallet = new Wallet(this.mintUrl, { unit: "sat" });
      this.walletPromise = wallet.loadMint().then(() => wallet);
    }
    return await this.walletPromise;
  }

  private toOptionalInt(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    if (typeof value === "bigint") return Number(value);
    return null;
  }

  /** Converts Cashu's number/bigint/Amount representations without truncation. */
  private toRequiredInt(value: unknown, label: string): number {
    if (
      typeof value === "object" && value !== null &&
      "toNumber" in value && typeof value.toNumber === "function"
    ) {
      value = value.toNumber();
    }
    const parsed = typeof value === "bigint" ? Number(value) : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid ${label}`);
    }
    return parsed;
  }
}
