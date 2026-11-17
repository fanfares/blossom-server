/**
 * Unit tests for mimeToExt — the storage-key extension mapping.
 *
 * Regression guard for the octet-stream blob-loss bug: blobs whose MIME type
 * mapped to an empty extension were stored under bare-hash R2 keys, which the
 * production deployment could not retrieve (uploads returned 201 but every
 * GET 404ed). mimeToExt must therefore never return an empty string: unknown
 * types and application/octet-stream fall back to "bin".
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { isActiveContentMime, mimeToExt } from "../../src/utils/mime.ts";
import { getBlobUrl } from "../../src/utils/url.ts";

Deno.test("mimeToExt: application/octet-stream maps to bin", () => {
  assertEquals(mimeToExt("application/octet-stream"), "bin");
});

Deno.test("mimeToExt: null maps to bin (DB stores octet-stream as null)", () => {
  assertEquals(mimeToExt(null), "bin");
});

Deno.test("mimeToExt: empty string maps to bin", () => {
  assertEquals(mimeToExt(""), "bin");
});

Deno.test("mimeToExt: unknown MIME type maps to bin", () => {
  assertEquals(mimeToExt("application/x-completely-made-up"), "bin");
});

Deno.test("mimeToExt: known MIME types keep their real extension", () => {
  // Extensions as @std/media-types maps them (image/jpeg is "jpeg", not "jpg").
  assertEquals(mimeToExt("image/jpeg"), "jpeg");
  assertEquals(mimeToExt("image/png"), "png");
  assertEquals(mimeToExt("text/plain"), "txt");
  assertEquals(mimeToExt("video/mp4"), "mp4");
});

Deno.test("mimeToExt: never returns an empty string", () => {
  const samples = [
    null,
    "",
    "application/octet-stream",
    "application/x-unknown",
    "image/jpeg",
    "video/mp4",
  ];
  for (const mime of samples) {
    assertNotEquals(mimeToExt(mime), "", `mimeToExt(${mime}) must not be ""`);
  }
});

Deno.test("getBlobUrl: null type yields a .bin URL, not a bare-hash URL", () => {
  const hash = "a".repeat(64);
  assertEquals(
    getBlobUrl(hash, null, "https://blossom.example"),
    `https://blossom.example/${hash}.bin`,
  );
});

// ---------------------------------------------------------------------------
// isActiveContentMime: types a browser would execute as a document
// ---------------------------------------------------------------------------

Deno.test("isActiveContentMime: HTML, XML, SVG and other +xml types are active", () => {
  for (
    const mime of [
      "text/html",
      "TEXT/HTML; charset=utf-8",
      "text/xml",
      "application/xml",
      "image/svg+xml",
      "application/xhtml+xml",
      "multipart/x-mixed-replace; boundary=x",
    ]
  ) {
    assertEquals(isActiveContentMime(mime), true, mime);
  }
});

Deno.test("isActiveContentMime: ordinary media and data types are not active", () => {
  for (
    const mime of [
      null,
      undefined,
      "",
      "application/octet-stream",
      "image/png",
      "image/avif",
      "audio/mp4",
      "video/mp4",
      "text/plain",
      "application/json",
      "+xml",
      "/+xml",
      "image/+xml",
    ]
  ) {
    assertEquals(isActiveContentMime(mime), false, String(mime));
  }
});
