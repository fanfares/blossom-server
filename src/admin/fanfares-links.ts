import type { NostrEvent } from "nostr-tools";
import { nip19 } from "nostr-tools";

/** Select the matching Fanfares frontend for this Blossom deployment. */
export function getFanfaresBaseUrl(publicDomain: string): string {
  const hostname = publicDomain.toLowerCase().split(":")[0];
  return hostname === "staging.blossom.fanfares.live" ||
      hostname.startsWith("staging.")
    ? "https://staging.fanfares.io"
    : "https://fanfares.io";
}

/** Fanfares event page for any signed event, including non-addressable kinds. */
export function getFanfaresEventUrl(
  event: Pick<NostrEvent, "id" | "pubkey">,
  publicDomain: string,
): string {
  const nevent = nip19.neventEncode({ id: event.id, author: event.pubkey });
  return `${getFanfaresBaseUrl(publicDomain)}/e/${nevent}`;
}

/** Fanfares profile page for a hex Nostr public key. */
export function getFanfaresProfileUrl(
  pubkey: string,
  publicDomain: string,
): string {
  return `${getFanfaresBaseUrl(publicDomain)}/p/${nip19.npubEncode(pubkey)}`;
}
