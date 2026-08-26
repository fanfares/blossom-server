/**
 * @module blob-mutation-lock
 * @covers
 *   - Same-hash mutations execute serially
 *   - Different hashes can mutate concurrently
 *   - A rejected mutation always releases the next waiter
 * @dependencies none
 * @type unit | deno
 */

import { assertEquals, assertRejects } from "@std/assert";
import { withBlobMutationLock } from "../../src/utils/blob-mutation-lock.ts";

Deno.test("same-hash blob mutations execute in arrival order", async () => {
  const events: string[] = [];
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstBarrier = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = withBlobMutationLock("a".repeat(64), async () => {
    events.push("first-start");
    markFirstStarted();
    await firstBarrier;
    events.push("first-end");
  });
  const second = withBlobMutationLock("a".repeat(64), () => {
    events.push("second");
    return Promise.resolve();
  });

  await firstStarted;
  assertEquals(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assertEquals(events, ["first-start", "first-end", "second"]);
});

Deno.test("different blob hashes do not block each other", async () => {
  const events: string[] = [];
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstBarrier = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = withBlobMutationLock("a".repeat(64), async () => {
    events.push("first-start");
    markFirstStarted();
    await firstBarrier;
  });
  const second = withBlobMutationLock("b".repeat(64), () => {
    events.push("second");
    return Promise.resolve();
  });

  await firstStarted;
  await second;
  assertEquals(events, ["first-start", "second"]);
  releaseFirst();
  await first;
});

Deno.test("a failed blob mutation releases the next waiter", async () => {
  const hash = "c".repeat(64);
  let releaseFirst!: () => void;
  const firstBarrier = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = withBlobMutationLock(hash, async () => {
    await firstBarrier;
    throw new Error("expected mutation failure");
  });
  const second = withBlobMutationLock(hash, () => Promise.resolve("released"));

  releaseFirst();
  await assertRejects(() => first, Error, "expected mutation failure");
  assertEquals(await second, "released");
});
