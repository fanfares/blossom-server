/** Validate browser artwork reuse without permitting stale or quarantined reads. */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { initDb } from "../../src/db/client.ts";
import { insertBlob } from "../../src/db/blobs.ts";
import { setQuarantine } from "../../src/db/quarantine.ts";
import { buildBlobsRouter } from "../../src/routes/blobs.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import {
  ARTWORK_CACHE_CONTROL,
  blobCacheControl,
  matchesBlobETag,
} from "../../src/utils/blob-cache.ts";

Deno.test("only passive image MIME metadata permits mandatory-validation caching", () => {
  for (
    const type of [
      "image/png",
      "IMAGE/JPEG; charset=utf-8",
      "image/webp",
      "image/gif",
    ]
  ) {
    assertEquals(blobCacheControl(type), ARTWORK_CACHE_CONTROL);
  }
  for (
    const type of [
      "image/svg+xml",
      "image/custom+xml",
      "text/html",
      "audio/mpeg",
      "application/octet-stream",
      null,
      undefined,
    ]
  ) {
    assertEquals(blobCacheControl(type), "no-store");
  }
});

Deno.test("content-hash validators use weak comparison and require valid quoted tags", () => {
  const hash = "a".repeat(64);
  for (
    const header of [`"${hash}"`, `W/"${hash}"`, `"other", W/"${hash}"`, " * "]
  ) {
    assertEquals(matchesBlobETag(header, hash), true);
  }
  for (const header of [undefined, "", hash, '"other"', `W/${hash}`]) {
    assertEquals(matchesBlobETag(header, hash), false);
  }
});

Deno.test("artwork revalidation skips storage, checks quarantine before 304 and observes restoration", async () => {
  const dir = await Deno.makeTempDir();
  const db = await initDb({ path: join(dir, "test.db") });
  const storage = new LocalStorage(join(dir, "blobs"));
  await storage.setup();
  const hash = "a".repeat(64), owner = "b".repeat(64);
  const bytes = new Uint8Array([1, 2, 3]);
  let storageChecks = 0, bodyReads = 0;
  const has = storage.has.bind(storage), read = storage.read.bind(storage);
  storage.has = (hash, ext) => {
    storageChecks++;
    return has(hash, ext);
  };
  storage.read = (hash, ext) => {
    bodyReads++;
    return read(hash, ext);
  };
  const app = buildBlobsRouter(db, storage, ConfigSchema.parse({}));
  const request = (
    headers: HeadersInit = {},
    method = "GET",
    suffix = ".png",
  ) =>
    app.fetch(
      new Request(`http://localhost/${hash}${suffix}`, { method, headers }),
    );
  try {
    await insertBlob(db, {
      sha256: hash,
      size: bytes.length,
      type: "image/png",
      uploaded: 1,
    }, owner);
    await Deno.writeFile(join(dir, "blobs", `${hash}.png`), bytes);
    const first = await request();
    assertEquals(first.status, 200);
    assertEquals(first.headers.get("cache-control"), ARTWORK_CACHE_CONTROL);
    assertEquals(first.headers.get("etag"), `"${hash}"`);
    assertEquals(new Uint8Array(await first.arrayBuffer()), bytes);
    storageChecks = bodyReads = 0;
    for (const method of ["GET", "HEAD"]) {
      for (const validator of [`"${hash}"`, `W/"${hash}"`, "*"]) {
        const response = await request({ "if-none-match": validator }, method);
        assertEquals(response.status, 304);
        assertEquals(
          response.headers.get("cache-control"),
          ARTWORK_CACHE_CONTROL,
        );
        assertEquals(response.headers.get("etag"), `"${hash}"`);
        assertEquals(await response.text(), "");
      }
    }
    assertEquals(
      storageChecks,
      0,
      "feed validation must not issue R2 existence checks",
    );
    assertEquals(
      bodyReads,
      0,
      "feed validation must not download artwork again",
    );
    const accessed = await db.execute({
      sql: "SELECT timestamp FROM accessed WHERE blob = ?",
      args: [hash],
    });
    assertEquals(Number(accessed.rows[0].timestamp) > 1, true);

    await setQuarantine(db, [hash], true, owner, "test hold");
    for (const method of ["GET", "HEAD"]) {
      for (const suffix of ["", ".png", ".jpg"]) {
        const held = await request(
          { "if-none-match": `W/"${hash}"`, range: "bytes=0-1" },
          method,
          suffix,
        );
        assertEquals(held.status, 404);
        assertEquals(held.headers.get("cache-control"), "no-store");
        assertEquals(held.headers.has("etag"), false);
        await held.text();
      }
    }
    assertEquals(storageChecks, 0);
    assertEquals(bodyReads, 0);
    await setQuarantine(db, [hash], false, owner, "restore");
    assertEquals((await request({ "if-none-match": `"${hash}"` })).status, 304);
    const restored = await request();
    assertEquals(restored.status, 200);
    assertEquals(new Uint8Array(await restored.arrayBuffer()), bytes);
    const changedValidator = await request({ "if-none-match": '"other"' });
    assertEquals(changedValidator.status, 200);
    await changedValidator.arrayBuffer();

    // File extension alone must not opt audio/ciphertext into image caching.
    await db.execute({
      sql: "UPDATE blobs SET type = 'audio/mpeg' WHERE sha256 = ?",
      args: [hash],
    });
    const audio = await request();
    assertEquals(audio.headers.get("cache-control"), "no-store");
    await audio.arrayBuffer();
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
