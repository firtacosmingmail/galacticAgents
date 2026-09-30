# Phase 1 review after wave 2 (2026-09-30)

**Resolution (same day):** every item below was implemented as P1-17 … P1-27 in `PHASE_1_AGENT_RUNTIME.md` — R1 → P1-17, R2 → P1-18, R3 → P1-19, R4 → P1-20, R5 + R6 + R7 → P1-21, R8 → P1-22, R9 → P1-23, R10 → P1-24, R11 → P1-25, R12 → P1-26, R13 → P1-27 (decisions in `TECHNOLOGY.md` §3.1, §3.4, §4, §6.2, §8). Wave 3 (P1-09) builds on the result.

Reviewed at commit `8bf40f9` (waves 1–2 done, clean tree). Verified on a fresh copy: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`, `pnpm format:check` and `pnpm test` (37 + 196 + 22) all green; `pnpm typecheck` green only after rebuilding the protocol package (R12).

Overall the phase is solid: the one-write rule is real, the status projection has a single implementation, the conformance suite runs through the actual composition root, redaction covers every agent-event string, and the graceful-stop and pid-identity work in the supervisor is careful. The items below are ordered by how much P1-09 (the real adapter) would have built on top of them.

## Change before P1-09 builds on it

### R1 — Two terminal events per agent, ordered by luck
A cap hit logged `agent.stopped` and then `agent.failed(cap)`, and `agent-runtime.test.ts` asserted exactly that. It worked because the fake adapter's `stop()` emits `agent.stopped` before resolving and the microtask ordering routes it first. With the SDK adapter the "stopped" comes from the supervisor merged asynchronously, so `onCapHit` could record `failed(cap)` first and the later `agent.stopped` would flip the status store to `stopped` (no terminal-is-a-sink rule in `apply`, and `route()` recorded events even when the agent had ended).
Fix: "exactly one terminal event per agent" is an invariant of the runtime — a cap stop is flagged on the live entry, the adapter's `agent.stopped` is folded into `agent.failed(cap)` whichever arrives first, stragglers from ended agents are dropped, events for unknown agents are reported; the status store treats an ended record as a sink.

### R2 — Policy evaluation about to be duplicated in every adapter
`SpawnOptions.permissionPolicy` handed the raw policy to the adapter, and §3.1 put the `evaluate()` call inside the SDK adapter's `PreToolUse` hook, next to the `caps.wouldExceed()` pre-flight: two cross-cutting rules every adapter (ACP's `request_permission`, PTY) would reimplement, and a coupling of `src/adapters` to `domain/permissions`.
Fix: the adapter gets a decision function, `SpawnOptions.gate: PermissionGate` (`check(toolCall) → allow | deny(reason) | ask(action, reasons)`), built by the runtime from policy + cap pre-flight (`runtime/permission-gate.ts`). A refused call also trips the cap, so an agent whose calls are all refused cannot spin.

### R3 — Who owns the send queue
The `AgentAdapter.send` doc (and §3.4, PLAN) said "enqueued, delivered when idle" while `inbox.ts` said adapters are only sent when idle, and the fake adapter carried a second inbox.
Fix: the runtime owns the queue; `send` = "start a turn now, the caller guarantees idle (or just interrupted)"; the fake rejects a mid-turn message; the conformance suite asserts no delivery was ever refused.

### R4 — The supervisor was a second event source nobody consumed
`ProcessSupervisor.events` emitted `agent.failed(crash|runtime)`, `agent.stopped` and `agent.progress`, but the runtime only pumps `adapter.events`; the SDK adapter would have had to merge that queue per session, and the two could disagree (SDK `result` → `finished` vs. exit code ≠ 0 → `crash`).
Fix: the supervisor reports `ProcessOutcome`s (`start_failed`, `crashed`, `exited`, `stopped`, `restarting`) through the spec's `onOutcome` hook; the adapter is the one emitter for its session and decides the verdict.

## Cheap now, a migration or a decision later

### R5 — Two slips in the one-write rule in `AgentRuntime`
`start()` upserted `sessionRef` in one transaction and recorded `agent.spawned` in another; `createAgent()` ran before `caps.canSpawn()`, so a refused spawn left an agent row, a procedural asteroid and three events behind.
Fix: gate → create → open → one command that upserts the ref and emits `agent.spawned` (`domain/agents.ts: recordSpawned`); a refused spawn writes nothing.

### R6 — Domain logic living in `runtime/`
`createAgent` (and the procedural asteroid) lived in the runtime; `redactEvent` in `agent-runtime.ts`.
Fix: `domain/agents.ts` (Phase 2's `spawnAgent` composes it), `redactEvent` in `redact.ts`.

### R7 — Dependency direction
`EventLog` (domain) took a `statuses()` callback for its snapshot, forcing a late-binding hack in `compose.ts`; `adapters/fake` imported `runtime/event-queue.ts` while `runtime/compose.ts` imported the fake adapter.
Fix: `EventLog.snapshot()` returns the tables (`TableSnapshot`); `ws/snapshot.ts: buildSnapshot(log, statuses)` assembles the wire snapshot; `EventQueue` moved to `src/lib/`, `collect()` to `src/test/`.

### R8 — Messages to agents were not events
The inbox history was memory-only: pending messages vanished on restart, P1-14 could not re-deliver them, and the Phase 2 mailbox is specified as fed by "user message" events that did not exist.
Fix: `message.sent{messageId, agentId, sender, text, interrupt}` in the protocol, recorded by `AgentRuntime.send` before queuing; the in-memory delivery history is bounded (`inboxHistory`, default 200).

### R9 — Questions were answered but never opened
`agent.needs_input` created no `Question` row and no `question.opened`, yet `answer()` emitted `question.answered{version: 0}`; P2-01's replay-equals-snapshot conformance would trip.
Fix: `domain/questions.ts` — the row and `question.opened` in the same command as `agent.needs_input`; `answerQuestion` closes the row and bumps `version`.

## Smaller

### R10 — Children inherited the server's whole environment
`supervisor.launch` passed `{...process.env, ...spec.env}`.
Fix: an allow-list (`INHERITED_ENV`) plus the spec's own variables; `inheritEnv` extends it per supervisor. Recorded in §8.

### R11 — Every live record was re-sent every second
`StatusStore.tick()` marked every live record dirty to refresh `wallClockMs.used`.
Fix: `StatusRecord.startedAt`; the tick marks only real stall transitions; clients extrapolate the wall clock.

### R12 — `pnpm typecheck` resolved the protocol from a stale `dist/`
Fix: the root `typecheck` script builds the protocol package first (same family as P0's R3).

### R13 — Redaction was per chunk
It relied on adapters emitting per content block, which nothing enforced; token-boundary splits are exactly where keys leak.
Fix: boundary-aware redaction in the pipeline — the previous chunk's tail is matched together with the new text, a secret's head moves into the new chunk, and the newest chunk of an agent is held for `holdMs` (250 ms) so its successor can complete it.

Also done on the way: `lib.ts` no longer exports the test helper; `AgentRuntime` records the `by` actor of a pause/resume/stop through the `control.*` events as before (the `by: system` on adapter-emitted events stays a documented decision).
