# Phase 1 — Agent runtime and adapters

**Current task:** — (phase complete) · **Task status:** —
**Phase status:** done (2026-10-01) — 38/38 tasks; reopened the same day for the phase review (`notes/P1-review.md`, wave 6) and closed again; exit criteria re-checked below

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

Prove that real agents can be spawned, observed without interruption, asked, paused, answered, stopped and recovered from a plain web page — before any hierarchy or 3D. The runtime-agnostic `AgentAdapter` interface is validated by a fake adapter passing the same conformance suite as the real Claude adapter.

## Entry criteria

- Phase 0 exit criteria met.
- Claude Code installed and logged in with the subscription on the dev machine (SPEC decision 17).

## References

- `IMPLEMENTATION_PLAN.md` → Phase 1; corner cases 1, 2, 4, 5, 7, 8, 8b, 30.
- `TECHNOLOGY.md` §3 (adapters; §3.1 the `claude-sdk` adapter), §3.4 (event model + adapter interface), §4 (status store), §5.4 (hard caps), §6.2 (transcript stream), §8 (redaction).
- `SPEC.md` §2.5, §3.6 (permission policy), §5 (resilience, cost safety), §8 open questions 1–2 (SDK auth, cost reporting — answered by P1-08).

## Design notes for implementation

- **Adapter boundary:** nothing outside `apps/server/src/adapters` imports a runtime-specific module (SDK, `node-pty`, ACP SDK). The brains (Phase 2) go through the same adapter.
- **One transport per session.** The `claude-sdk` adapter is the only Claude transport in v1; no ACP "complement".
- **Subscription login, no `--bare` by default**; `bare` is an opt-in spawn option.
- **Question kinds:** SDK permission callback → `needs_input(kind: permission)` filtered by the project's policy table; `AskUserQuestion` → `needs_input(kind: clarification)`.
- **Graceful stop:** `interrupt()` → wait for the turn to end (timeout) → terminate → kill. Never SIGTERM first.
- **Status store is a projection** rebuilt from `events`; diffs are broadcast at ≈10 Hz, never per token.
- **Caps live in the supervisor,** not in prompts: wall-clock, tool calls, global concurrency.
- **Secret redaction** happens before persisting transcript chunks and before sending to any client.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 (parallel) | P1-01, P1-03, P1-08, P1-10 | Process supervisor, fake adapter, SDK spike and policy engine are independent. |
| 2 (parallel) | P1-02, P1-04, P1-05, P1-06, P1-07 | Caps need the supervisor; conformance suite needs the fake adapter; status store, transcripts and inbox need the bus + fake adapter. |
| 2b (review) | P1-17 … P1-27 | Follow-ups of the wave 2 review (`notes/P1-wave2-review.md`); done before P1-09 so the real adapter builds on the final interfaces. What changed, for whoever continues: `notes/P1-wave2b-changes.md`. |
| 3 | P1-09 | Real adapter needs the spike, supervisor, inbox, policy engine and the gate (P1-18). |
| 4 (parallel) | P1-11, P1-13, P1-14, P1-15, P1-16 | Ops console, README, restart recovery (+ the two review follow-ups). |
| 5 | P1-12 | Conformance + resume against the real adapter, last. |
| 6 (review) | P1-28 … P1-38 | Follow-ups of the phase review (`notes/P1-review.md`); done before Phase 2 starts. P1-38 last (it tests the others). |

## Tasks

