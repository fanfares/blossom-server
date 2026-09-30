import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import {
  getTreasuryDestination,
  listAdminPayments,
  setTreasuryDestination,
  validateTreasuryDestination,
} from "../../src/db/admin-payments.ts";
import {
  indexContentReports,
  parseContentReport,
  reportTargetUrl,
} from "../../src/admin/content-reports.ts";
import { countUsers, insertBlob, listAllUsers } from "../../src/db/blobs.ts";
import { pruneStorage } from "../../src/prune/prune.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { getActiveMint } from "../../src/db/storage-mints.ts";
import { getStorageQuotaSummary } from "../../src/db/paid-storage.ts";
import { PaidStorageService } from "../../src/paid-storage/service.ts";
import {
  ADMIN_SESSION_COOKIE,
  signAdminToken,
} from "../../src/admin/admin-auth.ts";
import { buildAdminRouter } from "../../src/routes/admin-router.tsx";

Deno.test({
  name:
    "admin operations preserve payout destinations, retain files, and review signed client reports",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir();
    const db = await initDb({ path: join(dir, "test.db") });
    const storage = new LocalStorage(join(dir, "blobs"));
    await storage.setup();
    const actor = "a".repeat(64);
    const buyer = "b".repeat(64);
    const config = ConfigSchema.parse({
      publicDomain: "localhost",
      mirror: { enabled: false },
      dashboard: {
        enabled: true,
        adminPubkeys: [actor],
        password: "admin-password",
        sessionSecret: "a-long-and-random-session-secret-1234",
        lookupRelays: [],
      },
      paidStorage: {
        approvedMintUrls: ["https://new.example/mint"],
        enabled: true,
        quotaBytesPerUnit: 1000,
        treasury: { enabled: true, lightningAddress: "old@example.com" },
      },
      storage: { rules: [{ type: "*", expiration: "never" }] },
    });
    let counter = 0;
    const amounts = new Map<string, number>();
    const provider = {
      createQuote(amountSats: number) {
        const id = `quote-${++counter}`;
        amounts.set(id, amountSats);
        return Promise.resolve({
          providerQuoteId: id,
          invoice: "test-invoice",
          amountSats,
          unit: "sat",
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        });
      },
      checkQuote(id: string) {
        return Promise.resolve({
          state: "paid" as const,
          amountSats: amounts.get(id)!,
          unit: "sat",
        });
      },
    };
    // Keep payouts queued so both their immutable destination and safe dashboard output can be inspected.
    const treasury = {
      prepareClaim() {
        return Promise.reject(new Error("test mint unavailable"));
      },
      completeClaim() {
        return Promise.resolve("[]");
      },
      preparePayout() {
        return Promise.resolve({
          meltPreviewJson: "{}",
          forwardedAmountSats: 1,
          feeReserveSats: 0,
        });
      },
      completePayout() {
        return Promise.resolve({
          paid: true,
          changeProofsJson: "[]",
          paymentPreimage: "secret",
        });
      },
      isPayoutTerminallyFailed() {
        return Promise.resolve(false);
      },
    };
    try {
      assertThrows(() => validateTreasuryDestination("bad\n@example.com"));
      await assertRejects(() =>
        setTreasuryDestination(db, "new@example.com", "fake", "old@example.com")
      );
      const service = new PaidStorageService(
        db,
        config.paidStorage,
        provider,
        treasury,
      );
      const first = await service.getOrCreatePurchase(buyer, 1);
      await service.refreshPurchase(first.id, buyer);
      await setTreasuryDestination(
        db,
        "new@example.com",
        actor,
        "old@example.com",
      );
      assertEquals(
        await getTreasuryDestination(db, "old@example.com"),
        "new@example.com",
      );
      const second = await service.getOrCreatePurchase(buyer, 2);
      await service.refreshPurchase(second.id, buyer);
      const transfers = await db.execute(
        "SELECT destination FROM storage_treasury_transfers ORDER BY gross_amount_sats",
      );
      assertEquals(transfers.rows.map((row) => row[0]), [
        "old@example.com",
        "new@example.com",
      ]);
      const data = await listAdminPayments(db, 1, buyer);
      assertEquals(data.total, 2);
      assertEquals(
        (await getStorageQuotaSummary(db, buyer, Math.floor(Date.now() / 1000)))
          .availableBytes,
        3000,
      );
      assertEquals(data.rows[0].proofs_json, undefined);
      assertEquals(data.rows[0].payment_preimage, undefined);
      assertEquals(await countUsers(db), 1);
      assertEquals((await listAllUsers(db))[0].pubkey, buyer);
      const blob = "c".repeat(64);
      await insertBlob(db, {
        sha256: blob,
        size: 100,
        type: "image/png",
        uploaded: 1,
      }, buyer);
      const retained = await pruneStorage(
        db,
        storage,
        config.storage.rules,
        false,
      );
      assertEquals(retained.deleted, 0);
      assertEquals(
        (await db.execute("SELECT COUNT(*) FROM blobs")).rows[0][0],
        1,
      );

      const report = JSON.parse(JSON.stringify(finalizeEvent({
        kind: 1984,
        created_at: Math.floor(Date.now() / 1000),
        content: "Reported from the Fanfares modal",
        tags: [["e", blob, "spam"], ["a", `31337:${buyer}:track`, "spam"], [
          "p",
          buyer,
          "spam",
        ]],
      }, generateSecretKey())));
      assertEquals(parseContentReport(report).length, 3);
      assertEquals(
        parseContentReport({ ...report, content: "forged" }).length,
        0,
      );
      assertStringIncludes(
        reportTargetUrl(
          parseContentReport(report)[1],
          "staging.blossom.fanfares.live",
        ),
        "https://staging.fanfares.io/e/naddr",
      );
      assertEquals(await indexContentReports(db, [report]), 1);
      await db.execute({
        sql:
          "UPDATE admin_content_reports SET status = 'reviewed' WHERE event_id = ?",
        args: [report.id],
      });
      assertEquals(await indexContentReports(db, [report]), 0);
      assertEquals(
        (await db.execute("SELECT status FROM admin_content_reports"))
          .rows[0][0],
        "reviewed",
      );

      const app = buildAdminRouter(db, storage, config);
      const token = await signAdminToken({
        purpose: "session",
        pubkey: actor,
        exp: Math.floor(Date.now() / 1000) + 600,
      }, config.dashboard.sessionSecret);
      const headers = {
        cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
        origin: "http://localhost",
      };
      const unauthorized = await app.request("http://localhost/payments");
      assertEquals(unauthorized.status, 303);
      const payments = await app.request("http://localhost/payments", {
        headers,
      });
      assertEquals(payments.status, 200);
      assertStringIncludes(await payments.text(), "new@example.com");
      const user = await app.request(`http://localhost/users/${buyer}`, {
        headers,
      });
      assertEquals(user.status, 200);
      assertStringIncludes(await user.text(), "Available for uploads");
      const reports = await app.request(
        "http://localhost/reports?status=reviewed",
        { headers },
      );
      assertStringIncludes(
        await reports.text(),
        "Reported from the Fanfares modal",
      );
      const csrf = await app.request("http://localhost/payments/destination", {
        method: "POST",
        headers: { ...headers, origin: "https://attacker.example" },
        body: new URLSearchParams({
          password: "admin-password",
          destination: "attacker@example.com",
        }),
      });
      assertEquals(csrf.status, 403);
      const wrongPassword = await app.request(
        "http://localhost/payments/destination",
        {
          method: "POST",
          headers,
          body: new URLSearchParams({
            password: "wrong",
            destination: "attacker@example.com",
          }),
        },
      );
      assertEquals(wrongPassword.status, 403);
      assertEquals(
        await getTreasuryDestination(db, "old@example.com"),
        "new@example.com",
      );
      const rejectedMint = await app.request(
        "http://localhost/payments/destination",
        {
          method: "POST",
          headers,
          body: new URLSearchParams({
            password: "admin-password",
            destination: "attacker@example.com",
            mintUrl: "https://unapproved.example",
          }),
        },
      );
      assertEquals(rejectedMint.status, 400);
      assertEquals(
        await getTreasuryDestination(db, "old@example.com"),
        "new@example.com",
      );
      const change = await app.request(
        "http://localhost/payments/destination",
        {
          method: "POST",
          headers,
          body: new URLSearchParams({
            password: "admin-password",
            destination: "last@example.com",
            mintUrl: "https://new.example/mint",
          }),
        },
      );
      assertEquals(change.status, 303);
      assertEquals(
        await getTreasuryDestination(db, "old@example.com"),
        "last@example.com",
      );
      assertEquals(
        await getActiveMint(db, config.paidStorage.cashu.mintUrl),
        "https://new.example/mint",
      );
      const persisted = await initDb({ path: join(dir, "test.db") });
      assertEquals(
        await getTreasuryDestination(persisted, "old@example.com"),
        "last@example.com",
      );
      assertEquals(
        (await persisted.execute(
          "SELECT previous_destination FROM admin_treasury_audit ORDER BY id DESC LIMIT 1",
        )).rows[0][0],
        "new@example.com",
      );
      persisted.close();
      await db.execute("UPDATE storage_grants SET expires_at = 1");
      const expiredQuota = await getStorageQuotaSummary(
        db,
        buyer,
        Math.floor(Date.now() / 1000),
      );
      assertEquals(expiredQuota.quotaBytes, 0);
      assertEquals(expiredQuota.usedBytes, 100);
      assertEquals(expiredQuota.availableBytes, 0);
      assertEquals(
        (await pruneStorage(db, storage, config.storage.rules, false)).deleted,
        0,
      );
      const reopen = await app.request(
        `http://localhost/reports/${report.id}/review`,
        {
          method: "POST",
          headers,
          body: new URLSearchParams({ status: "open" }),
        },
      );
      assertEquals(reopen.status, 303);
      assertEquals(
        (await db.execute("SELECT status FROM admin_content_reports"))
          .rows[0][0],
        "open",
      );
    } finally {
      // Allow the immediate retry task to release its database lease before closing.
      await new Promise((resolve) => setTimeout(resolve, 50));
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
