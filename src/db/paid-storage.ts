import type { Client } from "@libsql/client";

export interface StoragePurchaseRecord {
  id: string;
  pubkey: string;
  units: number;
  quotaBytes: number;
  durationSeconds: number;
  amountSats: number;
  invoice: string;
  providerQuoteId: string;
  state: "pending" | "paid" | "expired" | "failed";
  invoiceExpires: number | null;
  createdAt: number;
  paidAt: number | null;
  creditedAt: number | null;
  purchaseType: "new" | "extension";
  alignedExpiresAt: number | null;
  baseAmountSats: number;
  alignmentAmountSats: number;
}

export interface StorageAlignmentTargetRecord {
  grantPurchaseId: string;
  quotaBytes: number;
  originalExpiresAt: number;
  targetExpiresAt: number;
}

export interface StorageGrantRecord {
  purchaseId: string;
  quotaBytes: number;
  startsAt: number;
  expiresAt: number;
}

export interface StorageQuotaSummary {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number;
  expiresAt: number | null;
}

function rowToPurchase(
  row: { [index: number]: unknown },
): StoragePurchaseRecord {
  return {
    id: row[0] as string,
    pubkey: row[1] as string,
    units: row[2] as number,
    quotaBytes: row[3] as number,
    durationSeconds: row[4] as number,
    amountSats: row[5] as number,
    invoice: row[6] as string,
    providerQuoteId: row[7] as string,
    state: row[8] as StoragePurchaseRecord["state"],
    invoiceExpires: row[9] as number | null,
    createdAt: row[10] as number,
    paidAt: row[11] as number | null,
    creditedAt: row[12] as number | null,
    purchaseType: (row[13] as StoragePurchaseRecord["purchaseType"]) ?? "new",
    alignedExpiresAt: row[14] === null ? null : Number(row[14]),
    baseAmountSats: Number(row[15] ?? row[5]),
    alignmentAmountSats: Number(row[16] ?? 0),
  };
}

const PURCHASE_COLUMNS = `
  id, pubkey, units, quota_bytes, duration_seconds, amount_sats, invoice,
  provider_quote_id, state, invoice_expires, created_at, paid_at, credited_at
`;

const PURCHASE_SELECT_COLUMNS = `${PURCHASE_COLUMNS},
  CASE WHEN EXISTS (
    SELECT 1 FROM storage_purchase_extensions e
    WHERE e.purchase_id = storage_purchases.id
  ) THEN 'extension' ELSE 'new' END,
  (SELECT a.target_expires_at FROM storage_purchase_alignments a
   WHERE a.purchase_id = storage_purchases.id),
  COALESCE((SELECT a.base_amount_sats FROM storage_purchase_alignments a
            WHERE a.purchase_id = storage_purchases.id), amount_sats),
  COALESCE((SELECT a.alignment_amount_sats FROM storage_purchase_alignments a
            WHERE a.purchase_id = storage_purchases.id), 0)
`;

function storagePurchaseInsert(purchase: StoragePurchaseRecord) {
  return {
    sql: `INSERT INTO storage_purchases (
      ${PURCHASE_COLUMNS}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      purchase.id,
      purchase.pubkey,
      purchase.units,
      purchase.quotaBytes,
      purchase.durationSeconds,
      purchase.amountSats,
      purchase.invoice,
      purchase.providerQuoteId,
      purchase.state,
      purchase.invoiceExpires,
      purchase.createdAt,
      purchase.paidAt,
      purchase.creditedAt,
    ],
  };
}

export async function insertStoragePurchase(
  db: Client,
  purchase: StoragePurchaseRecord,
): Promise<void> {
  await db.execute(storagePurchaseInsert(purchase));
}

export async function insertStorageExtensionPurchase(
  db: Client,
  purchase: StoragePurchaseRecord,
  targets: StorageGrantRecord[],
): Promise<void> {
  await db.batch(
    [
      storagePurchaseInsert(purchase),
      {
        sql: "INSERT INTO storage_purchase_extensions (purchase_id) VALUES (?)",
        args: [purchase.id],
      },
      ...targets.map((target) => ({
        sql: `INSERT INTO storage_extension_targets
              (purchase_id, grant_purchase_id) VALUES (?, ?)`,
        args: [purchase.id, target.purchaseId],
      })),
    ],
    "write",
  );
}

export async function insertStorageAlignedPurchase(
  db: Client,
  purchase: StoragePurchaseRecord,
  targetExpiresAt: number,
  targets: StorageAlignmentTargetRecord[],
): Promise<void> {
  await db.batch(
    [
      storagePurchaseInsert(purchase),
      {
        sql: `INSERT INTO storage_purchase_alignments
              (purchase_id, target_expires_at, base_amount_sats, alignment_amount_sats)
              VALUES (?, ?, ?, ?)`,
        args: [
          purchase.id,
          targetExpiresAt,
          purchase.baseAmountSats,
          purchase.alignmentAmountSats,
        ],
      },
      ...targets.map((target) => ({
        sql: `INSERT INTO storage_alignment_targets
              (purchase_id, grant_purchase_id, quota_bytes, original_expires_at, target_expires_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          purchase.id,
          target.grantPurchaseId,
          target.quotaBytes,
          target.originalExpiresAt,
          target.targetExpiresAt,
        ],
      })),
    ],
    "write",
  );
}

