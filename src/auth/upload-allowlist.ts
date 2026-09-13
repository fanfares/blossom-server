/**
 * Pubkey allowlist for write operations (upload / media / mirror).
 *
 * BUD-11 auth proves that *some* nostr key signed the request; it does not
 * prove the signer is one of our users. Without this gate any generated
 * keypair can store bytes in our bucket and serve them from our domain. The
 * allowlist closes that by checking the signer against a nostr contact list
 * (kind:3) published by a curator pubkey — the same list the Fanfares API uses
 * for early-access gating — so the set of people who may upload is exactly the
 * set who may use the app.
 *
 * Reads are deliberately untouched: buyers must always be able to fetch blobs.
 *
 * Failure policy is fail-closed: if the list cannot be resolved and no
 * usable cached copy remains, writes are refused (503) rather than allowed.
 * A stale cached list is preferred over refusing, up to `staleSeconds`, so a
 * relay hiccup does not stop legitimate uploads.
 */

import { HTTPException } from "@hono/hono/http-exception";
import { RelayPool } from "applesauce-relay";
import { lastValueFrom, take, timeout as rxTimeout, toArray } from "rxjs";
import { verifyEvent } from "nostr-tools/pure";
import type { Config, UploadAllowlistConfig } from "../config/schema.ts";
import { debug } from "../middleware/debug.ts";

/** Resolves the current set of allowed pubkeys, or throws. */
export type AllowlistFetcher = () => Promise<Set<string>>;

export interface UploadAllowlist {
  /**
   * Throws unless the given pubkey may perform write operations.
   *
   * @param pubkey Hex pubkey taken from the verified BUD-11 auth event.
   */
  assertAllowed(pubkey: string): Promise<void>;
}

interface CachedList {
  pubkeys: Set<string>;
  fetchedAtMs: number;
}

/**
 * Reads a kind:3 contact list from relays and returns the pubkeys it follows.
 *
 * Only `p` tags are counted, per NIP-02. The newest event wins when relays
 * disagree. A valid signed empty list revokes membership; an absent or invalid
 * response fails closed instead of becoming authorization data.
 *
 * @param config Allowlist configuration supplying curator pubkey, relays and timeout.
 * @param pool Relay pool used to issue the request.
 * @returns The set of followed pubkeys.
 */
export async function fetchContactListPubkeys(
  config: UploadAllowlistConfig,
  pool: RelayPool,
): Promise<Set<string>> {
  if (!config.listPubkey) {
    throw new Error("uploadAllowlist.listPubkey is not configured");
  }
  if (config.relays.length === 0) {
    throw new Error("uploadAllowlist.relays is empty");
  }

  const events = await lastValueFrom(
    pool
      .request(config.relays, {
        kinds: [3],
        authors: [config.listPubkey],
      })
      .pipe(rxTimeout(config.timeoutMs), take(1001), toArray()),
  );

  if (events.length > 1000) {
    throw new Error("contact-list response exceeded the event limit");
  }
  const now = Math.floor(Date.now() / 1000);

  let newest: { created_at: number; tags: string[][] } | undefined;
  for (const event of events) {
    try {
      if (
        event.kind !== 3 || event.pubkey !== config.listPubkey.toLowerCase() ||
        !Number.isSafeInteger(event.created_at) || event.created_at < 0 ||
        event.created_at > now + 60 ||
        !verifyEvent(event)
      ) continue;
    } catch {
      continue;
    }
    if (!newest || event.created_at > newest.created_at) newest = event;
  }

  if (!newest) {
    throw new Error("no kind:3 contact list found for the configured pubkey");
  }

  const pubkeys = new Set<string>();
  for (const tag of newest.tags) {
    if (tag[0] === "p" && /^[0-9a-f]{64}$/i.test(tag[1] ?? "")) {
      pubkeys.add(tag[1].toLowerCase());
    }
  }

  return pubkeys;
}

