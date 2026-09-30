# Phase 0 — Foundations

**Current task:** P0-12, P0-13, P0-14, P0-15, P0-16, P0-17, P0-18 (review follow-ups) · **Task status:** in progress
**Phase status:** reopened (2026-09-30) — 11/18 done; follow-ups from `docs/tasks/notes/P0-review.md`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

An empty but *correctly shaped* monorepo: server and web share one vocabulary (`packages/protocol`), the server persists with the one-transaction write rule, and the WebSocket protocol is already the resumable one every later client will use. Nothing here is throwaway; Phase 1 builds directly on it.

## Entry criteria

- `SPEC.md` v0.3, `TECHNOLOGY.md` v0.3 and `IMPLEMENTATION_PLAN.md` v0.3 read.
- Node 22 LTS and pnpm installed.

## References

- `IMPLEMENTATION_PLAN.md` → Phase 0.
- `TECHNOLOGY.md` §2.2 (server), §6 (persistence, event log, WebSocket protocol), §7 (repository layout and protocol vocabulary), §8 (security).
- `SPEC.md` §4.4 (task/project states — the enum values live in the protocol package), §7 decisions 18 (caps fields on `Agent`), 7 (`PermissionPolicy`).

## Design notes for implementation

- **Three workspaces only:** `apps/server`, `apps/web`, `packages/protocol`. Adapters and brains are folders inside `apps/server/src`.
- **`packages/protocol` is the single vocabulary.** Domain schemas, event schemas, the `AgentAdapter` interface and the `DomainCommands` interface all live there as zod schemas + TS types. Server and web import from it; nothing is redeclared elsewhere.
- **One write rule:** every command = domain mutation + event insert in one `better-sqlite3` transaction; event id = `events.rowid`; in-memory subscribers are notified *after* commit.
- **Two streams:** `events` (small, ordered, kept long) and `transcript_chunks(agentId, seq, chunk)` (batched, prunable). Phase 0 creates both tables; Phase 1 fills the second.
- **WebSocket protocol:** first frame `hello{token, lastEventId?}` → `snapshot{seq, …}` or `events since lastEventId` → ordered `{seq, event}` stream. Client state is derived from the stream only.
- **Security from day one:** bearer token even on localhost (printed once by `galactic start`), bind `127.0.0.1`, `Host` allow-list, `Origin` check on upgrade.
- Speculative fields go in a `meta` JSON column, not in the schema (corner case 20).

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P0-01 | Everything depends on the scaffold. |
| 2 (parallel) | P0-02, P0-03, P0-05 | Domain schemas, event schemas and the server skeleton are independent. |
| 3 (parallel) | P0-04, P0-06 | Interfaces need both schema sets; SQLite layer needs the domain schemas. |
| 4 | P0-07 | Event bus needs the DB and the event schemas. |
| 5 (parallel) | P0-08, P0-09 | WS protocol on the server; web client can start against the protocol types and finish once P0-08 exists. |
| 6 (parallel) | P0-10, P0-11 | Resume test and dev ergonomics. |
| 7 (parallel) | P0-12 … P0-18 | Review follow-ups (added 2026-09-30, see `notes/P0-review.md`); independent of each other. |

## Tasks

### P0-01 — Monorepo scaffold and tooling
- **Status:** done (2026-09-30) · **Depends on:** — · **Parallel with:** —
- pnpm workspace with `apps/server`, `apps/web`, `packages/protocol`; shared `tsconfig.base.json`; ESLint + Prettier; Vitest configured in all three packages; root `pnpm dev` script that starts server and web together (e.g. via `concurrently`); `.gitignore` covering `node_modules`, `dist`, `*.sqlite*`, `.env`.
- **Acceptance:** `pnpm install && pnpm -r build && pnpm -r test` pass on an empty codebase; `pnpm dev` starts both processes.

