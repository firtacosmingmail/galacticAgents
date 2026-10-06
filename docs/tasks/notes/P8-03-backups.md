# P8-03 — Backups, export and import of the map

Branch `p8-03-backups` (from `p8-wave2-smoke-backup-storage-caps`). User procedures: `docs/BACKUP_RESTORE.md`. Technical design: `TECHNOLOGY.md` §6.4 (plus a §8 bullet).

## What was built

| Piece | Where |
| --- | --- |
| World fold moved to the protocol package (`applyEvent`, `emptyWorld`, `applySnapshot`, `summaryOf`, `WorldState`); the web's `state/reduce.ts` re-exports it | `packages/protocol/src/world.ts` |
| Schemas: `BackupKind`, `BackupInfo`, `BackupOutcome`, `BackupSchedule` (+ defaults), `BackupsResponse`, `MapExport` and parts, `ExportQuery` | `packages/protocol/src/backup.ts` |
| Online backups, rotation, schedule | `apps/server/src/db/backup.ts` (`BackupService`, `backupTo`, `backupsToRemove`, `listBackups`) |
| Export | `apps/server/src/db/map-export.ts` |
| Import with a replayed rebuild | `apps/server/src/db/map-import.ts` (`importMap`, `foldRows`, `diffRows`, `isEmptyDatabase`) |
| Restore of a backup file | `apps/server/src/db/restore.ts` |
| CLI `galactic export <file> [--transcripts]`, `galactic import <file> [--replace] [--prefer-rows]`, `galactic restore <file or name>` | `apps/server/src/cli.ts`, `bin/galactic.mjs` |
| REST `GET`/`POST /api/backups`, `GET /api/export?transcripts=1` | `apps/server/src/http/backup-routes.ts`, wired in `app.ts` |
| Config `backups {enabled, keepDaily, keepWeekly, keepManual, reserveMiB}`, `GALACTIC_BACKUPS`; `dataPaths(env)` | `apps/server/src/config/config.ts` |
| Schedule started after `listen`, stopped on shutdown | `apps/server/src/index.ts` |
| Settings page "Backups" section (list, Back up now, Export the map with/without transcripts, remote note) | `apps/web/src/panel/settings/Backups.tsx`, `SettingsPage.tsx`, `settings.css` |

No migration was needed. Everything the backups need comes from the file names. The export/import uses existing tables only.

## Design choices

- **Binding.** The server uses better-sqlite3 13, whose `db.backup(dest, {progress})` drives SQLite's online backup API stepwise and awaits between steps. Steps are 1024 pages (4 MiB).
- **Backup file.** It is written as `.partial` (pre-created 0600 with `O_EXCL`), switched to `journal_mode = DELETE` (otherwise the copy inherits WAL mode and gets `-wal`/`-shm` siblings), checked with `quick_check`, then renamed. `integrity_check` was rejected: it is several times slower and blocks the loop for longer. `quick_check` catches page-level corruption, which is what a copy can get wrong.
- **Schedule without state.** The newest `auto` file's name is the schedule's clock. "Idle-ish" means the newest event's `at` is at least 2 min old, read with a single indexed `SELECT`, with no dependency on the runtime. If the log never goes quiet, the backup runs anyway once it is 6 h overdue.
- **Free space.** Free space must cover the database's size plus 1 GiB, or the backup is skipped. A backup filling the disk would trigger P8-04's held-writes mode for the live database. The skip is logged once per episode and shown as the last outcome in the settings.
- **Rotation** (grandfather-style, label-free). Keep the newest `auto` per UTC day for the last 7 days that have one, plus per ISO week for the last 4 weeks, plus the newest 5 `manual` and 5 `pre-import`.
- **Export format.** The event log is the truth, so it is exported whole with the schema and the app version. The rows are exported as a check, not as the source. The event payloads keep their raw form: the import writes the file's own objects back, not zod's output, which could reorder keys. The acceptance test shows the result is byte-identical.
- **Rebuild path.** No server-side "rows from events" path existed: the server only mutates rows through commands, and the startup rebuilds cover the status store, work states and budget projections, never the domain tables. Rather than write a second fold that could drift, the web client's pure fold moved to `packages/protocol`. The conformance test that holds it equal to the commands now covers the server's rebuild as well. The import adds only the retired-body tombstone, because the client deletes the body while the server keeps the row for its foreign keys.
- **Drift policy.** If the rebuild differs from the exported rows, the import refuses and lists the differences. `--prefer-rows` writes the exported rows instead. Old databases may have rows changed by early migrations, for example the 0004 defaults or the 0005 catalogue seeding with `INSERT OR IGNORE`. Refusing by default is the conservative choice, and the flag makes the file still usable.
- **New log identity** on import and restore. On import, a client of the old server must not resume against a log that diverges from here. On restore, the reissued `seq`s would make a resuming client skip new events. This bug shows up only with the restore-by-hand procedure, so the docs warn about it and `galactic restore` writes the new id.
- **Server must be stopped** for import and restore. The CLI calls `GET /health` on the configured port (`GALACTIC_PORT` → `config.json` → 4321) and refuses if `galactic-agents` answers. The export opens the database read-only and runs beside a live server.
- **Atomic replace.** The new database is built at `<db>.import-<pid>` / `<db>.restore-<pid>` and renamed over the target only after `foreign_key_check` and `quick_check`. A failure removes the temp files and leaves the target untouched (tested).
- **Push subscriptions** of a replaced database are carried over with `ATTACH … INSERT SELECT`. They are device configuration, never exported, and the phones would otherwise have to subscribe again.
- **Live agents in an imported or restored log** are resumed or flagged by startup recovery, like after a crash (decision 8). They are not stopped by the import (see the decision 105 / §8 below).

