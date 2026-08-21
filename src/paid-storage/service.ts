import type { Client } from "@libsql/client";
import { ulid } from "@std/ulid";
import type { PaidStorageConfig } from "../config/schema.ts";
import {
  creditStorageAlignedPurchase,
  creditStorageExtensionPurchase,
  creditStoragePurchase,
  expireStoragePurchase,
  findPendingStorageAlignedPurchase,
  findPendingStorageExtensionPurchase,
  findPendingStoragePurchase,
  getStoragePurchase,
  getStorageQuotaSummary,
  insertStorageAlignedPurchase,
  insertStorageExtensionPurchase,
  insertStoragePurchase,
  listActiveStorageGrants,
  listPendingStoragePurchases,
  listStorageAlignmentTargets,
  listStoragePurchases,
  type StorageAlignmentTargetRecord,
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

export interface StorageAlignmentPreview {
  storageUnits: number;
  durationYears: number;
  alignExpiry: boolean;
  selectedExpiresAt: number;
  targetExpiresAt: number;
  baseAmountSats: number;
  alignmentAmountSats: number;
  amountSats: number;
  newStorageExtraSeconds: number;
  existingStorageBytesExtended: number;
  grantChanges: StorageAlignmentTargetRecord[];
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
    alignExpiry = false,
  ): Promise<StoragePurchaseRecord> {
    if (!this.enabled) throw new Error("Paid storage is disabled");
    const now = this.now();
    const preview = await this.previewPurchase(
      pubkey,
      storageUnits,
      durationYears,
      alignExpiry,
      now,
    );
    const amountSats = preview.amountSats;
    const quotaBytes = storageUnits * this.config.quotaBytesPerUnit;
    const durationSeconds = durationYears * this.durationSecondsPerYear;
    const existing = preview.alignExpiry
      ? await findPendingStorageAlignedPurchase(
        this.db,
        pubkey,
        storageUnits,
        amountSats,
        quotaBytes,
        durationSeconds,
        now,
      )
      : await findPendingStoragePurchase(
        this.db,
        pubkey,
        storageUnits,
        amountSats,
        quotaBytes,
        durationSeconds,
        now,
      );
    if (existing) {
      if (!preview.alignExpiry) return existing;
      const storedTargets = (await listStorageAlignmentTargets(
        this.db,
        existing.id,
      )).map((target) =>
        `${target.grantPurchaseId}:${target.quotaBytes}:${target.originalExpiresAt}`
      ).sort();
      const currentTargets = preview.grantChanges
        .map((target) =>
          `${target.grantPurchaseId}:${target.quotaBytes}:${target.originalExpiresAt}`
        )
        .sort();
      if (storedTargets.join(",") === currentTargets.join(",")) {
        return existing;
      }
    }

    const quote = await this.payments.createQuote(
      amountSats,
      "Fanfares Blossom: " + storageUnits + " storage unit" +
        (storageUnits === 1 ? "" : "s") + " for " + durationYears +
        " year" + (durationYears === 1 ? "" : "s"),
    );
    this.assertQuoteTerms(quote, amountSats);
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
      alignedExpiresAt: preview.alignExpiry ? preview.targetExpiresAt : null,
      baseAmountSats: preview.baseAmountSats,
      alignmentAmountSats: preview.alignmentAmountSats,
    };
    if (preview.alignExpiry) {
      await insertStorageAlignedPurchase(
        this.db,
        purchase,
        preview.targetExpiresAt,
        preview.grantChanges,
      );
    } else {
      await insertStoragePurchase(this.db, purchase);
    }
    return purchase;
  }

  async previewPurchase(
    pubkey: string,
    storageUnits: number,
    durationYears: number,
    alignExpiry: boolean,
    now = this.now(),
  ): Promise<StorageAlignmentPreview> {
    if (!this.enabled) throw new Error("Paid storage is disabled");
    this.validateSelection(storageUnits, durationYears);
    const selectedExpiresAt = now + durationYears * this.durationSecondsPerYear;
    const grants = alignExpiry
      ? await listActiveStorageGrants(this.db, pubkey, now)
      : [];
    const shouldAlign = alignExpiry && grants.length > 0;
    const targetExpiresAt = shouldAlign
      ? Math.max(selectedExpiresAt, ...grants.map((grant) => grant.expiresAt))
      : selectedExpiresAt;
    const grantChanges = shouldAlign
      ? grants.map((grant) => ({
        grantPurchaseId: grant.purchaseId,
        quotaBytes: grant.quotaBytes,
        originalExpiresAt: grant.expiresAt,
        targetExpiresAt,
      }))
      : [];
    const newStorageExtraSeconds = targetExpiresAt - selectedExpiresAt;
    const extraByteSeconds =
      BigInt(storageUnits * this.config.quotaBytesPerUnit) *
        BigInt(newStorageExtraSeconds) +
      grantChanges.reduce(
        (total, grant) =>
          total +
          BigInt(grant.quotaBytes) *
            BigInt(targetExpiresAt - grant.originalExpiresAt),
        0n,
      );
    const unitYearByteSeconds = BigInt(this.config.quotaBytesPerUnit) *
      BigInt(this.durationSecondsPerYear);
    const baseAmountSats = storageUnits * durationYears * this.config.priceSats;
    const alignmentAmountSats = Number(
      (extraByteSeconds * BigInt(this.config.priceSats) + unitYearByteSeconds -
        1n) /
        unitYearByteSeconds,
    );
    const totalByteSeconds =
      BigInt(storageUnits * this.config.quotaBytesPerUnit) *
        BigInt(durationYears * this.durationSecondsPerYear) + extraByteSeconds;
    if (
      totalByteSeconds >
        BigInt(this.config.maxUnitsPerPurchase) * unitYearByteSeconds
    ) {
      throw new RangeError(
        "Aligned checkout exceeds the " + this.config.maxUnitsPerPurchase +
          " GiB-year checkout limit",
      );
    }
    return {
      storageUnits,
      durationYears,
      alignExpiry: shouldAlign,
      selectedExpiresAt,
      targetExpiresAt,
      baseAmountSats,
      alignmentAmountSats,
      amountSats: baseAmountSats + alignmentAmountSats,
      newStorageExtraSeconds,
      existingStorageBytesExtended: grantChanges.reduce(
        (total, grant) =>
          total +
          (grant.originalExpiresAt < grant.targetExpiresAt
            ? grant.quotaBytes
            : 0),
        0,
      ),
      grantChanges,
    };
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
    const existing = await findPendingStorageExtensionPurchase(
      this.db,
      pubkey,
      storageUnits,
      amountSats,
      quotaBytes,
      durationSeconds,
      targets.map((target) => target.purchaseId),
      now,
    );
    if (existing) return existing;
    const quote = await this.payments.createQuote(
      amountSats,
      "Fanfares Blossom: extend " + storageUnits + " storage unit" +
        (storageUnits === 1 ? "" : "s") + " by " + durationYears +
        " year" + (durationYears === 1 ? "" : "s"),
    );
    this.assertQuoteTerms(quote, amountSats);
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
      alignedExpiresAt: null,
      baseAmountSats: amountSats,
      alignmentAmountSats: 0,
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

    let providerStatus;
    try {
      providerStatus = await this.payments.checkQuote(
        purchase.providerQuoteId,
      );
    } catch (error) {
      if (this.isInvoiceExpired(purchase)) {
        // Keep the durable row pending so a later healthy mint check can still
        // credit a payment made immediately before expiry. The public response
        // is terminal because the invoice can no longer accept a new payment.
        return { ...purchase, state: "expired" };
      }
      throw error;
    }
    this.assertQuoteTerms(providerStatus, purchase.amountSats);
    if (providerStatus.state === "issued") {
      throw new Error(
        "Cashu storage quote was issued before the server credited the purchase",
      );
    }
    if (providerStatus.state === "paid") {
      const now = this.now();
      if (purchase.alignedExpiresAt !== null) {
        await creditStorageAlignedPurchase(
          this.db,
          purchase,
          now,
          this.treasuryDestination,
        );
      } else if (purchase.purchaseType === "extension") {
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
    if (providerStatus.state === "expired") {
      await expireStoragePurchase(this.db, purchase.id);
      return await getStoragePurchase(this.db, id, pubkey);
    }
    if (this.isInvoiceExpired(purchase)) {
      await expireStoragePurchase(this.db, purchase.id);
      return await getStoragePurchase(this.db, id, pubkey);
    }
    return purchase;
  }

  /** Reconciles a bounded pending-purchase batch without relying on a browser retaining an ID. */
  async processPendingPurchases(
    limit = 100,
    pubkey?: string,
  ): Promise<void> {
    const purchases = await listPendingStoragePurchases(
      this.db,
      limit,
      pubkey,
    );
    for (const purchase of purchases) {
      try {
        await this.refreshPurchase(purchase.id, purchase.pubkey);
      } catch (error) {
        console.error(
          `[paid-storage] Settlement check failed for ${purchase.id}:`,
          error,
        );
      }
    }
  }

  /** Returns the authenticated buyer's durable purchase history for cross-device recovery. */
  async listPurchases(pubkey: string): Promise<StoragePurchaseRecord[]> {
    const purchases = await listStoragePurchases(this.db, pubkey);
    return purchases.map((purchase) =>
      this.isInvoiceExpired(purchase)
        ? { ...purchase, state: "expired" }
        : purchase
    );
  }

  /** Reports whether a still-pending BOLT11 quote is past its server-recorded deadline. */
  private isInvoiceExpired(purchase: StoragePurchaseRecord): boolean {
    return purchase.state === "pending" && purchase.invoiceExpires !== null &&
      purchase.invoiceExpires <= this.now();
  }

  /** Fails closed when the mint returns terms that differ from the purchase. */
  private assertQuoteTerms(
    quote: { amountSats: number; unit: string },
    expectedAmountSats: number,
  ): void {
    if (
      quote.unit !== "sat" || quote.amountSats !== expectedAmountSats ||
      !Number.isSafeInteger(quote.amountSats)
    ) {
      throw new Error("Cashu mint quote does not match the storage purchase");
    }
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
