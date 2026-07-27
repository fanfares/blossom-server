import { Wallet } from "@cashu/cashu-ts";

export interface LightningQuote {
  providerQuoteId: string;
  invoice: string;
  expiresAt: number | null;
}

export type LightningQuoteState = "pending" | "paid" | "expired";

export interface LightningQuoteProvider {
  createQuote(amountSats: number, memo: string): Promise<LightningQuote>;
  checkQuote(providerQuoteId: string): Promise<LightningQuoteState>;
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
    };
  }

  async checkQuote(providerQuoteId: string): Promise<LightningQuoteState> {
    const wallet = await this.getWallet();
    const quote = await wallet.checkMintQuoteBolt11(providerQuoteId);
    const state = String(quote.state ?? "").toUpperCase();
    if (state === "PAID" || state === "ISSUED") return "paid";
    if (state === "EXPIRED") return "expired";
    return "pending";
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
}
