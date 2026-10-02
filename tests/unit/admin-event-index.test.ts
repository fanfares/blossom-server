/**
 * @module Admin event indexing
 * @covers Event identifier decoding and extraction of encrypted/public Blossom references
 * @dependencies nostr-tools NIP-19 codec
 * @type unit | deno
 */

import { assertEquals } from "@std/assert";
import { nip19 } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";
import type { Client } from "@libsql/client";
import { join } from "@std/path";
import { initDb } from "../../src/db/client.ts";
import { insertBlob, listAllBlobs, listAllUsers } from "../../src/db/blobs.ts";
import {
  eventIdentifierToFilter,
  extractEventBlobReferences,
  getEventKindLabel,
  groupBlobsByEvents,
  indexEventsForAdmin,
} from "../../src/admin/event-index.ts";

Deno.test("event kinds use the same content labels as the Fanfares client", () => {
  assertEquals(getEventKindLabel(30023), "Article");
  assertEquals(getEventKindLabel(31337), "Music Track");
  assertEquals(getEventKindLabel(36787), "Music Track");
  assertEquals(getEventKindLabel(31338), "Podcast Episode");
  assertEquals(getEventKindLabel(31339), "Audiobook");
  assertEquals(getEventKindLabel(42), "Kind 42");
});

Deno.test("metadata refresh uses one atomic write batch", async () => {
  const hash = "a".repeat(64);
  const event = finalizeEvent({
    kind: 31338,
    created_at: 1_000,
    content: "Episode summary",
    tags: [["title", "A searchable episode"], [
      "imeta",
      `url https://blossom.example/${hash}.bin`,
      "name Chapter One",
    ]],
  }, generateSecretKey());
  let batches = 0;
  const db = {
    batch: (statements: unknown[]) => {
      batches += 1;
      return Promise.resolve(statements.map(() => ({ rowsAffected: 1 })));
    },
    execute: () => {
      throw new Error(
        "metadata indexing must not use connection-level SQL transactions",
      );
    },
  } as unknown as Client;

  const result = await indexEventsForAdmin(
    db,
    [event],
    new Map([[event.pubkey, { name: "fftester" }]]),
    "blossom.example",
  );

  assertEquals(batches, 1);
  assertEquals(result, { events: 1, links: 1 });
});

Deno.test("event identifiers support hex, note, nevent, and naddr searches", () => {
  const id = "1".repeat(64);
  const pubkey = "2".repeat(64);
  assertEquals(eventIdentifierToFilter(id), { ids: [id] });
  assertEquals(eventIdentifierToFilter(nip19.noteEncode(id)), { ids: [id] });
  assertEquals(eventIdentifierToFilter(nip19.neventEncode({ id })), {
    ids: [id],
  });
  assertEquals(
    eventIdentifierToFilter(
      nip19.naddrEncode({ kind: 30023, pubkey, identifier: "article" }),
    ),
    { kinds: [30023], authors: [pubkey], "#d": ["article"] },
  );
});

Deno.test("event extraction keeps only this server and classifies each imeta", () => {
  const encryptedHash = "a".repeat(64);
  const publicHash = "b".repeat(64);
  const event = {
    tags: [
      [
        "imeta",
        `url https://blossom.example/${encryptedHash}.bin`,
        "encrypted aes-256-gcm",
      ],
      [
        "imeta",
        `url https://blobs.blossom.example/${publicHash}.jpg`,
        "preview",
      ],
      [
        "imeta",
        `url https://attacker.example/${"c".repeat(64)}.jpg`,
        "encrypted",
      ],
    ],
  } as NostrEvent;
  assertEquals(
    extractEventBlobReferences(event, [
      "blossom.example",
      "blobs.blossom.example",
    ]),
    [
      {
        sha256: encryptedHash,
        encrypted: true,
        name: undefined,
        role: undefined,
        chunkIndex: 1,
        chunkCount: 1,
      },
      {
        sha256: publicHash,
        encrypted: false,
        name: undefined,
        role: "preview",
        chunkIndex: 1,
        chunkCount: 1,
      },
    ],
  );
});

