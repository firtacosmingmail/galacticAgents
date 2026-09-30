# Phase 8 — Hardening, cost and polish (ongoing)

**Current task:** — (phase not started; tasks here are picked individually as needed) · **Task status:** —
**Phase status:** not started (0/8 done)

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

An ongoing backlog rather than a sequential phase: dollar budgets, retention/compaction, backups, crash drills, scene smoke tests, the optional desktop shell, and the deferred adapters (ACP for a second runtime, PTY for arbitrary CLIs). Tasks here can be picked any time after their dependencies are met; most can run in parallel with each other.

## Entry criteria

- Per task (see dependencies). Nothing here blocks Phases 3–7.

## References

- `IMPLEMENTATION_PLAN.md` → Phase 8; corner cases 3, 5, 8, 22, 33, 34.
- `TECHNOLOGY.md` §2.3 (Tauri), §3.2 (ACP adapter requirements), §3.3 (PTY adapter), §5.4 (caps → budgets), §6.2 (streams and retention).
- `SPEC.md` decision 5 (future runtimes), 17 (billing), 18 (budgets later).

## Design notes for implementation

- Budgets need reliable cost reporting (P1-08 finding); if cost is unavailable for subscription sessions, budgets apply to API-billed agents only and the UI says so.
- Compaction applies to `transcript_chunks` only; the `events` stream stays intact for resume and replay.
- The ACP adapter must advertise `elicitation.form`, map `request_permission` to permission-kind questions, not advertise `fs/*` or `terminal/*` unless implemented, and pass the same conformance suite.
- The PTY adapter cannot resume; status is heuristic; questions are best-effort.

## Execution order

All tasks are independent of each other; suggested priority order: P8-04 → P8-02 → P8-01 → P8-05 → P8-03 → P8-07 → P8-08 → P8-06.

## Tasks

### P8-01 — Dollar budgets per project/task
- **Status:** todo · **Depends on:** P2-17, P1-08 · **Parallel with:** all
- Budget fields on projects/tasks; cost aggregation from `agent.finished(cost)`; Harmonizer warns at a threshold and refuses spawns beyond the budget (tool error + user message); budget editing in settings/cards.
- **Acceptance:** tests with fake costs; the refusal is visible in the Harmonizer chat.

### P8-02 — Transcript retention and compaction
- **Status:** todo · **Depends on:** P1-06, P2-13 · **Parallel with:** all
- Retention policy for `transcript_chunks` (by age and by archived project); scheduled compaction; `events` untouched; VACUUM strategy.
- **Acceptance:** compaction runs on a fixture DB; resume from `lastEventId` and the scrubber still work afterwards.

### P8-03 — Backups, export and import of the map
- **Status:** todo · **Depends on:** P2-13 · **Parallel with:** all
- Scheduled SQLite backups (online backup API); export/import of projects, tasks, bodies and history as JSON; restore procedure documented.
- **Acceptance:** export → wipe → import reproduces the map and history.

### P8-04 — Crash recovery drills
- **Status:** todo · **Depends on:** P2-16 · **Parallel with:** all
- Scripted drills: `kill -9` mid-project, reboot the machine, unplug the network during a Steward run, disk full on write; record outcomes and fix findings; add the reproducible ones to CI.
- **Acceptance:** drill log in `docs/tasks/notes/P8-04-drills.md`; no data loss or duplicate spawns in any drill.

### P8-05 — Playwright scene and panel smoke tests
- **Status:** todo · **Depends on:** P5-05 · **Parallel with:** all
- Headless Chromium smoke tests: app loads, snapshot renders, a fake-adapter project shows bodies and satellites, inbox answer flow works; screenshot diffs for the scene at a fixed seed.
- **Acceptance:** suite in CI using the fake adapter.

### P8-06 — Tauri 2 desktop shell
- **Status:** todo · **Depends on:** P7-01 · **Parallel with:** all
- Wrap the web UI in Tauri 2: tray icon with status, auto-start option, server lifecycle managed by the shell, notifications via the OS.
- **Acceptance:** `.app` bundle runs the same UI against the local server.

### P8-07 — ACP adapter (Codex / Gemini CLI / claude-agent-acp)
- **Status:** todo · **Depends on:** P1-13, P1-04 · **Parallel with:** all
- Official TypeScript ACP SDK client; `initialize` capability set documented (advertise `elicitation.form`; no `fs/*`/`terminal/*` unless implemented); `session/new|prompt|update|cancel|load`; `request_permission` → permission-kind; `elicitation/create` → clarification-kind; fake ACP agent script for the conformance suite; runtime selection in spawn options and settings.
- **Acceptance:** conformance suite green against the fake ACP agent in CI and against one real ACP runtime locally.

### P8-08 — PTY adapter for arbitrary CLIs
- **Status:** todo · **Depends on:** P1-13, P1-04 · **Parallel with:** all
- `node-pty` spawn, xterm.js view in the Steward panel, heuristic status (activity, exit code, prompt detection), best-effort question detection, no resume (shown `interrupted` with restart).
- **Acceptance:** conformance suite green for the subset the interface marks optional; a shell-script "agent" runs end to end.

## Exit criteria

None as a phase; each task has its own acceptance criteria.
