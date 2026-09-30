# Phase 0 — Foundations

**Current task:** P0-05 — Server skeleton with auth and origin checks · **Task status:** todo
**Phase status:** in progress (3/11 done)

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
- **Status:** todo · **Depends on:** P0-02, P0-03 · **Parallel with:** P0-06
- `AgentAdapter`: `spawn(opts{cwd, prompt, tools?, systemPrompt?, permissionPolicy, caps})`, `send(sessionId, message, {interrupt?})`, `answer(questionId, answer)`, `interrupt`, `pause`, `resume`, `stop`, `resumeSession?(sessionRef)`, `events: AsyncIterable<AgentEvent>`. `DomainCommands`: the command surface brain tools and panel actions will call (create/assign/spawn/close/control…), typed but unimplemented (Phase 2 implements).
- **Acceptance:** interfaces exported; a no-op implementation of each type-checks.

### P0-05 — Server skeleton with auth and origin checks
- **Status:** todo · **Depends on:** P0-01 · **Parallel with:** P0-02, P0-03
- Fastify app bound to `127.0.0.1` on a configurable port; config loader (env + `~/.galactic/config.json`); token generated on first start, stored in config, printed once; `Host` allow-list (`localhost`, `127.0.0.1`, configurable `*.ts.net`); `Origin` check on WS upgrade; `ws` server attached; health endpoint.
- **Acceptance:** connection with wrong token, wrong `Host`, or foreign `Origin` is refused (tests); health endpoint answers with the token.

### P0-06 — SQLite layer and migrations
- **Status:** todo · **Depends on:** P0-02 · **Parallel with:** P0-04
- `better-sqlite3` in WAL mode; migrations folder + tiny runner (numbered SQL files, `schema_migrations` table); migration 0001 creates domain tables (bodies, projects, tasks, agents, proposals, questions, settings), `events(rowid, at, type, payload)`, `transcript_chunks(agentId, seq, chunk)`.
- **Acceptance:** fresh DB migrates from zero; re-running is a no-op; a test inserts and reads each table.

### P0-07 — Event bus with the one-write rule
- **Status:** todo · **Depends on:** P0-03, P0-06 · **Parallel with:** —
- `runCommand(fn)` wrapper: opens a transaction, runs the domain mutation, inserts the event(s), commits, then publishes to in-memory subscribers with `seq = rowid`. `eventsSince(seq)` reader. Snapshot builder skeleton (reads current tables).
- **Acceptance:** a test throws inside a command and verifies neither the row nor the event exists; subscribers receive events strictly in `seq` order.

### P0-08 — WebSocket protocol: hello, snapshot, resume, stream
- **Status:** todo · **Depends on:** P0-05, P0-07 · **Parallel with:** P0-09
- First-frame `hello{token, lastEventId?}` handling; reply with `snapshot` (when no/old `lastEventId`) or `events since`; then the live `{seq, event}` stream; per-connection backpressure; close on protocol violation.
- **Acceptance:** integration test: connect, receive snapshot, receive live events; reconnect with `lastEventId` and receive exactly the missed events.

### P0-09 — Web skeleton with resumable client
- **Status:** todo · **Depends on:** P0-01, P0-03 (start), P0-08 (finish) · **Parallel with:** P0-08
- Vite + React 19 + TS; Zustand store derived purely from the event stream; WS client with token entry, automatic reconnect and `lastEventId` persistence (in memory + `localStorage`); a bare page listing the snapshot and printing events as they arrive.
- **Acceptance:** page connects, shows the snapshot, prints a fake event emitted by the server.

### P0-10 — Resume and gap test
- **Status:** todo · **Depends on:** P0-08, P0-09 · **Parallel with:** P0-11
- Automated test (Vitest + a headless WS client, and a Playwright smoke if cheap) that emits N events, drops the connection mid-stream, reconnects, and asserts the client saw every `seq` exactly once.
- **Acceptance:** test in CI; documented in `apps/server/README.md`.

### P0-11 — Dev ergonomics and `galactic start`
- **Status:** todo · **Depends on:** P0-08, P0-09 · **Parallel with:** P0-10
- `galactic start` script (bin) that starts the server, prints the URL + token, opens the browser; `pnpm dev` with hot reload; root `README.md` quickstart.
- **Acceptance:** a fresh clone reaches the event page in under five minutes following the README.

## Exit criteria (from the plan)

`pnpm dev` starts server + web; a fake event emitted on the server appears in the browser; killing and restarting the web page resumes from `lastEventId` with no gaps or duplicates (tested).
