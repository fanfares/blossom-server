/**
 * Prune retention regression: the committed Cloudflare configs must not let
 * the prune loop delete stored blobs.
 *
 * Without explicit storage.rules the schema defaults prune any blob that has
 * gone unaccessed for 1 week (images: 1 month) and has no active paid grant,
 * removing both the metadata row and the R2 bytes. This test runs the real
 * prune engine against an old, unpaid blob under the default rules (deleted)
 * and under each committed Cloudflare config (kept).
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { initDb } from "../../src/db/client.ts";
import { getBlob, insertBlob } from "../../src/db/blobs.ts";
import { pruneStorage } from "../../src/prune/prune.ts";
import { ConfigSchema, type StorageRule } from "../../src/config/schema.ts";
import { loadConfig } from "../../src/config/loader.ts";
import type { IBlobStorage } from "../../src/storage/interface.ts";

const ENV = {
  TURSO_DATABASE_URL: "libsql://test-database.turso.io",
  TURSO_AUTH_TOKEN: "test-database-token",
  CF_ACCOUNT_ID: "test-cloudflare-account",
  R2_BUCKET: "test-r2-bucket",
  R2_ACCESS_KEY_ID: "test-r2-access-key",
  R2_SECRET_ACCESS_KEY: "test-r2-secret-key",
  BLOSSOM_PUBLIC_DOMAIN: "staging.blossom.fanfares.live",
};

/** Loads a committed config with placeholder secrets, restoring the environment afterward. */
async function loadCommittedRules(path: string): Promise<StorageRule[]> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(ENV)) {
    previous.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }
  try {
    return (await loadConfig(path)).storage.rules;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

/** Runs one prune cycle over a single two-year-old unpaid blob; returns whether it survived. */
async function oldBlobSurvives(rules: StorageRule[]): Promise<boolean> {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_prune_retention_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  const removed: string[] = [];
  const storage = {
    remove: (hash: string) => {
      removed.push(hash);
      return Promise.resolve(true);
    },
  } as unknown as IBlobStorage;
  try {
    const sha256 = "a".repeat(64);
    const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * 24 * 3600;
    await insertBlob(
      db,
      { sha256, size: 5, type: "audio/mp4", uploaded: twoYearsAgo },
      "b".repeat(64),
    );
    await pruneStorage(db, storage, rules, false);
    const survived = (await getBlob(db, sha256)) !== null;
    assertEquals(removed.length === 0, survived);
    return survived;
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("prune: the schema default rules delete an old unpaid blob (the hazard)", async () => {
  assertEquals(
    await oldBlobSurvives(ConfigSchema.parse({}).storage.rules),
    false,
  );
});

for (const path of ["config.cloudflare.yml", "config.cloudflare.staging.yml"]) {
  Deno.test(`prune: ${path} keeps an old unpaid blob`, async () => {
    assertEquals(await oldBlobSurvives(await loadCommittedRules(path)), true);
  });
}
