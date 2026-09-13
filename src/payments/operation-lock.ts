import type { Client } from "@libsql/client";

export type PersistPayment = <T>(
  action: (db: Client) => Promise<T>,
) => Promise<T>;

/** Serialize invoice issuance across processes and fence persistence after a reclaimed lease. */
export async function withPaymentOperation<T>(
  db: Client,
  resource: string,
  action: (persist: PersistPayment) => Promise<T>,
): Promise<T> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + 20_000;
  while (true) {
    const now = Date.now();
    const result = await db.execute({
      sql:
        `INSERT INTO payment_operation_locks (resource, token, expires_at) VALUES (?, ?, ?)
            ON CONFLICT(resource) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
            WHERE payment_operation_locks.expires_at <= ?`,
      args: [resource, token, now + 60_000, now],
    });
    if (result.rowsAffected === 1) break;
    if (Date.now() >= deadline) {
      throw new RangeError("Another checkout is in progress; retry shortly");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const persist: PersistPayment = async (save) => {
    const tx = await db.transaction("write");
    try {
      const lock = await tx.execute({
        sql:
          "SELECT 1 FROM payment_operation_locks WHERE resource = ? AND token = ? AND expires_at > ?",
        args: [resource, token, Date.now()],
      });
      if (lock.rows.length !== 1) {
        throw new Error("Checkout lease lost; quote was not published");
      }
      const result = await save(tx as unknown as Client);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  };
  try {
    return await action(persist);
  } finally {
    await db.execute({
      sql:
        "DELETE FROM payment_operation_locks WHERE resource = ? AND token = ?",
      args: [resource, token],
    });
  }
}

/** Durable fixed-window limits include unsuccessful external calls, without charging cache hits. */
export async function consumePaymentRateLimit(
  db: Client,
  kind: "quote" | "verify",
  pubkey: string,
): Promise<void> {
  const window = Math.floor(Date.now() / 60_000);
  const tx = await db.transaction("write");
  try {
    for (
      const [resource, limit] of [[
        `${kind}:global`,
        kind === "quote" ? 100 : 600,
      ], [`${kind}:${pubkey}`, kind === "quote" ? 10 : 60]] as const
    ) {
      const result = await tx.execute({
        sql:
          `INSERT INTO payment_rate_limits (resource, window_start, attempts) VALUES (?, ?, 1)
              ON CONFLICT(resource) DO UPDATE SET window_start = excluded.window_start,
                attempts = CASE WHEN window_start = excluded.window_start THEN attempts + 1 ELSE 1 END
              WHERE window_start != excluded.window_start OR attempts < ?`,
        args: [resource, window, limit],
      });
      if (result.rowsAffected !== 1) {
        throw new RangeError(
          "Payment request limit reached; retry in one minute",
        );
      }
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}
