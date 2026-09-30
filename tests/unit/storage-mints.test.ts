import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import {
  getActiveMint,
  getPurchaseMint,
  setActiveMint,
} from "../../src/db/storage-mints.ts";
import {
  getTreasuryDestination,
  setTreasuryDestination,
} from "../../src/db/admin-payments.ts";
import { PaidStorageService } from "../../src/paid-storage/service.ts";
import type { LightningQuoteProvider } from "../../src/payments/cashu.ts";
import type { TreasuryForwarder } from "../../src/payments/treasury.ts";

Deno.test({
  name:
    "mint changes preserve old invoices and treasury funds, persist, and reject unapproved settings atomically",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir();
    const db = await initDb({ path: join(dir, "db") });
    const oldMint = "https://old.example/mint",
      newMint = "https://new.example/mint",
      actor = "a".repeat(64),
      buyer = "b".repeat(64);
    const config = ConfigSchema.parse({
      mirror: { enabled: false },
      paidStorage: {
        enabled: true,
        cashu: { mintUrl: oldMint },
        approvedMintUrls: [newMint],
        treasury: { enabled: true, lightningAddress: "wallet@example.com" },
      },
    });
    const checks: string[] = [], payouts: string[] = [];
    let quote = 0;
    const quotes = new Map<string, number>();
    const factories = {
      payments: (mint: string): LightningQuoteProvider => ({
        createQuote(amountSats) {
          const id = `${++quote}`;
          quotes.set(id, amountSats);
          return Promise.resolve({
            providerQuoteId: id,
            invoice: "test",
            expiresAt: Math.floor(Date.now() / 1000) + 600,
            amountSats,
            unit: "sat",
          });
        },
        checkQuote(id) {
          checks.push(mint);
          return Promise.resolve({
            state: "paid",
            amountSats: quotes.get(id)!,
            unit: "sat",
          });
        },
      }),
      treasury: (mint: string): TreasuryForwarder => ({
        prepareClaim() {
          payouts.push(mint);
          return Promise.resolve("{}");
        },
        completeClaim() {
          return Promise.resolve("[]");
        },
        preparePayout() {
          return Promise.resolve({
            meltPreviewJson: "{}",
            forwardedAmountSats: 1,
            feeReserveSats: 1,
          });
        },
        completePayout() {
          return Promise.resolve({
            paid: true,
            changeProofsJson: "[]",
            paymentPreimage: null,
          });
        },
        isPayoutTerminallyFailed() {
          return Promise.resolve(false);
        },
      }),
    };
    try {
      const service = new PaidStorageService(
        db,
        config.paidStorage,
        undefined,
        undefined,
        factories,
      );
      const first = await service.getOrCreatePurchase(buyer, 1);
      assertEquals(first.mintUrl, oldMint);
      // Simulate an invoice from before the mint-snapshot migration.
      await db.execute({
        sql: "DELETE FROM storage_purchase_mints WHERE purchase_id=?",
        args: [first.id],
      });
      await setActiveMint(db, newMint, actor, oldMint, [newMint]);
      assertEquals(await getPurchaseMint(db, first.id, oldMint), oldMint);
      assertEquals((await service.getOrCreatePurchase(buyer, 1)).id, first.id);
      const second = await service.getOrCreatePurchase(buyer, 2);
      assertEquals(second.mintUrl, newMint);
      await service.refreshPurchase(first.id, buyer);
      await service.refreshPurchase(second.id, buyer);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assertEquals(checks, [oldMint, newMint]);
      assertEquals(payouts.sort(), [newMint, oldMint].sort());
      await assertRejects(() =>
        setTreasuryDestination(
          db,
          "attacker@example.com",
          actor,
          "wallet@example.com",
          {
            url: "https://unapproved.example",
            configured: oldMint,
            approved: [newMint],
          },
        )
      );
      assertEquals(
        await getTreasuryDestination(db, "wallet@example.com"),
        "wallet@example.com",
      );
      assertEquals(
        (await db.execute("SELECT COUNT(*) FROM admin_treasury_audit"))
          .rows[0][0],
        0,
      );
      const restarted = await initDb({ path: join(dir, "db") });
      assertEquals(await getActiveMint(restarted, oldMint), newMint);
      restarted.close();
      // Removing a mint from approval stops new quotes, but historical receipts remain valid.
      const restricted = new PaidStorageService(
        db,
        { ...config.paidStorage, approvedMintUrls: [] },
        undefined,
        undefined,
        factories,
      );
      await assertRejects(() =>
        restricted.getOrCreatePurchase("c".repeat(64), 1)
      );
    } finally {
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
