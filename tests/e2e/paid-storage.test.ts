/**
 * E2E coverage for the paid annual storage extension and upload quota gate.
 *
 * Uses real Hono routes, BUD-11 signatures, libSQL, LocalStorage, and upload
 * workers while replacing only the external Cashu mint with a deterministic
 * quote provider.
 */

import { assertEquals } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { join } from "@std/path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import type {
  LightningQuoteProvider,
  LightningQuoteState,
} from "../../src/payments/cashu.ts";
import { buildApp } from "../../src/server.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { initPool } from "../../src/workers/pool.ts";

const secretKey = generateSecretKey();

class FakePayments implements LightningQuoteProvider {
  state: LightningQuoteState = "pending";
  createCalls = 0;
  amounts = new Map<string, number>();

  createQuote(amountSats: number) {
    this.createCalls++;
    const providerQuoteId = `paid-storage-e2e-quote-${this.createCalls}`;
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

function authorization(verb: "upload" | "storage"): string {
  const now = Math.floor(Date.now() / 1000);
  const event: NostrEvent = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      tags: [["t", verb], ["expiration", String(now + 600)]],
      content: `Authorize ${verb}`,
    },
    secretKey,
  );
  return `Nostr ${
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(event)))
  }`;
}

Deno.test({
  name: "paid storage purchase credits quota and unlocks uploads",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "blossom_paid_e2e_" });
    const dbConfig = { path: join(tmpDir, "test.db") };
    const db = await initDb(dbConfig);
    const storage = new LocalStorage(join(tmpDir, "blobs"));
    await storage.setup();
    const pool = initPool(1, 4, 500, db, dbConfig);
    const payments = new FakePayments();
    const config = ConfigSchema.parse({
      publicDomain: "localhost",
      landing: { enabled: false },
      mirror: { enabled: false },
      storage: { rules: [{ type: "*", expiration: "1 year" }] },
      upload: { enabled: true, requireAuth: true },
      paidStorage: {
        enabled: true,
        quotaBytesPerUnit: 1000,
        durationDays: 365,
        priceSats: 25,
      },
    });
    const app = await buildApp(db, storage, config, {
      paymentProvider: payments,
    });

    try {
      const blocked = await app.fetch(
        new Request("http://localhost/upload", {
          method: "HEAD",
          headers: {
            Authorization: authorization("upload"),
            "X-Content-Length": "5",
            "X-Content-Type": "text/plain",
          },
        }),
      );
      assertEquals(blocked.status, 402);
      assertEquals(blocked.headers.get("X-Lightning"), "lnbc-25");
      const purchaseId = blocked.headers.get("X-Storage-Payment-Id") ?? "";

      payments.state = "paid";
      const settled = await app.fetch(
        new Request(`http://localhost/storage/purchases/${purchaseId}`, {
          headers: { Authorization: authorization("storage") },
        }),
      );
      assertEquals(settled.status, 200);
      assertEquals((await settled.json()).state, "paid");

      const body = new TextEncoder().encode("hello");
      const uploaded = await app.fetch(
        new Request("http://localhost/upload", {
          method: "PUT",
          headers: {
            Authorization: authorization("upload"),
            "Content-Length": String(body.byteLength),
            "Content-Type": "text/plain",
          },
          body,
        }),
      );
      assertEquals(uploaded.status, 201);

      const account = await app.fetch(
        new Request("http://localhost/storage/account", {
          headers: { Authorization: authorization("storage") },
        }),
      );
      const accountBody = await account.json();
      assertEquals(accountBody.quota.usedBytes, 5);
      assertEquals(accountBody.quota.availableBytes, 995);
      assertEquals(accountBody.files.length, 1);
      assertEquals(accountBody.grants.length, 1);

      const originalExpiry = accountBody.grants[0].expiresAt;
      const extension = await app.fetch(
        new Request("http://localhost/storage/purchases", {
          method: "POST",
          headers: {
            Authorization: authorization("storage"),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            purchaseType: "extension",
            durationYears: 2,
          }),
        }),
      );
      assertEquals(extension.status, 201);
      const extensionBody = await extension.json();
      assertEquals(extensionBody.purchaseType, "extension");
      assertEquals(extensionBody.durationYears, 2);
      assertEquals(extensionBody.amountSats, 50);

      const recovered = await app.fetch(
        new Request("http://localhost/storage/purchases", {
          headers: { Authorization: authorization("storage") },
        }),
      );
      assertEquals(recovered.status, 200);
      const recoveredBody = await recovered.json();
      assertEquals(recoveredBody[0].id, extensionBody.id);

      const extensionSettled = await app.fetch(
        new Request(
          `http://localhost/storage/purchases/${extensionBody.id}`,
          { headers: { Authorization: authorization("storage") } },
        ),
      );
      assertEquals(extensionSettled.status, 200);

      const extendedAccount = await app.fetch(
        new Request("http://localhost/storage/account", {
          headers: { Authorization: authorization("storage") },
        }),
      );
      const extendedAccountBody = await extendedAccount.json();
      assertEquals(
        extendedAccountBody.grants[0].expiresAt,
        originalExpiry + 2 * 365 * 24 * 60 * 60,
      );

      const alignmentPreview = await app.fetch(
        new Request("http://localhost/storage/purchases/preview", {
          method: "POST",
          headers: {
            Authorization: authorization("storage"),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            storageUnits: 1,
            durationYears: 1,
            alignExpiry: true,
          }),
        }),
      );
      assertEquals(alignmentPreview.status, 200);
      const alignmentPreviewBody = await alignmentPreview.json();
      assertEquals(alignmentPreviewBody.alignExpiry, true);
      assertEquals(alignmentPreviewBody.baseAmountSats, 25);
      assertEquals(alignmentPreviewBody.alignmentAmountSats, 50);
      assertEquals(alignmentPreviewBody.amountSats, 75);

      const aligned = await app.fetch(
        new Request("http://localhost/storage/purchases", {
          method: "POST",
          headers: {
            Authorization: authorization("storage"),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            purchaseType: "new",
            storageUnits: 1,
            durationYears: 1,
            alignExpiry: true,
          }),
        }),
      );
      assertEquals(aligned.status, 201);
      const alignedBody = await aligned.json();
      assertEquals(alignedBody.alignExpiry, true);
      assertEquals(alignedBody.amountSats, 75);

      const alignedSettled = await app.fetch(
        new Request(
          `http://localhost/storage/purchases/${alignedBody.id}`,
          { headers: { Authorization: authorization("storage") } },
        ),
      );
      assertEquals(alignedSettled.status, 200);
      const alignedAccount = await app.fetch(
        new Request("http://localhost/storage/account", {
          headers: { Authorization: authorization("storage") },
        }),
      );
      const alignedAccountBody = await alignedAccount.json();
      assertEquals(alignedAccountBody.grants.length, 2);
      assertEquals(
        alignedAccountBody.grants.map((grant: { expiresAt: number }) =>
          grant.expiresAt
        ),
        [
          extendedAccountBody.grants[0].expiresAt,
          extendedAccountBody.grants[0].expiresAt,
        ],
      );
    } finally {
      pool.shutdown();
      db.close();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
