import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { initDb } from "../../src/db/client.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import { PaidStorageService } from "../../src/paid-storage/service.ts";
import type { LightningQuoteProvider } from "../../src/payments/cashu.ts";
import {
  claimTreasuryTransfer,
  completeTreasuryTransfer,
  saveTreasuryClaim,
} from "../../src/db/treasury.ts";
import { insertBlob } from "../../src/db/blobs.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import {
  deleteStoredBlob,
  isBlobDeleted,
  retryBlobDeletions,
} from "../../src/storage/deletion.ts";
import { withBlobMutationLock } from "../../src/utils/blob-mutation-lock.ts";
import { buildApp } from "../../src/server.ts";

Deno.test("concurrent checkout across service instances enforces cap and reuses identical selections", async () => {
  const dir = await Deno.makeTempDir();
  const db = await initDb({ path: join(dir, "test.db") });
  try {
    let calls = 0;
    const payments: LightningQuoteProvider = {
      async createQuote(amountSats) {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          providerQuoteId: "q" + calls,
          invoice: "lnbc",
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          amountSats,
          unit: "sat",
        };
      },
      checkQuote: () =>
        Promise.resolve({ state: "pending", amountSats: 0, unit: "sat" }),
    };
    const config = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: { enabled: true, quotaBytesPerUnit: 1000, priceSats: 20 },
    });
    const services = [
      new PaidStorageService(db, config.paidStorage, payments),
      new PaidStorageService(db, config.paidStorage, payments),
    ];
    const buyer = "a".repeat(64);
    const results = await Promise.allSettled(
      Array.from(
        { length: 15 },
        (_, index) => services[index % 2].getOrCreatePurchase(buyer, index + 1),
      ),
    );
    assertEquals(
      results.filter((result) => result.status === "fulfilled").length,
      10,
    );
    assertEquals(calls, 10);
    assertEquals(
      Number(
        (await db.execute("SELECT COUNT(*) FROM storage_purchases")).rows[0][0],
      ),
      10,
    );
    const repeats = await Promise.all(
      services.map((service) => service.getOrCreatePurchase(buyer, 1)),
    );
    assertEquals(repeats[0].id, repeats[1].id);
    assertEquals(calls, 10);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("expired and superseded treasury workers cannot persist or complete", async () => {
  const dir = await Deno.makeTempDir();
  const db = await initDb({ path: join(dir, "test.db") });
  try {
    // Outbox fixtures must reference a purchase; use a real checkout.
    const config = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: { enabled: true, priceSats: 20 },
    });
    const provider: LightningQuoteProvider = {
      createQuote: (amountSats) =>
        Promise.resolve({
          providerQuoteId: "q",
          invoice: "lnbc",
          expiresAt: 9999999999,
          amountSats,
          unit: "sat",
        }),
      checkQuote: () =>
        Promise.resolve({ state: "pending", amountSats: 20, unit: "sat" }),
    };
    const purchase = await new PaidStorageService(
      db,
      config.paidStorage,
      provider,
    ).getOrCreatePurchase("b".repeat(64), 1);
    await db.execute({
      sql:
        "INSERT INTO storage_treasury_transfers (purchase_id, destination, gross_amount_sats, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: [purchase.id, "t@example.com", 20, 100, 100],
    });
    const first = (await claimTreasuryTransfer(db, purchase.id, 100, 10))!;
    await assertRejects(
      () =>
        saveTreasuryClaim(
          db,
          purchase.id,
          110,
          { proofsJson: "old" },
          first.leaseToken,
        ),
      Error,
      "lease lost",
    );
    const second = (await claimTreasuryTransfer(db, purchase.id, 110, 10))!;
    await assertRejects(
      () =>
        completeTreasuryTransfer(
          db,
          purchase.id,
          111,
          "[]",
          null,
          first.leaseToken,
        ),
      Error,
      "lease lost",
    );
    await saveTreasuryClaim(
      db,
      purchase.id,
      111,
      { proofsJson: "new" },
      second.leaseToken,
    );
    assertEquals(
      String(
        (await db.execute("SELECT proofs_json FROM storage_treasury_transfers"))
          .rows[0][0],
      ),
      "new",
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failed physical deletion stays hidden through metadata fallback and retry; reupload clears tombstone", async () => {
  const dir = await Deno.makeTempDir();
  const db = await initDb({ path: join(dir, "test.db") });
  const storage = new LocalStorage(join(dir, "blobs"));
  await storage.setup();
  try {
    const hash = "c".repeat(64);
    await Deno.writeTextFile(
      join(storage.dir, hash + ".html"),
      "<script>alert(1)</script>",
    );
    await insertBlob(db, {
      sha256: hash,
      type: "text/html",
      size: 25,
      uploaded: 1,
    }, "a".repeat(64));
    const originalRemove = storage.remove.bind(storage);
    storage.remove = () => Promise.resolve(false);
    await assertRejects(() =>
      withBlobMutationLock(
        hash,
        () => deleteStoredBlob(db, storage, hash, "html"),
      )
    );
    const app = await buildApp(db, storage, ConfigSchema.parse({}));
    for (const path of [hash, hash + ".html", hash + ".svg"]) {
      const response = await app.request("http://localhost/" + path);
      assertEquals(response.status, 404);
      await response.body?.cancel();
    }
    storage.remove = originalRemove;
    await retryBlobDeletions(db, storage);
    assertEquals(await storage.has(hash, "html"), false);
    assertEquals(await isBlobDeleted(db, hash), true);
    await insertBlob(db, {
      sha256: hash,
      type: "text/html",
      size: 25,
      uploaded: 1,
    }, "a".repeat(64));
    assertEquals(await isBlobDeleted(db, hash), false);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
