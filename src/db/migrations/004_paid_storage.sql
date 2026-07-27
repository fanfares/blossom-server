-- Paid annual storage purchases, grants, and short-lived upload reservations.
CREATE TABLE IF NOT EXISTS storage_purchases (
  id                TEXT PRIMARY KEY,
  pubkey            TEXT NOT NULL,
  units             INTEGER NOT NULL CHECK (units > 0),
  quota_bytes       INTEGER NOT NULL CHECK (quota_bytes > 0),
  duration_seconds  INTEGER NOT NULL CHECK (duration_seconds > 0),
  amount_sats       INTEGER NOT NULL CHECK (amount_sats > 0),
  invoice           TEXT NOT NULL,
  provider_quote_id TEXT NOT NULL UNIQUE,
  state             TEXT NOT NULL DEFAULT 'pending',
  invoice_expires   INTEGER,
  created_at        INTEGER NOT NULL,
  paid_at           INTEGER,
  credited_at       INTEGER
);

CREATE INDEX IF NOT EXISTS storage_purchases_pubkey
  ON storage_purchases (pubkey, created_at DESC);

CREATE TABLE IF NOT EXISTS storage_grants (
  purchase_id  TEXT PRIMARY KEY,
  pubkey       TEXT NOT NULL,
  quota_bytes  INTEGER NOT NULL CHECK (quota_bytes > 0),
  starts_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  FOREIGN KEY (purchase_id) REFERENCES storage_purchases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS storage_grants_pubkey_expiry
  ON storage_grants (pubkey, expires_at);

CREATE TABLE IF NOT EXISTS upload_reservations (
  id          TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_reservations_pubkey_expiry
  ON upload_reservations (pubkey, expires_at);
