# Phase 8 — Hardening, cost and polish (ongoing)

**Current task:** — (every task done; the phase stays open as the ongoing backlog) · **Task status:** —
**Phase status:** in progress (16/16 done) — on branch `phase-8`, cut from `phase-7`; merged into `main` on 2026-10-07; every task done, the phase stays open as the ongoing backlog

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

All tasks are independent of each other; suggested priority order: P8-04 → P8-02 → P8-01 → P8-05 → P8-03 → P8-07 → P8-08 → P8-06. Added from the P8-04 drills (2026-10-05): P8-10 (brains stopped by the wall-clock cap) first, then P8-09, then P8-11.

## Tasks

### P8-01 — Dollar budgets per project/task
- **Status:** done (2026-10-05) · **Depends on:** P2-17, P1-08 · **Parallel with:** all
- Budget fields on projects/tasks; cost aggregation from `agent.finished(cost)`; Harmonizer warns at a threshold and refuses spawns beyond the budget (tool error + user message); budget editing in settings/cards.
- **Acceptance:** tests with fake costs; the refusal is visible in the Harmonizer chat.

### P8-02 — Transcript retention and compaction
- **Status:** done (2026-10-05) · **Depends on:** P1-06, P2-13 · **Parallel with:** all
- Retention policy for `transcript_chunks` (by age and by archived project); scheduled compaction; `events` untouched; VACUUM strategy.
- **Acceptance:** compaction runs on a fixture DB; resume from `lastEventId` and the scrubber still work afterwards.

### P8-03 — Backups, export and import of the map
- **Status:** done (2026-10-06) · **Depends on:** P2-13 · **Parallel with:** all
- Scheduled SQLite backups (online backup API); export/import of projects, tasks, bodies and history as JSON; restore procedure documented.
- **Acceptance:** export → wipe → import reproduces the map and history.

### P8-04 — Crash recovery drills
- **Status:** done (2026-10-05) · **Depends on:** P2-16 · **Parallel with:** all
- Scripted drills: `kill -9` mid-project, reboot the machine, unplug the network during a Steward run, disk full on write; record outcomes and fix findings; add the reproducible ones to CI.
- **Acceptance:** drill log in `docs/tasks/notes/P8-04-drills.md`; no data loss or duplicate spawns in any drill.

### P8-05 — Playwright scene and panel smoke tests
- **Status:** done (2026-10-06) · **Depends on:** P5-05 · **Parallel with:** all
- Headless Chromium smoke tests: app loads, snapshot renders, a fake-adapter project shows bodies and satellites, inbox answer flow works; screenshot diffs for the scene at a fixed seed.
- **Acceptance:** suite in CI using the fake adapter.

### P8-06 — Tauri 2 desktop shell
- **Status:** done (2026-10-06) · **Depends on:** P7-01 · **Parallel with:** all
- Wrap the web UI in Tauri 2: tray icon with status, auto-start option, server lifecycle managed by the shell, notifications via the OS.
- **Acceptance:** `.app` bundle runs the same UI against the local server.

### P8-07 — ACP adapter (Codex / Gemini CLI / claude-agent-acp)
- **Status:** done (2026-10-07; conformance 22/22 against claude-agent-acp 0.86.0, isolated settings by default; codex-acp and Gemini not checked) · **Depends on:** P1-13, P1-04 · **Parallel with:** all
- Official TypeScript ACP SDK client; `initialize` capability set documented (advertise `elicitation.form`; no `fs/*`/`terminal/*` unless implemented); `session/new|prompt|update|cancel|load`; `request_permission` → permission-kind; `elicitation/create` → clarification-kind; fake ACP agent script for the conformance suite; runtime selection in spawn options and settings.
- **Acceptance:** conformance suite green against the fake ACP agent in CI and against one real ACP runtime locally.

### P8-08 — PTY adapter for arbitrary CLIs
- **Status:** done (2026-10-06) · **Depends on:** P1-13, P1-04 · **Parallel with:** all
- `node-pty` spawn, xterm.js view in the Steward panel, heuristic status (activity, exit code, prompt detection), best-effort question detection, no resume (shown `interrupted` with restart).
- **Acceptance:** conformance suite green for the subset the interface marks optional; a shell-script "agent" runs end to end.

### P8-09 — Storage health in the panel (added 2026-10-05)
- **Status:** done (2026-10-06) · **Depends on:** P8-04 · **Parallel with:** all
- From the P8-04 disk-full drill (`notes/P8-04-drills.md`, finding F2): the server now holds the agent events it cannot write and writes them when space returns, but the user only sees refused actions as generic 500 errors. Add a storage state to the status stream (writes failing since, agent events waiting), a "disk full — N agent events waiting" banner in the panel, and `507 storage_full` ("the disk is full") for REST and WebSocket actions the storage refuses. SPEC decision 99. The push notification first planned here is deferred (SPEC decision 104): whether a full disk should also send a push / desktop notification is the 2026-10-06 open question in SPEC §8; meanwhile none.
- **Acceptance:** with the drill's full disk, the panel shows the banner within a second, a refused action says the disk is full, and the banner clears when the held events are written.

