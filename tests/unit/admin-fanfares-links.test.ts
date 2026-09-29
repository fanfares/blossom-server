import { assertEquals } from "@std/assert";
import { nip19 } from "nostr-tools";
import {
  getFanfaresBaseUrl,
  getFanfaresEventUrl,
  getFanfaresProfileUrl,
} from "../../src/admin/fanfares-links.ts";

Deno.test("admin links follow the matching Fanfares environment", () => {
  const id = "1".repeat(64);
  const pubkey = "2".repeat(64);
  const nevent = nip19.neventEncode({ id, author: pubkey });
  const npub = nip19.npubEncode(pubkey);
  assertEquals(
    getFanfaresBaseUrl("staging.blossom.fanfares.live"),
    "https://staging.fanfares.io",
  );
  assertEquals(
    getFanfaresEventUrl({ id, pubkey }, "staging.blossom.fanfares.live"),
    `https://staging.fanfares.io/e/${nevent}`,
  );
  assertEquals(
    getFanfaresProfileUrl(pubkey, "blossom.fanfares.live"),
    `https://fanfares.io/p/${npub}`,
  );
});
