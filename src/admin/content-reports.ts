import type { Client } from "@libsql/client";
import type { NostrEvent } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { verifyEvent } from "nostr-tools/pure";
import { REPORT_TYPES } from "../db/reports.ts";
import { nip19 } from "nostr-tools";
import { getFanfaresBaseUrl, getFanfaresProfileUrl } from "./fanfares-links.ts";

export interface ReportTarget {
  type: "e" | "a" | "p";
  value: string;
  reason: string;
}
const HEX = /^[a-f0-9]{64}$/;

/** Only signed, bounded NIP-56 reports become moderation records. Claims are not verdicts. */
export function parseContentReport(event: NostrEvent): ReportTarget[] {
  if (
    event.kind !== 1984 || typeof event.content !== "string" ||
    event.content.length > 8000 || !Array.isArray(event.tags) ||
    event.tags.length > 100 ||
    !Number.isSafeInteger(event.created_at) || event.created_at < 0 ||
    event.created_at > Math.floor(Date.now() / 1000) + 300
  ) return [];
  // Recheck canonical fields rather than accepting nostr-tools' cached verification symbol.
  try {
    if (
      !verifyEvent({
        id: event.id,
        pubkey: event.pubkey,
        sig: event.sig,
        kind: event.kind,
        content: event.content,
        tags: event.tags,
        created_at: event.created_at,
      })
    ) return [];
  } catch {
    return [];
  }
  const fallbackReason = event.tags.find((tag) =>
    tag[0] === "p" &&
    REPORT_TYPES.includes(tag[2] as typeof REPORT_TYPES[number])
  )?.[2] ?? "other";
  const targets: ReportTarget[] = [];
  for (const tag of event.tags) {
    const type = tag[0];
    const value = tag[1] ?? "";
    const reason = REPORT_TYPES.includes(tag[2] as typeof REPORT_TYPES[number])
      ? tag[2]
      : fallbackReason;
    if ((type === "e" || type === "p") && HEX.test(value)) {
      targets.push({ type, value, reason });
    }
    if (type === "a" && value.length <= 1024) {
      const [kind, pubkey] = value.split(":");
      if (
        /^\d{1,5}$/.test(kind) && Number(kind) >= 30000 &&
        Number(kind) < 40000 && HEX.test(pubkey) &&
        value.split(":").length >= 3 &&
        new TextEncoder().encode(value.split(":").slice(2).join(":")).length <=
          255
      ) targets.push({ type, value, reason });
    }
  }
  return [
    ...new Map(
      targets.map((target) => [`${target.type}:${target.value}`, target]),
    ).values(),
  ];
}

export function reportTargetUrl(
  target: ReportTarget,
  publicDomain: string,
): string {
  if (target.type === "p") {
    return getFanfaresProfileUrl(target.value, publicDomain);
  }
  if (target.type === "e") {
    return `${getFanfaresBaseUrl(publicDomain)}/e/${
      nip19.neventEncode({ id: target.value })
    }`;
  }
  const [kind, pubkey, ...identifier] = target.value.split(":");
  const naddr = nip19.naddrEncode({
    kind: Number(kind),
    pubkey,
    identifier: identifier.join(":"),
  });
  return `${getFanfaresBaseUrl(publicDomain)}/e/${naddr}`;
}

export async function indexContentReports(
  db: Client,
  events: NostrEvent[],
): Promise<number> {
  const statements = [];
  for (const event of events.slice(0, 1000)) {
    const targets = parseContentReport(event);
    if (!targets.length) continue;
    statements.push({
      sql: `INSERT OR IGNORE INTO admin_content_reports
      (event_id, reporter, content, created_at, targets_json) VALUES (?, ?, ?, ?, ?)`,
      args: [
        event.id,
        event.pubkey,
        event.content,
        event.created_at,
        JSON.stringify(targets),
      ],
    });
  }
  if (!statements.length) return 0;
  const results = await db.batch(statements, "write");
  return results.reduce((sum, result) => sum + result.rowsAffected, 0);
}

/** Explicit bounded sync: page navigation always uses persisted reports, never waits on relays. */
export async function refreshContentReports(db: Client, relays: string[]) {
  const [owners, indexed] = await Promise.all([
    db.execute("SELECT DISTINCT pubkey FROM owners LIMIT 1001"),
    db.execute(
      "SELECT event_id FROM admin_events ORDER BY indexed_at DESC LIMIT 1001",
    ),
  ]);
  const pubkeys = owners.rows.slice(0, 1000).map((row) => String(row[0]));
  const ids = indexed.rows.slice(0, 1000).map((row) => String(row[0]));
  const pool = new SimplePool();
  try {
    const queries = [];
    if (pubkeys.length) {
      queries.push({ kinds: [1984], "#p": pubkeys, limit: 1000 });
    }
    if (ids.length) queries.push({ kinds: [1984], "#e": ids, limit: 1000 });
    if (!queries.length) return { added: 0, limited: false };
    const results = await Promise.all(
      queries.map((filter) =>
        pool.querySync(relays, filter, { maxWait: 3000 })
      ),
    );
    const events = [
      ...new Map(
        results.flatMap((events) => events.slice(0, 1000)).map((
          event,
        ) => [event.id, event]),
      ).values(),
    ];
    // Relay filters are hints: independently enforce local target scope.
    const local = events.filter((event) =>
      parseContentReport(event).some((target) =>
        target.type === "p"
          ? pubkeys.includes(target.value)
          : target.type === "e"
          ? ids.includes(target.value)
          : pubkeys.includes(target.value.split(":")[1])
      )
    );
    return {
      added: await indexContentReports(db, local),
      limited: owners.rows.length > 1000 || indexed.rows.length > 1000 ||
        results.some((events) => events.length >= 1000) || local.length > 1000,
    };
  } finally {
    pool.close(relays);
  }
}
