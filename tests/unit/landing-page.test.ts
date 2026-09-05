import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import { buildLandingRouter } from "../../src/routes/landing.tsx";

const HASH = "a".repeat(64);
const PUBKEY = "b".repeat(64);
const BLOB_URL = `https://blossom.example/${HASH}.png`;

async function renderLanding(tab: string): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_landing_test_" });
  const db = await initDb({ path: join(tmpDir, "landing.db") });

  try {
    await db.batch([
      {
        sql:
          "INSERT INTO blobs (sha256, size, type, uploaded) VALUES (?, ?, ?, ?)",
        args: [HASH, 1234, "image/png", 1_700_000_000],
      },
      {
        sql: "INSERT INTO owners (blob, pubkey) VALUES (?, ?)",
        args: [HASH, PUBKEY],
      },
    ]);

    const config = ConfigSchema.parse({
      publicDomain: "blossom.example",
      landing: { enabled: true, title: "Test Blossom" },
    });
    const app = await buildLandingRouter(db, config);
    const response = await app.request(`http://localhost/?tab=${tab}`);
    assertEquals(response.status, 200);
    return await response.text();
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("landing overview opens recent blob hashes directly", async () => {
  const html = await renderLanding("overview");

  assertStringIncludes(
    html,
    `href="${BLOB_URL}" target="_blank" rel="noopener noreferrer"`,
  );
  assertStringIncludes(html, "Open blob in a new tab");
});

Deno.test("landing file table opens the hash and action directly", async () => {
  const html = await renderLanding("files");

  const directLinks = html.match(new RegExp(`href="${BLOB_URL}"`, "g")) ?? [];
  assertEquals(directLinks.length, 2);
});

Deno.test("landing publisher sample opens the bare blob URL", async () => {
  const html = await renderLanding("publishers");

  assertStringIncludes(
    html,
    `href="https://blossom.example/${HASH}" target="_blank" rel="noopener noreferrer"`,
  );
});
