/**
 * @module config.cloudflare
 * @covers
 *   - Production upload, mirror, and delete endpoints require BUD-11 authentication
 *   - Production BUD-11 server scoping uses the canonical Fanfares hostname
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
