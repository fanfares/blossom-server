import type { Client } from "@libsql/client";
import { renewStorageReservation } from "../db/paid-storage.ts";

export interface StorageReservationLease {
  /** Stop background renewal after the route releases the reservation. */
  stop(): void;
  /** Revalidate quota with the worker's exact byte count before committing. */
  verify(sizeBytes: number): Promise<boolean>;
}

/**
 * Keeps an in-flight upload's quota reservation alive and exposes a final,
 * atomic capacity check before the blob is committed to durable storage.
 */
export function startStorageReservationLease(
  db: Client,
  input: {
    id: string;
    pubkey: string;
    sizeBytes: number;
    ttlSeconds: number;
  },
): StorageReservationLease {
  let stopped = false;
  let healthy = true;
  let sizeBytes = input.sizeBytes;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const intervalMs = Math.max(1_000, Math.floor(input.ttlSeconds * 1000 / 3));

  const renew = async (): Promise<boolean> => {
    if (stopped || !healthy) return false;
    const now = Math.floor(Date.now() / 1000);
    try {
      healthy = await renewStorageReservation(db, {
        id: input.id,
        pubkey: input.pubkey,
        sizeBytes,
        now,
        expiresAt: now + input.ttlSeconds,
      });
    } catch {
      healthy = false;
    }
    return healthy;
  };

  const schedule = () => {
    timer = setTimeout(async () => {
      if (await renew()) schedule();
    }, intervalMs);
  };
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    async verify(actualSizeBytes: number) {
      sizeBytes = actualSizeBytes;
      // A transient background-renewal failure must not doom the upload: the
      // final check is authoritative, so always re-ask the database here. If
      // the reservation row truly expired, the renewal UPDATE matches nothing
      // and this still fails closed.
      healthy = true;
      return await renew();
    },
  };
}
