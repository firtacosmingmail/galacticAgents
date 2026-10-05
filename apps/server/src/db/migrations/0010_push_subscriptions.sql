-- P7-04: Web Push subscriptions, one row per device (browser install). Device configuration, not
-- domain state: it never appears in a snapshot and no event describes it (like agent_processes).
-- `id` is the first 32 hex digits of SHA-256(endpoint); the endpoint and its keys never leave the
-- server once stored (the list shows the id and the label only). `kinds` is a JSON object of
-- booleans, one per push kind; `details` lets names and question text into the notification.
CREATE TABLE push_subscriptions (
  id            TEXT PRIMARY KEY,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  kinds         TEXT NOT NULL,
  details       INTEGER NOT NULL DEFAULT 0 CHECK (details IN (0, 1)),
  label         TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('local', 'remote')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_sent_at  TEXT,
  last_error    TEXT
);
