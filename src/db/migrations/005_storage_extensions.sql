-- Multi-year storage extensions without changing the original purchase table.
CREATE TABLE IF NOT EXISTS storage_purchase_extensions (
  purchase_id TEXT PRIMARY KEY,
  FOREIGN KEY (purchase_id) REFERENCES storage_purchases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS storage_extension_targets (
  purchase_id      TEXT NOT NULL,
  grant_purchase_id TEXT NOT NULL,
  PRIMARY KEY (purchase_id, grant_purchase_id),
  FOREIGN KEY (purchase_id) REFERENCES storage_purchases(id) ON DELETE CASCADE,
  FOREIGN KEY (grant_purchase_id) REFERENCES storage_grants(purchase_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS storage_extension_targets_grant
  ON storage_extension_targets (grant_purchase_id);
