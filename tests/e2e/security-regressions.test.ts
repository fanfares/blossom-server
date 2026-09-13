import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { encodeBase64Url } from "@std/encoding/base64url";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import { insertBlob, isOwner } from "../../src/db/blobs.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { buildApp } from "../../src/server.ts";
import { withBlobMutationLock } from "../../src/utils/blob-mutation-lock.ts";

Deno.test("active document isolation covers aliases, fallback, HEAD, range, and conditional responses", async () => {
  const dir = await Deno.makeTempDir();
  const db = await initDb({ path: join(dir, "db") });
  const storage = new LocalStorage(join(dir, "blobs"));
  await storage.setup();
  try {
    const hash = "a".repeat(64);
    await Deno.writeTextFile(
      join(storage.dir, hash + ".html"),
      "<script>alert(1)</script>",
    );
    await insertBlob(db, {
      sha256: hash,
      type: "text/html",
      size: 25,
      uploaded: 1,
    }, "b".repeat(64));
    const app = await buildApp(db, storage, ConfigSchema.parse({}));
    const requests: RequestInit[] = [
      {},
      { method: "HEAD" },
      { headers: { Range: "bytes=0-3" } },
      { headers: { "If-None-Match": '"' + hash + '"' } },
    ];
    for (const path of [hash, hash + ".html", hash + ".svg"]) {
      for (const init of requests) {
        const res = await app.request("http://localhost/" + path, init);
        assertEquals(res.headers.get("x-content-type-options"), "nosniff");
        assertEquals(
          res.headers.get("content-security-policy")?.includes("sandbox"),
          true,
        );
        assertEquals(
          res.headers.get("content-disposition")?.startsWith("attachment"),
          true,
        );
        await res.body?.cancel();
      }
    }
    await db.execute("DELETE FROM blobs");
    const fallback = await app.request("http://localhost/" + hash + ".html");
    assertEquals(fallback.status, 200);
    assertEquals(
      fallback.headers.get("content-security-policy")?.includes("sandbox"),
      true,
    );
    await fallback.body?.cancel();
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("last-owner DELETE waits for concurrent hash mutation and preserves the new owner", async () => {
  const dir = await Deno.makeTempDir();
  const db = await initDb({ path: join(dir, "db") });
  const storage = new LocalStorage(join(dir, "blobs"));
  await storage.setup();
  try {
    const hash = "c".repeat(64);
    const secret = generateSecretKey();
    const owner = getPublicKey(secret);
    const newOwner = "d".repeat(64);
    const blob = { sha256: hash, type: "text/plain", size: 3, uploaded: 1 };
    await Deno.writeTextFile(join(storage.dir, hash + ".txt"), "abc");
    await insertBlob(db, blob, owner);
    const app = await buildApp(db, storage, ConfigSchema.parse({}));
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent({
      kind: 24242,
      created_at: now,
      content: "",
      tags: [["t", "delete"], ["expiration", String(now + 600)], ["x", hash]],
    }, secret);
    let completed = false;
    let deletion!: Promise<Response>;
    await withBlobMutationLock(hash, async () => {
      deletion = Promise.resolve(app.request("http://localhost/" + hash, {
        method: "DELETE",
        headers: {
          Authorization: "Nostr " +
            encodeBase64Url(new TextEncoder().encode(JSON.stringify(event))),
        },
      })).then((res) => {
        completed = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assertEquals(
        completed,
        false,
        "Deletion must wait for the same hash lock as upload",
      );
      await insertBlob(db, blob, newOwner);
    });
    assertEquals((await deletion).status, 204);
    assertEquals(await isOwner(db, hash, newOwner), true);
    const res = await app.request("http://localhost/" + hash);
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "abc");
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    "legacy admin mutations reject absent or foreign Origin and accept the configured local origin",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const db = await initDb({ path: join(dir, "db") });
    const storage = new LocalStorage(join(dir, "blobs"));
    await storage.setup();
    try {
      const config = ConfigSchema.parse({
        publicDomain: "http://localhost:3000",
        dashboard: {
          enabled: true,
          username: "admin",
          password: "test-password",
          lookupRelays: [],
        },
      });
      const app = await buildApp(db, storage, config);
      const Authorization = "Basic " + btoa("admin:test-password");
      for (const origin of [undefined, "https://attacker.example"]) {
        const res = await app.request(
          "http://localhost:3000/admin/api/reports/1/dismiss",
          {
            method: "POST",
            headers: { Authorization, ...(origin ? { Origin: origin } : {}) },
          },
        );
        assertEquals(res.status, 403);
        await res.body?.cancel();
      }
      const valid = await app.request(
        "http://localhost:3000/admin/api/reports/1/dismiss",
        {
          method: "POST",
          headers: { Authorization, Origin: "http://localhost:3000" },
        },
      );
      assertEquals(
        valid.status,
        404,
        "Valid same-origin request reaches the missing-report handler",
      );
      assertEquals(valid.headers.get("cache-control"), "no-store");
      await valid.body?.cancel();
    } finally {
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
