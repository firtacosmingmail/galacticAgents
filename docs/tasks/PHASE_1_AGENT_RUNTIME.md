# Phase 1 — Agent runtime and adapters

**Current task:** — (phase not started; first task will be P1-01 / P1-03 / P1-10 in parallel) · **Task status:** —
**Phase status:** not started (0/14 done)

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
| 3 | P1-09 | Real adapter needs the spike, supervisor, inbox and policy engine. |
| 4 (parallel) | P1-11, P1-13, P1-14 | Ops console, README, restart recovery. |
| 5 | P1-12 | Conformance + resume against the real adapter, last. |

## Tasks

### P1-01 — Process supervisor
- **Status:** todo · **Depends on:** P0-07 · **Parallel with:** P1-03, P1-08, P1-10
- Spawn child processes in their own process group; capture stdio; detect exit/crash; restart policy (off by default); per-agent working directory; **graceful stop** sequence (interrupt → wait for turn end with timeout → terminate → kill); persisted PID/session table (`agents.sessionRef`, pid, startedAt); startup reconciliation against live processes (mark dead ones `interrupted`).
- **Acceptance:** tests spawn a script child, kill it, see `agent.failed`; stop sequence verified with a child that ignores the first signal; orphaned children of a killed agent are gone after group kill.

### P1-02 — Hard caps
- **Status:** todo · **Depends on:** P1-01 · **Parallel with:** P1-04, P1-05, P1-06, P1-07
- Per-agent wall-clock and tool-call caps (from `Agent.caps`, defaults from settings); global max concurrent agents (spawn refused with a clear reason); cap hit → graceful stop + `agent.failed(reason: cap)`.
- **Acceptance:** tests for each cap; the refusal reason is visible in the event payload.

### P1-03 — Fake adapter
- **Status:** todo · **Depends on:** P0-04 · **Parallel with:** P1-01, P1-08, P1-10
- Implements `AgentAdapter` with scriptable scenarios: output stream, tool calls, a clarification question, a permission request, idle, stall (silence), pause/resume, finish with cost, fail, stop, `resumeSession` from a fake session ref. Deterministic timing knobs for tests.
- **Acceptance:** every event type in `TECHNOLOGY.md` §3.4 can be produced on demand; used by the ops console in dev mode without Claude installed.

### P1-04 — Adapter conformance suite
- **Status:** todo · **Depends on:** P1-03 · **Parallel with:** P1-02, P1-05, P1-06, P1-07
- Vitest suite parameterised by adapter: spawn → output → clarification question answered → permission request answered → pause/resume → interrupt → finish with cost; stop from every state; `resumeSession` round trip; stall detection. Runs against the fake adapter in CI.
- **Acceptance:** suite green on the fake adapter; documented as the bar for any future adapter.

### P1-05 — Status store projection
- **Status:** todo · **Depends on:** P0-07, P1-03 · **Parallel with:** P1-02, P1-04, P1-06, P1-07
- Fold `agent.*` events into `StatusRecord`s (state, `current_activity`, `last_event_at`, `pending_question`, `progress`, `cost_so_far`, caps used); per-runtime silence threshold → `stalled`; rebuild from `events` on startup; batched diff broadcast (≈10 Hz) as `status.*` messages over the WS stream.
- **Acceptance:** replaying a recorded event log yields identical records; a silent agent turns `stalled` after the threshold and back to `working` on the next event.

### P1-06 — Transcript pipeline and secret redaction
- **Status:** todo · **Depends on:** P0-07 · **Parallel with:** P1-02, P1-04, P1-05, P1-07
- `agent.output` batched into `transcript_chunks` (≈10 Hz writes); redaction of known secret patterns (API keys, bearer tokens, `sk-…`, AWS keys) before persisting and before sending; per-agent subscribable transcript stream over WS (separate from the `events` stream); retention hook (no-op in v1).
- **Acceptance:** a chunk containing a fake key is stored and sent redacted; transcript subscription delivers chunks in `seq` order.

### P1-07 — Per-agent inbox (send queue)
- **Status:** todo · **Depends on:** P1-01, P1-03 · **Parallel with:** P1-02, P1-04, P1-05, P1-06
- `send()` enqueues; delivery on `agent.idle`; `interrupt: true` cancels the current turn and delivers immediately; every message records `sender` (user / supervisor id / system).
- **Acceptance:** two messages sent while working are delivered in order after idle; an interrupt message arrives first.

