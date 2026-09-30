-- Independent holds and audit records survive removal of ordinary metadata.
CREATE TABLE IF NOT EXISTS blob_quarantine (
  sha256 TEXT PRIMARY KEY,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blob_quarantine_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('quarantine','restore')),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blob_quarantine_audit_hash ON blob_quarantine_audit(sha256, id);
