-- P0-15: `seq` must never be reused. Without AUTOINCREMENT SQLite may hand the rowid of a deleted
-- newest row to the next insert; with it, ids only ever grow (tracked in sqlite_sequence).
-- SQLite cannot alter a primary key in place, so the table is rebuilt; ids are preserved.
CREATE TABLE events_new (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL
);
INSERT INTO events_new (id, at, type, payload) SELECT id, at, type, payload FROM events ORDER BY id;
DROP INDEX events_type;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX events_type ON events(type);
