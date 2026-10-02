-- Durable fairness for settlement sweeps and the original pre-snapshot mint.
CREATE TABLE IF NOT EXISTS storage_purchase_reconciliation (
  purchase_id TEXT PRIMARY KEY REFERENCES storage_purchases(id) ON DELETE CASCADE,
  last_checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS storage_legacy_mint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mint_url TEXT NOT NULL
);
