-- Durable security state. Separate tables keep migrations safe to replay at startup.
CREATE TABLE IF NOT EXISTS blob_deletions (
  sha256 TEXT PRIMARY KEY,
  extension TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  cleanup_done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_operation_locks (
  resource TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_rate_limits (
  resource TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_purchase_providers (
  purchase_id TEXT PRIMARY KEY REFERENCES storage_purchases(id) ON DELETE CASCADE,
  mint_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS treasury_lease_tokens (
  purchase_id TEXT PRIMARY KEY REFERENCES storage_treasury_transfers(purchase_id) ON DELETE CASCADE,
  token TEXT NOT NULL
);