export async function getStoragePurchase(
  db: Client,
  id: string,
  pubkey: string,
): Promise<StoragePurchaseRecord | null> {
  const rs = await db.execute({
    sql: `SELECT ${PURCHASE_SELECT_COLUMNS}
          FROM storage_purchases
          WHERE id = ? AND pubkey = ? LIMIT 1`,
    args: [id, pubkey],
  });
  return rs.rows[0] ? rowToPurchase(rs.rows[0]) : null;
}

export async function findPendingStoragePurchase(
  db: Client,
  pubkey: string,
  units: number,
  amountSats: number,
  quotaBytes: number,
  durationSeconds: number,
  now: number,
): Promise<StoragePurchaseRecord | null> {
  const rs = await db.execute({
    sql: `SELECT ${PURCHASE_SELECT_COLUMNS}
          FROM storage_purchases
          WHERE pubkey = ? AND units = ? AND amount_sats = ?
            AND quota_bytes = ? AND duration_seconds = ? AND state = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM storage_purchase_extensions e
              WHERE e.purchase_id = storage_purchases.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM storage_purchase_alignments a
              WHERE a.purchase_id = storage_purchases.id
            )
            AND (invoice_expires IS NULL OR invoice_expires > ?)
          ORDER BY created_at DESC LIMIT 1`,
    args: [pubkey, units, amountSats, quotaBytes, durationSeconds, now],
  });
  return rs.rows[0] ? rowToPurchase(rs.rows[0]) : null;
}

export async function findPendingStorageAlignedPurchase(
  db: Client,
  pubkey: string,
  units: number,
  amountSats: number,
  quotaBytes: number,
  durationSeconds: number,
  now: number,
): Promise<StoragePurchaseRecord | null> {
  const rs = await db.execute({
    sql: `SELECT ${PURCHASE_SELECT_COLUMNS}
          FROM storage_purchases
          WHERE pubkey = ? AND units = ? AND amount_sats = ?
            AND quota_bytes = ? AND duration_seconds = ? AND state = 'pending'
            AND EXISTS (
              SELECT 1 FROM storage_purchase_alignments a
              WHERE a.purchase_id = storage_purchases.id
            )
            AND (invoice_expires IS NULL OR invoice_expires > ?)
          ORDER BY created_at DESC LIMIT 1`,
    args: [pubkey, units, amountSats, quotaBytes, durationSeconds, now],
  });
  return rs.rows[0] ? rowToPurchase(rs.rows[0]) : null;
}

export async function listStorageAlignmentTargets(
  db: Client,
  purchaseId: string,
): Promise<StorageAlignmentTargetRecord[]> {
  const rs = await db.execute({
    sql:
      `SELECT grant_purchase_id, quota_bytes, original_expires_at, target_expires_at
          FROM storage_alignment_targets WHERE purchase_id = ?
          ORDER BY grant_purchase_id`,
    args: [purchaseId],
  });
  return rs.rows.map((row) => ({
    grantPurchaseId: String(row[0]),
    quotaBytes: Number(row[1]),
    originalExpiresAt: Number(row[2]),
    targetExpiresAt: Number(row[3]),
  }));
}

