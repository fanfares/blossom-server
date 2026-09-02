import type { Client } from "@libsql/client";
import type { NostrEvent } from "nostr-tools";
import { nip19 } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { verifyEvent } from "nostr-tools/pure";

const HEX_EVENT_RE = /^[a-f0-9]{64}$/i;
const BLOB_PATH_RE = /^\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i;
const pool = new SimplePool();

export interface IndexedEventResult {
  event: NostrEvent;
  linked: Array<{ sha256: string; encrypted: boolean }>;
  missing: string[];
}

/** Converts a hex, note, nevent, or naddr identifier into a relay query filter. */
export function eventIdentifierToFilter(
  identifier: string,
): Record<string, unknown> {
  const value = identifier.trim();
  if (HEX_EVENT_RE.test(value)) return { ids: [value.toLowerCase()] };
  const decoded = nip19.decode(value);
  if (decoded.type === "note") return { ids: [decoded.data] };
  if (decoded.type === "nevent") return { ids: [decoded.data.id] };
  if (decoded.type === "naddr") {
    return {
      kinds: [decoded.data.kind],
      authors: [decoded.data.pubkey],
      "#d": [decoded.data.identifier],
    };
  }
  throw new Error("Use an event hex ID, note, nevent, or naddr identifier.");
}

/** Extracts this Blossom server's referenced hashes and whether each imeta marks encryption. */
export function extractEventBlobReferences(
  event: NostrEvent,
  publicDomain: string,
): Array<{ sha256: string; encrypted: boolean }> {
  const hostname = new URL(
    publicDomain.includes("://") ? publicDomain : `https://${publicDomain}`,
  ).hostname.toLowerCase();
  const references = new Map<string, boolean>();
  for (const tag of event.tags) {
    const encrypted = tag[0] === "imeta" &&
      tag.some((field) =>
        field === "encrypted" || field.startsWith("encrypted ")
      );
    for (const field of tag.slice(1)) {
      const candidate = field.startsWith("url ") ? field.slice(4) : field;
      try {
        const url = new URL(candidate);
        const match = url.hostname.toLowerCase() === hostname
          ? url.pathname.match(BLOB_PATH_RE)
          : null;
        if (match) {
          references.set(
            match[1].toLowerCase(),
            encrypted || references.get(match[1].toLowerCase()) === true,
          );
        }
      } catch {
        // Non-URL tag fields are expected and ignored.
      }
    }
  }
  return [...references].map(([sha256, encrypted]) => ({ sha256, encrypted }));
}

/** Fetches one signed event, persists its existing blob links, and reports missing files. */
export async function inspectAndIndexEvent(
  db: Client,
  identifier: string,
  relays: string[],
  publicDomain: string,
): Promise<IndexedEventResult> {
  if (relays.length === 0) {
    throw new Error("No dashboard lookup relays are configured.");
  }
  const filter = eventIdentifierToFilter(identifier);
  const events = await pool.querySync(relays, { ...filter, limit: 1 }, {
    maxWait: 5_000,
  });
  const event = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!event) throw new Error("Event was not found on the configured relays.");
  if (!verifyEvent(event)) {
    throw new Error("Relay returned an invalid event signature.");
  }
  const references = extractEventBlobReferences(event, publicDomain);
  const linked: IndexedEventResult["linked"] = [];
  const missing: string[] = [];
  await db.execute("BEGIN");
  try {
    await db.execute({
      sql:
        `INSERT OR REPLACE INTO admin_events (event_id, pubkey, kind, created_at, indexed_at)
            VALUES (?, ?, ?, ?, unixepoch())`,
      args: [event.id, event.pubkey, event.kind, event.created_at],
    });
    await db.execute({
      sql: "DELETE FROM admin_event_blobs WHERE event_id = ?",
      args: [event.id],
    });
    for (const reference of references) {
      const result = await db.execute({
        sql:
          `INSERT OR IGNORE INTO admin_event_blobs (event_id, blob, encrypted)
              SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?)`,
        args: [
          event.id,
          reference.sha256,
          reference.encrypted ? 1 : 0,
          reference.sha256,
        ],
      });
      if ((result.rowsAffected ?? 0) > 0) linked.push(reference);
      else missing.push(reference.sha256);
    }
    await db.execute("COMMIT");
  } catch (error) {
    await db.execute("ROLLBACK");
    throw error;
  }
  return { event, linked, missing };
}
