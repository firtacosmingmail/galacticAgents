# P8-02 — Transcript retention and compaction

Branch `p8-02-retention` (from `p8-wave1-drills-retention-budgets`). Code in `apps/server/src/runtime/transcript-retention.ts`, `apps/server/src/db/vacuum.ts`, migration `0011_transcript_compactions.sql`, `packages/protocol/src/panel.ts` (`TranscriptRetention`, `TranscriptCompaction`), and the web views (`apps/web/src/panel/compaction.ts`, the Steward transcript, the chat, the settings page). TECHNOLOGY §6.2 ("Transcript retention") describes it.

## What compaction means

- **Chunks are removed, nothing is summarised.** A summary would be either an LLM's (cost, and a second source of truth) or a truncation (head + tail per session), and both show something the agent never wrote as if it had. The event log already keeps what matters for history: messages, tool calls (`agent.tool_call`), states, questions and answers. So the simplest honest choice: drop the oldest chunks of an agent and **say so**.
- **Always a prefix.** An agent's chunks are removed oldest first, so what is left is a contiguous tail after `through_seq`; a view never has a hole in the middle.
- **The UI says what is gone.** `transcript_compactions` (migration 0011, one row per agent) records `through_seq`, `through_at` (when the last removed chunk was written), `removed_at`, `removed_chunks`, `reason` (`age` | `archived`) and `last_seq`. `GET /api/agents/:id/transcript` and `/conversation` return it as `compacted` (optional field, so an older client ignores it). The Steward view shows "Older transcript (up to <date>) removed on <date> by retention." above the oldest chunk once there is nothing older to load (or "… this work was archived."); the chat shows "Replies up to <date> removed on <date> by retention. Messages are kept." at the top of the thread (its messages come from the event log and stay).
- **`events` untouched.** Resume from `lastEventId`, the timeline replay, the history inspector and the chat's messages read only `events` (the inspector reads no transcript at all; the replay skips `agent.output`, which never enters the log).
- **The high-water mark.** `last_seq` is the agent's newest `seq` when chunks were removed. The pipeline (`TranscriptPipeline`) and `History.maxSeq` number from `MAX(newest chunk, last_seq)`, so even an agent whose whole transcript was removed continues after it, across restarts. This replaces the old unused `prune()` (which kept the newest row for that reason).

## The policy

`transcriptRetention: {maxAgeDays, archivedDays}` in days (fractions allowed), `null` = keep forever; defaults **90** and **30** (`DEFAULT_TRANSCRIPT_RETENTION`).

