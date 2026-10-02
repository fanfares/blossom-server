-- Every checkout and its recoverable treasury funds keep their issuing mint.
CREATE TABLE IF NOT EXISTS storage_purchase_mints (
  purchase_id TEXT PRIMARY KEY REFERENCES storage_purchases(id) ON DELETE CASCADE,
  mint_url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_mint_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mint_url TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_mint_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint_url TEXT NOT NULL,
  previous_mint_url TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT NOT NULL
);
