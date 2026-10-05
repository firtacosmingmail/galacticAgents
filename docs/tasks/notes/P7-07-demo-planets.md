# P7-07 — Demo planets go away for good

Cosmin asked how to remove the planets of closed demo projects. The ops console's "Seed demo project" (`POST /dev/seed`, P0-16) makes an orbit-less "Demo planet n" with "Demo project n" (`in_progress`, workspace `/tmp/galactic-demo-n`) on it. Three problems:

1. Archiving the project only **freed** the planet (`body.freed`). The scene stopped drawing it (P4-13), but the server still had a free planet.
2. `chooseBody` / `freePlanets` (`catalogue.ts`) took any free planet, catalogue or not, so once Mercury … Neptune were taken a **real** project landed on a demo planet: it came back into the scene and quietly raised decision 1's planet cap.
3. Nothing cleared seeded demo work in bulk. The harness "Clear" (P4-06) takes only `meta.harness` rows.

## Design

**Which rows are demo** (`packages/protocol/src/dev.ts`):

- `/dev/seed` now flags both rows with `meta.demo: true` (`domain/demo.ts` `seedDemoProject`, stamped with the command clock).
- `isDemoBody(body)` matches `meta.demo`. For rows made before the flag it also matches **the legacy rule**: a `planet` with no `parentId`, no numeric `meta.orbit`, not `meta.reserved`, named exactly `Demo planet <digits>`. Catalogue bodies always have `meta.orbit` (migration 0005) and asteroids are not planets, so neither can ever match. `/dev/seed` has made exactly this shape since P0-16 (checked in the git history; nothing else in the code makes an orbit-less planet).
- `isDemoProject(project)` matches `meta.demo`. For older rows it matches name `Demo project <digits>` **and** workspace `/tmp/galactic-demo-<digits>`. A `meta.harness` project is never demo work. The workspace condition is there so a real project that ended up on a demo planet is never taken for demo work. Caveat: a real project that happens to be named exactly "Demo project N" **and** to have the workspace `/tmp/galactic-demo-N` is indistinguishable from a legacy seeded one, and "Clear demo projects" would close and archive it. Accepted: only `/dev/seed` ever made that pair, and Clear is a development-only button.

**Never chosen, never assigned** (`catalogue.ts`, `bodies.ts`, `parking.ts`, Harmonizer tools):

