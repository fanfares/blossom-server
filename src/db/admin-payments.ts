import { mintChangeStatements } from "./storage-mints.ts";
import type { Client } from "@libsql/client";

export function validateTreasuryDestination(value: string): string {
  const destination = value.trim();
  if (
    destination.length > 254 ||
    !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(destination)
  ) {
    throw new Error("Enter a Lightning address such as wallet@example.com.");
  }
  return destination;
}

export async function getTreasuryDestination(
  db: Client,
  fallback: string,
): Promise<string> {
  const result = await db.execute(
    "SELECT destination FROM admin_treasury_settings WHERE id = 1",
  );
  return result.rows[0] ? String(result.rows[0][0]) : fallback;
}

export async function setTreasuryDestination(
  db: Client,
  destination: string,
  actor: string,
  fallback: string,
  mint?: { url: string; configured: string; approved: string[] },
): Promise<void> {
  destination = validateTreasuryDestination(destination);
  if (!/^[a-f0-9]{64}$/.test(actor)) {
    throw new Error("Verified administrator required.");
  }
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    ...(mint
      ? mintChangeStatements(mint.url, actor, mint.configured, mint.approved)
      : []),
    {
      sql:
        `INSERT INTO admin_treasury_audit (destination, previous_destination, changed_at, changed_by)
      VALUES (?, COALESCE((SELECT destination FROM admin_treasury_settings WHERE id = 1), ?), ?, ?)`,
      args: [destination, fallback, now, actor],
    },
    {
      sql:
        `INSERT INTO admin_treasury_settings (id, destination, updated_at, updated_by) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET destination = excluded.destination, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      args: [destination, now, actor],
    },
  ], "write");
}

export async function listAdminPayments(
  db: Client,
  page: number,
  pubkey = "",
  state = "",
) {
  const where: string[] = [];
  const args: string[] = [];
  if (pubkey) {
    where.push("p.pubkey = ?");
    args.push(pubkey);
  }
  if (["pending", "paid", "expired", "failed"].includes(state)) {
    where.push("p.state = ?");
    args.push(state);
  }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count, summary] = await Promise.all([
    db.execute({
      sql:
        `SELECT p.id, p.pubkey, p.amount_sats, p.quota_bytes, p.duration_seconds, p.state,
      p.created_at, p.credited_at,
      (SELECT m.mint_url FROM storage_purchase_mints m WHERE m.purchase_id=p.id) AS mint_url,
      EXISTS(SELECT 1 FROM storage_purchase_extensions e WHERE e.purchase_id = p.id) AS is_extension,
      (SELECT target_expires_at FROM storage_purchase_alignments a WHERE a.purchase_id = p.id) AS aligned_expires_at,
      (SELECT expires_at FROM storage_grants g WHERE g.purchase_id = p.id) AS grant_expires_at,
      t.destination, t.state AS transfer_state, t.forwarded_amount_sats,
      t.attempt_count, t.forwarded_at FROM storage_purchases p
      LEFT JOIN storage_treasury_transfers t ON t.purchase_id = p.id ${filter}
      ORDER BY p.created_at DESC, p.id DESC LIMIT 50 OFFSET ?`,
      args: [...args, (page - 1) * 50],
    }),
    db.execute({
      sql: `SELECT COUNT(*) FROM storage_purchases p ${filter}`,
      args,
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS purchases,
      COALESCE(SUM(CASE WHEN p.credited_at IS NOT NULL THEN p.amount_sats ELSE 0 END), 0) AS paid,
      COALESCE(SUM(CASE WHEN t.state = 'paid' THEN t.forwarded_amount_sats ELSE 0 END), 0) AS forwarded,
      COALESCE(SUM(CASE WHEN t.state IN ('pending','processing') THEN 1 ELSE 0 END),0) AS waiting
      FROM storage_purchases p LEFT JOIN storage_treasury_transfers t ON t.purchase_id = p.id ${filter}`,
      args,
    }),
  ]);
  return {
    rows: rows.rows,
    total: Number(count.rows[0][0]),
    summary: summary.rows[0],
  };
}
