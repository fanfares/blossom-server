import { assertEquals } from "@std/assert";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { concat, NEVER, of, Subject, throwError } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import {
  eventStore,
  fetchUserProfile,
  fetchUserProfiles,
  lookupRelays$,
  pool,
} from "../../src/admin/nostr-profile.ts";
import { getProfileName } from "../../src/admin/event-index.ts";
import { EventCard } from "../../src/admin/event-card.tsx";
import { Hono } from "@hono/hono";

Deno.test("malformed signed profiles render a fallback event card without crashing", async () => {
  const previous = lookupRelays$.value;
  lookupRelays$.next([]);
  try {
    for (
      const metadata of [
        { name: 42, displayName: [], picture: {} },
        null,
        [],
        "text",
        {
          name: "Safe",
          picture: "javascript:alert(1)",
          image: "data:text/html,bad",
        },
      ]
    ) {
      const event = finalizeEvent({
        kind: 0,
        created_at: 1,
        tags: [],
        content: JSON.stringify(metadata),
      }, generateSecretKey());
      eventStore.add(event);
      const profile = await fetchUserProfile(event.pubkey);
      const app = new Hono();
      app.get("/", async (c) =>
        c.html(
          (await EventCard({
            group: {
              event,
              title: "Test",
              blobs: [],
              totalSize: 0,
              encryptedCount: 0,
            },
            profile: profile ?? undefined,
            publicDomain: "staging.blossom.fanfares.live",
            blobBaseUrl: "https://blobs.example.com",
          })) ?? "",
        ));
      const response = await app.request("/");
      assertEquals(response.status, 200);
      const body = await response.text();
      assertEquals(body.includes("Publisher") || body.includes("Safe"), true);
      assertEquals(body.includes('src="javascript:'), false);
      assertEquals(body.includes('src="data:'), false);
    }
  } finally {
    lookupRelays$.next(previous);
  }
});

Deno.test("profile boundary rejects malformed fields and preserves legitimate aliases", async () => {
  const sk = generateSecretKey();
  const event = finalizeEvent({
    kind: 0,
    created_at: 1,
    tags: [],
    content: JSON.stringify({
      name: 42,
      displayName: {},
      display_name: " Author ",
      picture: 17,
      image: "https://example.com/avatar.png",
      nip05: "author@example.com",
      about: " Bio ",
    }),
  }, sk);
  eventStore.add(event);
  const previous = lookupRelays$.value;
  lookupRelays$.next([]);
  try {
    const profiles = await fetchUserProfiles([event.pubkey]);
    const profile = profiles.get(event.pubkey);
    assertEquals(profile, {
      display_name: "Author",
      image: "https://example.com/avatar.png",
      nip05: "author@example.com",
      about: "Bio",
    });
    assertEquals(getProfileName(profile), "Author");
    assertEquals(
      profile?.displayName || profile?.display_name || profile?.name,
      "Author",
    );
  } finally {
    lookupRelays$.next(previous);
  }
});

Deno.test("a slower concurrent lookup cannot overwrite a freshly updated profile", async () => {
  const sk = generateSecretKey();
  const old = finalizeEvent({
    kind: 0,
    created_at: 1,
    tags: [],
    content: '{"name":"Old"}',
  }, sk);
  const fresh = finalizeEvent({
    kind: 0,
    created_at: 2,
    tags: [],
    content: '{"name":"New"}',
  }, sk);
  eventStore.add(old);
  const previousRelays = lookupRelays$.value;
  const request = pool.request;
  const slow = new Subject<NostrEvent>();
  const fast = new Subject<NostrEvent>();
  lookupRelays$.next(["wss://example.com"]);
  let requests = 0;
  pool.request = () => ++requests === 1 ? slow : fast;
  try {
    const slowResult = fetchUserProfile(old.pubkey, 4000, true);
    const fastResult = fetchUserProfile(old.pubkey, 750, true);
    fast.next(fresh);
    fast.complete();
    assertEquals(await fastResult, { name: "New" });
    slow.next(old);
    slow.complete();
    assertEquals(await slowResult, { name: "New" });
    assertEquals(await fetchUserProfile(old.pubkey), { name: "New" });
  } finally {
    slow.complete();
    fast.complete();
    pool.request = request;
    lookupRelays$.next(previousRelays);
  }
});

Deno.test("forced profile refresh fetches newer signed metadata and preserves safe identity on failures", async () => {
  const sk = generateSecretKey();
  const old = finalizeEvent({
    kind: 0,
    created_at: 10,
    tags: [],
    content: '{"name":"Old"}',
  }, sk);
  const fresh = finalizeEvent({
    kind: 0,
    created_at: 20,
    tags: [],
    content: '{"display_name":"New","nip05":"new@example.com"}',
  }, sk);
  eventStore.add(old);
  const previousRelays = lookupRelays$.value;
  const request = pool.request;
  lookupRelays$.next([]);
  try {
    assertEquals((await fetchUserProfile(old.pubkey))?.name, "Old");
    lookupRelays$.next(["wss://example.com"]);
    let requests = 0;
    pool.request = () => {
      requests++;
      return of(fresh);
    };
    const expected = { display_name: "New", nip05: "new@example.com" };
    assertEquals(await fetchUserProfile(old.pubkey, 20, true), expected);
    assertEquals(requests, 1);
    const other = finalizeEvent({
      kind: 0,
      created_at: 30,
      tags: [],
      content: '{"name":"Other"}',
    }, generateSecretKey());
    pool.request = () =>
      of(old, other, { ...fresh, content: '{"name":"Forged"}' });
    assertEquals(await fetchUserProfile(old.pubkey, 20, true), expected);
    pool.request = () => throwError(() => new Error("offline"));
    assertEquals(await fetchUserProfile(old.pubkey, 20, true), expected);
    pool.request = () => NEVER;
    assertEquals(await fetchUserProfile(old.pubkey, 5, true), expected);
    const newer = finalizeEvent({
      kind: 0,
      created_at: 40,
      tags: [],
      content: '{"name":"Newest"}',
    }, sk);
    pool.request = () => concat(of(newer), NEVER);
    assertEquals(await fetchUserProfile(old.pubkey, 5, true), {
      name: "Newest",
    });
  } finally {
    pool.request = request;
    lookupRelays$.next(previousRelays);
  }
});
