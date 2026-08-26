/**
 * @module paid-storage-persistence
 * @covers
 *   - A credited storage grant survives database and service restart
 *   - A later login with the same Nostr pubkey receives the original quota
 *   - Annual grants remain active after the reported multi-day return window
 * @dependencies local libSQL database, PaidStorageService, payment provider (fake)
 * @type integration | deno
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import { PaidStorageService } from "../../src/paid-storage/service.ts";
import type {
  LightningQuoteProvider,
  LightningQuoteState,
} from "../../src/payments/cashu.ts";

/**
 * Build a deterministic paid quote provider for restart-persistence coverage.
 * The test service invokes it before closing the first database connection and
 * reuses it only as an inert dependency after the persisted grant is reopened.
 */
function createSettledQuoteProvider(): LightningQuoteProvider {
  let state: LightningQuoteState = "pending";
  let amountSats = 0;
  return {
    /** Issue the one deterministic invoice used to create the persisted purchase. */
    createQuote(amount: number) {
      amountSats = amount;
      return Promise.resolve({
        providerQuoteId: "persistent-quote",
        invoice: `lnbc-${amount}`,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        amountSats: amount,
        unit: "sat",
      });
    },
    /** Report that invoice as paid so the first service credits its durable grant. */
    checkQuote() {
      state = "paid";
      return Promise.resolve({ state, amountSats, unit: "sat" });
    },
  };
}

Deno.test("credited storage remains available after a server restart and later login", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "blossom_paid_storage_persistence_",
  });
  const databasePath = join(tmpDir, "persistent.db");
  const pubkey = "a".repeat(64);
  const config = ConfigSchema.parse({
    mirror: { enabled: false },
    paidStorage: {
      enabled: true,
      quotaBytesPerUnit: 1024,
      durationDays: 365,
      priceSats: 20,
    },
  });
  const payments = createSettledQuoteProvider();
  const initialNowMs = Date.now();
  const originalDateNow = Date.now;
  let db = await initDb({ path: databasePath });

  try {
    const service = new PaidStorageService(db, config.paidStorage, payments);
    const purchase = await service.getOrCreatePurchase(pubkey, 2, 1);
    const settled = await service.refreshPurchase(purchase.id, pubkey);
    const originalQuota = await service.getQuota(pubkey);
    const originalGrants = await service.getActiveGrants(pubkey);

    assertEquals(settled?.state, "paid");
    assertEquals(originalQuota.quotaBytes, 2048);
    assertEquals(originalGrants.length, 1);
    assertEquals(
      originalGrants[0].expiresAt >
        Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60,
      true,
    );

    db.close();
    db = await initDb({ path: databasePath });
    Date.now = () => initialNowMs + 2 * 24 * 60 * 60 * 1000;
    const restartedService = new PaidStorageService(
      db,
      config.paidStorage,
      payments,
    );
    const restoredQuota = await restartedService.getQuota(pubkey);
    const restoredGrants = await restartedService.getActiveGrants(pubkey);

    assertEquals(restoredQuota, originalQuota);
    assertEquals(restoredGrants, originalGrants);
  } finally {
    Date.now = originalDateNow;
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});
