-- Treasury changes are durable and attributed to a verified administrator.
CREATE TABLE IF NOT EXISTS admin_treasury_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  destination TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_treasury_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  destination TEXT NOT NULL,
  previous_destination TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT NOT NULL
);
-- Relay reports remain distinct from BUD-09 blob reports.
CREATE TABLE IF NOT EXISTS admin_content_reports (
  event_id TEXT PRIMARY KEY,
  reporter TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  targets_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reviewed_at INTEGER,
  reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS admin_content_reports_created ON admin_content_reports(status, created_at DESC);
