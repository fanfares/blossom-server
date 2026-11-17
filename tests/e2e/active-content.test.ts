/**
 * E2E tests for active-content isolation on GET/HEAD /:sha256[.ext].
 *
 * Only an allowlist of media types stays inline (raster images, audio, video,
 * text/plain, application/octet-stream). Everything else (HTML, XML, XSL,
 * SVG, scripts, PDF, unknown) is served as an attachment inside a CSP
 * sandbox, and every blob response carries `X-Content-Type-Options: nosniff`
 * so a browser cannot reinterpret bytes uploaded under an innocent type.
 *
 * Stored types are parsed strictly: a malformed or multi-valued type such as
 * "image/png, text/html" (browsers use the last entry) is normalized to
 * application/octet-stream at upload and is never echoed back on the way out,
 * even for rows stored before the upload normalization existed.
 */

import { assert, assertEquals } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { encodeHex } from "@std/encoding/hex";
import { crypto as stdCrypto } from "@std/crypto";
import { join } from "@std/path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { Hono } from "@hono/hono";
import type { Client } from "@libsql/client";
import { initDb } from "../../src/db/client.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { initPool } from "../../src/workers/pool.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import type { BlossomVariables } from "../../src/middleware/auth.ts";

const sk = generateSecretKey();
const testOpts = { sanitizeOps: false, sanitizeResources: false } as const;

let app: Hono<{ Variables: BlossomVariables }>;
let db: Client;
let tmpDir: string;
let cleanup: () => Promise<void>;
const uploaded: Record<
  string,
  { hash: string; path: string; descriptorType: string }
> = {};

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await stdCrypto.subtle.digest(
    "SHA-256",
    data.buffer as ArrayBuffer,
  );
  return encodeHex(new Uint8Array(buf));
}

function authHeader(hash: string): string {
  const now = Math.floor(Date.now() / 1000);
  const event = finalizeEvent({
    kind: 24242,
    created_at: now,
    tags: [["t", "upload"], ["expiration", String(now + 600)], ["x", hash]],
    content: "Upload blob",
  }, sk);
  return `Nostr ${
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(event)))
  }`;
}

