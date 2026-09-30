import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import {
  getStoragePurchase,
  insertStoragePurchase,
  type StoragePurchaseRecord,
} from "../../src/db/paid-storage.ts";
import { getPurchaseMint } from "../../src/db/storage-mints.ts";
import { PaidStorageService } from "../../src/paid-storage/service.ts";
import type { LightningQuoteProvider } from "../../src/payments/cashu.ts";

const OLD = "https://old.example/mint";
const NEW = "https://new.example/mint";
const BUYER = "b".repeat(64);

function purchase(
  id: string,
  createdAt: number,
  mintUrl?: string,
): StoragePurchaseRecord {
  return {
    id,
    pubkey: BUYER,
    units: 1,
    quotaBytes: 1000,
    durationSeconds: 86400,
    amountSats: 20,
    invoice: "test",
    providerQuoteId: id,
    state: "pending",
    invoiceExpires: Math.floor(Date.now() / 1000) + 3600,
    createdAt,
    paidAt: null,
    creditedAt: null,
    purchaseType: "new",
    alignedExpiresAt: null,
    baseAmountSats: 20,
    alignmentAmountSats: 0,
    mintUrl,
  };
}

function config(mintUrl: string, legacyMintUrl?: string) {
  return ConfigSchema.parse({
    mirror: { enabled: false },
    paidStorage: {
      enabled: true,
      cashu: { mintUrl, legacyMintUrl },
      approvedMintUrls: [OLD, NEW],
    },
  }).paidStorage;
}

Deno.test("failed old invoices do not starve later settlements across database restarts", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "db");
  let db = await initDb({ path });
  const checks: string[] = [];
  const factories = {
    payments: (mint: string): LightningQuoteProvider => ({
      createQuote() {
        throw new Error("unexpected quote creation");
      },
      checkQuote(id) {
        checks.push(id);
        if (mint === OLD) return Promise.reject(new Error("old mint offline"));
        return Promise.resolve({ state: "paid", amountSats: 20, unit: "sat" });
      },
    }),
    treasury: () => {
      throw new Error("treasury disabled");
    },
  };
  try {
    await insertStoragePurchase(db, purchase("old-1", 1, OLD));
    await insertStoragePurchase(db, purchase("old-2", 2, OLD));
    await insertStoragePurchase(db, purchase("new-3", 3, NEW));
    await new PaidStorageService(
      db,
      config(NEW),
      undefined,
      undefined,
      factories,
    ).processPendingPurchases(2);
    assertEquals(checks, ["old-1", "old-2"]);
    db.close();
    db = await initDb({ path });
    const restarted = new PaidStorageService(
      db,
      config(NEW),
      undefined,
      undefined,
      factories,
    );
    await restarted.processPendingPurchases(2);
    assertEquals(checks[2], "new-3");
    assertEquals((await getStoragePurchase(db, "new-3", BUYER))?.state, "paid");
    await restarted.refreshPurchase("new-3", BUYER);
    assertEquals(
      (await db.execute(
        "SELECT COUNT(*) FROM storage_grants WHERE purchase_id='new-3'",
      )).rows[0][0],
      1,
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("startup pins legacy invoices before configuration rotation and preserves newer snapshots", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "db");
  let db = await initDb({ path });
  const checks: string[] = [];
  const factories = {
    payments: (mint: string): LightningQuoteProvider => ({
      createQuote() {
        throw new Error("unexpected quote creation");
      },
      checkQuote() {
        checks.push(mint);
        return Promise.resolve({ state: "paid", amountSats: 20, unit: "sat" });
      },
    }),
    treasury: () => {
      throw new Error("treasury disabled");
    },
  };
  try {
    await insertStoragePurchase(db, purchase("legacy", 1));
    await insertStoragePurchase(db, purchase("pinned-new", 2, NEW));
    await new PaidStorageService(
      db,
      config(OLD),
      undefined,
      undefined,
      factories,
    ).initialize();
    assertEquals(await getPurchaseMint(db, "legacy", NEW), OLD);
    db.close();
    db = await initDb({ path });
    const service = new PaidStorageService(
      db,
      config(NEW),
      undefined,
      undefined,
      factories,
    );
    await service.initialize();
    assertEquals(await getPurchaseMint(db, "legacy", NEW), OLD);
    assertEquals(await getPurchaseMint(db, "pinned-new", OLD), NEW);
    await service.refreshPurchase("legacy", BUYER);
    assertEquals(checks, [OLD]);
    assertEquals(
      (await getStoragePurchase(db, "legacy", BUYER))?.state,
      "paid",
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("first upgrade can explicitly identify the legacy mint while configuring a new mint", async () => {
  const dir = await Deno.makeTempDir();
  const db = await initDb({ path: join(dir, "db") });
  try {
    await insertStoragePurchase(db, purchase("legacy", 1));
    const service = new PaidStorageService(db, config(NEW, OLD));
    await service.initialize();
    assertEquals(await getPurchaseMint(db, "legacy", NEW), OLD);
    assertEquals(
      (await db.execute("SELECT mint_url FROM storage_legacy_mint WHERE id=1"))
        .rows[0][0],
      OLD,
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
