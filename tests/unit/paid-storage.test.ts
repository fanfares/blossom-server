/**
 * Unit/integration coverage for paid annual storage accounting.
 *
 * Verifies purchase quote reuse, idempotent grant crediting, owner-based usage,
 * and atomic upload reservations that prevent concurrent quota oversubscription.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import { insertBlob } from "../../src/db/blobs.ts";
import {
  getStorageQuotaSummary,
  reserveStorageQuota,
} from "../../src/db/paid-storage.ts";
import { PaidStorageService } from "../../src/paid-storage/service.ts";
import type {
  LightningQuoteProvider,
  LightningQuoteState,
} from "../../src/payments/cashu.ts";

class FakePayments implements LightningQuoteProvider {
  state: LightningQuoteState = "pending";
  createCalls = 0;

  createQuote(amountSats: number) {
    this.createCalls++;
    return Promise.resolve({
      providerQuoteId: `quote-${this.createCalls}`,
      invoice: `lnbc-${amountSats}`,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
  }

  checkQuote(): Promise<LightningQuoteState> {
    return Promise.resolve(this.state);
  }
}

Deno.test("paid storage credits purchases and reserves remaining quota atomically", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_paid_storage_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  try {
    const config = ConfigSchema.parse({
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

    const grantsBeforeExtension = await service.getActiveGrants(pubkey);
    const extension = await service.createExtensionPurchase(pubkey, 2);
    assertEquals(extension.purchaseType, "extension");
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
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});
