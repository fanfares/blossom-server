/**
 * @module config.cloudflare
 * @covers
 *   - Production upload, mirror, and delete endpoints require BUD-11 authentication
 *   - Production BUD-11 server scoping uses the canonical Fanfares hostname
 *   - Production writes are restricted to the early-access pubkey allowlist
 * @dependencies config loader and committed Cloudflare deployment config
 * @type unit | deno
 */

import { assertEquals } from "@std/assert";
import { loadConfig } from "../../src/config/loader.ts";

Deno.test("Cloudflare deployment config keeps destructive and storage routes authenticated", async () => {
  const config = await loadConfig("config.cloudflare.yml");

  assertEquals(config.upload.requireAuth, true);
  assertEquals(config.mirror.enabled, false);
  assertEquals(config.mirror.requireAuth, true);
  assertEquals(config.delete.requireAuth, true);
  assertEquals(config.publicDomain, "blossom.fanfares.live");
});

Deno.test("Cloudflare deployment config restricts writes to the pubkey allowlist", async () => {
  const config = await loadConfig("config.cloudflare.yml");

  assertEquals(config.uploadAllowlist.enabled, true);
  // A curator pubkey and at least one relay are what make the gate effective;
  // without them every write fails closed.
  assertEquals(typeof config.uploadAllowlist.listPubkey, "string");
  assertEquals(config.uploadAllowlist.relays.length > 0, true);
  // Break-glass access must exist so a list or relay problem cannot lock the
  // operator out of their own server.
  assertEquals(config.uploadAllowlist.extraPubkeys.length > 0, true);
});