### P8-10 — Brains and the wall-clock cap (added 2026-10-05)
- **Status:** done (2026-10-06) · **Depends on:** P2-17 · **Parallel with:** all
- From the P8-04 network drill (finding F5): the per-agent wall-clock cap (default 2 h) also stops the Harmonizer and Waykeepers, idle time included — an idle Harmonizer fails with `failed(reason: cap)` once the cap has passed since its spawn and is replaced with a fresh session; a Waykeeper fails every two hours. Decided by Cosmin (2026-10-06): the wall-clock cap applies to Stewards only; brains are bounded by the hierarchy and their tool-call cap and fix in `CapsEnforcer` with a test.
- **Acceptance:** a brain idle past the wall-clock cap keeps running; Stewards are still stopped by it.

### P8-11 — A CLI forked just before a kill (added 2026-10-05)
- **Status:** done (2026-10-06) · **Depends on:** P8-04 · **Parallel with:** all
- From the P8-04 kill-at-any-moment drill (residual R3, seen once): a child the supervisor forked in the instant before the server was killed can run with no PID-table row, so `reconcile()` never takes it. Record a launch intent (agent, command, time) before the spawn, and at startup take a marked (`GALACTIC_AGENT_ID`) orphan of such an intent's agent started in that window, with the same safety rules as P4-14.
- **Acceptance:** a drill that kills the server between the fork and the row (fault injection) leaves no process of the killed run.

### P8-12 — Push bookkeeping on a full disk (added 2026-10-06)
- **Status:** done (2026-10-06) · **Depends on:** P7-04, P8-09 · **Parallel with:** all
- Found while building P8-09: `PushService.deliver` calls `markSent` inside the send's `try`, so on a full disk a delivered push fails `markSent`, is treated as a network error and is sent again (up to three attempts). Separate delivery from bookkeeping; a bookkeeping failure must never re-send.
- **Acceptance:** with SQLITE_FULL on the push bookkeeping, each push is delivered once; a test proves it.

### P8-13 — Slash-command autocomplete in the composer (added 2026-10-07)
- **Status:** done (2026-10-07) · **Depends on:** P5-06, P8-07 · **Parallel with:** P8-14, P8-15
- Cosmin's request: as in the Claude terminal, typing `/` at the start of a message opens a list of the slash commands the agent being talked to supports (its skills and plugin commands, as its runtime reports them — the Claude SDK's supported commands; ACP's available commands; none for terminal agents), filtered as the user types; arrows move, Tab/Enter inserts, Esc closes. Works in every composer (Harmonizer chat, Waykeeper chat, Steward clarification box where sending is allowed), keyboard and touch, accessible (combobox/listbox).
- **Acceptance:** with the fake adapter reporting commands, `/` lists them, typing filters, Enter inserts the command; a runtime with no commands shows nothing; axe clean.

### P8-14 — Message history with ↑ in an empty composer (added 2026-10-07)
- **Status:** done (2026-10-07) · **Depends on:** P5-02 · **Parallel with:** P8-13, P8-15
- Cosmin's request: pressing ↑ in an empty composer recalls the user's previous messages to that agent (newest first), ↓ walks forward and back to empty, as in a terminal; editing a recalled message and sending sends the edited text; a draft is never lost (↑ only when the composer is empty or showing a recalled entry).
- **Acceptance:** ↑/↓ walk the user's own sent messages for that conversation; non-empty drafts are untouched; tests.

### P8-15 — Hidable navigation sheet on phones (added 2026-10-07)
- **Status:** done (2026-10-07) · **Depends on:** P7-03, P4-10 · **Parallel with:** P8-13, P8-14
- Cosmin's request: on the phone, the left navigation (Harmonizer, projects, asteroids — the agents sheet) becomes a sheet that slides in from the left edge and hides again: a button in the top bar, an edge swipe, tap outside or Esc to close; it closes after a selection; desktop layout unchanged; reduced motion respected; focus trapped while open.
- **Acceptance:** on a phone-sized viewport the sheet is hidden by default, opens from the button and the edge swipe, closes on selection/outside tap/Esc; e2e or jsdom tests; axe clean.

### P8-16 — Shorter asteroid names in the scene (added 2026-10-12)
- **Status:** done (2026-10-12) · **Depends on:** P3-07 · **Parallel with:** —
- Cosmin's request: "make the names of the asteroids smaller, similar to the ones used for the planets and moons." The labels share one font size; an asteroid's label shows its task's title (up to 32 characters) where a planet or moon shows a project's usually short name. An asteroid's label title is cut at 16 characters with "…"; the tooltip keeps the whole title; planets and moons unchanged.
- **Acceptance:** an asteroid's label title is at most 16 characters; a planet's or moon's still up to 32; tests.
- **Done:** `ASTEROID_TITLE_MAX` in `scene/labels/label-model.ts`; tests in `label-model.test.ts` and `labels-ui.test.tsx`; `notes/P3-07-labels.md` updated.

## Exit criteria

None as a phase; each task has its own acceptance criteria.