/** Finds an unexpired extension whose immutable grant snapshot exactly matches the current target set. */
export async function findPendingStorageExtensionPurchase(
  db: Client,
  pubkey: string,
  units: number,
  amountSats: number,
  quotaBytes: number,
  durationSeconds: number,
  targetPurchaseIds: string[],
  now: number,
): Promise<StoragePurchaseRecord | null> {
  if (targetPurchaseIds.length === 0) return null;
  const placeholders = targetPurchaseIds.map(() => "?").join(", ");
  const rs = await db.execute({
    sql: `SELECT ${PURCHASE_SELECT_COLUMNS}
          FROM storage_purchases
          WHERE pubkey = ? AND units = ? AND amount_sats = ?
            AND quota_bytes = ? AND duration_seconds = ? AND state = 'pending'
            AND (invoice_expires IS NULL OR invoice_expires > ?)
            AND EXISTS (
              SELECT 1 FROM storage_purchase_extensions e
              WHERE e.purchase_id = storage_purchases.id
            )
            AND (SELECT COUNT(*) FROM storage_extension_targets t
                 WHERE t.purchase_id = storage_purchases.id) = ?
            AND (SELECT COUNT(*) FROM storage_extension_targets t
                 WHERE t.purchase_id = storage_purchases.id
                   AND t.grant_purchase_id IN (${placeholders})) = ?
          ORDER BY created_at DESC LIMIT 1`,
    args: [
      pubkey,
      units,
      amountSats,
      quotaBytes,
      durationSeconds,
      now,
      targetPurchaseIds.length,
      ...targetPurchaseIds,
      targetPurchaseIds.length,
    ],
  });
  return rs.rows[0] ? rowToPurchase(rs.rows[0]) : null;
}

/** Lists purchases owned by one signer so clients can recover checkout IDs after losing local state. */
export async function listStoragePurchases(
  db: Client,
  pubkey: string,
  limit = 100,
): Promise<StoragePurchaseRecord[]> {
  const rs = await db.execute({
    sql: `SELECT ${PURCHASE_SELECT_COLUMNS}
          FROM storage_purchases
          WHERE pubkey = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: [pubkey, limit],
  });
  return rs.rows.map(rowToPurchase);
}

/** Lists a bounded settlement batch independently of any browser request. */
export async function listPendingStoragePurchases(
  db: Client,
  limit = 100,
  pubkey?: string,
): Promise<StoragePurchaseRecord[]> {
  const rs = await db.execute({
    sql: `SELECT ${PURCHASE_SELECT_COLUMNS}
          FROM storage_purchases
          WHERE state = 'pending'
            AND (? IS NULL OR pubkey = ?)
          ORDER BY created_at ASC LIMIT ?`,
    args: [pubkey ?? null, pubkey ?? null, limit],
  });
  return rs.rows.map(rowToPurchase);
}

export async function creditStoragePurchase(
  db: Client,
  purchase: StoragePurchaseRecord,
  now: number,
  treasuryDestination?: string,
): Promise<void> {
  await db.batch(
    [
      {
        sql: `INSERT OR IGNORE INTO storage_grants
              (purchase_id, pubkey, quota_bytes, starts_at, expires_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          purchase.id,
          purchase.pubkey,
          purchase.quotaBytes,
          now,
          now + purchase.durationSeconds,
        ],
      },
      {
        sql: `UPDATE storage_purchases
              SET state = 'paid', paid_at = COALESCE(paid_at, ?), credited_at = COALESCE(credited_at, ?)
              WHERE id = ?`,
        args: [now, now, purchase.id],
      },
      ...treasuryOutboxStatements(purchase, treasuryDestination, now),
    ],
    "write",
  );
}

