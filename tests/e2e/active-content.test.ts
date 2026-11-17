/**
 * E2E tests for active-content isolation on GET/HEAD /:sha256[.ext].
 *
 * A blob stored as HTML, XML or SVG must never render as a page on the
 * Blossom host: it is served as an attachment inside a CSP sandbox, and every
 * blob response carries `X-Content-Type-Options: nosniff` so a browser cannot
 * reinterpret bytes uploaded under an innocent type. Ordinary media stays
 * inline. Mirrors upstream blossom-server 6.4.1.
 */

import { assert, assertEquals } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { encodeHex } from "@std/encoding/hex";
import { crypto as stdCrypto } from "@std/crypto";
import { join } from "@std/path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { Hono } from "@hono/hono";
import { initDb } from "../../src/db/client.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { initPool } from "../../src/workers/pool.ts";
import { buildApp } from "../../src/server.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import type { BlossomVariables } from "../../src/middleware/auth.ts";

const sk = generateSecretKey();
const testOpts = { sanitizeOps: false, sanitizeResources: false } as const;

let app: Hono<{ Variables: BlossomVariables }>;
let cleanup: () => Promise<void>;
const uploaded: Record<string, { hash: string; path: string }> = {};

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

Deno.test({
  name: "active content e2e setup: upload fixtures",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "blossom_e2e_active_" });
    const dbPath = join(tmpDir, "test.db");
    const db = await initDb({ path: dbPath });
    const storage = new LocalStorage(join(tmpDir, "blobs"));
    await storage.setup();
    const pool = initPool(1, 4, 500, db, { path: dbPath });
    const config = ConfigSchema.parse({
      publicDomain: "localhost",
      upload: { requireAuth: false, enabled: true },
    });
    app = await buildApp(db, storage, config);

    for (const [name, fixture] of Object.entries(FIXTURES)) {
      const bytes = new TextEncoder().encode(fixture.body);
      const hash = await sha256Hex(bytes);
      const res = await app.fetch(
        new Request("http://localhost/upload", {
          method: "PUT",
          headers: {
            "Content-Length": String(bytes.byteLength),
            "Content-Type": fixture.type,
            "X-SHA-256": hash,
            Authorization: authHeader(hash),
          },
          body: bytes,
        }),
      );
      assertEquals(res.status, 201, `upload ${name}`);
      const descriptor = await res.json();
      uploaded[name] = { hash, path: new URL(descriptor.url).pathname };
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

Deno.test({
  name: "active content e2e teardown",
  async fn() {
    await cleanup();
  },
  ...testOpts,
});
