import type { Client } from "@libsql/client";
import type { IBlobStorage } from "./interface.ts";
import { withBlobMutationLock } from "../utils/blob-mutation-lock.ts";

/** Tombstones distinguish intentional deletion from metadata missing during recovery. */
export async function isBlobDeleted(
  db: Client,
  sha256: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM blob_deletions WHERE sha256 = ?",
    args: [sha256],
  });
  return result.rows.length > 0;
}

/** Caller must hold the hash lock. Hide the blob durably before attempting physical removal. */
export async function deleteStoredBlob(
  db: Client,
  storage: IBlobStorage,
  sha256: string,
  ext: string,
): Promise<void> {
  await db.batch([
    {
      sql:
        "INSERT OR REPLACE INTO blob_deletions (sha256, extension, deleted_at) VALUES (?, ?, ?)",
      args: [sha256, ext, Math.floor(Date.now() / 1000)],
    },
    { sql: "DELETE FROM blobs WHERE sha256 = ?", args: [sha256] },
  ], "write");
  if (!(await storage.remove(sha256, ext))) {
    throw new Error(
      "Blob hidden, but physical deletion failed; cleanup will retry",
    );
  }
  await db.execute({
    sql: "UPDATE blob_deletions SET cleanup_done = 1 WHERE sha256 = ?",
    args: [sha256],
  });
}

/** Retry physical deletion; retain tombstones so leftover extension aliases stay hidden. */
export async function retryBlobDeletions(
  db: Client,
  storage: IBlobStorage,
): Promise<void> {
  const rows = await db.execute(
    "SELECT sha256 FROM blob_deletions WHERE cleanup_done = 0 ORDER BY deleted_at LIMIT 100",
  );
  for (const row of rows.rows) {
    const hash = String(row[0]);
    try {
      await withBlobMutationLock(hash, async () => {
        const current = await db.execute({
          sql:
            "SELECT extension FROM blob_deletions WHERE sha256 = ? AND cleanup_done = 0",
          args: [hash],
        });
        if (!current.rows.length) return;
        const ext = String(current.rows[0][0]);
        if (
          !(await storage.remove(hash, ext)) && await storage.has(hash, ext)
        ) {
          throw new Error("Physical deletion still pending");
        }
        await db.execute({
          sql: "UPDATE blob_deletions SET cleanup_done = 1 WHERE sha256 = ?",
          args: [hash],
        });
      });
    } catch (error) {
      console.warn(
        `[storage] Physical deletion still pending for ${hash}`,
        error,
      );
    }
  }
}