export async function creditStorageAlignedPurchase(
  db: Client,
  purchase: StoragePurchaseRecord,
  now: number,
  treasuryDestination?: string,
): Promise<void> {
  if (purchase.alignedExpiresAt === null) {
    throw new Error("Aligned storage purchase is missing its target expiry");
  }
  const targets = await listStorageAlignmentTargets(db, purchase.id);
  await db.batch(
    [
      {
        sql: `INSERT OR IGNORE INTO storage_grants
              (purchase_id, pubkey, quota_bytes, starts_at, expires_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          purchase.id,
          purchase.pubkey,
          purchase.quotaBytes,
          now,
          purchase.alignedExpiresAt,
        ],
      },
      ...targets.map((target) => ({
        sql: `UPDATE storage_grants
              SET expires_at = MAX(expires_at, ?)
              WHERE purchase_id = ?
                AND EXISTS (
                  SELECT 1 FROM storage_purchases p
                  WHERE p.id = ? AND p.credited_at IS NULL
                )`,
        args: [
          target.targetExpiresAt,
          target.grantPurchaseId,
          purchase.id,
        ],
      })),
      {
        sql: `UPDATE storage_purchases
              SET state = 'paid', paid_at = COALESCE(paid_at, ?), credited_at = COALESCE(credited_at, ?)
              WHERE id = ?`,
        args: [now, now, purchase.id],
      },
      ...treasuryOutboxStatements(purchase, treasuryDestination, now),
    ],
    "write",
  );
}

export async function creditStorageExtensionPurchase(
  db: Client,
  purchase: StoragePurchaseRecord,
  now: number,
  treasuryDestination?: string,
): Promise<void> {
  const targets = await db.execute({
    sql: `SELECT grant_purchase_id FROM storage_extension_targets
          WHERE purchase_id = ?`,
    args: [purchase.id],
  });
  await db.batch(
    [
      ...targets.rows.map((row) => ({
        sql: `UPDATE storage_grants
              SET expires_at = expires_at + ?
              WHERE purchase_id = ?
                AND EXISTS (
                  SELECT 1 FROM storage_purchases p
                  WHERE p.id = ? AND p.credited_at IS NULL
                )`,
        args: [
          purchase.durationSeconds,
          row[0] as string,
          purchase.id,
        ],
      })),
      {
        sql: `UPDATE storage_purchases
              SET state = 'paid', paid_at = COALESCE(paid_at, ?), credited_at = COALESCE(credited_at, ?)
              WHERE id = ?`,
        args: [now, now, purchase.id],
      },
      ...treasuryOutboxStatements(purchase, treasuryDestination, now),
    ],
    "write",
  );
}

/** Builds the outbox insert included in the same transaction that activates customer storage. */
function treasuryOutboxStatements(
  purchase: StoragePurchaseRecord,
  destination: string | undefined,
  now: number,
) {
  if (!destination) return [];
  return [{
    sql: `INSERT OR IGNORE INTO storage_treasury_transfers
          (purchase_id, destination, gross_amount_sats, state, next_attempt_at,
           lease_until, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', ?, 0, ?, ?)`,
    args: [purchase.id, destination, purchase.amountSats, now, now, now],
  }];
}

export async function expireStoragePurchase(
  db: Client,
  id: string,
): Promise<void> {
  await db.execute({
    sql:
      "UPDATE storage_purchases SET state = 'expired' WHERE id = ? AND state = 'pending'",
    args: [id],
  });
}

export async function getStorageQuotaSummary(
  db: Client,
  pubkey: string,
  now: number,
): Promise<StorageQuotaSummary> {
  const rs = await db.execute({
    sql: `SELECT
      COALESCE((SELECT SUM(quota_bytes) FROM storage_grants WHERE pubkey = ? AND expires_at > ?), 0),
      COALESCE((SELECT SUM(b.size) FROM owners o JOIN blobs b ON b.sha256 = o.blob WHERE o.pubkey = ?), 0),
      COALESCE((SELECT SUM(size_bytes) FROM upload_reservations WHERE pubkey = ? AND expires_at > ?), 0),
      (SELECT MAX(expires_at) FROM storage_grants WHERE pubkey = ? AND expires_at > ?)`,
    args: [pubkey, now, pubkey, pubkey, now, pubkey, now],
  });
  const row = rs.rows[0];
  const quotaBytes = Number(row?.[0] ?? 0);
  const usedBytes = Number(row?.[1] ?? 0);
  const reservedBytes = Number(row?.[2] ?? 0);
  return {
    quotaBytes,
    usedBytes,
    reservedBytes,
    availableBytes: Math.max(0, quotaBytes - usedBytes - reservedBytes),
    expiresAt: row?.[3] === null || row?.[3] === undefined
      ? null
      : Number(row[3]),
  };
}

export async function listActiveStorageGrants(
  db: Client,
  pubkey: string,
  now: number,
): Promise<StorageGrantRecord[]> {
  const rs = await db.execute({
    sql: `SELECT purchase_id, quota_bytes, starts_at, expires_at
          FROM storage_grants
          WHERE pubkey = ? AND expires_at > ?
          ORDER BY expires_at ASC, purchase_id ASC`,
    args: [pubkey, now],
  });
  return rs.rows.map((row) => ({
    purchaseId: row[0] as string,
    quotaBytes: Number(row[1]),
    startsAt: Number(row[2]),
    expiresAt: Number(row[3]),
  }));
}

export async function reserveStorageQuota(
  db: Client,
  input: {
    id: string;
    pubkey: string;
    sizeBytes: number;
    now: number;
    expiresAt: number;
  },
): Promise<boolean> {
  await db.execute({
    sql: "DELETE FROM upload_reservations WHERE expires_at <= ?",
    args: [input.now],
  });
  const rs = await db.execute({
    sql: `INSERT INTO upload_reservations (id, pubkey, size_bytes, expires_at)
          SELECT ?, ?, ?, ?
          WHERE ? <=
            COALESCE((SELECT SUM(quota_bytes) FROM storage_grants WHERE pubkey = ? AND expires_at > ?), 0)
            - COALESCE((SELECT SUM(b.size) FROM owners o JOIN blobs b ON b.sha256 = o.blob WHERE o.pubkey = ?), 0)
            - COALESCE((SELECT SUM(size_bytes) FROM upload_reservations WHERE pubkey = ? AND expires_at > ?), 0)`,
    args: [
      input.id,
      input.pubkey,
      input.sizeBytes,
      input.expiresAt,
      input.sizeBytes,
      input.pubkey,
      input.now,
      input.pubkey,
      input.pubkey,
      input.now,
    ],
  });
  return (rs.rowsAffected ?? 0) > 0;
}

/**
 * Renews one live upload reservation while atomically revalidating the user's
 * current grants, owned bytes, and every competing reservation.
 */
export async function renewStorageReservation(
  db: Client,
  input: {
    id: string;
    pubkey: string;
    sizeBytes: number;
    now: number;
    expiresAt: number;
  },
): Promise<boolean> {
  const rs = await db.execute({
    sql: `UPDATE upload_reservations
          SET size_bytes = ?, expires_at = ?
          WHERE id = ? AND pubkey = ?
            AND ? <=
              COALESCE((SELECT SUM(quota_bytes) FROM storage_grants WHERE pubkey = ? AND expires_at > ?), 0)
              - COALESCE((SELECT SUM(b.size) FROM owners o JOIN blobs b ON b.sha256 = o.blob WHERE o.pubkey = ?), 0)
              - COALESCE((SELECT SUM(size_bytes) FROM upload_reservations WHERE pubkey = ? AND id != ? AND expires_at > ?), 0)`,
    args: [
      input.sizeBytes,
      input.expiresAt,
      input.id,
      input.pubkey,
      input.sizeBytes,
      input.pubkey,
      input.now,
      input.pubkey,
      input.pubkey,
      input.id,
      input.now,
    ],
  });
  return (rs.rowsAffected ?? 0) === 1;
}

export async function releaseStorageReservation(
  db: Client,
  id: string,
): Promise<void> {
  await db.execute({
    sql: "DELETE FROM upload_reservations WHERE id = ?",
    args: [id],
  });
}

export async function hasActivePaidOwner(
  db: Client,
  sha256: string,
  now: number,
): Promise<boolean> {
  const rs = await db.execute({
    sql: `SELECT 1
          FROM owners o
          JOIN storage_grants g ON g.pubkey = o.pubkey
          WHERE o.blob = ? AND g.expires_at > ?
          LIMIT 1`,
    args: [sha256, now],
  });
  return rs.rows.length > 0;
}