const FIXTURES: Record<string, { type: string; body: string }> = {
  html: {
    type: "text/html",
    body: "<!doctype html><script>alert(document.domain)</script>",
  },
  svg: {
    type: "image/svg+xml",
    body:
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  },
  xml: { type: "application/xml", body: "<?xml version='1.0'?><a/>" },
  // SVG markup declared as an image type: must stay an image, never sniffed.
  avif: {
    type: "image/avif",
    body:
      '<!--ftypavif--><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  },
  png: { type: "image/png", body: "\x89PNG\r\n\x1a\n-not-really-a-png" },
};

const HTML_BODY =
  "<!doctype html><title>pwned</title><script>alert(1)</script>";

/**
 * Bypass and allowlist fixtures. Each one carries an HTML body so that any
 * type that ends up inline as a document would be a script execution.
 * `contentType` is what GET must send, `download` whether it must be a
 * sandboxed attachment, `stored` the type the upload descriptor reports.
 */
const MATRIX: Record<string, {
  type: string | string[];
  stored: string;
  contentType: string;
  download: boolean;
}> = {
  // Chromium renders text/xsl as a document and runs its script.
  xsl: {
    type: "text/xsl",
    stored: "text/xsl",
    contentType: "text/xsl",
    download: true,
  },
  xslUpper: {
    type: "TEXT/XSL",
    stored: "text/xsl",
    contentType: "text/xsl",
    download: true,
  },
  // Comma lists: Chromium uses the last valid entry. Never stored verbatim.
  commaPngHtml: {
    type: "image/png, text/html",
    stored: "application/octet-stream",
    contentType: "application/octet-stream",
    download: false,
  },
  commaHtmlPng: {
    type: "text/html, image/png",
    stored: "application/octet-stream",
    contentType: "application/octet-stream",
    download: false,
  },
  commaPlainHtml: {
    type: "text/plain,text/html",
    stored: "application/octet-stream",
    contentType: "application/octet-stream",
    download: false,
  },
  commaInParams: {
    type: "image/png; x=1, text/html",
    stored: "application/octet-stream",
    contentType: "application/octet-stream",
    download: false,
  },
  // Two Content-Type header lines arrive joined as "image/png, text/html".
  duplicatedHeader: {
    type: ["image/png", "text/html"],
    stored: "application/octet-stream",
    contentType: "application/octet-stream",
    download: false,
  },
  // Not on the inline allowlist: downloads.
  js: {
    type: "text/javascript",
    stored: "text/javascript",
    contentType: "text/javascript",
    download: true,
  },
  pdf: {
    type: "application/pdf",
    stored: "application/pdf",
    contentType: "application/pdf",
    download: true,
  },
  json: {
    type: "application/json",
    stored: "application/json",
    contentType: "application/json",
    download: true,
  },
  unknown: {
    type: "application/x-made-up",
    stored: "application/x-made-up",
    contentType: "application/x-made-up",
    download: true,
  },
  // Malformed (a subtype must start with a letter or digit): octet-stream.
  plusXmlImage: {
    type: "image/+xml",
    stored: "application/octet-stream",
    contentType: "application/octet-stream",
    download: false,
  },
  // Well-formed but XML based: never an inline image.
  xmlImage: {
    type: "image/x-foo+xml",
    stored: "image/x-foo+xml",
    contentType: "image/x-foo+xml",
    download: true,
  },
  // On the inline allowlist: stays inline, lowercased, parameters dropped.
  pngUpper: {
    type: "IMAGE/PNG; charset=binary",
    stored: "image/png",
    contentType: "image/png",
    download: false,
  },
  mp3: {
    type: "audio/mpeg",
    stored: "audio/mpeg",
    contentType: "audio/mpeg",
    download: false,
  },
  mp4: {
    type: "video/mp4",
    stored: "video/mp4",
    contentType: "video/mp4",
    download: false,
  },
  txt: {
    type: "text/plain",
    stored: "text/plain",
    contentType: "text/plain",
    download: false,
  },
  bin: {
    type: "application/octet-stream",
    stored: "application/octet-stream",
    contentType: "application/octet-stream",
    download: false,
  },
};

async function uploadFixture(
  name: string,
  type: string | string[],
  body: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  const hash = await sha256Hex(bytes);
  const headers = new Headers({
    "Content-Length": String(bytes.byteLength),
    "X-SHA-256": hash,
    Authorization: authHeader(hash),
  });
  for (const value of Array.isArray(type) ? type : [type]) {
    headers.append("Content-Type", value);
  }
  const res = await app.fetch(
    new Request("http://localhost/upload", {
      method: "PUT",
      headers,
      body: bytes,
    }),
  );
  assertEquals(res.status, 201, `upload ${name}`);
  const descriptor = await res.json();
  uploaded[name] = {
    hash,
    path: new URL(descriptor.url).pathname,
    descriptorType: descriptor.type,
  };
}

/** Assert a response is a sandboxed download that no browser will render. */
function assertDownload(res: Response, hash: string, label: string): void {
  const disposition = res.headers.get("Content-Disposition") ?? "";
  assert(
    disposition.startsWith(`attachment; filename="${hash}`),
    `${label} disposition: ${disposition}`,
  );
  assertEquals(res.headers.get("Content-Security-Policy"), "sandbox", label);
  assertEquals(res.headers.get("X-Content-Type-Options"), "nosniff", label);
}

/** Assert a response is inline media with nosniff and no sandbox. */
function assertInline(res: Response, label: string): void {
  assertEquals(res.headers.get("Content-Disposition"), null, label);
  assertEquals(res.headers.get("Content-Security-Policy"), null, label);
  assertEquals(res.headers.get("X-Content-Type-Options"), "nosniff", label);
}

Deno.test({
  name: "active content e2e setup: upload fixtures",
  async fn() {
    tmpDir = await Deno.makeTempDir({ prefix: "blossom_e2e_active_" });
    const dbPath = join(tmpDir, "test.db");
    db = await initDb({ path: dbPath });
    const storage = new LocalStorage(join(tmpDir, "blobs"));
    await storage.setup();
    const pool = initPool(1, 4, 500, db, { path: dbPath });
    const config = ConfigSchema.parse({
      publicDomain: "localhost",
      upload: { requireAuth: false, enabled: true },
    });
    app = await buildApp(db, storage, config);

    for (const [name, fixture] of Object.entries(FIXTURES)) {
      await uploadFixture(name, fixture.type, fixture.body);
    }
    for (const [name, fixture] of Object.entries(MATRIX)) {
      // Distinct bodies so every fixture gets its own blob row.
      await uploadFixture(name, fixture.type, `${HTML_BODY}<!-- ${name} -->`);
    }

    cleanup = async () => {
      pool.shutdown();
      db.close();
      await Deno.remove(tmpDir, { recursive: true });
    };
  },
  ...testOpts,
});

for (const name of ["html", "svg", "xml"]) {
  Deno.test({
    name: `GET/HEAD ${name} blob: attachment, CSP sandbox, nosniff`,
    async fn() {
      const { hash, path } = uploaded[name];
      for (const method of ["GET", "HEAD"]) {
        const res = await app.fetch(
          new Request(`http://localhost${path}`, { method }),
        );
        assertEquals(res.status, 200, `${method} ${name}`);
        const disposition = res.headers.get("Content-Disposition") ?? "";
        assert(
          disposition.startsWith(`attachment; filename="${hash}`),
          `${method} ${name} disposition: ${disposition}`,
        );
        assertEquals(res.headers.get("Content-Security-Policy"), "sandbox");
        assertEquals(res.headers.get("X-Content-Type-Options"), "nosniff");
        await res.body?.cancel();
      }
    },
    ...testOpts,
  });
}

Deno.test({
  name: "active content: bare-hash, range and 304 responses keep the isolation",
  async fn() {
    const { hash } = uploaded.html;
    const bare = await app.fetch(new Request(`http://localhost/${hash}`));
    assertEquals(bare.status, 200);
    assert(bare.headers.get("Content-Disposition")?.startsWith("attachment"));
    await bare.body?.cancel();

    const range = await app.fetch(
      new Request(`http://localhost/${hash}`, {
        headers: { Range: "bytes=0-4" },
      }),
    );
    assertEquals(range.status, 206);
    assert(range.headers.get("Content-Disposition")?.startsWith("attachment"));
    assertEquals(range.headers.get("Content-Security-Policy"), "sandbox");
    await range.body?.cancel();

    const notModified = await app.fetch(
      new Request(`http://localhost/${hash}`, {
        headers: { "If-None-Match": `"${hash}"` },
      }),
    );
    assertEquals(notModified.status, 304);
    assert(
      notModified.headers.get("Content-Disposition")?.startsWith("attachment"),
    );
    assertEquals(notModified.headers.get("Content-Security-Policy"), "sandbox");
    assertEquals(notModified.headers.get("X-Content-Type-Options"), "nosniff");
  },
  ...testOpts,
});

for (const name of ["png", "avif"]) {
  Deno.test({
    name: `GET ${name} blob: stays inline with its stored type and nosniff`,
    async fn() {
      const res = await app.fetch(
        new Request(`http://localhost${uploaded[name].path}`),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("Content-Type"), FIXTURES[name].type);
      assertEquals(res.headers.get("Content-Disposition"), null);
      assertEquals(res.headers.get("Content-Security-Policy"), null);
      assertEquals(res.headers.get("X-Content-Type-Options"), "nosniff");
      await res.body?.cancel();
    },
    ...testOpts,
  });
}

for (const [name, fixture] of Object.entries(MATRIX)) {
  Deno.test({
    name: `upload + GET/HEAD ${name} (${String(fixture.type)}): ${
      fixture.download ? "sandboxed download" : "inline"
    } as ${fixture.contentType}`,
    async fn() {
      const { hash, path, descriptorType } = uploaded[name];
      assertEquals(descriptorType, fixture.stored, `${name} stored type`);
      for (const method of ["GET", "HEAD"]) {
        for (const url of [path, `/${hash}`]) {
          const res = await app.fetch(
            new Request(`http://localhost${url}`, { method }),
          );
          const label = `${method} ${url} (${name})`;
          assertEquals(res.status, 200, label);
          assertEquals(
            res.headers.get("Content-Type"),
            fixture.contentType,
            label,
          );
          if (fixture.download) assertDownload(res, hash, label);
          else assertInline(res, label);
          await res.body?.cancel();
        }
      }
    },
    ...testOpts,
  });
}

Deno.test({
  name: "active content: audio range request stays an inline 206",
  async fn() {
    const { hash } = uploaded.mp3;
    const res = await app.fetch(
      new Request(`http://localhost/${hash}`, {
        headers: { Range: "bytes=0-3" },
      }),
    );
    assertEquals(res.status, 206);
    assertEquals(res.headers.get("Content-Type"), "audio/mpeg");
    assertInline(res, "audio range");
    assertEquals(await res.text(), HTML_BODY.slice(0, 4));
  },
  ...testOpts,
});

Deno.test({
  name: "active content: text/xsl stays a download on range and 304",
  async fn() {
    const { hash } = uploaded.xsl;
    const range = await app.fetch(
      new Request(`http://localhost/${hash}`, {
        headers: { Range: "bytes=0-4" },
      }),
    );
    assertEquals(range.status, 206);
    assertDownload(range, hash, "xsl range");
    await range.body?.cancel();

    const notModified = await app.fetch(
      new Request(`http://localhost/${hash}`, {
        headers: { "If-None-Match": `"${hash}"` },
      }),
    );
    assertEquals(notModified.status, 304);
    assertDownload(notModified, hash, "xsl 304");
  },
  ...testOpts,
});

// Rows written before upload normalization existed may hold any string.
// None of them may be echoed, and none may stay inline unless they parse
// strictly to an allowlisted type.
const LEGACY_TYPES: Array<[string, string, boolean]> = [
  // [stored type, expected Content-Type, expected download]
  ["image/png, text/html", "application/octet-stream", true],
  ["text/html, image/png", "application/octet-stream", true],
  ["text/plain,text/html", "application/octet-stream", true],
  ['image/png; x="a,text/html"', "application/octet-stream", true],
  ["image/png\r\nX-Injected: 1", "application/octet-stream", true],
  ["TEXT/XSL", "text/xsl", true],
  ["Text/Html; Charset=UTF-8", "text/html; charset=UTF-8", true],
  ["image/svg+xml", "image/svg+xml", true],
  ["image/+xml", "application/octet-stream", true],
  ["IMAGE/PNG", "image/png", false],
  ["", "application/octet-stream", false],
];

Deno.test({
  name: "active content: legacy malformed stored types are never echoed",
  async fn() {
    const { hash } = uploaded.bin;
    try {
      for (const [stored, contentType, download] of LEGACY_TYPES) {
        await db.execute({
          sql: "UPDATE blobs SET type = ? WHERE sha256 = ?",
          args: [stored, hash],
        });
        const requests: Array<[string, number, RequestInit]> = [
          ["GET", 200, {}],
          ["HEAD", 200, { method: "HEAD" }],
          ["range", 206, { headers: { Range: "bytes=0-4" } }],
          ["304", 304, { headers: { "If-None-Match": `"${hash}"` } }],
        ];
        for (const [kind, status, init] of requests) {
          // The bytes live under .bin (uploaded as octet-stream); naming the
          // extension keeps the lookup independent of the rewritten type.
          const res = await app.fetch(
            new Request(`http://localhost/${hash}.bin`, init),
          );
          const label = `${kind} stored=${JSON.stringify(stored)}`;
          assertEquals(res.status, status, label);
          if (kind !== "304") {
            assertEquals(res.headers.get("Content-Type"), contentType, label);
          }
          if (download) assertDownload(res, hash, label);
          else assertInline(res, label);
          await res.body?.cancel();
        }
      }
    } finally {
      await db.execute({
        sql: "UPDATE blobs SET type = NULL WHERE sha256 = ?",
        args: [hash],
      });
    }
  },
  ...testOpts,
});

Deno.test({
  name: "active content: blob without a DB row is classified by its extension",
  async fn() {
    const { hash, path } = uploaded.html;
    await db.execute({
      sql: "DELETE FROM owners WHERE blob = ?",
      args: [hash],
    });
    await db.execute({
      sql: "DELETE FROM accessed WHERE blob = ?",
      args: [hash],
    });
    await db.execute({
      sql: "DELETE FROM blobs WHERE sha256 = ?",
      args: [hash],
    });
    const res = await app.fetch(new Request(`http://localhost${path}`));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/html; charset=UTF-8");
    assertDownload(res, hash, "row-less html");
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "upload normalization: storage rules see the normalized type",
  async fn() {
    // An image-only server must not accept a comma list that merely starts
    // with an image type, on PUT /upload or on the HEAD /upload preflight.
    const restricted = await buildApp(
      db,
      new LocalStorage(join(tmpDir, "blobs-restricted")),
      ConfigSchema.parse({
        publicDomain: "localhost",
        storage: { rules: [{ type: "image/*", expiration: "1 month" }] },
        upload: { requireAuth: false, enabled: true },
      }),
    );
    const body = new TextEncoder().encode(HTML_BODY);
    for (const type of ["image/png, text/html", "image/png,text/html"]) {
      const put = await restricted.fetch(
        new Request("http://localhost/upload", {
          method: "PUT",
          headers: {
            "Content-Length": String(body.byteLength),
            "Content-Type": type,
          },
          body,
        }),
      );
      assertEquals(put.status, 415, `PUT ${type}`);
      await put.body?.cancel();

      const head = await restricted.fetch(
        new Request("http://localhost/upload", {
          method: "HEAD",
          headers: {
            "X-Content-Type": type,
            "X-Content-Length": String(body.byteLength),
          },
        }),
      );
      assertEquals(head.status, 415, `HEAD ${type}`);
    }

    // A well-formed image type in any case still passes the preflight.
    const ok = await restricted.fetch(
      new Request("http://localhost/upload", {
        method: "HEAD",
        headers: { "X-Content-Type": "IMAGE/PNG", "X-Content-Length": "4" },
      }),
    );
    assertEquals(ok.status, 200);
  },
  ...testOpts,
});

Deno.test({
  name: "active content e2e teardown",
  async fn() {
    await cleanup();
  },
  ...testOpts,
});
