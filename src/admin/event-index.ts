import type { Client } from "@libsql/client";
import type { NostrEvent } from "nostr-tools";
import { nip19 } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { verifyEvent } from "nostr-tools/pure";
import type { AdminBlobRecord } from "../db/blobs.ts";

const HEX_EVENT_RE = /^[a-f0-9]{64}$/i;
const BLOB_PATH_RE = /^\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i;
const pool = new SimplePool();
const OWNER_EVENT_CACHE_MS = 5 * 60_000;
const ownerEventCache = new Map<
  string,
  { expiresAt: number; events: NostrEvent[] }
>();

export interface IndexedEventResult {
  event: NostrEvent;
  linked: EventBlobReference[];
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

export interface AdminProfileSummary {
  name?: string;
  display_name?: string;
  displayName?: string;
  picture?: string;
  image?: string;
  nip05?: string;
  about?: string;
}

export interface IndexedEventsSummary {
  events: number;
  links: number;
}

/** Human-readable title used by cards and the durable moderation search index. */
export function getEventTitle(event: NostrEvent): string {
  return event.tags.find((tag) => tag[0] === "title")?.[1] ||
    event.tags.find((tag) => tag[0] === "name")?.[1] ||
    event.tags.find((tag) => tag[0] === "subject")?.[1] ||
    `Event ${event.id.slice(0, 12)}…`;
}

/** Select the same author name precedence used by the Fanfares client. */
export function getProfileName(profile?: AdminProfileSummary): string {
  return profile?.displayName || profile?.display_name || profile?.name || "";
}

/** Mirrors the content labels used by the Fanfares client. */
export function getEventKindLabel(kind: number): string {
  const labels: Record<number, string> = {
    1: "Note",
    1338: "Podcast Announcement",
    1808: "Audio Stem",
    30023: "Article",
    31337: "Music Track",
    31338: "Podcast Episode",
    31339: "Audiobook",
    32123: "Wavlake Track",
    36787: "Music Track",
  };
  return labels[kind] ?? `Kind ${kind}`;
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
  publicDomain: string | string[],
): EventBlobReference[] {
  const hostnames = new Set(
    (Array.isArray(publicDomain) ? publicDomain : [publicDomain]).map((
      domain,
    ) =>
      new URL(domain.includes("://") ? domain : `https://${domain}`).hostname
        .toLowerCase()
    ),
  );
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
        const match = hostnames.has(url.hostname.toLowerCase())
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
  options: { maxWait?: number; force?: boolean } = {},
): Promise<NostrEvent[]> {
  if (pubkeys.length === 0 || relays.length === 0) return [];
  const authors = [...new Set(pubkeys)];
  const now = Date.now();
  const cached: NostrEvent[] = [];
  const missing: string[] = [];
  for (const author of authors) {
    const entry = ownerEventCache.get(author);
    if (!options.force && entry && entry.expiresAt > now) {
      cached.push(...entry.events);
    } else {
      missing.push(author);
    }
  }
  if (missing.length === 0) return cached;

  try {
    const events = await pool.querySync(relays, {
      authors: missing,
      limit: 1000,
    }, { maxWait: options.maxWait ?? 750 });
    const verified = events.filter((event) =>
      event.tags.some((tag) => tag[0] === "imeta") && verifyEvent(event)
    );
    const byAuthor = Map.groupBy(verified, (event) => event.pubkey);
    for (const author of missing) {
      ownerEventCache.set(author, {
        expiresAt: now + OWNER_EVENT_CACHE_MS,
        events: byAuthor.get(author) ?? [],
      });
    }
    return [...cached, ...verified];
  } catch {
    return cached;
  }
}

/** Join physical blob rows to the signed events whose imeta URL fields reference them. */
export function groupBlobsByEvents(
  blobs: AdminBlobRecord[],
  events: NostrEvent[],
  publicDomain: string | string[],
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
    const title = getEventTitle(event);
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

/** Persist verified relay events and their searchable moderation metadata. */
export async function indexEventsForAdmin(
  db: Client,
  events: NostrEvent[],
  profiles: ReadonlyMap<string, AdminProfileSummary | undefined>,
  publicDomain: string | string[],
): Promise<IndexedEventsSummary> {
  let indexedEvents = 0;
  let indexedLinks = 0;
  for (const event of events) {
    if (!verifyEvent(event)) continue;
    const references = extractEventBlobReferences(event, publicDomain);
    if (references.length === 0) continue;
    const profile = profiles.get(event.pubkey);
    const title = getEventTitle(event);
    const authorName = getProfileName(profile);
    const summary = event.tags.find((tag) => tag[0] === "summary")?.[1] || "";
    const searchText = [
      title,
      summary,
      event.content.slice(0, 4_000),
      authorName,
      profile?.nip05 ?? "",
      profile?.about?.slice(0, 1_000) ?? "",
      ...references.map((reference) => reference.name ?? ""),
    ].filter(Boolean).join(" ").slice(0, 8_000);

    const statements: Array<{
      sql: string;
      args: Array<string | number>;
    }> = [
      {
        sql:
          `INSERT INTO admin_events (event_id, pubkey, kind, created_at, indexed_at)
            VALUES (?, ?, ?, ?, unixepoch())
            ON CONFLICT(event_id) DO UPDATE SET indexed_at = unixepoch()`,
        args: [event.id, event.pubkey, event.kind, event.created_at],
      },
      {
        sql: "DELETE FROM admin_event_blobs WHERE event_id = ?",
        args: [event.id],
      },
    ];
    const linkResultIndexes: number[] = [];
    for (const reference of references) {
      linkResultIndexes.push(statements.length);
      statements.push(
        {
          sql:
            `INSERT OR IGNORE INTO admin_event_blobs (event_id, blob, encrypted)
              SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?)`,
          args: [
            event.id,
            reference.sha256,
            reference.encrypted ? 1 : 0,
            reference.sha256,
          ],
        },
        {
          sql:
            `INSERT OR REPLACE INTO admin_event_blob_metadata (event_id, blob, name)
              SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?)`,
          args: [
            event.id,
            reference.sha256,
            reference.name ?? reference.role ?? "",
            reference.sha256,
          ],
        },
      );
    }
    statements.push({
      sql: `INSERT INTO admin_event_search
            (event_id, title, author_name, author_nip05, search_text, refreshed_at)
            VALUES (?, ?, ?, ?, ?, unixepoch())
            ON CONFLICT(event_id) DO UPDATE SET
              title = excluded.title,
              author_name = CASE WHEN excluded.author_name != '' THEN excluded.author_name ELSE admin_event_search.author_name END,
              author_nip05 = CASE WHEN excluded.author_nip05 != '' THEN excluded.author_nip05 ELSE admin_event_search.author_nip05 END,
              search_text = excluded.search_text,
              refreshed_at = unixepoch()`,
      args: [
        event.id,
        title,
        authorName,
        profile?.nip05 ?? "",
        searchText,
      ],
    });
    const results = await db.batch(statements, "write");
    indexedLinks += linkResultIndexes.filter((index) =>
      (results[index].rowsAffected ?? 0) > 0
    ).length;
    indexedEvents += 1;
  }
  return { events: indexedEvents, links: indexedLinks };
}

/** Fetches one signed event, persists its existing blob links, and reports missing files. */
export async function inspectAndIndexEvent(
  db: Client,
  identifier: string,
  relays: string[],
  publicDomain: string | string[],
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
  const statements: Array<{
    sql: string;
    args: Array<string | number>;
  }> = [
    {
      sql:
        `INSERT INTO admin_events (event_id, pubkey, kind, created_at, indexed_at)
            VALUES (?, ?, ?, ?, unixepoch())
            ON CONFLICT(event_id) DO UPDATE SET indexed_at = unixepoch()`,
      args: [event.id, event.pubkey, event.kind, event.created_at],
    },
    {
      sql: "DELETE FROM admin_event_blobs WHERE event_id = ?",
      args: [event.id],
    },
  ];
  const linkResultIndexes: number[] = [];
  for (const reference of references) {
    linkResultIndexes.push(statements.length);
    statements.push({
      sql: `INSERT OR IGNORE INTO admin_event_blobs (event_id, blob, encrypted)
              SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?)`,
      args: [
        event.id,
        reference.sha256,
        reference.encrypted ? 1 : 0,
        reference.sha256,
      ],
    });
  }
  const title = getEventTitle(event);
  const searchText = [
    title,
    event.tags.find((tag) => tag[0] === "summary")?.[1] ?? "",
    event.content.slice(0, 4_000),
    ...references.map((reference) => reference.name ?? ""),
  ].filter(Boolean).join(" ").slice(0, 8_000);
  statements.push({
    sql: `INSERT INTO admin_event_search
          (event_id, title, author_name, author_nip05, search_text, refreshed_at)
          VALUES (?, ?, '', '', ?, unixepoch())
          ON CONFLICT(event_id) DO UPDATE SET title = excluded.title,
            search_text = excluded.search_text, refreshed_at = excluded.refreshed_at`,
    args: [event.id, title, searchText],
  });
  for (const reference of references) {
    statements.push({
      sql:
        `INSERT OR REPLACE INTO admin_event_blob_metadata (event_id, blob, name)
            SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?)`,
      args: [
        event.id,
        reference.sha256,
        reference.name ?? reference.role ?? "",
        reference.sha256,
      ],
    });
  }
  const results = await db.batch(statements, "write");
  references.forEach((reference, index) => {
    if ((results[linkResultIndexes[index]].rowsAffected ?? 0) > 0) {
      linked.push(reference);
    } else {
      missing.push(reference.sha256);
    }
  });
  return { event, linked, missing };
}
