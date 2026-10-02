import type { Client } from "@libsql/client";
import { withBlobMutationLock } from "../utils/blob-mutation-lock.ts";

export async function isQuarantined(
  db: Client,
  hash: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT active FROM blob_quarantine WHERE sha256 = ?",
    args: [hash],
  });
  return Number(result.rows[0]?.active ?? 0) === 1;
}

export async function quarantineTargets(
  db: Client,
  scope: string,
  id: string,
): Promise<string[]> {
  const sql = scope === "file"
    ? "SELECT sha256 FROM blobs WHERE sha256 = ?"
    : scope === "user"
    ? "SELECT blob AS sha256 FROM owners WHERE pubkey = ?"
    : "SELECT blob AS sha256 FROM admin_event_blobs WHERE event_id = ?";
  const result = await db.execute({
    sql: `${sql} ORDER BY sha256 LIMIT 10001`,
    args: [id],
  });
  if (result.rows.length > 10000) {
    throw new RangeError(
      "Too many files. Quarantine individual files instead.",
    );
  }
  return result.rows.map((row) => String(row.sha256));
}

/** Atomic audit and state update, serialized against physical removal in this single-instance deployment. */
export async function setQuarantine(
  db: Client,
  hashes: string[],
  active: boolean,
  actor: string,
  reason: string,
): Promise<void> {
  const ordered = [...new Set(hashes)].sort();
  async function locked(index: number): Promise<void> {
    if (index < ordered.length) {
      return await withBlobMutationLock(
        ordered[index],
        () => locked(index + 1),
      );
    }
    const existing = await db.execute({
      sql: `SELECT COUNT(*) AS total FROM blobs WHERE sha256 IN (${
        ordered.map(() => "?").join(",")
      })`,
      args: ordered,
    });
    if (Number(existing.rows[0].total) !== ordered.length) {
      throw new RangeError("File selection changed. Review again.");
    }
    const now = Math.floor(Date.now() / 1000);
    await db.batch(
      ordered.flatMap((hash) => [
        {
          sql:
            "INSERT INTO blob_quarantine_audit(sha256, action, actor, reason, created_at) VALUES (?, ?, ?, ?, ?)",
          args: [hash, active ? "quarantine" : "restore", actor, reason, now],
        },
        {
          sql:
            "INSERT INTO blob_quarantine(sha256, active, updated_at, updated_by, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET active=excluded.active, updated_at=excluded.updated_at, updated_by=excluded.updated_by, reason=excluded.reason",
          args: [hash, active ? 1 : 0, now, actor, reason],
        },
      ]),
      "write",
    );
  }
  if (ordered.length) await locked(0);
}