### P0-02 — Protocol: domain model schemas
- **Status:** done (2026-09-30) · **Depends on:** P0-01 · **Parallel with:** P0-03, P0-05
- zod schemas + inferred types for `Body`, `Project`, `Task`, `Agent`, `Proposal`, `Question`, `StatusRecord`, `PermissionPolicy`, and the enums: body kinds, agent roles/states (`starting, working, waiting_for_input, idle, stalled, paused, interrupted, finished, failed, stopped`), task/project states (`SPEC.md` §4.4), question kinds (`clarification | permission`), proposal states (`pending | approved | edited | rejected | parked`). Field lists as in `IMPLEMENTATION_PLAN.md` Phase 0.
- **Acceptance:** schemas exported from the package root; a test parses a fixture of each type and rejects one invalid example each.

### P0-03 — Protocol: event model schemas
- **Status:** done (2026-09-30) · **Depends on:** P0-01 · **Parallel with:** P0-02, P0-05
- Discriminated union of all events: `agent.*` (spawned, output, tool_call, needs_input, progress, idle, stalled, paused, resumed, finished, failed, stopped), `question.*` (opened, escalated, answered, reassigned), `proposal.*` (created, approved, edited, rejected, parked), `body.*` (assigned, moved, freed), `project.*`, `task.*`, `control.*` (stop, cancel, pause, resume, edit, close, archive, pin, reopen); envelope `{seq, at, event}`; the `hello` / `snapshot` WS message schemas.
- **Acceptance:** exhaustive `switch` over the union compiles; fixtures for every event type parse.

### P0-04 — Protocol: `AgentAdapter` and `DomainCommands` interfaces
- **Status:** done (2026-09-30) · **Depends on:** P0-02, P0-03 · **Parallel with:** P0-06
- `AgentAdapter`: `spawn(opts{cwd, prompt, tools?, systemPrompt?, permissionPolicy, caps})`, `send(sessionId, message, {interrupt?})`, `answer(questionId, answer)`, `interrupt`, `pause`, `resume`, `stop`, `resumeSession?(sessionRef)`, `events: AsyncIterable<AgentEvent>`. `DomainCommands`: the command surface brain tools and panel actions will call (create/assign/spawn/close/control…), typed but unimplemented (Phase 2 implements).
- **Acceptance:** interfaces exported; a no-op implementation of each type-checks.

### P0-05 — Server skeleton with auth and origin checks
- **Status:** done (2026-09-30) · **Depends on:** P0-01 · **Parallel with:** P0-02, P0-03
- Fastify app bound to `127.0.0.1` on a configurable port; config loader (env + `~/.galactic/config.json`); token generated on first start, stored in config, printed once; `Host` allow-list (`localhost`, `127.0.0.1`, configurable `*.ts.net`); `Origin` check on WS upgrade; `ws` server attached; health endpoint.
- **Acceptance:** connection with wrong token, wrong `Host`, or foreign `Origin` is refused (tests); health endpoint answers with the token.

### P0-06 — SQLite layer and migrations
- **Status:** done (2026-09-30) · **Depends on:** P0-02 · **Parallel with:** P0-04
- `better-sqlite3` in WAL mode; migrations folder + tiny runner (numbered SQL files, `schema_migrations` table); migration 0001 creates domain tables (bodies, projects, tasks, agents, proposals, questions, settings), `events(rowid, at, type, payload)`, `transcript_chunks(agentId, seq, chunk)`.
- **Acceptance:** fresh DB migrates from zero; re-running is a no-op; a test inserts and reads each table.

### P0-07 — Event bus with the one-write rule
- **Status:** done (2026-09-30) · **Depends on:** P0-03, P0-06 · **Parallel with:** —
- `runCommand(fn)` wrapper: opens a transaction, runs the domain mutation, inserts the event(s), commits, then publishes to in-memory subscribers with `seq = rowid`. `eventsSince(seq)` reader. Snapshot builder skeleton (reads current tables).
- **Acceptance:** a test throws inside a command and verifies neither the row nor the event exists; subscribers receive events strictly in `seq` order.

### P0-08 — WebSocket protocol: hello, snapshot, resume, stream
- **Status:** done (2026-09-30) · **Depends on:** P0-05, P0-07 · **Parallel with:** P0-09
- First-frame `hello{token, lastEventId?}` handling; reply with `snapshot` (when no/old `lastEventId`) or `events since`; then the live `{seq, event}` stream; per-connection backpressure; close on protocol violation.
- **Acceptance:** integration test: connect, receive snapshot, receive live events; reconnect with `lastEventId` and receive exactly the missed events.

