import type { Client } from "@libsql/client";

export function approvedMintUrls(
  configured: string,
  additional: string[],
): string[] {
  return [...new Set([configured, ...additional])];
}

export async function getActiveMint(
  db: Client,
  configured: string,
): Promise<string> {
  const result = await db.execute(
    "SELECT mint_url FROM admin_mint_settings WHERE id = 1",
  );
  return result.rows[0] ? String(result.rows[0][0]) : configured;
}

export async function getPurchaseMint(
  db: Client,
  purchaseId: string,
  configured: string,
): Promise<string> {
  const result = await db.execute({
    sql: "SELECT mint_url FROM storage_purchase_mints WHERE purchase_id = ?",
    args: [purchaseId],
  });
  return result.rows[0] ? String(result.rows[0][0]) : configured;
}

/** Atomically snapshot legacy purchases before activating an operator-approved mint. */
export function mintChangeStatements(
  mintUrl: string,
  actor: string,
  configured: string,
  additional: string[],
) {
  if (!approvedMintUrls(configured, additional).includes(mintUrl)) {
    throw new Error("Select a mint approved in server configuration.");
  }
  if (!/^[a-f0-9]{64}$/.test(actor)) {
    throw new Error("Verified administrator required.");
  }
  const now = Math.floor(Date.now() / 1000);
  return [
    {
      sql:
        "INSERT OR IGNORE INTO storage_purchase_mints (purchase_id, mint_url) SELECT id, ? FROM storage_purchases",
      args: [configured],
    },
    {
      sql:
        `INSERT INTO admin_mint_audit (mint_url, previous_mint_url, changed_at, changed_by)
      VALUES (?, COALESCE((SELECT mint_url FROM admin_mint_settings WHERE id = 1), ?), ?, ?)`,
      args: [mintUrl, configured, now, actor],
    },
    {
      sql:
        `INSERT INTO admin_mint_settings (id, mint_url, updated_at, updated_by) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mint_url=excluded.mint_url, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      args: [mintUrl, now, actor],
    },
  ];
}

export async function setActiveMint(
  db: Client,
  mintUrl: string,
  actor: string,
  configured: string,
  additional: string[],
) {
  await db.batch(
    mintChangeStatements(mintUrl, actor, configured, additional),
    "write",
  );
}
