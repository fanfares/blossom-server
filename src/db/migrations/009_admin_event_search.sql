-- Searchable, refreshable metadata kept separate from the immutable event/link
-- identity tables so this migration is safe to run repeatedly on existing DBs.
CREATE TABLE IF NOT EXISTS admin_event_search (
  event_id      TEXT(64) PRIMARY KEY REFERENCES admin_events(event_id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  author_name   TEXT NOT NULL DEFAULT '',
  author_nip05  TEXT NOT NULL DEFAULT '',
  search_text   TEXT NOT NULL DEFAULT '',
  refreshed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_event_blob_metadata (
  event_id  TEXT(64) NOT NULL,
  blob      TEXT(64) NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (event_id, blob),
  FOREIGN KEY (event_id, blob) REFERENCES admin_event_blobs(event_id, blob) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS admin_event_search_author ON admin_event_search (author_name);
