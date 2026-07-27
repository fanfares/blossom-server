import type { Client } from "@libsql/client";
import { ulid } from "@std/ulid";
import type { PaidStorageConfig } from "../config/schema.ts";
import {
  creditStorageExtensionPurchase,
  creditStoragePurchase,
  expireStoragePurchase,
  findPendingStoragePurchase,
  getStoragePurchase,
  getStorageQuotaSummary,
  insertStorageExtensionPurchase,
  insertStoragePurchase,
  listActiveStorageGrants,
  type StorageGrantRecord,
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
  maxDurationYears: number;
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
      maxDurationYears: this.config.maxDurationYears,
    };
  }

  async getQuota(pubkey: string): Promise<StorageQuotaSummary> {
    return await getStorageQuotaSummary(this.db, pubkey, this.now());
  }

  async getActiveGrants(pubkey: string): Promise<StorageGrantRecord[]> {
    return await listActiveStorageGrants(this.db, pubkey, this.now());
  }

  async getOrCreatePurchase(
    pubkey: string,
    storageUnits: number,
    durationYears = 1,
  ): Promise<StoragePurchaseRecord> {
    if (!this.enabled) throw new Error("Paid storage is disabled");
    this.validateSelection(storageUnits, durationYears);

    const billableUnits = storageUnits * durationYears;
    const now = this.now();
    const amountSats = billableUnits * this.config.priceSats;
    const quotaBytes = storageUnits * this.config.quotaBytesPerUnit;
    const durationSeconds = durationYears * this.durationSecondsPerYear;
    const existing = await findPendingStoragePurchase(
      this.db,
      pubkey,
      storageUnits,
      amountSats,
      quotaBytes,
      durationSeconds,
      now,
    );
    if (existing) return existing;

    const quote = await this.payments.createQuote(
      amountSats,
      "Fanfares Blossom: " + storageUnits + " storage unit" +
        (storageUnits === 1 ? "" : "s") + " for " + durationYears +
        " year" + (durationYears === 1 ? "" : "s"),
    );
    const purchase: StoragePurchaseRecord = {
      id: ulid(),
      pubkey,
      units: storageUnits,
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
      purchaseType: "new",
    };
    await insertStoragePurchase(this.db, purchase);
    return purchase;
  }

  async createExtensionPurchase(
    pubkey: string,
    durationYears: number,
  ): Promise<StoragePurchaseRecord> {
    if (!this.enabled) throw new Error("Paid storage is disabled");
    if (
      !Number.isInteger(durationYears) || durationYears < 1 ||
      durationYears > this.config.maxDurationYears
    ) {
      throw new RangeError(
        "Duration must be between 1 and " +
          this.config.maxDurationYears + " years",
      );
    }

    const now = this.now();
    const targets = await listActiveStorageGrants(this.db, pubkey, now);
    if (targets.length === 0) {
      throw new RangeError("No active storage is available to extend");
    }
    const quotaBytes = targets.reduce(
      (total, grant) => total + grant.quotaBytes,
      0,
    );
    const storageUnits = Math.ceil(
      quotaBytes / this.config.quotaBytesPerUnit,
    );
    const billableUnits = storageUnits * durationYears;
    if (billableUnits > this.config.maxUnitsPerPurchase) {
      throw new RangeError(
        "Extension exceeds the " + this.config.maxUnitsPerPurchase +
          " GiB-year checkout limit",
      );
    }

    const amountSats = billableUnits * this.config.priceSats;
    const durationSeconds = durationYears * this.durationSecondsPerYear;
    const quote = await this.payments.createQuote(
      amountSats,
      "Fanfares Blossom: extend " + storageUnits + " storage unit" +
        (storageUnits === 1 ? "" : "s") + " by " + durationYears +
        " year" + (durationYears === 1 ? "" : "s"),
    );
    const purchase: StoragePurchaseRecord = {
      id: ulid(),
      pubkey,
      units: storageUnits,
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
      purchaseType: "extension",
    };
    await insertStorageExtensionPurchase(this.db, purchase, targets);
    return purchase;
  }

  private validateSelection(
    storageUnits: number,
    durationYears: number,
  ): void {
    if (
      !Number.isInteger(storageUnits) || storageUnits < 1 ||
      !Number.isInteger(durationYears) || durationYears < 1 ||
      durationYears > this.config.maxDurationYears ||
      storageUnits * durationYears > this.config.maxUnitsPerPurchase
    ) {
      throw new RangeError(
        "Selection must be 1-" + this.config.maxDurationYears +
          " years and no more than " + this.config.maxUnitsPerPurchase +
          " GiB-years",
      );
    }
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
      if (purchase.purchaseType === "extension") {
        await creditStorageExtensionPurchase(this.db, purchase, now);
      } else {
        await creditStoragePurchase(this.db, purchase, now);
      }
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

  private get durationSecondsPerYear(): number {
    return this.config.durationDays * 24 * 60 * 60;
  }
}