/**
 * Builds an allowlist enforcer over the supplied configuration.
 *
 * The fetcher and clock are injectable so the caching, staleness and
 * fail-closed behaviour can be tested without relays or real time.
 *
 * @param config Allowlist settings.
 * @param fetcher Resolves the current allowed set; called at most once per refresh window.
 * @param now Millisecond clock, injectable for tests.
 * @returns An enforcer exposing {@link UploadAllowlist.assertAllowed}.
 */
export function createUploadAllowlist(
  config: UploadAllowlistConfig,
  fetcher: AllowlistFetcher,
  now: () => number = Date.now,
): UploadAllowlist {
  const extra = new Set(config.extraPubkeys.map((key) => key.toLowerCase()));
  let cached: CachedList | undefined;
  let inFlight: Promise<Set<string>> | undefined;

  /**
   * Returns the allowed set, refreshing it when the cache has aged out.
   *
   * Concurrent callers share a single in-flight refresh. On refresh failure a
   * cached list is reused while it is within the stale window; otherwise the
   * error propagates so the caller can fail closed.
   *
   * @returns The current allowed pubkey set.
   */
  async function resolveList(): Promise<Set<string>> {
    const nowMs = now();
    if (cached && nowMs - cached.fetchedAtMs < config.refreshSeconds * 1000) {
      return cached.pubkeys;
    }

    if (!inFlight) {
      inFlight = fetcher()
        .then((pubkeys) => {
          cached = { pubkeys, fetchedAtMs: now() };
          debug("[allowlist]", `refreshed: ${pubkeys.size} pubkeys`);
          return pubkeys;
        })
        .finally(() => {
          inFlight = undefined;
        });
    }

    try {
      return await inFlight;
    } catch (error) {
      const stale = cached;
      if (stale && now() - stale.fetchedAtMs < config.staleSeconds * 1000) {
        console.warn(
          "Upload allowlist refresh failed; serving cached list",
          error,
        );
        return stale.pubkeys;
      }
      throw error;
    }
  }

  return {
    async assertAllowed(pubkey: string): Promise<void> {
      if (!config.enabled) return;

      const normalized = pubkey.toLowerCase();
      if (extra.has(normalized)) return;

      // Enabled with no list source is a misconfiguration. Refuse writes
      // rather than silently reverting to open uploads; reads keep working.
      if (!config.listPubkey) {
        console.warn(
          "uploadAllowlist.enabled is true but no listPubkey is configured; refusing writes",
        );
        throw new HTTPException(503, {
          message: "Upload authorization is unavailable",
        });
      }

      let allowed: Set<string>;
      try {
        allowed = await resolveList();
      } catch (error) {
        console.warn("Upload allowlist unavailable; refusing write", error);
        throw new HTTPException(503, {
          message: "Upload authorization is unavailable",
        });
      }

      if (!allowed.has(normalized)) {
        throw new HTTPException(403, {
          message: "This pubkey is not authorized to upload to this server",
        });
      }
    },
  };
}

let singleton: UploadAllowlist | undefined;
let singletonPool: RelayPool | undefined;

/**
 * Enforces the allowlist for a write request, lazily building the shared
 * enforcer (and its relay pool) on first use.
 *
 * Route handlers call this immediately after BUD-11 auth succeeds. It is a
 * no-op when the allowlist is disabled, which keeps the upstream default
 * behaviour unchanged for other deployments.
 *
 * @param config Full server config.
 * @param pubkey Hex pubkey from the verified auth event.
 */
export async function assertUploadAllowed(
  config: Config,
  pubkey: string,
): Promise<void> {
  if (!config.uploadAllowlist.enabled) return;

  if (!singleton) {
    singletonPool = new RelayPool({ keepAlive: 10_000, eoseTimeout: 8_000 });
    const allowlistConfig = config.uploadAllowlist;
    singleton = createUploadAllowlist(
      allowlistConfig,
      () => fetchContactListPubkeys(allowlistConfig, singletonPool!),
    );
  }

  await singleton.assertAllowed(pubkey);
}
