CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
  value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS records_kind_updated ON records (kind, updated_at);
CREATE TABLE IF NOT EXISTS transaction_assertions (
  id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1)
);