### P1-08 — Claude SDK adapter spike (answers SPEC §8 questions 1–2)
- **Status:** todo · **Depends on:** P0-04 · **Parallel with:** P1-01, P1-03, P1-10
- Throwaway script exercising the TypeScript Agent SDK: authentication under the subscription login (in-process), custom tools + system prompt, permission callback shape, how `AskUserQuestion` surfaces, `resume` by session id, cost in the final result, interrupt behaviour, whether `bare` is exposed. Record findings and update `SPEC.md` §8 (answer or keep open) and `TECHNOLOGY.md` §3.1 if reality differs.
- **Acceptance:** a short findings note in `docs/tasks/notes/P1-08-sdk-spike.md`; SPEC §8 rows 1–2 resolved or refined.

### P1-09 — Claude SDK adapter implementation
- **Status:** todo · **Depends on:** P1-08, P1-01, P1-07, P1-10 · **Parallel with:** —
- `spawn(opts)` with cwd, prompt, optional tools/system prompt (for Phase 2 brains), subscription login, `bare` opt-in; permission callback → policy engine → auto-allow or `needs_input(kind: permission)` (blocks the tool call until answered); `AskUserQuestion` → `needs_input(kind: clarification)`; streaming output/tool calls/thinking → `agent.output` / `agent.tool_call`; final result → `agent.finished(cost)`; `resumeSession(sessionRef)`; `interrupt`, `pause` (hold delivery + interrupt), `resume`, `stop` via the supervisor's graceful sequence.
- **Acceptance:** manual run on the dev machine passes every step of the exit criteria; unit tests with the SDK mocked for the event mapping.

### P1-10 — Permission policy engine
- **Status:** todo · **Depends on:** P0-02 · **Parallel with:** P1-01, P1-03, P1-08
- Pure function `evaluate(policy, action) → allow | ask`: inside/outside workspace path checks, destructive command patterns (`rm -rf`, branch deletes, force ops), network/install patterns, `git push`; defaults per `SPEC.md` §3.6; per-project override merged over the global default.
- **Acceptance:** table-driven tests for each row of the SPEC table, including path traversal outside the workspace.

### P1-11 — Ops console page
- **Status:** todo · **Depends on:** P0-09, P1-05, P1-06, P1-07 · **Parallel with:** P1-13, P1-14
- Agents list with state, activity, cost, caps; spawn form (adapter, cwd, prompt, policy preset); send message (+ interrupt toggle); answer `needs_input` of both kinds (permission shows the requested action); pause/resume/stop; live transcript view.
- **Acceptance:** everything in the Phase 1 exit criteria is doable from this page with the fake adapter and with the real one.

### P1-12 — Conformance and resume against the real adapter
- **Status:** todo · **Depends on:** P1-09, P1-04, P1-14 · **Parallel with:** —
- Run the conformance suite against the `claude-sdk` adapter locally (tagged, not in CI); add the "kill the server mid-task, restart, agent resumes from `sessionRef`" scenario.
- **Acceptance:** suite green locally; a short run log kept in `docs/tasks/notes/`.

### P1-13 — Adapters README: how to add a runtime
- **Status:** todo · **Depends on:** P1-04 · **Parallel with:** P1-11, P1-14
- `apps/server/src/adapters/README.md`: the interface, event mapping table, question kinds, graceful stop, what the conformance suite checks, notes for the future ACP adapter (advertise `elicitation.form`; `request_permission` is permission-kind) and PTY adapter (no resume).
- **Acceptance:** a reader could implement the ACP adapter from it without reading the SDK adapter.

### P1-14 — Restart recovery v1
- **Status:** todo · **Depends on:** P1-01, P1-09 · **Parallel with:** P1-11, P1-13
- Graceful shutdown handler (SIGINT/SIGTERM on the server): interrupt every agent, persist session refs, exit. Startup: reconcile PID table, respawn interrupted agents via `resumeSession` where the adapter supports it, deliver any answer given meanwhile as the first message, mark the rest `interrupted`.
- **Acceptance:** kill -9 and clean restart both recover a fake-adapter agent; state visible in the ops console as `interrupted → working`.

## Exit criteria (from the plan)

Claude Code can be spawned, asked to do a small job, interrupted with a clarification question and a permission request that you answer from the page, paused and resumed, and stopped — the status store shows the right state throughout without sending the agent any extra message; killing the server mid-task and restarting resumes the agent from its session ref; the fake adapter passes the identical test suite.
