-- Durable provider work saved atomically with quarantine, independent of bytes.
CREATE TABLE IF NOT EXISTS image_cache_purge (
  sha256 TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending',
  generation INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS image_cache_purge_due ON image_cache_purge(state, next_attempt);
CREATE TABLE IF NOT EXISTS blossom_image_sources (
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (sha256, source)
);
