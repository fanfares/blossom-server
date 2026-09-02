/**
 * @module Admin authentication
 * @covers Signed session integrity, expiration, Nostr challenge binding, admin allowlisting, and password comparison
 * @dependencies Web Crypto and nostr-tools
 * @type unit | deno
 */

import { assertEquals } from "@std/assert";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";
import {
  constantTimePasswordEqual,
  createAdminLoginTemplate,
  signAdminToken,
  verifyAdminLoginEvent,
  verifyAdminToken,
} from "../../src/admin/admin-auth.ts";

Deno.test("admin tokens accept intact unexpired state and reject tampering", async () => {
  const token = await signAdminToken(
    { purpose: "session", pubkey: "a".repeat(64), exp: 1_100 },
    "a-long-test-password",
  );
  const verified = await verifyAdminToken(
    token,
    "session",
    "a-long-test-password",
    1_000,
  );
  assertEquals(verified?.pubkey, "a".repeat(64));
  assertEquals(
    await verifyAdminToken(
      `${token}x`,
      "session",
      "a-long-test-password",
      1_000,
    ),
    null,
  );
  assertEquals(
    await verifyAdminToken(token, "session", "a-long-test-password", 1_101),
    null,
  );
});

Deno.test("admin Nostr login requires the exact challenge, origin, signer, and time window", () => {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const template = createAdminLoginTemplate(
    "nonce-1",
    "https://blossom.example",
    1_000,
  );
  const event = finalizeEvent(template, secretKey);
  assertEquals(
    verifyAdminLoginEvent(
      event,
      "nonce-1",
      "https://blossom.example",
      [pubkey],
      1_000,
    ),
    true,
  );
  assertEquals(
    verifyAdminLoginEvent(event, "different", "https://blossom.example", [
      pubkey,
    ], 1_000),
    false,
  );
  assertEquals(
    verifyAdminLoginEvent(
      event,
      "nonce-1",
      "https://other.example",
      [pubkey],
      1_000,
    ),
    false,
  );
  assertEquals(
    verifyAdminLoginEvent(event, "nonce-1", "https://blossom.example", [
      "b".repeat(64),
    ], 1_000),
    false,
  );
  assertEquals(
    verifyAdminLoginEvent(
      { kind: 27235, created_at: 1_000, pubkey: null } as unknown as NostrEvent,
      "nonce-1",
      "https://blossom.example",
      [pubkey],
      1_000,
    ),
    false,
  );
});

Deno.test("admin password comparison distinguishes the configured value", async () => {
  assertEquals(
    await constantTimePasswordEqual("correct-password", "correct-password"),
    true,
  );
  assertEquals(
    await constantTimePasswordEqual("incorrect", "correct-password"),
    false,
  );
});
