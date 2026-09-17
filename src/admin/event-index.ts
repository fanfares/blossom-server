import type { Client } from "@libsql/client";
import type { NostrEvent } from "nostr-tools";
import { nip19 } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { verifyEvent } from "nostr-tools/pure";
import type { AdminBlobRecord } from "../db/blobs.ts";

const HEX_EVENT_RE = /^[a-f0-9]{64}$/i;
const BLOB_PATH_RE = /^\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i;
const pool = new SimplePool();

export interface IndexedEventResult {
  event: NostrEvent;
  linked: Array<{ sha256: string; encrypted: boolean }>;
  missing: string[];
}

export interface EventBlobReference {
  sha256: string;
  encrypted: boolean;
  name?: string;
  role?: "preview" | "artwork" | "image";
  chunkIndex: number;
  chunkCount: number;
}

export interface AdminEventGroup {
  event: NostrEvent;
  title: string;
  blobs: Array<{ blob: AdminBlobRecord; reference: EventBlobReference }>;
  totalSize: number;
  encryptedCount: number;
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
): EventBlobReference[] {
  const hostname = new URL(
    publicDomain.includes("://") ? publicDomain : `https://${publicDomain}`,
  ).hostname.toLowerCase();
  const references = new Map<string, EventBlobReference>();
  for (const tag of event.tags) {
    if (tag[0] !== "imeta") continue;
    const encrypted = tag[0] === "imeta" &&
      tag.some((field) =>
        field === "encrypted" || field.startsWith("encrypted ")
      );
    const urlFields = tag.slice(1).filter((field) => field.startsWith("url "));
    const name = tag.find((field) => field.startsWith("name "))?.slice(5)
      .trim() || undefined;
    const role = tag.includes("preview")
      ? "preview"
      : tag.includes("artwork")
      ? "artwork"
      : tag.includes("image")
      ? "image"
      : undefined;
    for (const [urlIndex, field] of urlFields.entries()) {
      const candidate = field.slice(4);
      try {
        const url = new URL(candidate);
        const match = url.hostname.toLowerCase() === hostname
          ? url.pathname.match(BLOB_PATH_RE)
          : null;
        if (match) {
          const sha256 = match[1].toLowerCase();
          const previous = references.get(sha256);
          references.set(sha256, {
            sha256,
            encrypted: encrypted || previous?.encrypted === true,
            name: name ?? previous?.name,
            role: role ?? previous?.role,
            chunkIndex: urlIndex + 1,
            chunkCount: urlFields.length,
          });
        }
      } catch {
        // Non-URL tag fields are expected and ignored.
      }
    }
  }
  return [...references.values()];
}

/** Fetch recent signed events authored by owners represented on the current blob page. */
export async function fetchOwnerEvents(
  pubkeys: string[],
  relays: string[],
): Promise<NostrEvent[]> {
  if (pubkeys.length === 0 || relays.length === 0) return [];
  try {
    const events = await pool.querySync(relays, {
      authors: [...new Set(pubkeys)],
      limit: 1000,
    }, { maxWait: 4_000 });
    return events.filter((event) =>
      event.tags.some((tag) => tag[0] === "imeta") && verifyEvent(event)
    );
  } catch {
    return [];
  }
}

/** Join physical blob rows to the signed events whose imeta URL fields reference them. */
export function groupBlobsByEvents(
  blobs: AdminBlobRecord[],
  events: NostrEvent[],
  publicDomain: string,
): { groups: AdminEventGroup[]; ungrouped: AdminBlobRecord[] } {
  const blobsByHash = new Map(
    blobs.map((blob) => [blob.sha256.toLowerCase(), blob]),
  );
  const groupedHashes = new Set<string>();
  const groups = events.flatMap((event): AdminEventGroup[] => {
    const references = extractEventBlobReferences(event, publicDomain);
    const matched = references.flatMap((reference) => {
      const blob = blobsByHash.get(reference.sha256);
      return blob ? [{ blob, reference }] : [];
    });
    if (matched.length === 0) return [];
    matched.forEach(({ blob }) => groupedHashes.add(blob.sha256.toLowerCase()));
    const title = event.tags.find((tag) => tag[0] === "title")?.[1] ||
      event.tags.find((tag) => tag[0] === "name")?.[1] ||
      event.tags.find((tag) => tag[0] === "subject")?.[1] ||
      `Event ${event.id.slice(0, 12)}…`;
    return [{
      event,
      title,
      blobs: matched.sort((a, b) => b.blob.uploaded - a.blob.uploaded),
      totalSize: matched.reduce((total, { blob }) => total + blob.size, 0),
      encryptedCount: matched.filter(({ reference }) =>
        reference.encrypted
      ).length,
    }];
  }).sort((a, b) => b.event.created_at - a.event.created_at);
  return {
    groups,
    ungrouped: blobs.filter((blob) =>
      !groupedHashes.has(blob.sha256.toLowerCase())
    ),
  };
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
