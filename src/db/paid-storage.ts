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
  ) THEN 'extension' ELSE 'new' END
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
            AND (invoice_expires IS NULL OR invoice_expires > ?)
          ORDER BY created_at DESC LIMIT 1`,
    args: [pubkey, units, amountSats, quotaBytes, durationSeconds, now],
  });
  return rs.rows[0] ? rowToPurchase(rs.rows[0]) : null;
}

export async function creditStoragePurchase(
  db: Client,
  purchase: StoragePurchaseRecord,
  now: number,
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
    ],
    "write",
  );
}

export async function creditStorageExtensionPurchase(
  db: Client,
  purchase: StoragePurchaseRecord,
  now: number,
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
    ],
    "write",
  );
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