- **Archived work** — an agent whose task, or any project in its chain (its own project or its task's, then each parent), is `archived` loses its **whole** transcript `archivedDays` after the archive. The archive time is the last `*.state_changed` into `archived` (from the log), falling back to the row's `updatedAt`; with several archived items in the chain the latest counts (kept longer). Reopened work is no longer archived, so it is no longer due (what was already removed stays removed; the views say so).
- **Age** — any other agent, the Harmonizer included, loses its chunks written more than `maxAgeDays` ago. A long-running Harmonizer's old replies therefore go after 90 days by default, while its conversation's messages stay.
- **Pinned work is never compacted** — an agent whose task or any project in its chain is pinned is skipped by both rules (a pin already suspends archival, decisions 11b and 41).
- Orphan chunks (an agent row that does not exist) follow the age rule.

Settings: `config.json` (`transcriptRetention`, partial objects merged over the defaults), `PATCH /api/settings {transcriptRetention: {maxAgeDays?, archivedDays?}}` (merged key by key; applied live to the job), the settings page's "Transcript retention" section (page only, not in the first-run wizard; shown only when the server sends the setting). It is not in the remote-writable list: a remote client gets 403 `remote_settings` (decisions 51, 90) unless `autoApproveRemote`.

## Schedule and the event loop

- `TranscriptRetention` runs hourly from the composition (`TRANSCRIPT_RETENTION_INTERVAL_MS`, once at start, `unref`'d timer; tests call `run()` with an injected clock). Concurrent `run()` calls share one run; `stop()` (shutdown) ends a run at its next pause, before the database closes.
- Agents are enumerated by index seeks on the primary key (`agent_id > ? ORDER BY agent_id LIMIT 1`), not a scan.
- Deletes go in **batches of 500 chunks**, one transaction each (delete + marker upsert), awaiting `setImmediate` between batches.
- Then the space is given back (below).

## VACUUM strategy

- **Current DB settings before this task:** `journal_mode = WAL`, `synchronous = NORMAL`, `auto_vacuum = NONE` (SQLite's default), 4 KiB pages. With `NONE`, deleted pages go to the free list and are reused by later inserts, but the file never shrinks.
- **New databases** get `PRAGMA auto_vacuum = INCREMENTAL`, set in `openDatabase` before `journal_mode` (it only takes effect before the first table is created; it cannot go in a migration: migrations run inside a transaction and VACUUM cannot).
- **Existing databases** are converted once at startup in `index.ts` (`convertToIncrementalVacuum`: the pragma, then one full `VACUUM`), before the server listens, so no client waits on it. Cost: 0.3 s at 22 MB, 3.2–3.5 s at 213 MB, 7–11 s at 531 MB (below). If it fails (VACUUM needs room for a copy: a full disk) it is logged and retried at the next start; the server works as before meanwhile.
- **After a run that removed chunks**, `vacuumIncrementally` releases the free list **256 pages (1 MiB) per step** with `PRAGMA incremental_vacuum(256)`, yielding between steps. No explicit WAL checkpoint: a `wal_checkpoint(TRUNCATE)` at the end measured 0.2–0.4 s in one go on a probe, while SQLite's auto-checkpoint (every 1 000 pages) keeps the WAL at ≈ 4 MB.
- Why not a periodic full VACUUM when idle: better-sqlite3 is synchronous, so a full VACUUM holds the event loop for seconds on a few hundred MB (see the conversion cost) — exactly what the task rules out. Step sizes tried on the 404 k-chunk fixture: 2 048 pages per step → longest step ≈ 0.2 s with a 78 ms longest delete batch at 2 000 chunks per batch; 256 / 500 keeps typical steps at 3–30 ms and batches under 40 ms for about +15 % total time.

## Measurements

The fixture (`apps/server/src/runtime/transcript-retention.fixture.test.ts`, a file database in WAL mode): 101 agents — the Harmonizer; 12 projects archived 110 days ago (Waykeeper + 3 Stewards each); 4 projects (moons) archived 5 days ago; a pinned archived project; 3 live projects; 20 standalone tasks' Stewards, half archived 110 days ago — each with `n` chunks of ≈ 450 bytes (text / tool / thinking) evenly over 120 days, and 2 516 events (agent lifecycle and 20 tool calls per agent). Policy: 90 days of age, 30 days after archive, at day 120. Apple M3 Pro, Node 22.14, macOS; other agents' test runs were sharing the machine, so the worst single steps are noisy.

`GALACTIC_P802_SCALE=n` multiplies `n = 400`; `GALACTIC_P802_REPORT=<file>` writes these figures; `GALACTIC_P802_FULL_VACUUM=1` times a full VACUUM first (in a separate run: it leaves the OS writing back the rewritten file, which slows the compaction's fsyncs right after it).

| Chunks before → after | DB before → after | Removed | Batches · longest | Vacuum steps · longest | Vacuum total | Run total | Full VACUUM (conversion) |
|---|---|---|---|---|---|---|---|
| 40 400 → 13 300 (CI default) | 21.9 → 8.1 MB | 27 100 | 97 · 15 ms | 14 · 18 ms | 24 ms | 0.21 s | 0.3 s |
| 404 000 → 133 000 | 212.7 → 71.3 MB | 271 000 | 542 · 36 ms | 142 · 204 ms | 0.49 s | 1.7 s | 3.2–3.5 s |
| 1 010 000 → 332 500 | 533.9 → 177.4 MB | 677 500 | 1 355 · 78 ms | 357 · 412 ms | 2.7 s | 7.4 s | 7.3–11 s |

"DB after" is after a TRUNCATE checkpoint taken by the test outside the timed run (the job leaves the WAL at 4.2–4.8 MB). Typical vacuum steps are 3–30 ms; the longest ones are the steps where SQLite's auto-checkpoint lands (its fsync), measured at ≈ 0.1–0.17 s on a probe whose file was already flushed and up to 0.4 s in the fixture right after it wrote the whole file. Those are rare (a few per run, at most once an hour, and only when something was removed). The CI-size fixture asserts: archived work emptied, pinned work whole, live and recently archived work keeps its last 90 days (¾), the file under 60 % of its size, longest batch and step under 0.5 s.

## Acceptance

- Compaction on a fixture DB: the fixture test above (default size in CI).
- Resume from `lastEventId` after compaction: the same test starts the app on the compacted log and resumes a socket from `lastSeq − 50`; it receives exactly those 50 events, then `caught_up`.
- The scrubber after compaction: `HistoryEvents.read` (the replay endpoint's reader) returns identical events for a live and an archived project before and after.
- The event log: same row count, same `currentSeq`, same `eventsSince`.
- Unit tests (`transcript-retention.test.ts`): the archived rule and its timing, the age rule as a prefix, both off, pinned exempt, the `compacted` marker on both pages, the high-water `seq` after a full removal, batching and pausing, stop mid-run (the marker covers what was removed), shared concurrent runs, new-DB incremental mode and the one-time conversion, stepwise vacuum. Settings (`settings.test.ts`): defaults, key-by-key patch, live apply, restart, remote refusal. Web: the Steward view note above the oldest chunk, the chat note, the settings section (and its absence for an older server).

## Proposed decision 97 (for SPEC §7; not edited there)

> **97 · Transcript retention** — *Old agent output is removed, and the views say so* (2026-10-05, P8-02; §4.6, decisions 4, 11b, 41, 51, 61, 78, 90): agents' output (their replies, tool calls as they printed them, thinking) is kept for a configurable time, then removed for good; nothing summarises it. Two settings, each in days or "keep forever": output older than **90 days** is removed from any agent, the Harmonizer included; an agent's whole output is removed **30 days after its work was archived**. Pinned work is never touched. What is always kept: messages to agents, questions and answers, states, tool calls as the log recorded them, and so the history, the inspector and the timeline replay. Where output was removed the Steward's transcript says "Older transcript removed on <date> by retention" above what is left, and a chat says its replies up to a date were removed while its messages stay. The settings are changed on the Mac only (a remote client cannot, decision 90). Removing output gives the disk space back gradually, without pausing the app; a database from before this change is converted once when Mission Control starts, which can take a few seconds for a large one.

## Left open / notes for review

- `transcriptRetention` is optional in `Settings` so a page reading an older server still parses; this server always sends it. It has no environment override.
- A reopened archived project gets no transcript back (removed is removed); the marker keeps saying so.
- No client event announces a compaction: an open Steward view or chat learns of it on its next REST page (open, reload, catch-up). Acceptable: compaction only touches output older than the policy, which an open view rarely holds; an event would also need a fold and a conformance exemption.
- The fixture's large runs are not in CI (only `n = 400`); rerun with `GALACTIC_P802_SCALE=10` / `25` to refresh the table.
