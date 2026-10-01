# P2-02 — Body catalogue and assignment (notes)

Branch: the P2-02 worktree branch off `p2-wave2-services`. The phase file, README, SPEC, TECHNOLOGY and PLAN were not edited (coordination rule): the texts below are written so they can be pasted in when the wave is merged.

## What was built

- **Migration 0005 `body_catalogue`.** Rebuilds `bodies` (SQLite cannot alter a CHECK): `kind` gains `'star'`, and a new `moved_to` JSON column holds the "moved to …" marker. Then it seeds 31 bodies with `INSERT OR IGNORE`: `b-sun` (star), the 8 planets `b-mercury` … `b-neptune` with `meta.orbit` 1–8, and 22 major moons with `parent_id` and `meta.orbit` around their planet (Moon; Phobos, Deimos; Io, Europa, Ganymede, Callisto; Mimas … Iapetus; Miranda … Oberon; Proteus, Triton, Nereid). `meta.reserved: true` is set on the Sun, Earth and the Moon. P2-01's `isReserved` contract is unchanged. Existing rows keep their ids, hosts and rowid order.
- **Migration runner.** A migration that contains the line `-- migrate: foreign_keys=off` runs with foreign keys off. The pragma can only be changed outside a transaction. The runner checks `PRAGMA foreign_key_check` before committing and switches foreign keys back on.
- **Protocol** (additive):
  - `WorkBodyKind` (planet | moon | asteroid); `BodyKind` = `star` + `WorkBodyKind`. `Proposal.kind`, `ProposedBody.kind`, `CreateProposalInput.kind` and `CreateProjectInput.kind` now use `WorkBodyKind`.
  - New types `Body.movedTo?: BodyMarker{bodyId, host, at}`, `BodyOccupancy`, `BodyRequest` and `BodyChoice`.
  - `BodyMoved.intoProjectId?`.
  - New `DomainCommands` methods `freePlanets()`, `freeMoons(planetId?)` and `chooseBody(request)`.
  - Fixture body renamed `b-earth` → `b-kepler`, so it no longer collides with the seeded Earth.
- **`apps/server/src/domain/catalogue.ts`.**
  - `SUN_ID` / `EARTH_ID` / `MOON_ID`, `isReserved`, `isFree`.
  - `catalogueOrder`: star, planets by orbit, moons by (planet orbit, own orbit), asteroids by number, then name and id.
  - `freePlanets`, `freeMoons`, `occupiedPlanets`.
  - `chooseBody(ctx, request, {isRunning?})`.
  - `describeRefusal`.
  - The asteroid generator: `asteroidSpec(n)`, a pure function of `n` (mulberry32 seeded from `BELT_SEED ^ n`). It gives id `b-asteroid-n`, name `(n) Word` and `meta {number, seed, orbit{radius, phase, inclination}}`. `createAsteroid` emits `body.created`.
- **Wiring.**
  - `createProject` without a `bodyId` goes through `chooseBody`. A refusal is a `conflict` that names the occupants. `firstFreeBody` was removed.
  - `createTask`, `reopenTask` and `createAgent` (the Phase 1 inline asteroid) use the generator.
  - `Commands` gets `freePlanets` / `freeMoons` / `chooseBody` / `sweepMarkers(retentionMs?)`. `compose.ts` passes `isRunning` from the status store.
- **Moved marker.**
  - `moveHost` and `moveTask` call `markMoved`. The old body loses its host and gets `movedTo{bodyId, host, at = ctx.now}`. `body.moved` announces the move.
  - For `moveTask` the event carries `intoProjectId`: the task now lives on the project's body, and that body's host is unchanged. This replaces P2-01's `body.freed` on the asteroid, so the satellite-flight event exists for both kinds of move (PLAN Phase 4).
  - A marked body is neither free nor assignable.
  - `release` / `body.freed` clear the host and the marker. `freeBody` on a marked body frees it early.
  - `sweepMarkers(ctx, retentionMs = DEFAULT_RETENTION_MS (7 d))` frees markers whose age by `ctx.now` is at least the retention period. The clock is injectable through `EventLog({now})`. P2-13's scheduler only has to call it.
- **Web reducer.**
  - `body.moved` sets `movedTo` on the old body from the envelope's `at`. It sets the new body's host unless `intoProjectId` is present.
  - `body.freed` drops `host` and `movedTo`.
  - The conformance test now runs on the seeded catalogue. It covers moving a task into a project (marker), a catalogue-chosen planet and moon, freeing a marker early, and a sweep after `clock.advance(8 d)`, followed by a reopen on the swept body.

## Decisions (ready to paste)

