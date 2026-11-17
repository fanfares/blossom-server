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
import {
  isInlineSafeMime,
  mimeToExt,
  normalizeIncomingMime,
  parseMimeType,
  resolveServedType,
} from "../../src/utils/mime.ts";
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
// parseMimeType: exactly one well-formed type/subtype, or null
// ---------------------------------------------------------------------------

Deno.test("parseMimeType: single types parse, lowercased, with token parameters", () => {
  const cases: Array<[string, string, string]> = [
    ["image/png", "image/png", "image/png"],
    ["  IMAGE/PNG  ", "image/png", "image/png"],
    ["TEXT/XSL", "text/xsl", "text/xsl"],
    [
      "Text/Plain; Charset=UTF-8",
      "text/plain",
      "text/plain; charset=UTF-8",
    ],
    ["text/plain;", "text/plain", "text/plain"],
    ["image/svg+xml", "image/svg+xml", "image/svg+xml"],
    [
      "application/vnd.ms-excel",
      "application/vnd.ms-excel",
      "application/vnd.ms-excel",
    ],
  ];
  for (const [input, essence, value] of cases) {
    assertEquals(parseMimeType(input), { essence, value }, input);
  }
});

Deno.test("parseMimeType: comma lists, duplicates and malformed values are null", () => {
  for (
    const input of [
      null,
      undefined,
      "",
      "   ",
      "image/png, text/html",
      "text/html, image/png",
      "text/plain,text/html",
      "image/png; x=1, text/html",
      'image/png; x="a,text/html"',
      'text/plain; charset="utf-8"',
      "image/png; charset",
      "image/png; =x",
      "image/png\r\nX-Injected: 1",
      "image/ png",
      "image/png text/html",
      "image",
      "image/",
      "/png",
      "+xml",
      "/+xml",
      "image/+xml",
      "*/*",
      "image/*",
      "image/png/x",
      "imäge/png",
      "image/png\u0000",
    ]
  ) {
    assertEquals(parseMimeType(input), null, JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------
// normalizeIncomingMime: what upload, preflight, media and mirror store
// ---------------------------------------------------------------------------

Deno.test("normalizeIncomingMime: valid types keep their lowercase essence", () => {
  assertEquals(normalizeIncomingMime("IMAGE/PNG; charset=binary"), "image/png");
  assertEquals(normalizeIncomingMime("text/xsl"), "text/xsl");
  assertEquals(normalizeIncomingMime("audio/mpeg"), "audio/mpeg");
});

Deno.test("normalizeIncomingMime: missing, malformed or multi-valued types become octet-stream", () => {
  for (
    const input of [
      null,
      undefined,
      "",
      "image/png, text/html",
      "text/plain,text/html",
      "image/png; x=1, text/html",
      "image/+xml",
    ]
  ) {
    assertEquals(
      normalizeIncomingMime(input),
      "application/octet-stream",
      JSON.stringify(input),
    );
  }
});

// ---------------------------------------------------------------------------
// isInlineSafeMime / resolveServedType: the inline allowlist
// ---------------------------------------------------------------------------

Deno.test("isInlineSafeMime: raster images, audio, video, text/plain, octet-stream", () => {
  for (
    const essence of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
      "audio/mpeg",
      "audio/mp4",
      "audio/ogg",
      "video/mp4",
      "video/webm",
      "text/plain",
      "application/octet-stream",
    ]
  ) {
    assertEquals(isInlineSafeMime(essence), true, essence);
  }
});

Deno.test("isInlineSafeMime: documents, scripts, XML images and unknown types are not inline", () => {
  for (
    const essence of [
      "text/html",
      "text/xml",
      "text/xsl",
      "application/xml",
      "application/xhtml+xml",
      "application/xslt+xml",
      "image/svg+xml",
      "image/x-foo+xml",
      "image/xml",
      "text/javascript",
      "application/javascript",
      "application/json",
      "application/pdf",
      "multipart/x-mixed-replace",
      "text/css",
      "text/vtt",
      "application/x-made-up",
      "font/woff2",
    ]
  ) {
    assertEquals(isInlineSafeMime(essence), false, essence);
  }
});

Deno.test("resolveServedType: allowlisted types inline, others download, malformed never echoed", () => {
  const cases: Array<[string | null, string, boolean]> = [
    ["image/png", "image/png", false],
    ["IMAGE/PNG", "image/png", false],
    ["text/plain; charset=UTF-8", "text/plain; charset=UTF-8", false],
    ["application/octet-stream", "application/octet-stream", false],
    ["audio/mpeg", "audio/mpeg", false],
    ["video/mp4", "video/mp4", false],
    ["text/html; charset=UTF-8", "text/html; charset=UTF-8", true],
    ["text/xsl", "text/xsl", true],
    ["TEXT/XSL", "text/xsl", true],
    ["image/svg+xml", "image/svg+xml", true],
    ["application/pdf", "application/pdf", true],
    ["image/png, text/html", "application/octet-stream", true],
    ["text/html, image/png", "application/octet-stream", true],
    ["text/plain,text/html", "application/octet-stream", true],
    ["image/+xml", "application/octet-stream", true],
    ["", "application/octet-stream", true],
    [null, "application/octet-stream", true],
  ];
  for (const [input, contentType, download] of cases) {
    assertEquals(
      resolveServedType(input),
      { contentType, download },
      JSON.stringify(input),
    );
  }
});
