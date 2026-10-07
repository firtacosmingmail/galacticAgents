# Phase 8 wave 2 review (P8-03, P8-05, P8-09, P8-10)

Review of `phase-8...p8-wave2-smoke-backup-storage-caps`, 2026-10-06. No blockers. Fixes landed on
`p8-wave2-review-fixes` and were merged into the batch branch; gates green afterwards (protocol 98,
server 1164 + 1 skipped, web 1669), `pnpm drills` green, `pnpm e2e` 8/8.

## The drill failure after the merge

`kill-anytime` failed once (seed 75240, run 3): the recovery report listed an agent the test did
not expect. Cause: a wrong expectation left from wave 1 — an agent caught between `agent.created`
and `agent.spawned` has no status record, and recovery correctly restarts it (decision 101). The
test now expects those agents too; the reproduction (150 runs, window 600–760 ms) passes 150/150.

## Should-fix (all fixed)

1. **Import or restore could replace the database under a running server** (a server on another
   port, still starting, or on another address escaped the `/health` check). The server now holds
   `galactic.sqlite.lock` (pid, start time, boot, port) for its life; import and restore refuse while
   a live holder exists, and a second server refuses to start on the same data folder.
2. **Half-written backups piled up.** `*.partial*` and dead-pid import/restore leftovers are removed
   before each backup, at start and by the CLI.
3. **Old pages looped on the optional wall-clock limit.** `limit` is always sent again; `capped:
   false` marks a brain. TECHNOLOGY §6.3 states the rule: every message stays readable by the
   previous build.

## Nits (fixed)

Rotation always keeps the newest of each kind; `GET /api/export` streams from a read-only
connection; shutdown waits for a backup in flight; restore refuses a backup from a newer build; a
full disk writing `config.json` is 507; the e2e server runs with its own `HOME`; the §8 import
question covers restore; the P8-09 task text defers the push to §8.

## Checked and OK

The fold moved to `packages/protocol/src/world.ts` unchanged, so client and import replay agree; a
new log id after import/restore forces clients to take a snapshot; exports hold no secrets; online
backups include concurrent writes; storage refusals map to 507/503 everywhere; `meta.freeForm` is
set only by the ops console spawn; the e2e suite is isolated.

## Left open

- P8-11 (a CLI forked just before a kill), P8-12 (push bookkeeping on a full disk), P8-06/07/08.
- `galactic export` on the CLI builds the document in memory; `quick_check` runs on the main thread
  (~50 ms per 100 MB).
- If `pnpm dev`'s watcher ever starts the new server before the old one exits, the new one refuses
  to start with the lock message (restart it).
- No CI yet for `pnpm e2e`.
