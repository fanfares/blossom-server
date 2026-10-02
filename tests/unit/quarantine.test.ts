import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { initDb } from "../../src/db/client.ts";
import {
  countOwners,
  deleteBlob,
  insertBlob,
  removeOwner,
} from "../../src/db/blobs.ts";
import {
  isQuarantined,
  quarantineTargets,
  setQuarantine,
} from "../../src/db/quarantine.ts";
import { getStorageQuotaSummary } from "../../src/db/paid-storage.ts";
import { buildDeleteRouter } from "../../src/routes/delete.ts";
import { buildBlobsRouter } from "../../src/routes/blobs.ts";
import { buildAdminRouter } from "../../src/routes/admin-router.tsx";
import { ConfigSchema } from "../../src/config/schema.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { pruneStorage } from "../../src/prune/prune.ts";
import {
  ADMIN_SESSION_COOKIE,
  signAdminToken,
} from "../../src/admin/admin-auth.ts";

Deno.test("quarantine blocks every read variant, preserves ownership and bytes, audits restoration and requires admin origin", async () => {
  const dir = await Deno.makeTempDir();
  const db = await initDb({ path: join(dir, "test.db") });
  const hash = "a".repeat(64), user = "b".repeat(64), actor = "c".repeat(64);
  const storage = new LocalStorage(join(dir, "blobs"));
  await storage.setup();
  const config = ConfigSchema.parse({
    publicDomain: "localhost",
    dashboard: {
      enabled: true,
      adminPubkeys: [actor],
      password: "test-password",
      sessionSecret: "long-session-secret-for-quarantine-test",
      lookupRelays: [],
    },
  });
  try {
    await insertBlob(db, {
      sha256: hash,
      size: 3,
      type: "text/plain",
      uploaded: 1,
    }, user);
    await Deno.writeFile(
      join(dir, "blobs", `${hash}.txt`),
      new Uint8Array([1, 2, 3]),
    );
    const app = buildBlobsRouter(db, storage, config);
    assertEquals(
      (await app.fetch(
        new Request(`http://localhost/${hash}.txt`, { method: "HEAD" }),
      )).status,
      200,
    );
    const admin = buildAdminRouter(db, storage, config);
    const token = await signAdminToken({
      purpose: "session",
      pubkey: actor,
      exp: Math.floor(Date.now() / 1000) + 600,
    }, config.dashboard.sessionSecret);
    const body = () =>
      new URLSearchParams({
        scope: "file",
        id: hash,
        selection: hash,
        action: "quarantine",
        reason: "Review pending",
      });
    assertEquals(
      (await admin.fetch(
        new Request("http://localhost/quarantine", {
          method: "POST",
          body: body(),
        }),
      )).status,
      303,
    );
    assertEquals(await isQuarantined(db, hash), false);
    const headers = {
      cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
      origin: "https://attacker.example",
    };
    assertEquals(
      (await admin.fetch(
        new Request("http://localhost/quarantine", {
          method: "POST",
          headers,
          body: body(),
        }),
      )).status,
      403,
    );
    headers.origin = "http://localhost";
    assertEquals(
      (await admin.fetch(
        new Request("http://localhost/quarantine", {
          method: "POST",
          headers,
          body: body(),
        }),
      )).status,
      303,
    );
    assertEquals(await isQuarantined(db, hash), true);
    for (const method of ["GET", "HEAD"]) {
      for (const suffix of ["", ".txt", ".jpg"]) {
        const res = await app.fetch(
          new Request(`http://localhost/${hash}${suffix}`, {
            method,
            headers: { range: "bytes=0-1", "if-none-match": `"${hash}"` },
          }),
        );
        assertEquals(res.status, 404);
        assertEquals(res.headers.get("cache-control"), "no-store");
      }
    }
    const deleting = buildDeleteRouter(
      db,
      storage,
      ConfigSchema.parse({ delete: { requireAuth: false } }),
    );
    assertEquals(
      (await deleting.fetch(
        new Request(`http://localhost/${hash}`, { method: "DELETE" }),
      )).status,
      403,
    );
    assertEquals(await deleteBlob(db, hash), false);
    assertEquals(await removeOwner(db, hash, user), false);
    assertEquals(await countOwners(db, hash), 1);
    assertEquals(
      (await pruneStorage(
        db,
        storage,
        [{ type: "*", expiration: "1 second" }],
        true,
      )).deleted,
      0,
    );
    assertEquals(await storage.has(hash, "txt"), true);
    assertEquals(
      (await getStorageQuotaSummary(db, user, Math.floor(Date.now() / 1000)))
        .usedBytes,
      0,
    );
    assertEquals(await quarantineTargets(db, "user", user), [hash]);
    const eventId = "d".repeat(64);
    await db.execute({
      sql:
        "INSERT INTO admin_events(event_id,pubkey,kind,created_at,indexed_at) VALUES(?,?,1,1,1)",
      args: [eventId, user],
    });
    await db.execute({
      sql:
        "INSERT INTO admin_event_blobs(event_id,blob,encrypted) VALUES(?,?,0)",
      args: [eventId, hash],
    });
    assertEquals(await quarantineTargets(db, "event", eventId), [hash]);
    const staleBody = body();
    staleBody.set("selection", "e".repeat(64));
    assertEquals(
      (await admin.fetch(
        new Request("http://localhost/quarantine", {
          method: "POST",
          headers,
          body: staleBody,
        }),
      )).status,
      409,
    );

    const detail = await admin.fetch(
      new Request(`http://localhost/blobs/${hash}`, { headers }),
    );
    const html = await detail.text();
    assertStringIncludes(html, "Preview disabled while quarantined");
    assertStringIncludes(html, "Review pending");
    await setQuarantine(db, [hash], false, actor, "Mistaken block");
    assertEquals(
      (await app.fetch(
        new Request(`http://localhost/${hash}.txt`, { method: "HEAD" }),
      )).status,
      200,
    );
    assertEquals(
      Number(
        (await db.execute(
          "SELECT COUNT(*) AS total FROM blob_quarantine_audit",
        )).rows[0].total,
      ),
      2,
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