- `isCatalogued(body)` (in `@galactic/protocol`'s `dev.ts` since the review, shared by the server and the panel) means a numeric `meta.orbit`, not demo, not retired. `freePlanets` and `freeMoons` (so `chooseBody`, `createProject`, un-parking and the promotion flow) return catalogued bodies only. Any orbit-less planet is skipped too, whatever its name.
- `roomFor` keeps a card's named body only while it is catalogued. The Harmonizer's `isFree` refuses demo and retired bodies.
- The proposal card's edit form (`ProposalCard.tsx` `freeBodies`) lists only catalogued free bodies too (review fix 2026-10-05: it offered demo and orbit-less planets the server would then not use).
- `checkAssignable` refuses a retired body, and a demo body for anything except the demo project it already hosts.
- `occupiedPlanets` (the "no free planet" refusal) still lists a demo planet that hosts work, because it is occupied. It never lists a retired one.

**Retired when its project is archived** (`archiveProject` → `release` → `retireBody`):

- New protocol event **`body.retired{bodyId}`**. `retireBody` only takes a free demo body: it throws for a catalogue body, an asteroid, or a body still hosting work or showing a marker.
- **The row is not deleted.** `projects.body_id` is a `NOT NULL` foreign key, and the archived project's history and inspector still name its body. The row becomes a tombstone with `meta.retired: true`:
  - `EventLog.snapshot()` leaves it out, so a snapshotting client never sees it.
  - The web reducer deletes the body on `body.retired`, so a replaying client ends up with the same world. `conformance.test.ts` now seeds, archives and reopens a demo project and still checks fold == snapshot at every commit.
  - Reopening an archived demo project does not reuse its retired planet. It takes a catalogue body.
- Timeline replay (P4-07): `touches` treats `body.retired` like `body.freed`, so the project's events run from `body.created` to `body.retired`. The replay starts from the live bodies (no demo planet), shows the planet while the project lived, and drops it at the end. Tested in `replay-conformance.test.ts`.
- History inspector: it reads the body name from the table (the tombstone), so archived demo work still shows "Demo planet n".
- Any archive retires a demo body: the panel, the Harmonizer's `finished_work`, the retention sweep, and "Clear demo projects". That includes a demo planet a real project leaked onto before this task. That project keeps the planet while it lives, and the planet retires when the project is archived.

**"Clear demo projects"** (`POST /dev/demo/clear`, `runtime/demo-clear.ts`; a button next to "Seed demo project" in the ops console `/debug`):

- It sits under `/dev`, so it gets the same guards as the harness: it exists only with `GALACTIC_DEV=1`, needs the bearer token, and answers 403 `remote_dev` to remote clients (decision 90).
- For every non-archived demo project, sub-projects first: each task (except harness tasks) is closed if still open, then archived. Then the project is closed (or, if still `proposed`, cancelled by archiving it directly) and archived. Archiving retires its planet. Everything goes through `Commands`, as the panel's actions do.
- It then retires every **free** demo body that is not retired yet (`retireFreeDemoBodies`): the leftovers of demo projects archived before this task.
- Best effort. A refused step (for example, a demo project with a running agent) and a demo planet still hosting real work are listed in `skipped` with the reason. The rest goes on.
- It returns `{seq, projects, tasks, retired, skipped}`. The console prints one line, e.g. "Cleared 4 demo projects and 0 tasks; retired 4 demo planets."

## Older pages and `body.retired` (review fix, 2026-10-05)

`body.retired` is a new event type. A page loaded from a build before it failed `ServerMessage` on that event, closed with 4002, resumed from the same `seq` and received the same event again, forever. The client now skips an event of an unknown type with a valid envelope, advancing `seq` past it (TECHNOLOGY §6.3 item 5, `unknownEventFrame`). That protects later builds; a tab still running a bundle from before the fix keeps looping until it is reloaded (the P7-01 update banner prompts the reload).

## SPEC text (recorded in SPEC decision 79, 2026-10-05)

Added to decision 79 rather than as a new number:

> **Demo planets go away for good** (2026-10-05, P7-07; decisions 1, 63): the ops console's older "Seed demo project" button makes a made-up "Demo planet n" with a demo project on it. Such a planet is never offered or given to real work (only the catalogue's planets and moons are, so it never raises decision 1's planet count), and once its project is archived it is retired: it leaves the world for good — no longer in the scene, the lists or a timeline replay after that point — while the archived project's history still names it. In the same development-only, this-machine-only console, "Clear demo projects" closes (or cancels) and archives every seeded demo project and its tasks and retires their planets, including planets left over from demo projects archived earlier; it never touches real work or the harness's items (the harness has its own "Clear"), and a made-up planet that real work landed on before this rule stays until that work is archived.

## Clearing Cosmin's existing leftovers

According to the P4-12 notes, his database holds four "Demo project 1–4", `in_progress` on "Demo planet" bodies made by `/dev/seed`. No flags exist yet, but the legacy rule catches them: `/dev/seed` always used the names `Demo project n` / `Demo planet n` and the workspace `/tmp/galactic-demo-n`.

1. Start the server from this branch in development mode on the Mac: `pnpm dev`, or `galactic start --dev`. No migration is needed.
2. Optional: preview read-only what the rule will take, without the server writing anything:
   `sqlite3 ~/.galactic/galactic.sqlite "SELECT id, name, workspace, state FROM projects WHERE name GLOB 'Demo project [0-9]*' AND workspace GLOB '/tmp/galactic-demo-[0-9]*';"`
3. On the Mac (not the phone, which is refused), open `/debug`, the ops console, and click **Clear demo projects**. Or call the route directly:
   `curl -X POST -H "Authorization: Bearer $(node -p "require(process.env.HOME + '/.galactic/config.json').token")" http://127.0.0.1:4321/dev/demo/clear` (the token lives in `~/.galactic/config.json`; use your port if it is not the default 4321).
4. The status line says how many projects were archived and how many planets were retired. Every demo planet is now gone from the scene and from the lists, and none is ever offered to a new project.
   - If a line under "not cleared" names a demo planet that "still holds project …", a real project landed on it before this fix. Archive that project when it is done and its planet retires.
   - If he renamed a demo project, the name rule will not match it. Archive it from the panel: its planet still retires, because the body rule does not depend on the project, and a second "Clear" also retires any free one.

## Tests

- Web `panel/cards/free-bodies.test.ts` (1): the edit form's body list skips reserved, hosting, demo (flagged and legacy), retired and orbit-less bodies.
- Protocol `dev.test.ts` (+6): `isCatalogued`; `isDemoBody` (flagged, legacy, never catalogue/moon/reserved/other names), `isRetiredBody`, `isDemoProject` (flagged, legacy, never real or harness work).
- Server `domain/demo.test.ts` (+9):
  - seed flags;
  - `freePlanets` / `chooseBody` skip free demo planets (flagged and legacy) and any orbit-less planet, so with the catalogue full a new project is refused rather than given a demo planet;
  - assigning a demo planet by name is refused;
  - archive emits `project.state_changed, body.freed, body.retired`, and the snapshot no longer has the body;
  - legacy planets and a leaked real project's planet retire;
  - a catalogue planet and an asteroid never retire;
  - reopening takes a catalogue planet;
  - `retireFreeDemoBodies` is idempotent.
- Server `http/dev-demo.test.ts` (+5):
  - guards: 404 without `GALACTIC_DEV`, 401 without the token, 403 for `x-forwarded-for` and a `*.ts.net` origin, with nothing archived;
  - clear archives two seeded projects and a demo task, and retires their planets and a legacy leftover, while a real project and a harness scenario stay byte-for-byte unchanged;
  - after the clear, new projects fill the catalogue planets only, then get "no free planet";
  - a second clear is empty;
  - a demo planet hosting real work is skipped and named.
- Web:
  - `reduce.test.ts` (+1): `body.retired` drops the body;
  - `conformance.test.ts`: a demo seed, archive and reopen inside the recorded run, with `body.retired` in the covered types;
  - `replay-conformance.test.ts` (+1): replay of a demo project;
  - `demo-clear.test.ts` (+2): the console's line;
  - `App.test.tsx` (+1): the button posts with the token and shows the line.

## Left as it is

- Freeing a "moved to …" marker on a demo planet (a demo project moved away from it) frees the planet but does not retire it. It is never chosen again, and the next "Clear demo projects" retires it.
- `PROTOCOL_VERSION` is unchanged. Server and web ship together, and the P7-01 service-worker update flow replaces a stale page. An older page would not recognise `body.retired`.