## Security

- Backup files are 0600 and the folder 0700. Export files are 0600, re-chmodded when overwriting an existing file. The imported or restored database is 0600.
- Never exported: `settings` (log id, vacuum counter), `agent_processes`, `push_subscriptions` (endpoints, p256dh, auth), `config.json` (token, remote host, identity logins), `vapid.json`, runtime sessions. Transcripts only with the flag. The test "never exports secrets or device configuration" greps the JSON for planted endpoint, key and auth values and a PID.
- User-written text (messages, answers, prompts) is exported as written, as TECHNOLOGY §8 already says for the log. The docs say to treat the file like the database.
- REST: bearer-guarded, and 403 `remote_control` for remote clients unless `autoApproveRemote` (decision 90; tested with a forwarded `Host`). No import or restore over REST: both replace the database under the server.

## Measurements (221 MB database: 400 000 transcript chunks + 600 events, on the development Mac)

| | |
| --- | --- |
| Backup through `BackupService` (copy + journal switch + `quick_check` + rename) | 1.46 s in all; longest event-loop block 102 ms |
| Raw `db.backup` at 1024 pages/step | 1.79 s; longest step 50 ms |
| `quick_check` of the copy | 136 ms |
| Export without transcripts (600 events) | 3 ms, 248 KB |
| Export with transcripts | 553 ms (synchronous: on the loop for `GET /api/export?transcripts=1`), 201 MiB of JSON |

## Tests

- `apps/server/src/db/map-export.test.ts` (9). **Acceptance:** a composed runtime with the fake adapter builds a map (card edited and approved; project with a policy, a budget and a pin; a sub-project moved, archived and reopened, then detached; tasks with blockers; a Harmonizer, a Waykeeper and three Stewards, one finishing with a cost and one asking a question that is answered; a standalone task moved into the project; a question escalated, reassigned and answered; a loose project closed and archived; a marker sweep; a demo project archived, so its planet retires, then reopened; agents stopped). Then export, wipe the data folder, import. The test checks: the snapshot is equal (logId aside, and new); the `events` rows are equal row by row (id, at, type, payload text); status records rebuilt from the log are equal; `HistoryView.work`/`questions`/`detail` for every project and task are equal; `HistoryEvents.read` for every project is equal (membership token aside); chats keep their messages (replies need `--transcripts`, with which they come back equal); `logDrift` (P8-04) is empty; spend is rebuilt; the file is 0600. Also covered: transcripts and compaction markers only with the flag; no secrets; refuse not-empty, then `--replace` with a pre-import copy and push subscriptions kept; import into a migrated-only database; drift refused and nothing left behind, then `--prefer-rows`; an invalid file and a newer or other build's export refused; an unmigrated database refused for export; an unknown event type folds to nothing.
- `apps/server/src/db/backup.test.ts` (10): 0600/0700, one file in DELETE mode, integrity, event count; a write during a stepwise backup; shared concurrent calls; low-disk skip logged once; failure reported; idle and overdue scheduling; schedule survives a restart; disabled schedule; timer start and stop; the rotation policy over 60 days; folder rotation ignoring foreign files.
- `apps/server/src/db/restore.test.ts` (3): restore with a new log id, WAL mode, snapshot equal to the moment of the backup, pre-import copy holding the later work; a bad or missing file refused with the target untouched; CLI name lookup in `backups/` and refusal while the server runs.
- `apps/server/src/cli.test.ts` (3), `apps/server/src/http/backup-routes.test.ts` (3), `apps/server/src/config/config.test.ts` (+2), `apps/web/src/panel/settings/backups.test.tsx` (7).
- Manually: the built `bin/galactic.mjs export`/`import` against temp `GALACTIC_HOME`s (`GALACTIC_PORT=1`).

