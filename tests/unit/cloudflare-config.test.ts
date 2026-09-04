/**
 * @module config.cloudflare
 * @covers
 *   - Production upload, mirror, and delete endpoints require BUD-11 authentication
 *   - Production BUD-11 server scoping uses the canonical Fanfares hostname
 *   - Production writes are restricted to the early-access pubkey allowlist
 *   - Production quota and purchase records use the durable Turso database
 *   - Staging uses its isolated hostname and forwards low-cost storage payments to its test wallet
 *   - Missing deployment secrets fail configuration loading before startup
 * @dependencies config loader and committed Cloudflare deployment config
 * @type unit | deno
 */

import { assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../../src/config/loader.ts";

const CLOUDFLARE_TEST_ENV = {
  TURSO_DATABASE_URL: "libsql://test-database.turso.io",
  TURSO_AUTH_TOKEN: "test-database-token",
  CF_ACCOUNT_ID: "test-cloudflare-account",
  R2_BUCKET: "test-r2-bucket",
  R2_ACCESS_KEY_ID: "test-r2-access-key",
  R2_SECRET_ACCESS_KEY: "test-r2-secret-key",
};

const STAGING_PUBLIC_DOMAIN = "staging.blossom.fanfares.live";

/** Loads the committed Cloudflare config with non-secret test values and restores the process environment afterward. */
async function loadTestCloudflareConfig() {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(CLOUDFLARE_TEST_ENV)) {
    previous.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }
  try {
    return await loadConfig("config.cloudflare.yml");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

/** Loads the committed staging config with isolated test resource identifiers and restores the process environment afterward. */
async function loadTestStagingConfig() {
  const environment = {
    ...CLOUDFLARE_TEST_ENV,
    BLOSSOM_PUBLIC_DOMAIN: STAGING_PUBLIC_DOMAIN,
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(environment)) {
    previous.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }
  try {
    return await loadConfig("config.cloudflare.staging.yml");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("Cloudflare deployment config keeps destructive and storage routes authenticated", async () => {
  const config = await loadTestCloudflareConfig();

  assertEquals(config.upload.requireAuth, true);
  assertEquals(config.mirror.enabled, false);
  assertEquals(config.mirror.requireAuth, true);
  assertEquals(config.delete.requireAuth, true);
  assertEquals(config.publicDomain, "blossom.fanfares.live");
  assertEquals(config.database.url, CLOUDFLARE_TEST_ENV.TURSO_DATABASE_URL);
  assertEquals(
    config.database.authToken,
    CLOUDFLARE_TEST_ENV.TURSO_AUTH_TOKEN,
  );
  assertEquals(config.paidStorage.enabled, false);
  assertEquals(config.paidStorage.treasury.enabled, false);
});

Deno.test("Cloudflare deployment config restricts writes to the pubkey allowlist", async () => {
  const config = await loadTestCloudflareConfig();

  assertEquals(config.uploadAllowlist.enabled, true);
  // A curator pubkey and at least one relay are what make the gate effective;
  // without them every write fails closed.
  assertEquals(typeof config.uploadAllowlist.listPubkey, "string");
  assertEquals(config.uploadAllowlist.relays.length > 0, true);
  // Break-glass access must exist so a list or relay problem cannot lock the
  // operator out of their own server.
  assertEquals(config.uploadAllowlist.extraPubkeys.length > 0, true);
});

Deno.test("Staging Cloudflare config forwards paid storage to its dedicated test wallet", async () => {
  const config = await loadTestStagingConfig();

  assertEquals(config.publicDomain, STAGING_PUBLIC_DOMAIN);
  assertEquals(config.paidStorage.enabled, true);
  assertEquals(config.paidStorage.priceSats, 5);
  assertEquals(config.paidStorage.treasury.enabled, true);
  assertEquals(
    config.paidStorage.treasury.lightningAddress,
    "fanfares@rizful.com",
  );
  assertEquals(config.upload.requireAuth, true);
  assertEquals(config.delete.requireAuth, true);
});

Deno.test("Configuration loading rejects a missing environment placeholder", async () => {
  const variableName = "FANFARES_TEST_REQUIRED_CONFIG_VALUE";
  const previous = Deno.env.get(variableName);
  const configPath = await Deno.makeTempFile({ suffix: ".yml" });
  Deno.env.delete(variableName);
  try {
    await Deno.writeTextFile(
      configPath,
      `database:\n  path: "\${${variableName}}"\n`,
    );
    await assertRejects(
      () => loadConfig(configPath),
      Error,
      `Required environment variable "${variableName}" is not set`,
    );
  } finally {
    await Deno.remove(configPath);
    if (previous === undefined) Deno.env.delete(variableName);
    else Deno.env.set(variableName, previous);
  }
});
