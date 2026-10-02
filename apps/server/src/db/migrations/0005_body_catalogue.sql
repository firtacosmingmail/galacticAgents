-- P2-02: the body catalogue (SPEC §3.1, decisions 1, 10, 15).
--
-- The Sun becomes a body of its own kind (`star`), so `kind` gains 'star'; bodies gain
-- `moved_to`, the "moved to …" marker (`Body.movedTo`, JSON) the old body shows after its work
-- moved away, until the retention sweep frees it. SQLite cannot alter a CHECK constraint, so the
-- table is rebuilt the documented way (new table, copy, drop, rename) with foreign keys off; the
-- runner checks `foreign_key_check` before committing.
-- migrate: foreign_keys=off

CREATE TABLE bodies_new (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('star', 'planet', 'moon', 'asteroid')),
  parent_id   TEXT REFERENCES bodies(id),
  name        TEXT NOT NULL,
  host_kind   TEXT CHECK (host_kind IN ('project', 'task')),
  host_id     TEXT,
  moved_to    TEXT,
  meta        TEXT
);
INSERT INTO bodies_new (id, kind, parent_id, name, host_kind, host_id, meta)
  SELECT id, kind, parent_id, name, host_kind, host_id, meta FROM bodies ORDER BY rowid;
DROP TABLE bodies;
ALTER TABLE bodies_new RENAME TO bodies;
CREATE INDEX bodies_host ON bodies(host_kind, host_id);

-- The seeded catalogue: the Sun, the eight planets in orbit order (`meta.orbit`, 1 = Mercury) and
-- their major moons with `parent_id` (`meta.orbit` around the planet). The Sun, Earth and Earth's
-- Moon are reserved (`meta.reserved`): Earth is the headquarters, none of them is ever assigned.
-- A database that already holds a body with one of these ids keeps its own row.
INSERT OR IGNORE INTO bodies (id, kind, parent_id, name, meta) VALUES
  ('b-sun', 'star', NULL, 'Sun', '{"reserved":true}'),
  ('b-mercury', 'planet', NULL, 'Mercury', '{"orbit":1}'),
  ('b-venus', 'planet', NULL, 'Venus', '{"orbit":2}'),
  ('b-earth', 'planet', NULL, 'Earth', '{"orbit":3,"reserved":true}'),
  ('b-mars', 'planet', NULL, 'Mars', '{"orbit":4}'),
  ('b-jupiter', 'planet', NULL, 'Jupiter', '{"orbit":5}'),
  ('b-saturn', 'planet', NULL, 'Saturn', '{"orbit":6}'),
  ('b-uranus', 'planet', NULL, 'Uranus', '{"orbit":7}'),
  ('b-neptune', 'planet', NULL, 'Neptune', '{"orbit":8}'),
  ('b-moon', 'moon', 'b-earth', 'Moon', '{"orbit":1,"reserved":true}'),
  ('b-phobos', 'moon', 'b-mars', 'Phobos', '{"orbit":1}'),
  ('b-deimos', 'moon', 'b-mars', 'Deimos', '{"orbit":2}'),
  ('b-io', 'moon', 'b-jupiter', 'Io', '{"orbit":1}'),
  ('b-europa', 'moon', 'b-jupiter', 'Europa', '{"orbit":2}'),
  ('b-ganymede', 'moon', 'b-jupiter', 'Ganymede', '{"orbit":3}'),
  ('b-callisto', 'moon', 'b-jupiter', 'Callisto', '{"orbit":4}'),
  ('b-mimas', 'moon', 'b-saturn', 'Mimas', '{"orbit":1}'),
  ('b-enceladus', 'moon', 'b-saturn', 'Enceladus', '{"orbit":2}'),
  ('b-tethys', 'moon', 'b-saturn', 'Tethys', '{"orbit":3}'),
  ('b-dione', 'moon', 'b-saturn', 'Dione', '{"orbit":4}'),
  ('b-rhea', 'moon', 'b-saturn', 'Rhea', '{"orbit":5}'),
  ('b-titan', 'moon', 'b-saturn', 'Titan', '{"orbit":6}'),
  ('b-iapetus', 'moon', 'b-saturn', 'Iapetus', '{"orbit":7}'),
  ('b-miranda', 'moon', 'b-uranus', 'Miranda', '{"orbit":1}'),
  ('b-ariel', 'moon', 'b-uranus', 'Ariel', '{"orbit":2}'),
  ('b-umbriel', 'moon', 'b-uranus', 'Umbriel', '{"orbit":3}'),
  ('b-titania', 'moon', 'b-uranus', 'Titania', '{"orbit":4}'),
  ('b-oberon', 'moon', 'b-uranus', 'Oberon', '{"orbit":5}'),
  ('b-proteus', 'moon', 'b-neptune', 'Proteus', '{"orbit":1}'),
  ('b-triton', 'moon', 'b-neptune', 'Triton', '{"orbit":2}'),
  ('b-nereid', 'moon', 'b-neptune', 'Nereid', '{"orbit":3}');
