import type { Client } from "@libsql/client";
import { ulid } from "@std/ulid";
import type { PaidStorageConfig } from "../config/schema.ts";
import {
  creditStoragePurchase,
  expireStoragePurchase,
  findPendingStoragePurchase,
  getStoragePurchase,
  getStorageQuotaSummary,
  insertStoragePurchase,
  type StoragePurchaseRecord,
  type StorageQuotaSummary,
} from "../db/paid-storage.ts";
import {
  CashuPaymentProvider,
  type LightningQuoteProvider,
} from "../payments/cashu.ts";

export interface PaidStoragePlan {
  quotaBytesPerUnit: number;
  durationDays: number;
  priceUsdCents: number;
  priceSats: number;
  maxUnitsPerPurchase: number;
}

/** Coordinates Cashu Lightning quotes with durable annual quota grants. */
export class PaidStorageService {
  private readonly payments: LightningQuoteProvider;

  constructor(
    private readonly db: Client,
    private readonly config: PaidStorageConfig,
    payments?: LightningQuoteProvider,
  ) {
    this.payments = payments ?? new CashuPaymentProvider(config.cashu.mintUrl);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get plan(): PaidStoragePlan {
    return {
      quotaBytesPerUnit: this.config.quotaBytesPerUnit,
      durationDays: this.config.durationDays,
      priceUsdCents: this.config.priceUsdCents,
      priceSats: this.config.priceSats,
      maxUnitsPerPurchase: this.config.maxUnitsPerPurchase,
    };
  }

  async getQuota(pubkey: string): Promise<StorageQuotaSummary> {
    return await getStorageQuotaSummary(this.db, pubkey, this.now());
  }

  async getOrCreatePurchase(
    pubkey: string,
    units: number,
  ): Promise<StoragePurchaseRecord> {
    if (!this.enabled) throw new Error("Paid storage is disabled");
    if (
      !Number.isInteger(units) || units < 1 ||
      units > this.config.maxUnitsPerPurchase
    ) {
      throw new RangeError(
        `Units must be between 1 and ${this.config.maxUnitsPerPurchase}`,
      );
    }

    const now = this.now();
    const amountSats = units * this.config.priceSats;
    const quotaBytes = units * this.config.quotaBytesPerUnit;
    const durationSeconds = this.config.durationDays * 24 * 60 * 60;
    const existing = await findPendingStoragePurchase(
      this.db,
      pubkey,
      units,
      amountSats,
      quotaBytes,
      durationSeconds,
      now,
    );
    if (existing) return existing;

    const quote = await this.payments.createQuote(
      amountSats,
      `Fanfares Blossom: ${units} storage unit${units === 1 ? "" : "s"}`,
    );
    const purchase: StoragePurchaseRecord = {
      id: ulid(),
      pubkey,
      units,
      quotaBytes,
      durationSeconds,
      amountSats,
      invoice: quote.invoice,
      providerQuoteId: quote.providerQuoteId,
      state: "pending",
      invoiceExpires: quote.expiresAt,
      createdAt: now,
      paidAt: null,
      creditedAt: null,
    };
    await insertStoragePurchase(this.db, purchase);
    return purchase;
  }

  async refreshPurchase(
    id: string,
    pubkey: string,
  ): Promise<StoragePurchaseRecord | null> {
    const purchase = await getStoragePurchase(this.db, id, pubkey);
    if (!purchase || purchase.state !== "pending") return purchase;

    const providerState = await this.payments.checkQuote(
      purchase.providerQuoteId,
    );
    if (providerState === "paid") {
      const now = this.now();
      await creditStoragePurchase(this.db, purchase, now);
      return await getStoragePurchase(this.db, id, pubkey);
    }
    if (providerState === "expired") {
      await expireStoragePurchase(this.db, purchase.id);
      return await getStoragePurchase(this.db, id, pubkey);
    }
    return purchase;
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }
}