**SPEC §7, new decision — Body catalogue (2026-10-01, P2-02):**
> | 25 | Body catalogue | **Seeded, deterministic, room to grow** (2026-10-01, P2-02): the catalogue is the Sun, the 8 planets and 22 major moons; the Sun, Earth and the Moon are reserved. A new planet project gets the first free planet (from the Sun outwards) that still has a free moon, so it can later take a sub-project; Mercury and Venus (no moons) come last. An independent moon project takes the first free moon of a planet without a running Waykeeper (a free planet, a project not yet staffed, or a finished project), else any free moon. Asteroids are generated on demand, numbered `(n) Name` with seeded orbits, and never reused: each standalone task keeps its own body in history. A body whose work moved away shows "moved to …" and is neither free nor assignable until the retention sweep (or an explicit free) clears it. |

**SPEC §3.1 (wording):** "Earth is reserved … The Sun and Earth's Moon are likewise never assigned work" stays as it is. Add: "The Sun is a body of its own kind (`star`)."

**TECHNOLOGY §7 vocabulary** — replace `Body{id, kind, parentId?, host?: {kind: project|task, id}}` with:
> `Body{id, kind: star|planet|moon|asteroid, parentId?, host?: {kind: project|task, id}, movedTo?: {bodyId, host, at}, meta}` (catalogue data in `meta`: `reserved`, `orbit`, an asteroid's `number`/`seed`/orbit) …

and the `body.*` list with:
> `body.*` (`created` for a body that was not in the seeded catalogue — a procedural asteroid — then `assigned` / `moved` (with `intoProjectId` when a standalone task joins a project's body; the old body gets the "moved to …" marker) / `freed` (clears host and marker))

(This removes "a task's body": see the next decision.)

**TECHNOLOGY §6.1 (append):** "A migration that rebuilds a table (SQLite's only way to change a constraint) declares `-- migrate: foreign_keys=off`; the runner disables foreign keys around its transaction and refuses to commit if `foreign_key_check` reports anything (P2-02, migration 0005)."

**TECHNOLOGY §6.2 (append):** "The 'moved to …' marker is a first-class `Body.movedTo` column, not `meta`: `body.moved` writes it with the event's `at`, `body.freed` clears it, and both the commands and the client reducer fold it the same way (P2-02). `sweepMarkers(retentionMs)` frees markers by the log's clock; the retention period is decision 4's setting (default 7 days) until P2-13 reads it."

**Project tasks keep P2-01's model, with no body rows of their own.** SPEC §3.1 says a project task is "on the project's body (surface or orbit; no asteroid)", and decision 9 says the same. Nothing requires a body row per task. A row with `host = task, parentId = project body` would break the rule that a body hosts at most one project or standalone task. Every catalogue query would then have to filter out those rows, and `body.moved` would be ambiguous. The scene can draw a project's tasks from `tasks` by `bodyId`. The P2-02 line "host assignment for project tasks (`Body.host = task`, `parentId = project body`)" and PLAN Phase 2's "Project tasks are hosted on the project's body (`Body.host` = task with `parentId` = the planet/moon)" should be reworded to: "project tasks live on the project's body (`Task.bodyId = Project.bodyId`); they never get a body of their own."

**Shape of the "no free planet" result** (P2-09 consumes it): `chooseBody({kind:'planet'})` returns `{ok:false, reason:'no_free_planet', occupied: BodyOccupancy[]}`. The list covers every unreserved planet in catalogue order, as `{bodyId, bodyName, host?, occupant?, state?, movedTo?}`. A completed project still listed there is a candidate for early closure. For a sub-project, `no_free_moon` carries the `planetId` (SPEC §3.2: "stays a task on the planet").

## Deferred / for other tasks

- **P2-09:** park a proposal from a `BodyChoice` (`proposal.parked` only has `reason`; it could carry `occupied`). Un-park when `body.freed` frees a planet.
- **P2-13:** call `Commands.sweepMarkers(retention)` from the retention scheduler, using the retention setting. Pinning does not apply to markers.
- **P2-12:** promotion uses `moveHost`, which already leaves the marker. The "permanent link in history" is the `body.moved` event.
- **P2-20:** spawn the Harmonizer on `EARTH_ID` (`catalogue.ts`).
- `/dev/seed` (P0-16) still creates its own "Demo planet n" bodies outside the catalogue. They sort after the seeded planets and are assignable. It could use `chooseBody` once the console stops needing it.
- Free asteroids accumulate. Phase 3's scene should draw only asteroids that host something or show a marker.
- `DomainCommands.chooseBody` does not cover asteroids: an asteroid is always a fresh `createAsteroid`.

## Tests

`apps/server/src/domain/catalogue.test.ts` holds 19 tests:
- the seed and its parents, and exactly three reserved bodies;
- the rebuild keeps existing rows and hosts, and foreign keys still hold afterwards;
- the order of free bodies;
- each preference rule (planet with moons, sub-project on its own planet's moon, Waykeeper-less moons first, the `isRunning` override, finished projects, the any-moon fallback);
- no free planet, including a marked planet in the list;
- no free moon;
- reserved bodies never assigned;
- asteroid determinism, numbering, and the agent fallback;
- marker retention boundaries, a configurable period, and an early free;
- the `Commands` surface with live Waykeeper status.

Existing tests were updated to the seeded catalogue. Totals: protocol 43, server 437 (+1 skipped), web 31.
