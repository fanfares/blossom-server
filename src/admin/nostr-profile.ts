/**
 * Nostr profile metadata lookup for the admin dashboard.
 *
 * Exports bare module-level singletons following the standard applesauce
 * pattern. Lookup relays are held in a BehaviorSubject; explicit bounded
 * requests refresh existing profiles as well as retrieve missing ones.
 *
 * This module is only imported when the admin dashboard is enabled.
 */

import { EventStore } from "applesauce-core/event-store";
import { RelayPool } from "applesauce-relay";
import {
  BehaviorSubject,
  catchError,
  EMPTY,
  firstValueFrom,
  take,
  takeUntil,
  timer,
  toArray,
} from "rxjs";
import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";
import type { AdminProfileSummary } from "./event-index.ts";

// ── Singletons ────────────────────────────────────────────────────────────────

export const eventStore = new EventStore();

export const pool = new RelayPool({
  keepAlive: 10_000,
  eoseTimeout: 8_000,
});

/** Update this subject at any time to change the relays used for profile lookup. */
export const lookupRelays$ = new BehaviorSubject<string[]>([]);

const PROFILE_CACHE_MS = 5 * 60_000;
const PROFILE_RETRY_MS = 15_000;
const MAX_CACHED_PROFILES = 2_000;
const pendingProfiles = new Map<string, Promise<AdminProfileSummary | null>>();
const profileCache = new Map<
  string,
  { expiresAt: number; profile: AdminProfileSummary | null }
>();

/** Relay metadata is JSON, never a trusted object with computed profile getters. */
export function normalizeProfile(content: string): AdminProfileSummary | null {
  if (content.length > 64_000) return null;
  try {
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const fields = raw as Record<string, unknown>;
    const profile: AdminProfileSummary = {};
    for (
      const key of [
        "name",
        "display_name",
        "displayName",
        "picture",
        "image",
        "nip05",
        "about",
      ] as const
    ) {
      const value = fields[key];
      if (
        typeof value === "string" &&
        value.length <= (key === "about" ? 8_000 : 2_048)
      ) {
        profile[key] = value.trim();
      }
    }
    for (const key of ["picture", "image"] as const) {
      if (!profile[key]) continue;
      try {
        const url = new URL(profile[key]!);
        if (
          !["http:", "https:"].includes(url.protocol) || url.username ||
          url.password
        ) delete profile[key];
      } catch {
        delete profile[key];
      }
    }
    return profile;
  } catch {
    return null;
  }
}

function validProfileEvent(event: NostrEvent, pubkey: string): boolean {
  try {
    return event.kind === 0 && event.pubkey === pubkey &&
      Number.isSafeInteger(event.created_at) && event.created_at >= 0 &&
      event.created_at <= Math.floor(Date.now() / 1000) + 300 &&
      typeof event.content === "string" && event.content.length <= 64_000 &&
      verifyEvent({
        id: event.id,
        pubkey: event.pubkey,
        sig: event.sig,
        kind: event.kind,
        created_at: event.created_at,
        tags: event.tags,
        content: event.content,
      });
  } catch {
    return false;
  }
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch Nostr kind:0 profile metadata for a single pubkey.
 *
 * Checks the in-process EventStore cache first (synchronous, zero latency).
 * Falls back to relay fetch, bounded by `timeout`. Returns null on timeout or
 * any error — the caller always gets a result quickly.
 */
export async function fetchUserProfile(
  pubkey: string,
  timeout = 4_000,
  force = false,
): Promise<AdminProfileSummary | null> {
  const cached = profileCache.get(pubkey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.profile;
  const pendingKey = `${pubkey}:${timeout}:${force}`;
  const pending = pendingProfiles.get(pendingKey);
  if (pending) return pending;
  const lookup = (async () => {
    let newest = eventStore.getReplaceable(0, pubkey);
    if (newest && !validProfileEvent(newest, pubkey)) newest = undefined;
    let received = false;
    try {
      if (lookupRelays$.value.length > 0 && (force || cached || !newest)) {
        const events = await firstValueFrom(
          pool.request(lookupRelays$.value, {
            kinds: [0],
            authors: [pubkey],
            limit: 1,
          }).pipe(
            take(100),
            takeUntil(timer(timeout)),
            catchError(() => EMPTY),
            toArray(),
          ),
        );
        for (const event of events) {
          if (
            !validProfileEvent(event, pubkey) ||
            !normalizeProfile(event.content)
          ) continue;
          received = true;
          if (
            !newest || event.created_at > newest.created_at ||
            (event.created_at === newest.created_at && event.id < newest.id)
          ) {
            newest = event;
          }
        }
      }
    } catch {
      // Relay failures retain the last known identity.
    }
    // A concurrent lookup may have refreshed the store while this request
    // awaited its relays. Never overwrite that newer identity with our snapshot.
    const current = eventStore.getReplaceable(0, pubkey);
    if (
      current && validProfileEvent(current, pubkey) &&
      (!newest || current.created_at > newest.created_at ||
        (current.created_at === newest.created_at && current.id < newest.id))
    ) {
      newest = current;
    }
    if (newest) eventStore.add(newest);
    const profile = newest ? normalizeProfile(newest.content) : null;
    const fallback = profile ?? cached?.profile ?? null;
    if (profileCache.size >= MAX_CACHED_PROFILES && !profileCache.has(pubkey)) {
      profileCache.delete(profileCache.keys().next().value!);
    }
    profileCache.set(pubkey, {
      expiresAt: Date.now() +
        (profile && (!force || received) ? PROFILE_CACHE_MS : PROFILE_RETRY_MS),
      profile: fallback,
    });
    return fallback;
  })();
  pendingProfiles.set(pendingKey, lookup);
  try {
    return await lookup;
  } finally {
    pendingProfiles.delete(pendingKey);
  }
}

/**
 * Fetch Nostr kind:0 profile metadata for multiple pubkeys in parallel.
 *
 * Duplicate pubkeys share one lookup; all distinct lookups run concurrently. Each is individually bounded
 * by `timeout` — a slow relay for one pubkey never delays others.
 * Failed lookups retain the last safe identity, or return undefined if none exists.
 */
export async function fetchUserProfiles(
  pubkeys: string[],
  timeout = 4_000,
  force = false,
): Promise<Map<string, AdminProfileSummary | undefined>> {
  const result = new Map<string, AdminProfileSummary | undefined>();
  if (pubkeys.length === 0) return result;

  const uniquePubkeys = [...new Set(pubkeys)];
  const profiles = await Promise.all(
    uniquePubkeys.map((pubkey) => fetchUserProfile(pubkey, timeout, force)),
  );
  uniquePubkeys.forEach((pubkey, index) =>
    result.set(pubkey, profiles[index] ?? undefined)
  );

  return result;
}
