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
import {
  claimTreasuryTransfer,
  completeTreasuryTransfer,
  listDueTreasuryTransferIds,
  retryTreasuryTransfer,
  saveTreasuryClaim,
  saveTreasuryMelt,
} from "../db/treasury.ts";
import {
  CashuTreasuryForwarder,
  type TreasuryForwarder,
} from "../payments/treasury.ts";

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
  private readonly treasury: TreasuryForwarder;

  constructor(
    private readonly db: Client,
    private readonly config: PaidStorageConfig,
    payments?: LightningQuoteProvider,
    treasury?: TreasuryForwarder,
  ) {
    this.payments = payments ?? new CashuPaymentProvider(config.cashu.mintUrl);
    this.treasury = treasury ??
      new CashuTreasuryForwarder(config.cashu.mintUrl);
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
        await creditStorageExtensionPurchase(
          this.db,
          purchase,
          now,
          this.treasuryDestination,
        );
      } else {
        await creditStoragePurchase(
          this.db,
          purchase,
          now,
          this.treasuryDestination,
        );
      }
      this.forwardTreasuryPurchase(purchase.id).catch((error) => {
        console.error(
          `[treasury] Immediate forwarding failed for ${purchase.id}:`,
          error,
        );
      });
      return await getStoragePurchase(this.db, id, pubkey);
    }
    if (providerState === "expired") {
      await expireStoragePurchase(this.db, purchase.id);
      return await getStoragePurchase(this.db, id, pubkey);
    }
    return purchase;
  }

  /** Processes due durable payouts from the server retry loop after paid storage has been activated. */
  async processDueTreasuryTransfers(limit = 10): Promise<void> {
    if (!this.treasuryDestination) return;
    const now = this.now();
    const ids = await listDueTreasuryTransferIds(this.db, now, limit);
    for (const id of ids) {
      try {
        await this.forwardTreasuryPurchase(id);
      } catch (error) {
        console.error(`[treasury] Retry failed for ${id}:`, error);
      }
    }
  }

  /** Advances one leased Cashu claim and Lightning payout without allowing concurrent duplicate melts. */
  private async forwardTreasuryPurchase(purchaseId: string): Promise<void> {
    if (!this.treasuryDestination) return;
    const claimed = await claimTreasuryTransfer(
      this.db,
      purchaseId,
      this.now(),
      600,
    );
    if (!claimed) return;
    try {
      let mintPreviewJson = claimed.mintPreviewJson;
      if (!mintPreviewJson) {
        mintPreviewJson = await this.treasury.prepareClaim(
          claimed.grossAmountSats,
          await this.providerQuoteIdForPurchase(purchaseId),
        );
        await saveTreasuryClaim(this.db, purchaseId, this.now(), {
          mintPreviewJson,
        });
      }

      let proofsJson = claimed.proofsJson;
      if (!proofsJson) {
        proofsJson = await this.treasury.completeClaim(mintPreviewJson);
        await saveTreasuryClaim(this.db, purchaseId, this.now(), {
          proofsJson,
        });
      }

      let meltPreviewJson = claimed.meltPreviewJson;
      if (!meltPreviewJson) {
        const prepared = await this.treasury.preparePayout(
          proofsJson,
          claimed.destination,
          claimed.grossAmountSats,
        );
        meltPreviewJson = prepared.meltPreviewJson;
        await saveTreasuryMelt(
          this.db,
          purchaseId,
          this.now(),
          meltPreviewJson,
          prepared.forwardedAmountSats,
          prepared.feeReserveSats,
        );
      }

      const completed = await this.treasury.completePayout(meltPreviewJson);
      if (!completed.paid) {
        throw new Error(
          "Cashu mint reports the treasury payment is still pending",
        );
      }
      await completeTreasuryTransfer(
        this.db,
        purchaseId,
        this.now(),
        completed.changeProofsJson,
        completed.paymentPreimage,
      );
      console.log(
        `[treasury] Forwarded storage purchase ${purchaseId} to ${claimed.destination}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await retryTreasuryTransfer(
        this.db,
        purchaseId,
        claimed.attemptCount,
        this.now(),
        message,
      );
      throw error;
    }
  }

  /** Reads the original Cashu mint quote ID needed to claim a settled purchase into proofs. */
  private async providerQuoteIdForPurchase(
    purchaseId: string,
  ): Promise<string> {
    const result = await this.db.execute({
      sql:
        "SELECT provider_quote_id FROM storage_purchases WHERE id = ? LIMIT 1",
      args: [purchaseId],
    });
    if (!result.rows[0]) throw new Error("Treasury purchase no longer exists");
    return String(result.rows[0][0]);
  }

  private get treasuryDestination(): string | undefined {
    return this.config.treasury.enabled
      ? this.config.treasury.lightningAddress
      : undefined;
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  private get durationSecondsPerYear(): number {
    return this.config.durationDays * 24 * 60 * 60;
  }
}
