-- Atomic new-capacity purchases that align every active grant to one expiry.
CREATE TABLE IF NOT EXISTS storage_purchase_alignments (
  purchase_id          TEXT PRIMARY KEY,
  target_expires_at    INTEGER NOT NULL,
  base_amount_sats     INTEGER NOT NULL CHECK (base_amount_sats > 0),
  alignment_amount_sats INTEGER NOT NULL CHECK (alignment_amount_sats >= 0),
  FOREIGN KEY (purchase_id) REFERENCES storage_purchases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS storage_alignment_targets (
  purchase_id       TEXT NOT NULL,
  grant_purchase_id TEXT NOT NULL,
  quota_bytes       INTEGER NOT NULL CHECK (quota_bytes > 0),
  original_expires_at INTEGER NOT NULL,
  target_expires_at INTEGER NOT NULL,
  PRIMARY KEY (purchase_id, grant_purchase_id),
  FOREIGN KEY (purchase_id) REFERENCES storage_purchases(id) ON DELETE CASCADE,
  FOREIGN KEY (grant_purchase_id) REFERENCES storage_grants(purchase_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS storage_alignment_targets_grant
  ON storage_alignment_targets (grant_purchase_id);
