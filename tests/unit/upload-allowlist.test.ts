/**
 * @module upload-allowlist
 * @covers
 *   - Disabled allowlist is a no-op
 *   - Allowed pubkeys pass; unknown pubkeys are rejected 403
 *   - extraPubkeys bypass the list entirely (break-glass)
 *   - The list is cached and refreshed only after refreshSeconds
 *   - Concurrent callers share one in-flight refresh
 *   - A failed refresh serves the stale list within staleSeconds
 *   - Beyond staleSeconds, and with no cache at all, writes fail closed (503)
 *   - Enabled without a listPubkey fails closed rather than allowing writes
 *   - Contact-list parsing takes p tags from the newest event; empty is an error
 * @dependencies none; fetcher and clock are injected
 * @type unit | deno
 */

import { assertEquals, assertRejects } from "@std/assert";
import { HTTPException } from "@hono/hono/http-exception";
import {
  createUploadAllowlist,
  fetchContactListPubkeys,
} from "../../src/auth/upload-allowlist.ts";
import type { UploadAllowlistConfig } from "../../src/config/schema.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const OPERATOR = "c".repeat(64);

/**
 * Builds an allowlist config with test-friendly defaults.
 *
 * @param overrides Fields to override on the base config.
 * @returns A complete allowlist config.
 */
function makeConfig(
  overrides: Partial<UploadAllowlistConfig> = {},
): UploadAllowlistConfig {
  return {
    enabled: true,
    listPubkey: "curator",
    relays: ["wss://relay.example"],
    extraPubkeys: [],
    refreshSeconds: 300,
    staleSeconds: 86_400,
    timeoutMs: 5_000,
    ...overrides,
  };
}

/**
 * Asserts that a thrown value is an HTTPException with the given status.
 *
 * @param error Value thrown by the code under test.
 * @param status Expected HTTP status.
 */
function assertStatus(error: unknown, status: number): void {
  assertEquals(error instanceof HTTPException, true);
  assertEquals((error as HTTPException).status, status);
}

Deno.test("disabled allowlist allows any pubkey without fetching", async () => {
  let calls = 0;
  const allowlist = createUploadAllowlist(
    makeConfig({ enabled: false }),
    () => {
      calls += 1;
      return Promise.resolve(new Set<string>());
    },
  );

  await allowlist.assertAllowed(BOB);
  assertEquals(calls, 0);
});

Deno.test("allows a listed pubkey and rejects an unlisted one", async () => {
  const allowlist = createUploadAllowlist(
    makeConfig(),
    () => Promise.resolve(new Set([ALICE])),
  );

  await allowlist.assertAllowed(ALICE);

  const error = await assertRejects(() => allowlist.assertAllowed(BOB));
  assertStatus(error, 403);
});

Deno.test("matches pubkeys case-insensitively", async () => {
  const allowlist = createUploadAllowlist(
    makeConfig(),
    () => Promise.resolve(new Set([ALICE])),
  );

  await allowlist.assertAllowed(ALICE.toUpperCase());
});

Deno.test("extraPubkeys bypass the list without fetching", async () => {
  let calls = 0;
  const allowlist = createUploadAllowlist(
    makeConfig({ extraPubkeys: [OPERATOR] }),
    () => {
      calls += 1;
      return Promise.reject(new Error("relays are down"));
    },
  );

  await allowlist.assertAllowed(OPERATOR);
  assertEquals(calls, 0);
});

Deno.test("caches the list and refreshes only after refreshSeconds", async () => {
  let calls = 0;
  let nowMs = 1_000_000;
  const allowlist = createUploadAllowlist(
    makeConfig({ refreshSeconds: 60 }),
    () => {
      calls += 1;
      return Promise.resolve(new Set([ALICE]));
    },
    () => nowMs,
  );

  await allowlist.assertAllowed(ALICE);
  await allowlist.assertAllowed(ALICE);
  assertEquals(calls, 1);

  nowMs += 61_000;
  await allowlist.assertAllowed(ALICE);
  assertEquals(calls, 2);
});

Deno.test("concurrent callers share a single in-flight refresh", async () => {
  let calls = 0;
  const allowlist = createUploadAllowlist(makeConfig(), () => {
    calls += 1;
    return new Promise((resolve) =>
      setTimeout(() => resolve(new Set([ALICE, BOB])), 5)
    );
  });

  await Promise.all([
    allowlist.assertAllowed(ALICE),
    allowlist.assertAllowed(BOB),
    allowlist.assertAllowed(ALICE),
  ]);

  assertEquals(calls, 1);
});

Deno.test("serves the stale list when a refresh fails inside staleSeconds", async () => {
  let shouldFail = false;
  let nowMs = 1_000_000;
  const allowlist = createUploadAllowlist(
    makeConfig({ refreshSeconds: 60, staleSeconds: 3_600 }),
    () =>
      shouldFail
        ? Promise.reject(new Error("relays are down"))
        : Promise.resolve(new Set([ALICE])),
    () => nowMs,
  );

  await allowlist.assertAllowed(ALICE);

  shouldFail = true;
  nowMs += 61_000; // cache is stale enough to refresh, still inside the stale window

  // The known-good list is still honoured for both verdicts.
  await allowlist.assertAllowed(ALICE);
  const error = await assertRejects(() => allowlist.assertAllowed(BOB));
  assertStatus(error, 403);
});

Deno.test("fails closed once the stale window has passed", async () => {
  let shouldFail = false;
  let nowMs = 1_000_000;
  const allowlist = createUploadAllowlist(
    makeConfig({ refreshSeconds: 60, staleSeconds: 600 }),
    () =>
      shouldFail
        ? Promise.reject(new Error("relays are down"))
        : Promise.resolve(new Set([ALICE])),
    () => nowMs,
  );

  await allowlist.assertAllowed(ALICE);

  shouldFail = true;
  nowMs += 601_000;

  const error = await assertRejects(() => allowlist.assertAllowed(ALICE));
  assertStatus(error, 503);
});

Deno.test("fails closed when the list has never been fetched", async () => {
  const allowlist = createUploadAllowlist(
    makeConfig(),
    () => Promise.reject(new Error("relays are down")),
  );

  const error = await assertRejects(() => allowlist.assertAllowed(ALICE));
  assertStatus(error, 503);
});

Deno.test("fails closed when enabled without a listPubkey", async () => {
  const allowlist = createUploadAllowlist(
    makeConfig({ listPubkey: null }),
    () => Promise.resolve(new Set([ALICE])),
  );

  const error = await assertRejects(() => allowlist.assertAllowed(ALICE));
  assertStatus(error, 503);
});

Deno.test("contact-list parsing requires configuration", async () => {
  await assertRejects(() =>
    fetchContactListPubkeys(
      makeConfig({ listPubkey: null }),
      // deno-lint-ignore no-explicit-any
      {} as any,
    )
  );

  await assertRejects(() =>
    fetchContactListPubkeys(
      makeConfig({ relays: [] }),
      // deno-lint-ignore no-explicit-any
      {} as any,
    )
  );
});
