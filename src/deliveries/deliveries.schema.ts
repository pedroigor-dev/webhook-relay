export const DELIVERIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state,next_at,lease_until);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  generation INTEGER NOT NULL,
  number INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  error TEXT
);
`;
