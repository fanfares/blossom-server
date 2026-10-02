import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { initDb } from "../../src/db/client.ts";
import { insertBlob } from "../../src/db/blobs.ts";
import { isQuarantined, setQuarantine } from "../../src/db/quarantine.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import {
  imageCachePurgeStatus,
  imagePurgeSources,
  processImageCachePurges,
} from "../../src/admin/image-cache-purge.ts";

const hash = "a".repeat(64);
const config = ConfigSchema.parse({
  publicDomain: "staging.blossom.fanfares.live",
  blobDomain: "blobs.staging.blossom.fanfares.live",
  dashboard: {
    imageCachePurge: {
      enabled: true,
      token: "secret-test-only",
      project: "test-project",
      teamId: "test-team",
    },
  },
});

Deno.test("image purge excludes legacy CDN, foreign environments and credentials; retains observed exact aliases", () => {
  const exact = `https://staging.blossom.fanfares.live/${hash}.JPG?custom=1`;
  const sources = imagePurgeSources(hash, config, [
    exact,
    `https://staging.api.fanfares.live/cdn/${hash}.jpg`,
    `https://blossom.fanfares.live/${hash}.jpg`,
    `https://user:password@staging.blossom.fanfares.live/${hash}.jpg`,
  ]);
  assertEquals(sources.includes(exact), true);
  assertEquals(
    sources.every((source) =>
      !source.includes("/cdn/") && !source.includes("password")
    ),
    true,
  );
  assertEquals(
    sources.some((source) => new URL(source).host === "blossom.fanfares.live"),
    false,
  );
  assertEquals(imagePurgeSources("invalid", config, []), []);
});

Deno.test("durable image purge retries without unquarantining; targets project, ignores audio, and resists stale completion", async () => {
  const dir = await Deno.makeTempDir();
  const db = await initDb({ path: join(dir, "test.db") });
  try {
    await insertBlob(db, {
      sha256: hash,
      size: 1,
      type: "image/jpeg",
      uploaded: 1,
    }, "c".repeat(64));
    const audio = "b".repeat(64);
    await insertBlob(db, {
      sha256: audio,
      size: 1,
      type: "audio/mpeg",
      uploaded: 1,
    }, "c".repeat(64));
    await setQuarantine(
      db,
      [hash, audio],
      true,
      "c".repeat(64),
      "Test moderation",
    );
    assertEquals(
      (await db.execute("SELECT COUNT(*) AS n FROM image_cache_purge")).rows[0]
        .n,
      1,
    );
    const disabled = ConfigSchema.parse({ publicDomain: config.publicDomain });
    await processImageCachePurges(
      db,
      disabled,
      (() => {
        throw Error("must not call");
      }) as typeof fetch,
      100,
    );
    assertStringIncludes(
      await imageCachePurgeStatus(db, hash, disabled),
      "not configured",
    );
    let calls = 0;
    const failure = ((input: URL | RequestInfo, init?: RequestInit) => {
      calls++;
      assertStringIncludes(String(input), "projectIdOrName=test-project");
      assertStringIncludes(String(input), "teamId=test-team");
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        "Bearer secret-test-only",
      );
      assertEquals(Object.keys(JSON.parse(String(init?.body))), ["srcImages"]);
      return Promise.resolve(
        new Response("never store this secret", { status: 429 }),
      );
    }) as typeof fetch;
    await processImageCachePurges(db, config, failure, 100);
    assertEquals(await isQuarantined(db, hash), true);
    assertEquals(calls, 1);
    await processImageCachePurges(db, config, failure, 101);
    assertEquals(calls, 1);
    assertStringIncludes(
      await imageCachePurgeStatus(db, hash, config),
      "HTTP 429",
    );
    const success = (() => Promise.resolve(new Response("{}"))) as typeof fetch;
    await processImageCachePurges(db, config, success, 131);
    assertStringIncludes(
      await imageCachePurgeStatus(db, hash, config),
      "accepted",
    );
    // An in-flight older generation cannot mark a newer quarantine request completed.
    await setQuarantine(db, [hash], true, "c".repeat(64), "Second moderation");
    await processImageCachePurges(
      db,
      config,
      (async () => {
        await setQuarantine(
          db,
          [hash],
          true,
          "c".repeat(64),
          "Concurrent moderation",
        );
        return new Response("{}");
      }) as typeof fetch,
      200,
    );
    assertEquals(
      (await db.execute("SELECT state FROM image_cache_purge")).rows[0].state,
      "pending",
    );
    await processImageCachePurges(
      db,
      config,
      (() => Promise.reject(Error("secret-test-only"))) as typeof fetch,
      201,
    );
    assertEquals(
      (await db.execute("SELECT last_error FROM image_cache_purge")).rows[0]
        .last_error,
      "Vercel purge request failed",
    );
    // Failure to durably enqueue must roll back the moderation state and audit too.
    await setQuarantine(
      db,
      [hash],
      false,
      "c".repeat(64),
      "Restore for rollback test",
    );
    const auditBefore =
      (await db.execute("SELECT COUNT(*) AS n FROM blob_quarantine_audit"))
        .rows[0].n;
    await db.execute("DROP TABLE image_cache_purge");
    await assertRejects(() =>
      setQuarantine(db, [hash], true, "c".repeat(64), "Must roll back")
    );
    assertEquals(await isQuarantined(db, hash), false);
    assertEquals(
      (await db.execute("SELECT COUNT(*) AS n FROM blob_quarantine_audit"))
        .rows[0].n,
      auditBefore,
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