Deno.test("admin blobs group under events while unmatched uploads remain visible", () => {
  const groupedHash = "a".repeat(64);
  const otherHash = "b".repeat(64);
  const owner = "c".repeat(64);
  const makeBlob = (sha256: string, size: number) => ({
    sha256,
    size,
    type: "application/octet-stream",
    uploaded: 1_000,
    owners: [owner],
    events: [],
  });
  const event = {
    id: "d".repeat(64),
    sig: "e".repeat(128),
    pubkey: owner,
    kind: 30023,
    created_at: 900,
    content: "",
    tags: [["title", "Grouped publication"], [
      "imeta",
      `url http://localhost:3001/${groupedHash}.bin`,
      "name Chapter One",
      "encrypted aes-256-gcm",
    ]],
  } as NostrEvent;

  const result = groupBlobsByEvents(
    [makeBlob(groupedHash, 42), makeBlob(otherHash, 7)],
    [event],
    "localhost:3001",
  );
  assertEquals(result.groups[0].title, "Grouped publication");
  assertEquals(result.groups[0].totalSize, 42);
  assertEquals(result.groups[0].encryptedCount, 1);
  assertEquals(result.groups[0].blobs[0].reference.name, "Chapter One");
  assertEquals(result.ungrouped.map((blob) => blob.sha256), [otherHash]);
});

Deno.test("admin blob queries search and filter persisted event relationships", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_admin_index_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  const hash = "a".repeat(64);
  const eventId = "b".repeat(64);
  const pubkey = "c".repeat(64);
  try {
    await insertBlob(
      db,
      {
        sha256: hash,
        size: 42,
        type: "application/octet-stream",
        uploaded: 1_000,
      },
      pubkey,
    );
    await db.batch([
      {
        sql:
          "INSERT INTO admin_events (event_id, pubkey, kind, created_at, indexed_at) VALUES (?, ?, ?, ?, ?)",
        args: [eventId, pubkey, 30023, 900, 1_001],
      },
      {
        sql:
          "INSERT INTO admin_event_blobs (event_id, blob, encrypted) VALUES (?, ?, 1)",
        args: [eventId, hash],
      },
      {
        sql:
          "INSERT INTO admin_event_search (event_id, title, author_name, author_nip05, search_text, refreshed_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [
          eventId,
          "A searchable episode",
          "Alice Creator",
          "alice@example.com",
          "A searchable episode Alice Creator alice@example.com",
          1_002,
        ],
      },
      {
        sql:
          "INSERT INTO admin_event_blob_metadata (event_id, blob, name) VALUES (?, ?, ?)",
        args: [eventId, hash, "Chapter One"],
      },
    ]);
    const rows = await listAllBlobs(db, {
      filter: { q: eventId, visibility: "encrypted" },
    });
    assertEquals(rows.length, 1);
    assertEquals(rows[0].events, [{
      id: eventId,
      pubkey,
      kind: 30023,
      encrypted: true,
    }]);
    assertEquals(
      await listAllBlobs(db, { filter: { visibility: "public" } }),
      [],
    );
    for (
      const query of [
        "searchable episode",
        "Alice Creator",
        "alice@example.com",
        "Chapter One",
      ]
    ) {
      assertEquals(
        (await listAllBlobs(db, { filter: { q: query } })).length,
        1,
        query,
      );
    }
    assertEquals(
      (await listAllUsers(db, { filter: { q: "Alice Creator" } }))[0]
        .pubkey,
      pubkey,
    );
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("refresh retains searchable author identity when profile relays fail", async () => {
  const tmpDir = await Deno.makeTempDir();
  const db = await initDb({ path: join(tmpDir, "test.db") });
  const hash = "a".repeat(64);
  const event = finalizeEvent({
    kind: 31339,
    created_at: 1000,
    content: "",
    tags: [["title", "Test book"], [
      "imeta",
      `url https://blossom.example/${hash}.bin`,
      "name Chapter One",
    ]],
  }, generateSecretKey());
  try {
    await insertBlob(
      db,
      { sha256: hash, size: 42, type: null, uploaded: 1000 },
      event.pubkey,
    );
    await indexEventsForAdmin(
      db,
      [event],
      new Map([[event.pubkey, {
        name: "fftester",
        nip05: "test@example.com",
      }]]),
      "blossom.example",
    );
    await indexEventsForAdmin(db, [event], new Map(), "blossom.example");
    for (
      const query of [
        "fftester",
        "test@example.com",
        "Chapter One",
        "Test book",
      ]
    ) {
      assertEquals(
        (await listAllBlobs(db, { filter: { q: query } })).length,
        1,
        query,
      );
    }
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});