### P1-01 — Process supervisor
- **Status:** done (2026-09-30) · **Depends on:** P0-07 · **Parallel with:** P1-03, P1-08, P1-10
- Spawn child processes in their own process group; capture stdio; detect exit/crash; restart policy (off by default); per-agent working directory; **graceful stop** sequence (interrupt → wait for turn end with timeout → terminate → kill); persisted PID/session table (`agents.sessionRef`, pid, startedAt); startup reconciliation against live processes (mark dead ones `interrupted`).
- **Acceptance:** tests spawn a script child, kill it, see `agent.failed`; stop sequence verified with a child that ignores the first signal; orphaned children of a killed agent are gone after group kill.
- **Done:** `apps/server/src/runtime/supervisor.ts` (+ `process-store.ts`, `event-queue.ts`, migration 0003 `agent_processes`). `spawn()`/`adopt()` (synchronous, for the SDK's `spawnClaudeCodeProcess`), `stop()` = interrupt hook → `turnEnded()`/exit within `graceMs` → SIGTERM → SIGKILL, `expectExit()` for runtime-initiated exits, restart policy off by default, `reconcile()` kills a live orphan only when the pid is from this boot and still runs the recorded command. Decisions recorded in `TECHNOLOGY.md` §3.4.

### P1-02 — Hard caps
- **Status:** done (2026-09-30) · **Depends on:** P1-01 · **Parallel with:** P1-04, P1-05, P1-06, P1-07
- Per-agent wall-clock and tool-call caps (from `Agent.caps`, defaults from settings); global max concurrent agents (spawn refused with a clear reason); cap hit → graceful stop + `agent.failed(reason: cap)`.
- **Acceptance:** tests for each cap; the refusal reason is visible in the event payload.
- **Done:** `apps/server/src/runtime/caps.ts` + `agent-runtime.ts` (`onCapHit`): wall-clock timer, tool-call counter (`reserveToolCall()` is the permission gate's pre-flight: a refused call also trips the cap), concurrency gate; a hit records `control.stop`, runs the adapter's graceful stop, then `agent.failed(reason: cap)` as the agent's one terminal event (P1-17) — unless the agent's own `finished`/`failed` arrived first. Stewards-per-Waykeeper and spawns-per-hour come with Phase 2.

### P1-03 — Fake adapter
- **Status:** done (2026-09-30) · **Depends on:** P0-04 · **Parallel with:** P1-01, P1-08, P1-10
- Implements `AgentAdapter` with scriptable scenarios: output stream, tool calls, a clarification question, a permission request, idle, stall (silence), pause/resume, finish with cost, fail, stop, `resumeSession` from a fake session ref. Deterministic timing knobs for tests.
- **Acceptance:** every event type in `TECHNOLOGY.md` §3.4 can be produced on demand; used by the ops console in dev mode without Claude installed.
- **Done:** `apps/server/src/adapters/fake/` — scripted `FakeStep`s, named scenarios (`echo`, `happy`, `asks`, `permission`, `stalls`, `fails`, `long`, `full`) picked by a `scenario:<name>` prompt, `speed` knob (0 = instantaneous), session refs `fake:<scenario>:<sessionId>:<step>` with an injectable progress map for in-process restarts. `agent.spawned` is the runtime layer's (TECHNOLOGY §3.4), every other event is covered by a test.

### P1-04 — Adapter conformance suite
- **Status:** done (2026-09-30) · **Depends on:** P1-03 · **Parallel with:** P1-02, P1-05, P1-06, P1-07
- Vitest suite parameterised by adapter: spawn → output → clarification question answered → permission request answered → pause/resume → interrupt → finish with cost; stop from every state; `resumeSession` round trip; stall detection. Runs against the fake adapter in CI.
- **Acceptance:** suite green on the fake adapter; documented as the bar for any future adapter.
- **Done:** `apps/server/src/adapters/conformance.ts` (`describeAdapterConformance(target)`), run through `composeRuntime` so the whole runtime is under test; `fake-adapter.conformance.test.ts` is the CI target. `claude-sdk.conformance.test.ts` is the real target (P1-09/P1-12, `GALACTIC_REAL_CLAUDE=1`), with `jobEnd: 'idle'` for a long-lived session; P1-13 documents it.

### P1-05 — Status store projection
- **Status:** done (2026-09-30) · **Depends on:** P0-07, P1-03 · **Parallel with:** P1-02, P1-04, P1-06, P1-07
- Fold `agent.*` events into `StatusRecord`s (state, `current_activity`, `last_event_at`, `pending_question`, `progress`, `cost_so_far`, caps used); per-runtime silence threshold → `stalled`; rebuild from `events` on startup; batched diff broadcast (≈10 Hz) as `status.*` messages over the WS stream. This is the **only** implementation of the projection (TECHNOLOGY §4, decided with P0-18): the web client stores the records it receives (`snapshot.statuses`, then the status messages) and never derives them from `agent.*` itself — `apps/web/src/state/reduce.ts` already treats those events as seq-only.
- **Acceptance:** replaying a recorded event log yields identical records; a silent agent turns `stalled` after the threshold and back to `working` on the next event.
- **Done:** `apps/server/src/runtime/status-store.ts` (fold, `touch()` for output, `rebuild()`, ticker for stalls + wall clock, 10 Hz diffs), wired in `runtime/compose.ts` and pushed as `status` messages by `ws/session.ts` (also after a replay's `caught_up`); `agent.created{agent}` added to the protocol so replay and snapshot agree on `agents`. Web store keeps the records as received.

### P1-06 — Transcript pipeline and secret redaction
- **Status:** done (2026-09-30) · **Depends on:** P0-07 · **Parallel with:** P1-02, P1-04, P1-05, P1-07
- `agent.output` batched into `transcript_chunks` (≈10 Hz writes); redaction of known secret patterns (API keys, bearer tokens, `sk-…`, AWS keys) before persisting and before sending; per-agent subscribable transcript stream over WS (separate from the `events` stream); retention hook (no-op in v1).
- **Acceptance:** a chunk containing a fake key is stored and sent redacted; transcript subscription delivers chunks in `seq` order.
- **Done:** `apps/server/src/runtime/redact.ts` (shape-based rules) + `transcripts.ts` (10 Hz batches, per-agent seq across restarts, paged history, per-subscription cursor, `prune()` hook); `transcript.subscribe/unsubscribe` + `transcript` messages in the protocol and the session handler. The runtime also redacts the strings of every other agent event.

### P1-07 — Per-agent inbox (send queue)
- **Status:** done (2026-09-30) · **Depends on:** P1-01, P1-03 · **Parallel with:** P1-02, P1-04, P1-05, P1-06
- `send()` enqueues; delivery on `agent.idle`; `interrupt: true` cancels the current turn and delivers immediately; every message records `sender` (user / supervisor id / system).
- **Acceptance:** two messages sent while working are delivered in order after idle; an interrupt message arrives first.
- **Done:** `apps/server/src/runtime/inbox.ts`, owned by the runtime (adapters only ever get `send()` when idle): FIFO, interrupt-first, held while paused, `sender` and delivery time on every message, failed deliveries kept in the history with their error.

### P1-08 — Claude SDK adapter spike (answers SPEC §8 questions 1–2)
- **Status:** done (2026-09-30) · **Depends on:** P0-04 · **Parallel with:** P1-01, P1-03, P1-10
- Throwaway script exercising the TypeScript Agent SDK: authentication under the subscription login (in-process), custom tools + system prompt, permission callback shape, how `AskUserQuestion` surfaces, `resume` by session id, cost in the final result, interrupt behaviour, whether `bare` is exposed. Record findings and update `SPEC.md` §8 (answer or keep open) and `TECHNOLOGY.md` §3.1 if reality differs.
- **Acceptance:** a short findings note in `docs/tasks/notes/P1-08-sdk-spike.md`; SPEC §8 rows 1–2 resolved or refined.
- **Done:** note + script (`P1-08-sdk-spike.mjs`), SDK pinned at 0.3.285, SPEC §8 rows 1–2 answered, TECHNOLOGY §3.1 carries the adapter shape (streaming input, `PreToolUse` hook + `canUseTool`, `spawnClaudeCodeProcess`, `bare` needs an API key). Ran in a cloud sandbox under an OAuth login; **one follow-up for Cosmin:** run `node docs/tasks/notes/P1-08-sdk-spike.mjs auth tools` once on the dev machine after `pnpm install` to confirm the same under his own subscription.

### P1-09 — Claude SDK adapter implementation
- **Status:** done (2026-10-01) · **Depends on:** P1-08, P1-01, P1-07, P1-10 · **Parallel with:** —
- `spawn(opts)` with cwd, prompt, optional tools/system prompt (for Phase 2 brains), subscription login, `bare` opt-in; `PreToolUse` hook → `opts.gate.check(toolCall)` (P1-18: the runtime's gate, never the policy itself) → `allow` runs, `deny` refuses with the reason, `ask` → `needs_input(kind: permission)` (blocks the tool call until answered); `AskUserQuestion` → `needs_input(kind: clarification)`; the supervisor's `onOutcome` (P1-20) is mapped by the adapter to `agent.failed(crash|runtime)` / `agent.stopped`; `send()` starts a turn (the runtime's inbox guarantees idle, P1-19); streaming output/tool calls/thinking → `agent.output` / `agent.tool_call`; final result → `agent.finished(cost)`; `resumeSession(sessionRef)`; `interrupt`, `pause` (hold delivery + interrupt), `resume`, `stop` via the supervisor's graceful sequence.
- **Acceptance:** manual run on the dev machine passes every step of the exit criteria; unit tests with the SDK mocked for the event mapping.
- **Read first:** `docs/tasks/notes/P1-wave2b-changes.md` — the interfaces this task builds on (`SpawnOptions.gate`, the `send` contract, `ProcessOutcome`, the one-terminal-event invariant) changed in wave 2b.
- **Done:** `apps/server/src/adapters/claude-sdk/` — `claude-sdk-adapter.ts` (one streaming-input `query()` per session; `PreToolUse` → gate, `canUseTool` → permission / `AskUserQuestion` questions; CLI spawned by the supervisor via `spawnClaudeCodeProcess` with `ProcessOutcome` mapped to the one terminal event; SIGSTOP/SIGCONT pause; graceful stop; `resumeSession`; brain tools as an in-process MCP server), `sdk-surface.ts` (the slice of the SDK used, lazily loaded — the only import of the SDK), `json-schema-to-zod.ts`, `fake-sdk.ts` (scripted SDK for the 20 unit tests), `claude-sdk.conformance.test.ts` (the P1-12 target, runs with `GALACTIC_REAL_CLAUDE=1`). Registered in `index.ts` with a SQLite-backed supervisor that reconciles its PID table on start. Decisions in `TECHNOLOGY.md` §3.1 (job end = `agent.idle`, pause = SIGSTOP, env pass-through). Verified against the real SDK in a cloud sandbox under an OAuth login: `scripts/sdk-smoke.ts` (spawn → idle → message, clarification, two permissions, pause/resume during a 20 s shell loop, stop mid-turn in 1.5 s, resume by session ref) and the conformance suite (11/11). **For Cosmin:** `pnpm --filter @galactic/server exec tsx scripts/sdk-smoke.ts` on the Mac is the manual acceptance run under the subscription login.

### P1-10 — Permission policy engine
- **Status:** done (2026-09-30) · **Depends on:** P0-02 · **Parallel with:** P1-01, P1-03, P1-08
- Pure function `evaluate(policy, action) → allow | ask`: inside/outside workspace path checks, destructive command patterns (`rm -rf`, branch deletes, force ops), network/install patterns, `git push`; defaults per `SPEC.md` §3.6; per-project override merged over the global default.
- **Acceptance:** table-driven tests for each row of the SPEC table, including path traversal outside the workspace.
- **Done:** `apps/server/src/domain/permissions.ts` — `classifyToolCall` / `classifyCommand` → `PermissionAction[]`, `decide` (strictest wins, nothing recognised → `ask`), `resolvePolicy` (project over default), `evaluate`. Shell commands are split on operators with a stateful `cd`, quoted/wrapped payloads (`sh -c`, `node -e`, `eval`, …) and unexpandable `$VAR` paths are `ask`, git global options are skipped, case-insensitive. Reviewed with bypass probes as table rows.

### P1-11 — Ops console page
- **Status:** done (2026-10-01) · **Depends on:** P0-09, P1-05, P1-06, P1-07 · **Parallel with:** P1-13, P1-14
- Agents list with state, activity, cost, caps; spawn form (adapter, cwd, prompt, policy preset); send message (+ interrupt toggle); answer `needs_input` of both kinds (permission shows the requested action); pause/resume/stop; live transcript view.
- **Acceptance:** everything in the Phase 1 exit criteria is doable from this page with the fake adapter and with the real one.
- **Done:** server side `http/agent-routes.ts` (bearer-guarded `/api/runtimes`, `/api/agents` + `send|pause|resume|interrupt|stop|recover`, `/api/questions/:id/answer`; every call goes through the runtime, results arrive on the stream) and the Vite proxy; web side `console/api.ts`, `console/AgentsConsole.tsx` (list, spawn form fed by `/api/runtimes` with the fake scenarios, per-agent panel with facts, question card for both kinds, controls, message + interrupt toggle, live transcript via `transcript.subscribe`, "Resume session" for `interrupted`), `client.ts` transcript subscriptions re-sent on reconnect. Tests: 5 route tests, 4 console tests. Click-through with Playwright against the running server: the fake `full` scenario and the real `claude-sdk` adapter (clarification → permission for an `rm -rf` → pause/resume → message → stop, cost shown) both pass with no page errors.

### P1-12 — Conformance and resume against the real adapter
- **Status:** done (2026-10-01) · **Depends on:** P1-09, P1-04, P1-14 · **Parallel with:** —
- Run the conformance suite against the `claude-sdk` adapter locally (tagged, not in CI); add the "kill the server mid-task, restart, agent resumes from `sessionRef`" scenario.
- **Acceptance:** suite green locally; a short run log kept in `docs/tasks/notes/`.
- **Done:** `notes/P1-12-real-adapter-run.md` — conformance 11/11 against the real SDK (`GALACTIC_REAL_CLAUDE=1`), the kill -9 + restart scenario (`scripts/sdk-restart-smoke.ts`: reconcile kills the orphaned CLI, `recover()` resumes the session, the agent remembers life 1), and the ops-console click-through. Fix found on the way: `conformance.ts` now gives its `describe` the target's timeout (Vitest's 5 s default was cutting real runs short). One repeat of the three commands is left for Cosmin's machine under his own subscription.

### P1-13 — Adapters README: how to add a runtime
- **Status:** done (2026-10-01) · **Depends on:** P1-04 · **Parallel with:** P1-11, P1-14
- `apps/server/src/adapters/README.md`: the interface, event mapping table, question kinds, graceful stop, what the conformance suite checks, notes for the future ACP adapter (advertise `elicitation.form`; `request_permission` is permission-kind) and PTY adapter (no resume).
- **Acceptance:** a reader could implement the ACP adapter from it without reading the SDK adapter.
- **Done:** `apps/server/src/adapters/README.md` — the interface table (wave 2b contract: no adapter queue, gate in `SpawnOptions`), the event mapping, the two question kinds and how they resolve, the gate verdicts, supervisor outcomes → events, what the conformance suite checks, and the ACP/PTY notes.

### P1-14 — Restart recovery v1
- **Status:** done (2026-10-01) · **Depends on:** P1-01, P1-09 · **Parallel with:** P1-11, P1-13
- Graceful shutdown handler (SIGINT/SIGTERM on the server): interrupt every agent, persist session refs, exit. Startup: reconcile PID table, respawn interrupted agents via `resumeSession` where the adapter supports it, deliver any answer given meanwhile as the first message, mark the rest `interrupted`.
- **Acceptance:** kill -9 and clean restart both recover a fake-adapter agent; state visible in the ops console as `interrupted → working`.
- **Done:** `index.ts` shutdown = `composed.shutdown()` (every live agent gets `agent.interrupted{pending}` then its adapter stops) → `supervisor.dispose()` → `app.close()`, 15 s deadline, second signal forces exit. Startup = `supervisor.reconcile()` → `composed.recover()`: `AgentRuntime.recover()` resumes every `interrupted` agent whose adapter has `resumeSession` from `agent.meta` (cwd, prompt, workspace, policy), redelivers what was pending (`pendingFor()`: the ids on `agent.interrupted`, else messages/answers logged after the interruption), and reports `{resumed, needAttention}`; the rest stay `interrupted` with a "Resume session" button in the console (`POST /api/agents/:id/recover`). Tests: `runtime/recovery.test.ts` (clean shutdown, kill -9 simulation, redelivery, unresumable), the real run in `notes/P1-12-real-adapter-run.md`.

### P1-15 — Restart recovery: `agent.interrupted` event and shutdown semantics (added 2026-09-30)
- **Status:** done (2026-10-01) · **Depends on:** P1-14 design · **Parallel with:** P1-14
- Found in the wave 2 review. The status store has an `interrupted` state but no event maps to it, and a graceful shutdown today ends every agent with `control.stop{by: system}` + `agent.stopped`, indistinguishable from a user stop. Add `agent.interrupted{agentId, reason}` to the protocol (emitted by the shutdown path and by `reconcile()` for dead/orphaned rows), fold it in the status store and the web reducer, and make P1-14's resume path key off it. Decide and record in `SPEC.md` §7 whether a resumed agent's wall-clock cap restarts from zero (today it does).
- **Acceptance:** after `kill -9` + restart the fake agent shows `interrupted → working`; after a clean shutdown the log has `agent.interrupted`, not `agent.stopped`.
- **Done:** `agent.interrupted{agentId, reason, pending?}` in the protocol (runtime-owned, a terminal event for the status store: `interrupted` with the reason as activity); emitted by `shutdown()` and by `recover()` for rows the reconcile found dead or orphaned; folded in `status-store.ts` and the web reducer. SPEC decision 21: a resumed agent's caps restart from zero (the run is a new process; the log keeps the history).

### P1-16 — Retention of ended status records and inbox histories (added 2026-09-30)
- **Status:** done (2026-10-01) · **Depends on:** P1-05 · **Parallel with:** P1-11
- Found in the wave 2 review. Ended agents stay in the status store (and in every snapshot) and the runtime keeps no bounded history of delivered messages. Add a retention rule (keep ended records for the decision-4 period, then drop from the store; keep inbox history in the log or cap it) and stop creating a procedural asteroid for a spawn refused by the concurrency cap.
- **Acceptance:** a long-running server with thousands of finished agents keeps `snapshot.statuses` bounded; a refused spawn leaves no orphan body.
- **Note (P1-21):** the refused-spawn half is done — a spawn over the concurrency cap writes nothing. The inbox history is bounded since P1-22 (`message.sent` is in the log). What remains is the retention of ended status records.
- **Done:** `StatusStore` retention — ended records are kept `retainEndedMs` (24 h) and at most `maxEnded` (500), pruned on the ticker; the `status` message carries `removed: Id[]` and the web store drops them. The log keeps the full history; the snapshot stays bounded (TECHNOLOGY §4).

### P1-17 — One terminal event per agent (added 2026-09-30, review R1)
- **Status:** done (2026-09-30) · **Depends on:** P1-02, P1-05 · **Parallel with:** P1-18 … P1-27
- The runtime logs exactly one of `agent.finished` / `agent.failed` / `agent.stopped` per agent: a cap stop is flagged on the live entry and the adapter's `agent.stopped` is folded into `agent.failed(reason: cap)` whichever arrives first; a straggler from an ended agent is dropped; an event for an agent the runtime never spawned is reported through `onError` and never logged. The status store treats an ended record as a sink (only a new `agent.spawned` moves it).
- **Acceptance:** the tool-call cap test sees `agent.failed` alone; the conformance suite asserts one terminal event after every finish and every stop; a replayed log with two terminals keeps the first.
- **Done:** `agent-runtime.ts` (`terminal()`, `failForCap()`, `ended` memory), `status-store.ts` (`apply` sink rule), tests.

### P1-18 — Permission gate handed to adapters (added 2026-09-30, review R2)
- **Status:** done (2026-09-30) · **Depends on:** P1-10, P1-02 · **Parallel with:** P1-17, P1-19 …
- `SpawnOptions.gate: PermissionGate` replaces `permissionPolicy` (and `workspace`): `check(toolCall) → {allow} | {deny, reason} | {ask, action?, reasons}`, built per spawn by `runtime/permission-gate.ts` from the project's policy and the caps (`reserveToolCall()` pre-flight; a refused call trips the cap). `ToolCall` joins the protocol; `PolicyVerdict.dominant` names the category behind a decision. The fake adapter runs every `tool_call` and `permission` step through the gate like a real hook would.
- **Acceptance:** with the default policy the `permission` scenario asks and `allow` runs the call; with an allow-all gate it runs without asking; a deny skips it with the reason; the cap test's third call is refused before it runs.
- **Done:** `packages/protocol/src/adapter.ts`, `domain.ts` (`ToolCall`), `runtime/permission-gate.ts`, `caps.ts`, fake adapter, TECHNOLOGY §3.1.

### P1-19 — Send contract: the runtime owns the queue (added 2026-09-30, review R3)
- **Status:** done (2026-09-30) · **Depends on:** P1-07, P1-03 · **Parallel with:** P1-17 …
- `AgentAdapter.send` = start a turn now; the runtime's inbox guarantees the session is idle (or was just interrupted, `opts.interrupt`); adapters keep no queue and may reject a mid-turn message. The fake adapter's inbox is gone; the conformance suite asserts no delivery was ever refused.
- **Acceptance:** fake-adapter test "keeps no queue"; conformance green; TECHNOLOGY §3.4 and the PLAN say the same thing.
- **Done:** `packages/protocol/src/adapter.ts` docs, `fake-adapter.ts`, `conformance.ts`, docs.

### P1-20 — Supervisor reports outcomes, not agent events (added 2026-09-30, review R4)
- **Status:** done (2026-09-30) · **Depends on:** P1-01 · **Parallel with:** P1-17 …
- `ProcessSupervisor.events` is gone. A process's fate reaches the adapter through `ProcessSpec.onOutcome(ProcessOutcome)` (`start_failed` · `crashed` · `exited` · `stopped{by}` · `restarting{attempt, maxRestarts}`), plus `SupervisorOptions.onOutcome` for logging and tests; the adapter is the one emitter of `agent.*` for its session and decides the verdict.
- **Acceptance:** supervisor tests assert outcomes; a clean exit is `exited`, never a crash; a stop reports exactly one outcome.
- **Done:** `runtime/supervisor.ts`, tests, TECHNOLOGY §3.4.

### P1-21 — Layering and the one-write rule in the runtime (added 2026-09-30, review R5–R7)
- **Status:** done (2026-09-30) · **Depends on:** P1-02, P1-05 · **Parallel with:** P1-17 …
- Concurrency gate before any write (a refused spawn leaves no row, body or event); the session ref and `agent.spawned` in one command (`domain/agents.ts: recordSpawned`); agent-row creation in `domain/agents.ts`; `redactEvent` in `redact.ts`; `EventLog.snapshot()` returns the tables and `ws/snapshot.ts` adds the status records (no late binding in `compose.ts`); `EventQueue` in `src/lib/`, `collect()` in `src/test/`.
- **Acceptance:** runtime test "the session ref lands on the row in the same command as agent.spawned"; refused-spawn test sees no new events; `event-log.test.ts` snapshot has no `statuses`.
- **Done:** as listed.

### P1-22 — `message.sent` event (added 2026-09-30, review R8)
- **Status:** done (2026-09-30) · **Depends on:** P1-07 · **Parallel with:** P1-17 …
- `message.sent{messageId, agentId, sender, text, interrupt}` in the protocol, recorded by `AgentRuntime.send` before the message is queued, so a restart knows what was still pending (P1-14) and the Phase 2 mailbox reads it from the log. The in-memory delivery history is bounded (`inboxHistory`, default 200). The web reducer treats it as seq-only until the chat view (Phase 2.5).
- **Acceptance:** the inbox test finds every message in the log with the inbox's ids and in send order; history bounded test.
- **Done:** `packages/protocol/src/events.ts`, `agent-runtime.ts`, `inbox.ts`, `apps/web/src/state/reduce.ts`, TECHNOLOGY §6.2.

### P1-23 — Question rows opened with `agent.needs_input` (added 2026-09-30, review R9)
- **Status:** done (2026-09-30) · **Depends on:** P1-05 · **Parallel with:** P1-17 …
- `domain/questions.ts`: `openQuestion` inserts the `Question` row (holder `user` in Phase 1) and emits `question.opened` in the same command as `agent.needs_input`; `answerQuestion` closes the row, bumps `version` and emits `question.answered`. Holder routing and escalation stay with Phase 2.
- **Acceptance:** runtime test sees `question.opened` right after `agent.needs_input` and the row `open` → `answered` with `version` 0 → 1; conformance checks the row.
- **Done:** as listed.

### P1-24 — Child environment allow-list (added 2026-09-30, review R10)
- **Status:** done (2026-09-30) · **Depends on:** P1-01 · **Parallel with:** P1-17 …
- Children inherit `INHERITED_ENV` (PATH, HOME, locale, proxies, `CLAUDE_CONFIG_DIR`, …) plus the spec's `env`; `SupervisorOptions.inheritEnv` extends the list. The server's token and any API keys never reach an agent unless a spec passes them (bare mode).
- **Acceptance:** supervisor test: a server-only variable is absent in the child, an extended one present, a spec `undefined` removes an inherited one.
- **Done:** `runtime/supervisor.ts`, TECHNOLOGY §8.

### P1-25 — Status diffs only when something changed (added 2026-09-30, review R11)
- **Status:** done (2026-09-30) · **Depends on:** P1-05 · **Parallel with:** P1-17 …
- `StatusRecord.startedAt`; the ticker marks only real stall transitions; `caps.wallClockMs.used` is as of the record's last change and clients extrapolate from `startedAt`.
- **Acceptance:** status-store test: a tick that finds no stall sends nothing; a stall sends one diff.
- **Done:** `packages/protocol/src/domain.ts`, `runtime/status-store.ts`, TECHNOLOGY §4.

### P1-26 — `pnpm typecheck` builds the protocol first (added 2026-09-30, review R12)
- **Status:** done (2026-09-30) · **Depends on:** — · **Parallel with:** P1-17 …
- The root `typecheck` script builds `@galactic/protocol` before `pnpm -r typecheck`, like `test` does, so a stale `dist/` cannot produce phantom errors.
- **Done:** `package.json`.

### P1-27 — Boundary-aware transcript redaction (added 2026-09-30, review R13)
- **Status:** done (2026-09-30) · **Depends on:** P1-06 · **Parallel with:** P1-17 …
- The pipeline matches the previous chunk's tail together with the new text; a secret that starts in the previous chunk has its head moved into the new one before both are redacted; the newest chunk of every agent is held for `holdMs` (250 ms) so its successor can complete a split secret; an explicit `flush()` takes everything.
- **Acceptance:** a key split over two and over three chunks never reaches the rows or the subscribers in any part; the hold test.
- **Done:** `runtime/transcripts.ts`, tests.

### P1-28 — `/api` and `/dev` authentication on the decoded route (added 2026-10-01, review R1)
- **Status:** done (2026-10-01) · **Depends on:** P1-11 · **Parallel with:** P1-29 … P1-37
- The bearer check keyed off the raw `req.url`, so `/%61pi/…` skipped it. Register the routes in encapsulated plugins (`prefix: '/api'`, `prefix: '/dev'`) whose hook always runs.
- **Acceptance:** encoded-path requests (`/%61pi/runtimes`, `/%64ev/events`) without a token get 401/404, never 200.
- **Done:** `http/security.ts` `bearerGuard()`; `agent-routes.ts` and `dev-routes.ts` register their routes inside an encapsulated scope with an `onRequest` guard; test with `/%61pi/…`, `/ap%69/…`, `/%64ev/…` (TECHNOLOGY §8).

### P1-29 — One recovery path for `/recover` (added 2026-10-01, review R2)
- **Status:** done (2026-10-01) · **Depends on:** P1-14 · **Parallel with:** P1-28 …
- `POST /api/agents/:id/recover` and startup recovery share `AgentRuntime.recoverAgent(id)`: 409 unless the agent is `interrupted` and not live; the policy and `bare` come from `agent.meta`; pending messages and answers are redelivered.
- **Acceptance:** recover on a live agent → 409 and no second `agent.spawned`; a `cautious` agent resumes `cautious`.
- **Done:** `AgentRuntime.recoverAgent(id)` (also behind `recover()`): 409 unless `interrupted` and not live, policy/workspace/`bare` from `Agent.meta`, undelivered messages queued with their ids; `resume()` is private; the route is a thin wrapper. Tests in `recovery.test.ts`; conformance resumes through `recover()`.

### P1-30 — Policy engine bypasses and a fail-closed gate (added 2026-10-01, review R3)
- **Status:** done (2026-10-01) · **Depends on:** P1-10, P1-18 · **Parallel with:** P1-28 …
- Dequote words before matching; `git -c alias.*`, `git config` aliases/`--global` opaque; glued and fd-prefixed redirections, `/dev/tcp`; split on a single `&`; `~name` unresolvable; more destructive git commands; agent config paths (`.claude/`, `.mcp.json`, `.git/hooks`, `.husky`) ask; unknown policy values → `ask`, the policy parsed in `createPermissionGate`; edit tools with no path → `ask`; interpreters fed from stdin/heredoc are opaque. The gate never throws (an exception → `deny`), asserts cwd inside the workspace, and the SDK adapter checks once per `toolUseId`. SPEC §7 records the merge semantics; TECHNOLOGY §8 that the engine is lexical.
- **Acceptance:** every bypass in the review is a table row returning `ask`; a throwing gate denies; one reservation per asked call.
- **Done:** `domain/permissions.ts` is a small shell lexer now (dequoting, `&`, glued/fd redirections, substitutions as commands, heredoc bodies as data, opaque computed names and stdin interpreters); every review bypass is a test row; `git -c` aliases / executed keys and `git config` writes, `~name`, more destructive git commands, agent config paths, edit tools without a path, `Agent` like `Task`, network additions. `runtime/permission-gate.ts` never throws, parses the policy (invalid → all `ask`), cwd outside the workspace → `ask`; `PermissionGate.check(call, {reserve?})` in the protocol. The SDK adapter checks once per `toolUseId` and denies on a throwing gate. SPEC decision 22 and §8 (floor question), TECHNOLOGY §3.1/§8.

### P1-31 — Redaction of split secrets (added 2026-10-01, review R4)
- **Status:** done (2026-10-01) · **Depends on:** P1-27 · **Parallel with:** P1-28 …
- The runtime hands raw `agent.output` text to the transcript pipeline; a private-key block is masked until its `END` line whatever the chunking; the held chunk stays out of a subscribe backlog; new patterns (case-insensitive assignments, `PASS|PWD|CREDENTIAL`, Basic auth, PGP blocks, `xapp-`/`xoxe-`, `glpat-`, `hf_`). TECHNOLOGY §8 records that user-authored text is not redacted.
- **Acceptance:** a key split through the runtime and a 1.2 KB PEM split anywhere never reach rows or subscribers; a subscriber never gets text that is later changed.
- **Done:** `runtime/redact.ts` (new patterns, two tiers for secret-bearing names, PGP/OPENSSH/ENCRYPTED blocks), `runtime/transcripts.ts` (stateful private-key masking with a 16 KB cap, same-kind joins, persisted-only subscribe backlog, notify after write, `prune()` keeps the newest row); the runtime hands raw `agent.output` text to the pipeline. TECHNOLOGY §6.2/§8 (user-authored text is not redacted).

### P1-32 — Stop and shutdown semantics (added 2026-10-01, review R5)
- **Status:** done (2026-10-01) · **Depends on:** P1-14, P1-09 · **Parallel with:** P1-28 …
- A stop in flight at shutdown ends as `agent.stopped` / `agent.failed(cap)`, never `interrupted`, and is not resumed; shutdown logs every interruption and flushes transcripts first, then stops agents in parallel under a deadline above grace + term; a failing `adapter.stop` ends the agent with `agent.failed(runtime)`; the supervisor's interrupt hook runs inside the grace window; the SDK adapter fails the session when its query loop ends with the process alive; the process group is killed when the leader exits.
- **Acceptance:** tests for each, including "user stop then shutdown → not resumed" and "grandchild gone after exit".
- **Done:** Runtime: `stopRequested` on the live entry, shutdown logs each agent's fate first (stopped / failed(cap) / interrupted), flushes transcripts, stops all in parallel; a crash during a stop recovers as `agent.stopped`; stop failure → `agent.failed(runtime)`, resolved-without-event → `agent.stopped{by}`; `index.ts` wires shutdown before recovery, handles a failed listen, deadline 25 s. Supervisor: interrupt hook inside the grace window; the group is killed whenever the leader exits; `reconcile()` cleans a dead leader's group. SDK adapter: loop end with a live CLI → `agent.failed(runtime)` + stop. SPEC decision 23, TECHNOLOGY §3.4.

### P1-33 — Inbox: no lost or duplicated messages (added 2026-10-01, review R6)
- **Status:** done (2026-10-01) · **Depends on:** P1-07, P1-14 · **Parallel with:** P1-28 …
- A delivery marks the agent working; a refused delivery goes back to the head of the queue; redelivered items keep their ids; `message.delivered` in the protocol bounds what a crash redelivers; recovery reads the log once.
- **Acceptance:** pause/resume right after a delivery loses nothing; two restarts in a row keep the pending message; a crash mid-turn does not redeliver the delivered message.
- **Done:** `message.delivered` in the protocol, logged by the runtime's deliver hook; a delivery marks the agent busy; the inbox retries a refused delivery at the head (3 attempts); recovery redelivers exactly the undelivered messages with their ids, reading the log once (paged). Tests: inbox, runtime (pause/resume after a delivery), recovery (two restarts, crash after delivery).

### P1-34 — Question lifecycle (added 2026-10-01, review R7)
- **Status:** done (2026-10-01) · **Depends on:** P1-23 · **Parallel with:** P1-28 …
- `question.cancelled{questionId, agentId, reason}`: the runtime cancels an agent's open questions in the same command as its terminal or interrupted event and when an interrupt withdraws them; the status store clears `pendingQuestionId` on `agent.idle`.
- **Acceptance:** after stop or interrupt the row is `cancelled` and pause/resume does not bring back `waiting_for_input`.
- **Done:** `question.cancelled` + status `cancelled` in the protocol; `domain/questions.ts` `cancelQuestion` / `cancelQuestionsOf`; the runtime cancels with every terminal/interrupted event (one command) and on an idle with a question open; the status store clears `pendingQuestionId` on cancel, idle and interrupted; the web reducer folds it. SPEC decision 21 refined: the resumed agent re-asks instead of receiving an answer given meanwhile.

### P1-35 — `EventLog` publishes only committed events (added 2026-10-01, review R8)
- **Status:** done (2026-10-01) · **Depends on:** P0-13 · **Parallel with:** P1-28 …
- Events are buffered per outermost command and handed to the publish queue on its commit.
- **Acceptance:** a nested command inside a rolled-back command, run from a subscriber, publishes nothing.
- **Done:** `domain/event-log.ts` keeps an `uncommitted` buffer per outermost command (truncated on a nested rollback) and publishes it on the outermost commit; two tests that fail on the old code. TECHNOLOGY §6.1.

### P1-36 — SDK adapter mapping gaps (added 2026-10-01, review R9)
- **Status:** done (2026-10-01) · **Depends on:** P1-09 · **Parallel with:** P1-28 …
- `AskUserQuestion` with several questions asks each one; multi-select answers; `interrupt()` while paused resumes first; `agent.paused` only with a process; `result.is_error` fails the turn as an error result; cache tokens in the cost; `rate_limit_event` → `agent.progress`; session leak (`sessions`/`byAgent`) and stale-session events; stderr reported once; `adopt()` rejects a restart policy; stop closes the input so the CLI can exit on its own.
- **Acceptance:** fake-SDK tests for each.
- **Done:** `claude-sdk-adapter.ts`: per-question `AskUserQuestion`, multi-select hint, interrupt while paused thaws first, pause refused without a process, `is_error` results as errored turns, cache tokens in the cost, `rate_limit_event` → `agent.progress`, sessions freed and stale sessions ignored, stderr once, session-id check on resume, idle stop by stdin EOF; `supervisor.adopt()` refuses a restart policy. Fake-SDK tests. TECHNOLOGY §3.1.

### P1-37 — `reconcile()` process identity (added 2026-10-01, review R10)
- **Status:** done (2026-10-01) · **Depends on:** P1-01 · **Parallel with:** P1-28 …
- Command name from `basename` of the whole `comm` (macOS paths with spaces), plus a start-time check (`ps -o lstart=`) against `startedAt`.
- **Acceptance:** tests with an injected process probe: a recycled pid with another start time is not killed; a path with spaces matches.
- **Done:** `runtime/supervisor.ts`: injectable `probe`, `basename` of the whole `comm`, `lstart` start-time check (5 s tolerance, fallback to name + boot); tests for a recycled pid and a path with spaces. TECHNOLOGY §3.4.

### P1-38 — Conformance additions, smaller fixes and hygiene (added 2026-10-01, review R11, gaps, hygiene)
- **Status:** done (2026-10-01) · **Depends on:** P1-28 … P1-37 · **Parallel with:** —
- Conformance: permission denied, gate deny, one `tool_call` per call, interrupt while paused and while asking, send while paused, external kill → one `failed(crash)`, spawn failure, two sessions at once, resume from a bad ref. Smaller runtime fixes from R11 (replace on replay, send during a cap stop, early cap hit, failed resume, pause/resume ordering, startup signals, transcript seq after write). REST schemas and `ENDED_STATES` in the protocol; console fixes; 409 bodies redacted. Decisions: spawn cwd, credentials in the CLI env, stall threshold for long tools.
- **Acceptance:** conformance green on the fake adapter; everything in the review's R11 and hygiene lists done or recorded as a decision.
- **Done:** Conformance: a `failure paths` block — permission answered deny, policy deny, one `tool_call` per use, interrupt while paused / while asking, send while paused, crash → one `failed(crash)`, bad cwd, two concurrent sessions, resume from an invalid or missing ref (fake adapter: `toolUseId`s, `crash()` hook, `checkCwd`); the claude-sdk target carries the same cases (untested against the real CLI until the dev-machine run). R11: replacing status set after a replay (`status{replace}`), send during a stop, early cap hit, failed resume, pause/resume ordering, startup signals, transcript seq after write. Hygiene: `packages/protocol/src/rest.ts` (spawn/send/answer bodies, `RuntimesInfo`), `ENDED_STATES`, `CLOSE_UNAUTHORIZED`, console send keeps its text on failure, safe unsubscribe and frame parsing, transcripts reset on a new `logId`, redacted 409 bodies; adapters README. Decisions recorded: spawn cwd and stall threshold as SPEC §8 questions, credentials in the CLI env in TECHNOLOGY §8. Not done: a "no process left in the group" conformance case (covered by supervisor tests) and teaching `fake-sdk.ts` every failure mode of the real SDK (those paths are tested with dedicated fake-SDK scripts instead).

## Exit criteria (from the plan)

Claude Code can be spawned, asked to do a small job, interrupted with a clarification question and a permission request that you answer from the page, paused and resumed, and stopped — the status store shows the right state throughout without sending the agent any extra message; killing the server mid-task and restarting resumes the agent from its session ref; the fake adapter passes the identical test suite.

**Verified 2026-10-01** (`notes/P1-12-real-adapter-run.md`): all of it from the ops console against the real `claude-sdk` adapter (spawn → clarification card → permission card for an `rm -rf` → pause/resume → message → stop, states and cost shown, no extra message sent to the agent); kill -9 + restart resumes from `sessionRef` (`scripts/sdk-restart-smoke.ts`); the fake adapter runs the identical conformance suite in CI (`fake-adapter.conformance.test.ts`, 36 tests across the fake suite) and the real one passes it 11/11 locally. **Dev machine confirmed 2026-10-02** (`notes/P1-12-real-adapter-run.md` §4): `pnpm check:real` passes under Cosmin's claude.ai team subscription — spike, smoke, conformance 22/22, restart — after three fixes the run found (symlinked workspace paths in the gate, the resume message naming cancelled questions, the checks isolated from the developer's own global Claude Code rules).

**Re-checked 2026-10-01 after wave 6 (P1-28 … P1-38):** `pnpm build`, `typecheck`, `lint`, `format:check` and `pnpm test` green (protocol 42, server 358 + 1 skipped, web 30; server suite 3× without flakes). The fake adapter passes the extended conformance suite (24 cases, run 3×), including the recovery path through `recover()`. Not re-run against the real SDK here (no CLI in the sandbox): the claude-sdk conformance target now has the new failure-path cases too, so **the dev-machine run is the one open item** — `GALACTIC_REAL_CLAUDE=1 pnpm --filter @galactic/server exec vitest run src/adapters/claude-sdk/claude-sdk.conformance.test.ts`, `scripts/sdk-smoke.ts`, `scripts/sdk-restart-smoke.ts` and the spike's `auth tools`, under the subscription login on the Mac (this also exercises the macOS `ps` identity check of P1-37).
