import { assertEquals, assertRejects } from "@std/assert";
import { writeAndHash } from "../../src/utils/upload-pipeline.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { readBoundedJson } from "../../src/utils/http-body.ts";
import { join } from "@std/path";

Deno.test("streaming uploads enforce byte limits and Content-Length while preserving hashing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "body");
    const body = (bytes: number[]) => new Response(new Uint8Array(bytes)).body!;
    const result = await writeAndHash(body([97, 98, 99]), path, 3, 3);
    assertEquals(
      result.hash,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assertEquals(result.size, 3);
    await assertRejects(
      () => writeAndHash(body([1, 2, 3, 4]), path, null, 3),
      Error,
      "exceeds",
    );
    await assertRejects(
      () => writeAndHash(body([1, 2]), path, 3, 3),
      Error,
      "Content-Length",
    );
    await assertRejects(
      () => writeAndHash(body([1, 2, 3]), path, 2, 3),
      Error,
      "exceeds",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stalled upload and provider bodies are cancelled and time out", async () => {
  const dir = await Deno.makeTempDir();
  let cancelled = 0;
  const stalled = () =>
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
  try {
    await assertRejects(
      () => writeAndHash(stalled(), join(dir, "body"), null, 100, 5),
      Error,
      "timed out",
    );
    await assertRejects(
      () => readBoundedJson(new Response(stalled()), 100, 5),
      Error,
      "timed out",
    );
    assertEquals(cancelled, 2);
    await assertRejects(
      () => readBoundedJson(new Response("x".repeat(101)), 100),
      Error,
      "byte limit",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("worker-path write sessions and ordinary streaming sessions release file resources", async () => {
  const dir = await Deno.makeTempDir();
  const storage = new LocalStorage(dir);
  await storage.setup();
  try {
    const direct = await storage.beginWrite(null);
    await Deno.writeTextFile(direct.tmpPath, "abc");
    await storage.abortWrite(direct);
    await direct.done;
    const session = await storage.beginWrite(3);
    await new Response("abc").body!.pipeTo(session.writable);
    await session.done;
    await storage.commitWrite(session, "a".repeat(64), "txt");
    assertEquals(
      await Deno.readTextFile(join(dir, "a".repeat(64) + ".txt")),
      "abc",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