### P0-09 — Web skeleton with resumable client
- **Status:** done (2026-09-30) · **Depends on:** P0-01, P0-03 (start), P0-08 (finish) · **Parallel with:** P0-08
- Vite + React 19 + TS; Zustand store derived purely from the event stream; WS client with token entry, automatic reconnect and `lastEventId` persistence (in memory + `localStorage` — the `localStorage` part was reverted by P0-12); a bare page listing the snapshot and printing events as they arrive.
- **Acceptance:** page connects, shows the snapshot, prints a fake event emitted by the server.

### P0-10 — Resume and gap test
- **Status:** done (2026-09-30) · **Depends on:** P0-08, P0-09 · **Parallel with:** P0-11
- Automated test (Vitest + a headless WS client, and a Playwright smoke if cheap) that emits N events, drops the connection mid-stream, reconnects, and asserts the client saw every `seq` exactly once.
- **Acceptance:** test in CI; documented in `apps/server/README.md`.

### P0-11 — Dev ergonomics and `galactic start`
- **Status:** done (2026-09-30) · **Depends on:** P0-08, P0-09 · **Parallel with:** P0-10
- `galactic start` script (bin) that starts the server, prints the URL + token, opens the browser; `pnpm dev` with hot reload; root `README.md` quickstart.
- **Acceptance:** a fresh clone reaches the event page in under five minutes following the README.

