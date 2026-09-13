import { crypto as stdCrypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";

/** A single backpressured pass bounds bytes, stalled reads, and overall lifetime. */
export async function writeAndHash(
  stream: ReadableStream<Uint8Array>,
  path: string,
  sizeHint: number | null,
  maxBytes: number,
  idleTimeoutMs = 60_000,
  lifetimeMs = 3_600_000,
  onBytes: (bytes: number) => void = () => {},
): Promise<{ hash: string; size: number }> {
  const reader = stream.getReader();
  let file: Deno.FsFile | null = null;
  let totalSize = 0;
  const deadline = Date.now() + lifetimeMs;
  try {
    file = await Deno.open(path, { write: true, create: true, truncate: true });
    const chunks = async function* () {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Upload lifetime exceeded");
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Upload body timed out")),
                Math.min(idleTimeoutMs, remaining),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (read.done) break;
        const chunk = read.value;
        totalSize += chunk.byteLength;
        if (
          totalSize > maxBytes || (sizeHint !== null && totalSize > sizeHint)
        ) {
          throw new Error("Upload body exceeds declared or allowed size");
        }
        let offset = 0;
        while (offset < chunk.length) {
          offset += await file!.write(chunk.subarray(offset));
        }
        onBytes(chunk.byteLength);
        yield chunk as Uint8Array<ArrayBuffer>;
      }
    };
    const hash = encodeHex(
      new Uint8Array(await stdCrypto.subtle.digest("SHA-256", chunks())),
    );
    if (sizeHint !== null && totalSize !== sizeHint) {
      throw new Error("Upload body does not match Content-Length");
    }
    return { hash, size: totalSize };
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    file?.close();
    reader.releaseLock();
  }
}
