import type { WriteSession } from "./interface.ts";

/** Lazily open the stream writer: upload workers normally write the path directly. */
export async function createWriteSession(path: string): Promise<WriteSession> {
  const initial = await Deno.open(path, { write: true, createNew: true });
  initial.close();
  let file: Deno.FsFile | null = null;
  let settled = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const dispose = () => {
    file?.close();
    file = null;
    if (!settled) {
      settled = true;
      resolveDone();
    }
    return Promise.resolve();
  };
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (settled) throw new Error("Write session already closed");
      file ??= await Deno.open(path, { write: true });
      let offset = 0;
      while (offset < chunk.length) {
        offset += await file.write(chunk.subarray(offset));
      }
    },
    close: dispose,
    async abort(error) {
      if (!settled) {
        settled = true;
        rejectDone(error);
      }
      await dispose();
    },
  });
  return { tmpPath: path, writable, done, dispose };
}
