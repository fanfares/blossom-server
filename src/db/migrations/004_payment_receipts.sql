-- BUD-07 payment receipts for paid uploads/media
-- One row per successfully verified payment used for an upload/media request.
CREATE TABLE IF NOT EXISTS payment_receipts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id        TEXT NOT NULL,
  endpoint          TEXT NOT NULL,            -- upload | media
  amount_sats       INTEGER NOT NULL,
  quote_amount_sats INTEGER NOT NULL,
  mint_url          TEXT NOT NULL,
  payer_pubkey      TEXT,                     -- Nostr pubkey from auth context
  uploader_pubkey   TEXT,                     -- Nostr pubkey used for upload auth
  melt_quote_id     TEXT,
  melt_state        TEXT,
  paid_at           INTEGER NOT NULL,         -- unix timestamp (server-observed)
  created_at        INTEGER NOT NULL,
  UNIQUE (payment_id, endpoint, uploader_pubkey)
);

CREATE INDEX IF NOT EXISTS payment_receipts_paid_at_idx
  ON payment_receipts (paid_at DESC);

CREATE INDEX IF NOT EXISTS payment_receipts_uploader_idx
  ON payment_receipts (uploader_pubkey);
