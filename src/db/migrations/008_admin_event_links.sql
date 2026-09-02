-- Nostr events explicitly inspected by an administrator.
CREATE TABLE IF NOT EXISTS admin_events (
  event_id    TEXT(64) PRIMARY KEY,
  pubkey      TEXT(64) NOT NULL,
  kind        INTEGER  NOT NULL,
  created_at  INTEGER  NOT NULL,
  indexed_at  INTEGER  NOT NULL
);

-- Blob references extracted from inspected events. A blob may appear in many
-- events, and one event may contain both public previews and encrypted files.
CREATE TABLE IF NOT EXISTS admin_event_blobs (
  event_id    TEXT(64) NOT NULL REFERENCES admin_events(event_id) ON DELETE CASCADE,
  blob        TEXT(64) NOT NULL REFERENCES blobs(sha256) ON DELETE CASCADE,
  encrypted   INTEGER  NOT NULL CHECK (encrypted IN (0, 1)),
  PRIMARY KEY (event_id, blob)
);

CREATE INDEX IF NOT EXISTS admin_event_blobs_blob ON admin_event_blobs (blob);
CREATE INDEX IF NOT EXISTS admin_events_pubkey ON admin_events (pubkey);