### P0-12 — Memory-only `lastEventId` (added 2026-09-30, review R1)
- **Status:** in progress · **Depends on:** P0-09 · **Parallel with:** P0-13 … P0-18
- A fresh page load sent `hello{lastEventId}` from `localStorage` while the store started empty, so the page never got a snapshot and showed a world missing everything before `lastEventId`. Keep `lastEventId` in memory only (reconnects within a page's life still resume exactly); every fresh load takes a snapshot.
- **Acceptance:** a test loads the page twice against a server holding a project and sees the project both times; `localStorage` no longer holds `galactic.lastEventId`.

### P0-13 — Re-entrancy-safe `EventLog.publish` (added 2026-09-30, review R2)
- **Status:** in progress · **Depends on:** P0-07 · **Parallel with:** P0-12 …
- A subscriber that runs a command while being notified made other subscribers see events out of `seq` order (`[3, 1, 2]`). Publish through a drain loop: events committed while publishing are queued and delivered after the current batch.
- **Acceptance:** test: subscriber A reacts to seq 1 with a command; subscriber B still sees `[1, 2, 3]`.

### P0-14 — `pnpm dev` and `pnpm test` build the protocol first (added 2026-09-30, review R3)
- **Status:** in progress · **Depends on:** P0-11 · **Parallel with:** P0-12 …
- On a fresh clone `@galactic/protocol` resolves to `dist/`, which does not exist until `tsc` ran; `tsx watch` and Vite crashed. `dev` and `test` build the protocol package first; README says so.
- **Acceptance:** `git clone && pnpm install && pnpm dev` serves the page; `pnpm install && pnpm test` is green without a prior build.

### P0-15 — Monotonic `seq` and log identity (added 2026-09-30, review R4)
- **Status:** in progress · **Depends on:** P0-06, P0-08 · **Parallel with:** P0-12 …
- Migration 0002 rebuilds `events` with `AUTOINCREMENT` so a `seq` is never reused. The log gets an identity (`logId` in `settings`, generated on first open) returned in `snapshot` and `/health` and sent back in `hello{logId?}`; a mismatch (database deleted or replaced) yields a snapshot instead of replaying an unrelated history.
- **Acceptance:** tests: migration 0002 keeps existing rows and their ids; a client resuming with the wrong `logId` gets a snapshot; the right one gets a replay.

### P0-16 — Dev routes gated; `/health` token only for a loopback `Origin` (added 2026-09-30, review R5, R6)
- **Status:** in progress · **Depends on:** P0-05, P0-08 · **Parallel with:** P0-12 …
- `/dev/*` exists only with `GALACTIC_DEV=1` (set by `pnpm dev`; `galactic start --dev` opts in), `POST /dev/events` accepts only `agent.*` demo events (they touch no domain table), and `POST /dev/seed` creates a demo body + project through a proper command so snapshot and replay agree. `/health` hands the token out only when the `Origin`, if present, is itself a loopback host name — never for the configured extra hosts (a reverse proxy such as Tailscale Serve connects from loopback).
- **Acceptance:** tests: without the flag `/dev/*` is 404; a domain event on `/dev/events` is 400; `/dev/seed` shows up in the snapshot; `/health` with `Origin: https://x.ts.net` (allowed host) carries no token.

### P0-17 — Repo hygiene and small fixes (added 2026-09-30, review "Hygiene")
- **Status:** in progress · **Depends on:** P0-01 · **Parallel with:** P0-12 …
- `.gitignore` ignores npm/yarn lockfiles; `preinstall` runs `only-allow pnpm`; `.npmrc` no longer claims better-sqlite3 needs its build script; `apps/web` gets `exactOptionalPropertyTypes` back; `TECHNOLOGY.md` §7 lists `Agent.taskId/projectId`; the raw upgrade socket gets an error listener before `deny()`; the hello timer is cleared on close; `galactic start` prints the banner after the token line; the page forgets a token refused with 4401 and re-discovers it; "Emit fake event" reports a failed request.
- **Acceptance:** lint, typecheck and tests green with `exactOptionalPropertyTypes` on in `apps/web`; the listed fixes are in place.

### P0-18 — `agent.needs_input` carries a `QuestionContext`; projection and policy-storage decisions recorded (added 2026-09-30, review R7, R8, R9)
- **Status:** in progress · **Depends on:** P0-03 · **Parallel with:** P0-12 …
- `AgentNeedsInput.question` becomes a `QuestionContext` (text, options, `toolCall`, `permissionAction`) so a permission question can carry the tool call the policy table needs. `TECHNOLOGY.md` records: status records are a server-owned projection pushed to clients (the client never folds `agent.*` itself — R7), a replay-vs-snapshot conformance test guards the domain reducer (P2-01), and the per-project `PermissionPolicy` lives in a `permission_policy` JSON column on `projects` added with P2-01 (R9).
- **Acceptance:** fixtures and the exhaustive switch compile; the client reducer no longer derives statuses from `agent.*`; the three decisions are in `TECHNOLOGY.md` and referenced from P1-05 / P2-01.

## Exit criteria (from the plan)

`pnpm dev` starts server + web; a fake event emitted on the server appears in the browser; killing and restarting the web page resumes from `lastEventId` with no gaps or duplicates (tested).

## Exit criteria check (2026-09-30)

| Criterion | Result | How it was verified |
|---|---|---|
| `pnpm dev` starts server + web | ✅ | `concurrently` runs `tsc --watch` (protocol), `tsx watch` (server) and `vite` (web); `/health` and `/ws` answered through the Vite proxy on port 5173 with an allowed `Origin`, a foreign `Origin` was refused with 403. |
| A fake event emitted on the server appears in the browser | ✅ (headless) | `POST /dev/events` → the event arrived on the proxied WebSocket; `apps/web/src/App.test.tsx` renders the page under jsdom, receives the snapshot and prints a live `agent.progress` event. Not yet clicked through in a real browser — do it once on the Mac: `pnpm dev`, open <http://localhost:5173>, press **Emit fake event**. |
| Killing and restarting the web page resumes from `lastEventId` with no gaps or duplicates (tested) | ✅ | `apps/web/src/client/resume.test.ts` (P0-10): mid-stream terminations (single and repeated), a fresh client resuming from the persisted seq, and the snapshot fallback — every `seq` exactly once, in order; run 6× without flakes. `pnpm -r test`: 37 + 41 + 18 tests green. |

Notes for Phase 1: the status store projection (`statuses` in the snapshot) is empty until P1-05; `agent.output` is refused by the event log and must go to `transcript_chunks` (P1-06); `Agent` gained `taskId` / `projectId`, `Question` a `version`, and the stream a `caught_up` frame — all recorded in `packages/protocol` and `TECHNOLOGY.md` §6.3/§7.

