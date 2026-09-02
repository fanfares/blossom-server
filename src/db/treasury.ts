import type { Client } from "@libsql/client";

export interface TreasuryTransferRecord {
  purchaseId: string;
  destination: string;
  grossAmountSats: number;
  state: "pending" | "processing" | "paid";
  mintPreviewJson: string | null;
  proofsJson: string | null;
  meltPreviewJson: string | null;
  forwardedAmountSats: number | null;
  feeReserveSats: number | null;
  attemptCount: number;
  nextAttemptAt: number;
  leaseUntil: number;
}

/** Maps a libSQL result row into the durable treasury transfer used by the retry worker. */
function rowToTransfer(
  row: { [index: number]: unknown },
): TreasuryTransferRecord {
  return {
    purchaseId: String(row[0]),
    destination: String(row[1]),
    grossAmountSats: Number(row[2]),
    state: row[3] as TreasuryTransferRecord["state"],
    mintPreviewJson: row[4] === null ? null : String(row[4]),
    proofsJson: row[5] === null ? null : String(row[5]),
    meltPreviewJson: row[6] === null ? null : String(row[6]),
    forwardedAmountSats: row[7] === null ? null : Number(row[7]),
    feeReserveSats: row[8] === null ? null : Number(row[8]),
    attemptCount: Number(row[9]),
    nextAttemptAt: Number(row[10]),
    leaseUntil: Number(row[11]),
  };
}

const TRANSFER_COLUMNS = `purchase_id, destination, gross_amount_sats, state,
  mint_preview_json, proofs_json, melt_preview_json, forwarded_amount_sats,
  fee_reserve_sats, attempt_count, next_attempt_at, lease_until`;

/** Lists due outbox IDs for the treasury sweep invoked by the server retry loop. */
export async function listDueTreasuryTransferIds(
  db: Client,
  now: number,
  limit: number,
): Promise<string[]> {
  const result = await db.execute({
    sql: `SELECT purchase_id FROM storage_treasury_transfers
          WHERE state != 'paid' AND next_attempt_at <= ?
            AND (state = 'pending' OR lease_until <= ?)
          ORDER BY next_attempt_at, created_at LIMIT ?`,
    args: [now, now, limit],
  });
  return result.rows.map((row) => String(row[0]));
}

/** Atomically leases one due transfer so request-time and background retries cannot pay it concurrently. */
export async function claimTreasuryTransfer(
  db: Client,
  purchaseId: string,
  now: number,
  leaseSeconds: number,
): Promise<TreasuryTransferRecord | null> {
  const claimed = await db.execute({
    sql: `UPDATE storage_treasury_transfers
          SET state = 'processing', lease_until = ?, attempt_count = attempt_count + 1, updated_at = ?
          WHERE purchase_id = ? AND state != 'paid' AND next_attempt_at <= ?
            AND (state = 'pending' OR lease_until <= ?)`,
    args: [now + leaseSeconds, now, purchaseId, now, now],
  });
  if (claimed.rowsAffected !== 1) return null;
  const result = await db.execute({
    sql:
      `SELECT ${TRANSFER_COLUMNS} FROM storage_treasury_transfers WHERE purchase_id = ?`,
    args: [purchaseId],
  });
  return result.rows[0] ? rowToTransfer(result.rows[0]) : null;
}

/** Persists replay-safe Cashu claim data immediately before or after minting proofs. */
export async function saveTreasuryClaim(
  db: Client,
  purchaseId: string,
  now: number,
  input: { mintPreviewJson?: string; proofsJson?: string },
): Promise<void> {
  await db.execute({
    sql: `UPDATE storage_treasury_transfers SET
            mint_preview_json = COALESCE(?, mint_preview_json),
            proofs_json = COALESCE(?, proofs_json), updated_at = ?
          WHERE purchase_id = ? AND state = 'processing'`,
    args: [
      input.mintPreviewJson ?? null,
      input.proofsJson ?? null,
      now,
      purchaseId,
    ],
  });
}

/** Persists a replay-safe Lightning melt preview before the treasury invoice is paid. */
export async function saveTreasuryMelt(
  db: Client,
  purchaseId: string,
  now: number,
  meltPreviewJson: string,
  forwardedAmountSats: number,
  feeReserveSats: number,
): Promise<void> {
  await db.execute({
    sql: `UPDATE storage_treasury_transfers SET melt_preview_json = ?,
            forwarded_amount_sats = ?, fee_reserve_sats = ?, updated_at = ?
          WHERE purchase_id = ? AND state = 'processing'`,
    args: [
      meltPreviewJson,
      forwardedAmountSats,
      feeReserveSats,
      now,
      purchaseId,
    ],
  });
}

/** Marks a treasury payout complete after the Cashu mint reports the Lightning invoice paid. */
export async function completeTreasuryTransfer(
  db: Client,
  purchaseId: string,
  now: number,
  changeProofsJson: string,
  paymentPreimage: string | null,
): Promise<void> {
  await db.execute({
    sql: `UPDATE storage_treasury_transfers SET state = 'paid', lease_until = 0,
            change_proofs_json = ?, payment_preimage = ?, last_error = NULL,
            updated_at = ?, forwarded_at = ? WHERE purchase_id = ?`,
    args: [changeProofsJson, paymentPreimage, now, now, purchaseId],
  });
}

/**
 * Discards a melt preview whose Lightning invoice can never be paid, so the next
 * sweep prepares a fresh invoice from the still-persisted proofs. Callers must
 * hold the processing lease and must have confirmed the quote is terminally
 * UNPAID with the mint first — clearing a payable preview risks a double payout.
 */
export async function clearTreasuryMelt(
  db: Client,
  purchaseId: string,
  now: number,
): Promise<void> {
  await db.execute({
    sql: `UPDATE storage_treasury_transfers SET melt_preview_json = NULL,
            forwarded_amount_sats = NULL, fee_reserve_sats = NULL, updated_at = ?
          WHERE purchase_id = ? AND state = 'processing'`,
    args: [now, purchaseId],
  });
}

/** Releases a failed payout attempt with capped exponential backoff for a later server sweep. */
export async function retryTreasuryTransfer(
  db: Client,
  purchaseId: string,
  attemptCount: number,
  now: number,
  error: string,
): Promise<void> {
  const delay = Math.min(3600, 30 * 2 ** Math.min(attemptCount - 1, 7));
  await db.execute({
    sql:
      `UPDATE storage_treasury_transfers SET state = 'pending', lease_until = 0,
            next_attempt_at = ?, last_error = ?, updated_at = ? WHERE purchase_id = ? AND state != 'paid'`,
    args: [now + delay, error.slice(0, 1000), now, purchaseId],
  });
}
