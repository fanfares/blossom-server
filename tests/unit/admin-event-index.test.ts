/**
 * @module Admin event indexing
 * @covers Event identifier decoding and extraction of encrypted/public Blossom references
 * @dependencies nostr-tools NIP-19 codec
 * @type unit | deno
 */

import { assertEquals } from "@std/assert";
import { nip19 } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";
import { join } from "@std/path";
import { initDb } from "../../src/db/client.ts";
import { insertBlob, listAllBlobs } from "../../src/db/blobs.ts";
import {
  eventIdentifierToFilter,
  extractEventBlobReferences,
} from "../../src/admin/event-index.ts";

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
      ["imeta", `url https://blossom.example/${publicHash}.jpg`, "preview"],
      [
        "imeta",
        `url https://attacker.example/${"c".repeat(64)}.jpg`,
        "encrypted",
      ],
    ],
  } as NostrEvent;
  assertEquals(extractEventBlobReferences(event, "blossom.example"), [
    { sha256: encryptedHash, encrypted: true },
    { sha256: publicHash, encrypted: false },
  ]);
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
  } finally {
    db.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});
