-- Durable outbox for forwarding settled storage revenue to the operator wallet.
CREATE TABLE IF NOT EXISTS storage_treasury_transfers (
  purchase_id           TEXT PRIMARY KEY,
  destination           TEXT NOT NULL,
  gross_amount_sats     INTEGER NOT NULL CHECK (gross_amount_sats > 0),
  state                 TEXT NOT NULL DEFAULT 'pending',
  mint_preview_json     TEXT,
  proofs_json           TEXT,
  melt_preview_json     TEXT,
  forwarded_amount_sats INTEGER,
  fee_reserve_sats      INTEGER,
  change_proofs_json    TEXT,
  payment_preimage      TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       INTEGER NOT NULL DEFAULT 0,
  lease_until           INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  forwarded_at          INTEGER,
  FOREIGN KEY (purchase_id) REFERENCES storage_purchases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS storage_treasury_transfers_due
  ON storage_treasury_transfers (state, next_attempt_at, lease_until);
