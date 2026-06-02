-- D1 metadata schema for Blossom dashboard/search.
-- Mirrors the current libSQL schema used by the container runtime.

CREATE TABLE IF NOT EXISTS blobs (
  sha256    TEXT PRIMARY KEY,
  size      INTEGER  NOT NULL,
  type      TEXT,
  uploaded  INTEGER  NOT NULL
);

CREATE TABLE IF NOT EXISTS owners (
  blob      TEXT NOT NULL,
  pubkey    TEXT NOT NULL,
  PRIMARY KEY (blob, pubkey),
  FOREIGN KEY (blob) REFERENCES blobs(sha256) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS owners_pubkey ON owners (pubkey);

CREATE TABLE IF NOT EXISTS accessed (
  blob      TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (blob) REFERENCES blobs(sha256) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS accessed_timestamp ON accessed (timestamp);

CREATE TABLE IF NOT EXISTS media_derivatives (
  original_sha256   TEXT NOT NULL,
  optimized_sha256  TEXT NOT NULL,
  PRIMARY KEY (original_sha256),
  FOREIGN KEY (optimized_sha256) REFERENCES blobs(sha256) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
  id        INTEGER  PRIMARY KEY AUTOINCREMENT,
  event_id  TEXT NOT NULL,
  reporter  TEXT NOT NULL,
  blob      TEXT NOT NULL,
  type      TEXT,
  content   TEXT NOT NULL DEFAULT '',
  created   INTEGER NOT NULL,
  UNIQUE (event_id, blob)
);

CREATE INDEX IF NOT EXISTS reports_blob    ON reports (blob);
CREATE INDEX IF NOT EXISTS reports_created ON reports (created DESC);
