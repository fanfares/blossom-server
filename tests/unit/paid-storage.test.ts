/**
 * Unit/integration coverage for paid annual storage accounting.
 *
 * Verifies purchase quote reuse, idempotent grant crediting, owner-based usage,
 * and atomic upload reservations that prevent concurrent quota oversubscription.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { Wallet } from "@cashu/cashu-ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import { insertBlob } from "../../src/db/blobs.ts";
import {
  getStorageQuotaSummary,
  renewStorageReservation,
  reserveStorageQuota,
} from "../../src/db/paid-storage.ts";
import { PaidStorageService } from "../../src/paid-storage/service.ts";
import type {
  LightningQuoteProvider,
  LightningQuoteState,
} from "../../src/payments/cashu.ts";
import { CashuPaymentProvider } from "../../src/payments/cashu.ts";
import type {
  CompletedTreasuryPayout,
  PreparedTreasuryPayout,
  TreasuryForwarder,
} from "../../src/payments/treasury.ts";
import { CashuTreasuryForwarder } from "../../src/payments/treasury.ts";

class FakePayments implements LightningQuoteProvider {
  state: LightningQuoteState = "pending";
  createCalls = 0;
  amounts = new Map<string, number>();

  createQuote(amountSats: number) {
    this.createCalls++;
    const providerQuoteId = `quote-${this.createCalls}`;
    this.amounts.set(providerQuoteId, amountSats);
    return Promise.resolve({
      providerQuoteId,
      invoice: `lnbc-${amountSats}`,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      amountSats,
      unit: "sat",
    });
  }

  checkQuote(providerQuoteId: string) {
    return Promise.resolve({
      state: this.state,
      amountSats: this.amounts.get(providerQuoteId) ?? 0,
      unit: "sat",
    });
  }
}

class FakeTreasury implements TreasuryForwarder {
  completed = 0;

  prepareClaim(): Promise<string> {
    return Promise.resolve('{"claim":true}');
  }

  completeClaim(): Promise<string> {
    return Promise.resolve('[{"amount":20}]');
  }

  preparePayout(): Promise<PreparedTreasuryPayout> {
    return Promise.resolve({
      meltPreviewJson: '{"melt":true}',
      forwardedAmountSats: 19,
      feeReserveSats: 1,
    });
  }

  completePayout(): Promise<CompletedTreasuryPayout> {
    this.completed++;
    return Promise.resolve({
      paid: true,
      changeProofsJson: "[]",
      paymentPreimage: "preimage",
    });
  }
}

Deno.test("paid storage credits purchases and reserves remaining quota atomically", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_paid_storage_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  try {
    const config = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: {
        enabled: true,
        quotaBytesPerUnit: 1000,
        durationDays: 365,
        priceSats: 25,
      },
    });
    const payments = new FakePayments();
    const service = new PaidStorageService(db, config.paidStorage, payments);
    const pubkey = "a".repeat(64);

    const first = await service.getOrCreatePurchase(pubkey, 1);
    const reused = await service.getOrCreatePurchase(pubkey, 1);
    assertEquals(first.id, reused.id);
    assertEquals(first.amountSats, 25);
    assertEquals(payments.createCalls, 1);

    const repricedConfig = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: {
        enabled: true,
        quotaBytesPerUnit: 1000,
        durationDays: 365,
        priceSats: 20,
      },
    });
    const repricedService = new PaidStorageService(
      db,
      repricedConfig.paidStorage,
      payments,
    );
    const repriced = await repricedService.getOrCreatePurchase(pubkey, 1);
    assertEquals(repriced.id === first.id, false);
    assertEquals(repriced.amountSats, 20);
    assertEquals(payments.createCalls, 2);

    payments.state = "paid";
    const settled = await service.refreshPurchase(first.id, pubkey);
    assertEquals(settled?.state, "paid");

    const multiYear = await service.getOrCreatePurchase("c".repeat(64), 2, 3);
    assertEquals(multiYear.units, 2);
    assertEquals(multiYear.quotaBytes, 2000);
    assertEquals(multiYear.amountSats, 150);
    assertEquals(multiYear.durationSeconds, 3 * 365 * 24 * 60 * 60);

    await insertBlob(
      db,
      { sha256: "b".repeat(64), size: 400, type: "audio/mpeg", uploaded: 1 },
      pubkey,
    );
    let quota = await service.getQuota(pubkey);
    assertEquals(quota.quotaBytes, 1000);
    assertEquals(quota.usedBytes, 400);
    assertEquals(quota.availableBytes, 600);

    const now = Math.floor(Date.now() / 1000);
    assertEquals(
      await reserveStorageQuota(db, {
        id: "reservation-1",
        pubkey,
        sizeBytes: 500,
        now,
        expiresAt: now + 600,
      }),
      true,
    );
    assertEquals(
      await reserveStorageQuota(db, {
        id: "reservation-2",
        pubkey,
        sizeBytes: 101,
        now,
        expiresAt: now + 600,
      }),
      false,
    );

    quota = await getStorageQuotaSummary(db, pubkey, now);
    assertEquals(quota.reservedBytes, 500);
    assertEquals(quota.availableBytes, 100);

    assertEquals(
      await renewStorageReservation(db, {
        id: "reservation-1",
        pubkey,
        sizeBytes: 500,
        now: now + 599,
        expiresAt: now + 1199,
      }),
      true,
    );
    assertEquals(
      await reserveStorageQuota(db, {
        id: "reservation-after-expiry",
        pubkey,
        sizeBytes: 500,
        now: now + 1200,
        expiresAt: now + 1800,
      }),
      true,
    );
    assertEquals(
      await renewStorageReservation(db, {
        id: "reservation-1",
        pubkey,
        sizeBytes: 500,
        now: now + 1200,
        expiresAt: now + 1800,
      }),
      false,
    );

    const grantsBeforeExtension = await service.getActiveGrants(pubkey);
    const extension = await service.createExtensionPurchase(pubkey, 2);
    const reusedExtension = await service.createExtensionPurchase(pubkey, 2);
    assertEquals(extension.purchaseType, "extension");
    assertEquals(reusedExtension.id, extension.id);
    assertEquals(extension.units, 1);
    assertEquals(extension.amountSats, 50);
    await service.refreshPurchase(extension.id, pubkey);
    const grantsAfterExtension = await service.getActiveGrants(pubkey);
    assertEquals(
      grantsAfterExtension[0].expiresAt,
      grantsBeforeExtension[0].expiresAt + 2 * 365 * 24 * 60 * 60,
    );

    await service.refreshPurchase(extension.id, pubkey);
    const grantsAfterSecondRefresh = await service.getActiveGrants(pubkey);
    assertEquals(
      grantsAfterSecondRefresh[0].expiresAt,
      grantsAfterExtension[0].expiresAt,
    );

    const recoveredPubkey = "f".repeat(64);
    const recoverable = await service.getOrCreatePurchase(recoveredPubkey, 1);
    await service.processPendingPurchases(100, recoveredPubkey);
    assertEquals((await service.getQuota(recoveredPubkey)).quotaBytes, 1000);
    assertEquals(
      (await service.listPurchases(recoveredPubkey))[0].id,
      recoverable.id,
    );
    assertEquals(await service.listPurchases("9".repeat(64)), []);
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("paid storage rejects unsafe routes and mismatched Cashu quote terms", async () => {
  assertThrows(
    () =>
      ConfigSchema.parse({
        paidStorage: { enabled: true },
        mirror: { enabled: true },
      }),
    Error,
    "Mirror uploads must be disabled",
  );
  assertThrows(
    () =>
      ConfigSchema.parse({
        paidStorage: { enabled: true },
        mirror: { enabled: false },
        media: { enabled: true },
      }),
    Error,
    "Media uploads must be disabled",
  );
  assertThrows(
    () =>
      ConfigSchema.parse({
        paidStorage: {
          enabled: true,
          treasury: { enabled: true },
        },
        mirror: { enabled: false },
      }),
    Error,
    "treasury Lightning Address is required",
  );

  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_quote_terms_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  try {
    const config = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: { enabled: true, priceSats: 20 },
    });
    const payments = new FakePayments();
    payments.createQuote = () =>
      Promise.resolve({
        providerQuoteId: "wrong-amount",
        invoice: "lnbc-1",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        amountSats: 1,
        unit: "sat",
      });
    const service = new PaidStorageService(db, config.paidStorage, payments);
    await assertRejects(
      () => service.getOrCreatePurchase("e".repeat(64), 1),
      Error,
      "does not match",
    );
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("aligned storage purchase prices and credits one shared expiry atomically", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_aligned_storage_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  const originalDateNow = Date.now;
  const fixedNow = 1_900_000_000;
  Date.now = () => fixedNow * 1000;
  try {
    const config = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: {
        enabled: true,
        quotaBytesPerUnit: 1000,
        durationDays: 365,
        priceSats: 10,
      },
    });
    const payments = new FakePayments();
    const service = new PaidStorageService(db, config.paidStorage, payments);
    const pubkey = "7".repeat(64);
    const original = await service.getOrCreatePurchase(pubkey, 2, 1);
    payments.state = "paid";
    await service.refreshPurchase(original.id, pubkey);
    payments.state = "pending";

    const preview = await service.previewPurchase(pubkey, 1, 2, true);
    assertEquals(preview.alignExpiry, true);
    assertEquals(preview.baseAmountSats, 20);
    assertEquals(preview.alignmentAmountSats, 20);
    assertEquals(preview.amountSats, 40);
    assertEquals(preview.existingStorageBytesExtended, 2000);
    assertEquals(preview.grantChanges.length, 1);

    const aligned = await service.getOrCreatePurchase(pubkey, 1, 2, true);
    const reused = await service.getOrCreatePurchase(pubkey, 1, 2, true);
    assertEquals(reused.id, aligned.id);
    assertEquals(aligned.alignedExpiresAt, preview.targetExpiresAt);
    assertEquals(aligned.amountSats, 40);
    payments.state = "paid";
    await service.refreshPurchase(aligned.id, pubkey);

    const grants = await service.getActiveGrants(pubkey);
    assertEquals(grants.length, 2);
    assertEquals(
      grants.map((grant) => grant.expiresAt),
      [preview.targetExpiresAt, preview.targetExpiresAt],
    );
    assertEquals((await service.getQuota(pubkey)).quotaBytes, 3000);
  } finally {
    Date.now = originalDateNow;
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("aligned storage extends a shorter new selection to the latest active expiry", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_aligned_new_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  const originalDateNow = Date.now;
  const fixedNow = 1_900_000_000;
  Date.now = () => fixedNow * 1000;
  try {
    const config = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: {
        enabled: true,
        quotaBytesPerUnit: 1000,
        durationDays: 365,
        priceSats: 10,
      },
    });
    const payments = new FakePayments();
    const service = new PaidStorageService(db, config.paidStorage, payments);
    const pubkey = "6".repeat(64);
    const original = await service.getOrCreatePurchase(pubkey, 2, 2);
    payments.state = "paid";
    await service.refreshPurchase(original.id, pubkey);

    const preview = await service.previewPurchase(pubkey, 1, 1, true);
    assertEquals(preview.targetExpiresAt, fixedNow + 2 * 365 * 24 * 60 * 60);
    assertEquals(preview.newStorageExtraSeconds, 365 * 24 * 60 * 60);
    assertEquals(preview.existingStorageBytesExtended, 0);
    assertEquals(preview.baseAmountSats, 10);
    assertEquals(preview.alignmentAmountSats, 10);
    assertEquals(preview.amountSats, 20);

    const separate = await service.previewPurchase(pubkey, 1, 1, false);
    assertEquals(separate.alignExpiry, false);
    assertEquals(separate.alignmentAmountSats, 0);
    assertEquals(separate.amountSats, 10);
  } finally {
    Date.now = originalDateNow;
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("paid storage hides expired invoices without abandoning uncertain settlement", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_expired_storage_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  try {
    const config = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: { enabled: true, priceSats: 20 },
    });
    const payments = new FakePayments();
    payments.createQuote = (amountSats: number) =>
      Promise.resolve({
        providerQuoteId: "expired-quote",
        invoice: "lnbc-20-expired",
        expiresAt: Math.floor(Date.now() / 1000) - 1,
        amountSats,
        unit: "sat",
      });
    payments.checkQuote = () => Promise.reject(new Error("quote not found"));
    const service = new PaidStorageService(db, config.paidStorage, payments);
    const pubkey = "8".repeat(64);
    const purchase = await service.getOrCreatePurchase(pubkey, 1);

    assertEquals(
      (await service.refreshPurchase(purchase.id, pubkey))?.state,
      "expired",
    );
    assertEquals((await service.listPurchases(pubkey))[0].state, "expired");
    const durable = await db.execute({
      sql: "SELECT state FROM storage_purchases WHERE id = ?",
      args: [purchase.id],
    });
    assertEquals(durable.rows[0]?.[0], "pending");

    payments.checkQuote = () =>
      Promise.resolve({ state: "paid", amountSats: 20, unit: "sat" });
    assertEquals(
      (await service.refreshPurchase(purchase.id, pubkey))?.state,
      "paid",
    );
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("paid storage durably forwards settled revenue to the configured wallet once", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_treasury_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  try {
    const config = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: {
        enabled: true,
        quotaBytesPerUnit: 1000,
        priceSats: 20,
        treasury: {
          enabled: true,
          lightningAddress: "iefan@walletofsatoshi.com",
        },
      },
    });
    const payments = new FakePayments();
    const treasury = new FakeTreasury();
    const service = new PaidStorageService(
      db,
      config.paidStorage,
      payments,
      treasury,
    );
    const pubkey = "d".repeat(64);
    const purchase = await service.getOrCreatePurchase(pubkey, 1);
    payments.state = "paid";
    await service.refreshPurchase(purchase.id, pubkey);

    let state = "";
    for (let attempt = 0; attempt < 20 && state !== "paid"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await db.execute({
        sql:
          "SELECT state, destination, forwarded_amount_sats FROM storage_treasury_transfers WHERE purchase_id = ?",
        args: [purchase.id],
      });
      state = String(result.rows[0]?.[0] ?? "");
      if (state === "paid") {
        assertEquals(result.rows[0]?.[1], "iefan@walletofsatoshi.com");
        assertEquals(result.rows[0]?.[2], 19);
      }
    }
    assertEquals(state, "paid");

    await service.refreshPurchase(purchase.id, pubkey);
    await service.processDueTreasuryTransfers();
    assertEquals(treasury.completed, 1);
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Cashu providers retry wallet initialization after a transient mint failure", async () => {
  let paymentLoads = 0;
  const paymentWallet = {
    loadMint() {
      paymentLoads++;
      return paymentLoads === 1
        ? Promise.reject(new Error("temporary mint failure"))
        : Promise.resolve();
    },
    createMintQuoteBolt11() {
      return Promise.resolve({
        quote: "retry-quote",
        request: "lnbc20",
        expiry: 1,
        amount: 20,
        unit: "sat",
      });
    },
  } as unknown as Wallet;
  const payments = new CashuPaymentProvider(
    "https://mint.example",
    () => paymentWallet,
  );
  await assertRejects(
    () => payments.createQuote(20, "storage"),
    Error,
    "temporary mint failure",
  );
  assertEquals((await payments.createQuote(20, "storage")).amountSats, 20);
  assertEquals(paymentLoads, 2);

  let treasuryLoads = 0;
  const treasuryWallet = {
    loadMint() {
      treasuryLoads++;
      return treasuryLoads === 1
        ? Promise.reject(new Error("temporary treasury mint failure"))
        : Promise.resolve();
    },
    prepareMint() {
      return Promise.reject(new Error("continued after retry"));
    },
  } as unknown as Wallet;
  const treasury = new CashuTreasuryForwarder(
    "https://mint.example",
    () => treasuryWallet,
  );
  await assertRejects(
    () => treasury.prepareClaim(20, "quote"),
    Error,
    "temporary treasury mint failure",
  );
  await assertRejects(
    () => treasury.prepareClaim(20, "quote"),
    Error,
    "continued after retry",
  );
  assertEquals(treasuryLoads, 2);

  const hangingWallet = {
    loadMint: () => new Promise<void>(() => {}),
  } as unknown as Wallet;
  const bounded = new CashuPaymentProvider(
    "https://mint.example",
    () => hangingWallet,
    5,
  );
  await assertRejects(
    () => bounded.createQuote(20, "storage"),
    Error,
    "timed out",
  );
});