## Proposed SPEC text (not applied; §7 is the coordinator's)

**Decision 105 — Backups, export and restore** (2026-10-06, P8-03; decisions 8, 51, 90, 97, 99): Mission Control copies its database by itself once a day, at a quiet moment (it waits up to six hours for one), while it keeps working. It keeps the newest copy of each of the last 7 days and of each of the last 4 weeks, plus the last 5 copies taken with "Back up now" in the settings. A copy is checked before it is kept, readable only by the user, and skipped (the settings say why) when the disk would keep less than 1 GB free. The settings page lists the copies and offers "Back up now" and "Export the map", on the Mac only (decision 90). The export is one file holding the map's whole history (every project, task, body, card, question, answer, message and state change), plus the agents' output when asked for, and never a credential, the phones' subscriptions or the settings file. Putting a copy back (`galactic restore`) or importing an export (`galactic import`) is done from the command line with Mission Control stopped. Either one first copies the database it replaces, and an import refuses a database that already holds work unless told to replace it. After either, every open panel reloads, and the work that was running is resumed as after any restart (decision 8). Repositories, worktrees and the agents' own sessions are not part of either: on another machine they must be brought over separately, and the agents whose sessions are missing show as needing attention.

Possible §8 open question: should an import onto another machine stop every agent that was live at the export (`agent.stopped` by the system, appended after the imported events) instead of letting recovery try to resume them? Meanwhile the import is faithful (the log is reproduced event for event), and a resume that cannot find its session or folder already ends as "needs attention".

## Left open / follow-ups

- ~~The REST export with transcripts builds the JSON synchronously~~ — streamed since the wave 2 review (below).
- `quick_check` runs on the main thread (≈ 50 ms for 96 MiB, cached). A worker thread would remove it, but would need a worker entry that also works under `tsx` in tests. Documented in `backup.ts` and TECHNOLOGY §6.4.
- The rotation is not editable from the panel (`config.json` only). The settings section shows it.
- A single JSON document is limited by V8's string size (~512 MB). That is fine for the log, but a transcript export of several hundred MB could approach it. JSON Lines would scale if it ever matters.
- Without `--transcripts`, imported agents have no compaction marker saying their output is missing. The views are just empty. Adding a marker would need a new `reason` (a migration on `transcript_compactions`' CHECK).

## Review fixes (P8 wave 2 review, 2026-10-06; branch `p8-wave2-review-fixes`)

- **Import / restore under a running server.** The `/health` check missed `galactic start --port N` (the port is only in the child's environment), a server still in its startup vacuum or recovery (not listening yet) and non-loopback binds. Now a **data lock** (`db/data-lock.ts`, `<db>.lock`: pid, role, `ps lstart` process start time, boot time, port/host once listening). The server takes it before opening the database and removes it on exit; it refuses to start while a live holder has it (a second server on the same database). `galactic import` / `restore` refuse while a live holder has it, keep `/health` as a second check, and hold the lock themselves while they replace the file. Stale = dead pid, a pid now belonging to a process started at another time, another boot, or an unparsable file. Tests: `data-lock.test.ts` (5), `cli.test.ts` (+2), `index-lock.test.ts` (the real `src/index.ts` exits 1 naming the holder and never creates the database).
- **Leftovers.** Each backup first removes `*.partial*` in `backups/` (`removePartialBackups`); the server start and the CLI remove `<db>.import-<pid>` / `.restore-<pid>` files of dead pids (`removeStaleTempDatabases`); the CLI also removes `backups/*.partial*`. Tests in `backup.test.ts`, `data-lock.test.ts`, `cli.test.ts`.
- **Rotation.** The newest backup of each kind is always kept (a `keep*` of 0 can no longer delete the copy just taken or the only pre-import copy). The schema's `nonnegative()` stays, so existing `config.json` files still load.
- **`GET /api/export` streams** (`exportMapText` over a dedicated read-only connection, one read transaction, 2 000 events or chunks per page, event-loop yields between pages, payloads written as stored); the schema check runs before the first byte (409 `export_refused`). Tests: the streamed document equals `exportMap`'s and ignores a write made mid-stream (`map-export.test.ts`); the route on a file database, and its refusal (`backup-routes.test.ts`).
- **Shutdown** awaits a backup under way (`BackupService.idle()`).
- **Restore** checks the backup's migrations (`checkSchema(…, {allowOlder: true})`): a newer build's backup is refused; an older one is accepted (migrated at the next start). Test in `restore.test.ts`.
- SPEC §8's 2026-10-06 import question now covers a restore too (agents live in the backup resume sessions and worktrees that moved on).

