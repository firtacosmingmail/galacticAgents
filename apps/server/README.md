# @galactic/server — Mission Control

The Node/TypeScript server that will own the agents. Phase 0 delivers its foundations: config and security, SQLite with migrations, the event log with the one write rule, and the resumable WebSocket protocol.

## Run

- `pnpm dev` (from the repo root) runs it with `tsx watch`; `galactic start` runs the built `dist/index.js` and serves `apps/web/dist`.
- Environment: `GALACTIC_HOME` (data folder, default `~/.galactic`), `GALACTIC_PORT` (default 4321), `GALACTIC_TOKEN`, `GALACTIC_ALLOWED_HOSTS` (comma-separated, `*.ts.net` wildcards allowed), `GALACTIC_DB`, `GALACTIC_WEB_DIR`, `GALACTIC_LOG=silent`.
- `~/.galactic/config.json` (mode 0600) holds `token`, and optionally `port` and `allowedHosts`.

## Security (TECHNOLOGY §8)

- Binds `127.0.0.1` only. A bearer token is required even on localhost: as the first WebSocket frame (`hello{token}`) or as `Authorization: Bearer …` on `/dev/*`.
- Every HTTP request and every WebSocket upgrade must carry an allowed `Host` (`localhost`, `127.0.0.1`, `[::1]`, plus configured names) — the DNS-rebinding guard.
- A WebSocket upgrade with a foreign `Origin` is refused with 403; a missing `Origin` (non-browser client) is allowed and protected by the token alone.
- `GET /health` returns the token only to loopback callers with an allowed (or no) `Origin`, so the local page never needs pasting.

## HTTP

| Route                     | Purpose                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /health`             | `{ok, name, version, protocolVersion, seq, token?}`                                           |
| `POST /dev/events`        | Appends one protocol-validated event under the one write rule; returns `{seq}`. Bearer token. |
| `GET /dev/events?since=N` | `{seq, events}` — the log after `N`. Bearer token.                                            |
| `GET /*`                  | The built web app when `GALACTIC_WEB_DIR` is set (SPA fallback to `index.html`).              |

## WebSocket protocol (`/ws`, TECHNOLOGY §6.3)

1. Client sends `hello{token, lastEventId?}` as the first frame (5 s timeout).
2. Server answers with `snapshot{seq, agents, bodies, projects, tasks, questions, proposals, statuses}` when `lastEventId` is absent, ahead of the log, pruned away, or more than `maxReplay` (10 000) events behind; otherwise with every `event{seq, at, event}` since `lastEventId` followed by `caught_up{seq}`.
3. Then the live stream of `event{seq, at, event}` in strict `seq` order. `ping` → `pong`. Anything else closes the socket with 4002 (`protocol_violation`); a bad token closes with 4401 (`unauthorized`); a client whose socket buffer exceeds 4 MB is terminated (it reconnects and catches up).

Subscribing to the log and reading the snapshot/replay happen in the same synchronous tick, so nothing can be committed in between; `lastSent` drops anything already covered.

## Persistence (TECHNOLOGY §6)

- `better-sqlite3` in WAL mode, foreign keys on. Migrations are numbered SQL files in `src/db/migrations/` (copied to `dist/` on build); `schema_migrations` records what ran; re-running is a no-op.
- Two streams: `events(id = rowid = seq, at, type, payload)` and `transcript_chunks(agent_id, seq, at, chunk)` (filled from Phase 1).
- `EventLog.runCommand(fn)` is the one write rule: `fn` mutates the tables and `emit`s events; both are committed in one transaction (nested calls join it), `seq = rowid`, and subscribers are notified after the outermost commit, strictly in order — also when a subscriber runs a command of its own while being notified: its events are committed at once but published after the current batch (drain loop). A throw anywhere leaves neither rows nor events. `agent.output` is refused here — it belongs to the transcript stream.

## Tests

`pnpm --filter @galactic/server test` — config, security helpers, HTTP/upgrade refusals, migrations and table round-trips, the event log (rollback, ordering, nesting, subscriber isolation) and the stream (snapshot, exact replay, `caught_up`, duplicates, protocol violations, slow consumer, dev routes).

The **resume and gap test (P0-10)** lives in `apps/web/src/client/resume.test.ts` because it exercises the real web client against this real server in-process: it emits events, terminates every socket mid-stream (repeatedly), lets events land during the reconnect, restarts the client from a persisted `lastEventId`, and asserts that every `seq` was seen exactly once and in order; it also checks the snapshot fallback when too much was missed. Run it with `pnpm --filter @galactic/web test`. A Playwright smoke through a real browser is left for when a browser is available in CI.
