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

  createQuote(amountSats: number) {
    return Promise.resolve({
      providerQuoteId: "paid-storage-e2e-quote",
      invoice: `lnbc-${amountSats}`,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
  }

  checkQuote(): Promise<LightningQuoteState> {
    return Promise.resolve(this.state);
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
    } finally {
      pool.shutdown();
      db.close();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
