# Phase 1, wave 2b — what changed and why (read before P1-09)

**Audience:** the agent that continues Phase 1 (P1-09 real adapter, then P1-11 … P1-16).
**State:** commits `213c26f` … `106c897` on `main` (2026-09-30), on top of wave 2 (`8bf40f9`). Tree clean; `pnpm test` 37 + 206 + 22, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build` all green.
**Source of the items:** `docs/tasks/notes/P1-wave2-review.md` (R1 … R13). Tasks P1-17 … P1-27 in `PHASE_1_AGENT_RUNTIME.md`. Design recorded in `TECHNOLOGY.md` §3.1, §3.4, §4, §6.2, §8 and `IMPLEMENTATION_PLAN.md` (Phase 1 bullets).

The one-paragraph version: the **runtime** (`apps/server/src/runtime/agent-runtime.ts`) is now unambiguously the owner of the inbox, the caps, the permission policy and the event log, and an **adapter** is a translator only. Several interfaces changed to make that true, so P1-09 must be written against the files as they are now, not against the wave 2 shape of `SpawnOptions`, `AgentAdapter.send` or `ProcessSupervisor`.

---

## 1. Interface changes P1-09 will meet

### `SpawnOptions` (`packages/protocol/src/adapter.ts`) — P1-18

`permissionPolicy` and `workspace` are gone. In their place:

```ts
gate: PermissionGate;            // the runtime's decision function for tool calls

interface PermissionGate { check(call: ToolCall): GateVerdict }
type GateVerdict =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; action?: PermissionAction; reasons: string[] };
```

`ToolCall = { toolName, input? }` lives in `packages/protocol/src/domain.ts` and is also what `QuestionContext.toolCall` is. The gate is built per spawn by `apps/server/src/runtime/permission-gate.ts` from the project's policy (`domain/permissions.ts`) and the caps; it is **synchronous** and does no I/O.

What the SDK adapter does with it (TECHNOLOGY §3.1): in the `PreToolUse` hook call `opts.gate.check({ toolName, input })`; `allow` → let the call run; `deny` → refuse it, surfacing `reason` to the model; `ask` → open `agent.needs_input(kind: 'permission', question: { text, toolCall, permissionAction: verdict.action })` and block the call until `answer()`. Do **not** import `domain/permissions.ts` from the adapter and do not look at caps there: `check()` already pre-flights the tool-call cap (a refused call also trips the cap, so the runtime stops the agent — `CapsEnforcer.reserveToolCall`).

The fake adapter (`adapters/fake/fake-adapter.ts`, `toolCall()`) is the reference implementation of this flow.

### `AgentAdapter.send` — P1-19

```ts
/** Starts a new turn with `message` now. The runtime's inbox guarantees the session is idle
 *  (or that it just called `interrupt`, when `interrupt` is set); an adapter keeps no queue of
 *  its own and may reject a message that arrives mid-turn. */
send(sessionId, message, opts?: { interrupt?: boolean }): Promise<void>;
```

For the SDK adapter this means: the inbox *is* the streaming-input `AsyncIterable` — push the message into it and return; never buffer a second one. The fake adapter throws on a mid-turn message without `interrupt`; the conformance suite checks that the runtime never caused such a rejection.

### `ProcessSupervisor` — P1-20, P1-24

`supervisor.events` no longer exists. A process's fate reaches the adapter through the spec:

```ts
interface ProcessSpec { …; onOutcome?: (o: ProcessOutcome) => void }
type ProcessOutcome =
  | { kind: 'start_failed'; agentId; error }
  | { kind: 'crashed';      agentId; exit }               // unrequested, code ≠ 0 or signal
  | { kind: 'exited';       agentId; exit }               // clean, or announced with expectExit()
  | { kind: 'stopped';      agentId; exit; by }           // a stop sequence completed
  | { kind: 'restarting';   agentId; exit; attempt; maxRestarts };
```

The adapter maps these to events itself — `start_failed` → `agent.failed(reason: runtime)`, `crashed` → `agent.failed(reason: crash)`, `stopped` → `agent.stopped`, `exited` → whatever the runtime's final message said (`agent.finished`) — so there is exactly one emitter per session and no race between a process exit and a final result. `StopProcessOptions.silent` is gone (nothing is emitted any more). `SupervisorOptions.onOutcome` sees every outcome (logging, tests).

Children now inherit only `INHERITED_ENV` (PATH, HOME, locale, proxies, `CLAUDE_CONFIG_DIR`, …) plus the spec's `env`; `inheritEnv` extends it per supervisor. **`ANTHROPIC_API_KEY` is not inherited**: bare mode must pass it in `spec.env` explicitly.

### `StatusRecord` — P1-25

New field `startedAt` (ISO). `caps.wallClockMs.used` is as of the record's last change; the ticker no longer re-sends every live record each second. A client that shows a running clock extrapolates from `startedAt`.

### New event `message.sent` — P1-22

```ts
{ type: 'message.sent', messageId, agentId, sender: Actor, text, interrupt: boolean }
```

Recorded by `AgentRuntime.send()` *before* the message is queued. P1-14 (restart recovery) re-delivers what was sent but not yet followed by the agent's own events; the Phase 2 mailbox reads user messages from the log. The web reducer treats it as seq-only for now.

---

## 2. Runtime invariants (what the adapter can rely on, and must not break)

- **One terminal event per agent (P1-17).** The runtime logs exactly one of `agent.finished | agent.failed | agent.stopped`. On a cap stop it flags the live entry and folds the adapter's `agent.stopped` into `agent.failed(reason: cap)` whichever arrives first. An event for an agent that already ended is dropped; an event for an agent the runtime never spawned is reported through `onError` and never logged. The status store treats an ended record as a sink (only a new `agent.spawned` moves it). Consequence for adapters: emit your terminal event once and stop emitting; stragglers are harmless but noisy.
- **Nothing is written for a refused spawn (P1-21).** The concurrency gate runs before the agent row is created. The session ref and `agent.spawned` are written in **one** command (`domain/agents.ts: recordSpawned`), so the row and the log never disagree.
- **Questions are rows (P1-23).** `agent.needs_input` inserts the `Question` row (holder `user`) and emits `question.opened` in the same command; `AgentRuntime.answer()` calls the adapter first, then closes the row and emits `question.answered{version: 1}`. Adapters only need stable, unique `questionId`s.
- **Redaction is boundary-aware (P1-27).** The transcript pipeline matches the previous chunk's tail with the new text and holds the newest chunk 250 ms. Adapters still emit `agent.output` per content block (one row per token is not a transcript), but a key split across deltas no longer leaks.

---

## 3. Where things live now (layering, P1-21)

| Concern | File |
|---|---|
| Agent row + procedural asteroid, `agent.spawned` with the session ref | `apps/server/src/domain/agents.ts` (`createAgent`, `recordSpawned`) — Phase 2's `spawnAgent` composes these |
| Question rows | `apps/server/src/domain/questions.ts` (`openQuestion`, `answerQuestion`, `openQuestionsOf`) |
| Policy engine (pure) | `apps/server/src/domain/permissions.ts` — `PolicyVerdict.dominant` names the category behind a decision |
| Permission gate (policy + caps → `GateVerdict`) | `apps/server/src/runtime/permission-gate.ts` |
| Event redaction (`redactEvent`) | `apps/server/src/runtime/redact.ts` (moved out of `agent-runtime.ts`) |
| Wire snapshot (tables + status records) | `apps/server/src/ws/snapshot.ts` (`buildSnapshot`); `EventLog.snapshot()` now returns tables only (`TableSnapshot`) and no longer knows the status store |
| `EventQueue` (the `AsyncIterable` shape adapters use) | `apps/server/src/lib/event-queue.ts` |
| `collect()` test helper | `apps/server/src/test/collect.ts` (no longer exported from `lib.ts`) |

`compose.ts` no longer needs the log↔store late binding. `pnpm typecheck` builds the protocol package first (P1-26), so a stale `dist/` cannot produce phantom errors.

---

## 4. Item-by-item summary

| Review | Task | Problem | Change | Tests |
|---|---|---|---|---|
| R1 | P1-17 | Cap stop logged `agent.stopped` then `agent.failed(cap)`; order depended on the fake adapter's microtask timing and the status store had no sink rule | `AgentRuntime.terminal()` / `failForCap()` / `ended` memory; `StatusStore.apply` ignores events after a terminal one | `agent-runtime.test.ts` cap test (one terminal, 2 tool calls, third refused); straggler/stranger test; `status-store.test.ts` sink; conformance `expectOneTerminal` |
| R2 | P1-18 | Raw policy handed to adapters; `evaluate()` + cap pre-flight would be re-implemented in every adapter | `SpawnOptions.gate`, `ToolCall` in the protocol, `runtime/permission-gate.ts`, `CapsEnforcer.reserveToolCall()`, fake adapter routes every tool call through the gate | `fake-adapter.test.ts` "the gate decides"; cap test |
| R3 | P1-19 | `send` documented as "enqueued", runtime said "only when idle", fake adapter had a second inbox | Interface contract rewritten; fake inbox removed (`send` rejects mid-turn); `InboxMessage.interrupt` forwarded to `send` | `fake-adapter.test.ts` "keeps no queue"; conformance `expectCleanDeliveries` |
| R4 | P1-20 | Supervisor emitted `agent.*` on a stream nobody consumed; would race the adapter's verdict | `ProcessOutcome` + `onOutcome` hooks; `events` and `silent` removed | `supervisor.test.ts` rewritten on outcomes |
| R5 | P1-21 | `createAgent` before the concurrency gate; `sessionRef` upsert and `agent.spawned` in separate transactions | Gate first; `recordSpawned` does both in one command | "refuses a spawn … before writing anything"; "session ref lands on the row in the same command" |
| R6 | P1-21 | Domain logic (`createAgent`, asteroid) and `redactEvent` inside `runtime/` | `domain/agents.ts`; `redactEvent` in `redact.ts` | existing routing tests |
| R7 | P1-21 | `EventLog` depended on the status store; `adapters/fake` ↔ `runtime` import cycle | `TableSnapshot` + `ws/snapshot.ts`; `lib/event-queue.ts`, `test/collect.ts` | `event-log.test.ts` snapshot without `statuses` |
| R8 | P1-22 | User→agent messages were memory-only; restart lost them; Phase 2 mailbox had no event to read | `message.sent` event; `AgentRuntime.send` records it; `inboxHistory` bound (default 200) | inbox test checks the log; "bounded delivery history" |
| R9 | P1-23 | `question.answered` without `question.opened` or a row | `domain/questions.ts`, opened in the same command as `needs_input` | "a question opens a row…"; conformance checks the row |
| R10 | P1-24 | Children inherited the server's whole environment | `INHERITED_ENV` allow-list + `spec.env` + `inheritEnv` | "children inherit only the allow-list" |
| R11 | P1-25 | Every live record marked dirty every second | `StatusRecord.startedAt`; tick marks only stall transitions | "marks only records that changed" |
| R12 | P1-26 | `pnpm typecheck` read a stale protocol `dist/` | root `typecheck` builds the protocol first | — |
| R13 | P1-27 | Per-chunk redaction leaked keys split across streamed deltas | boundary matching, head moved forward, `holdMs` hold on the newest chunk; `flush()` takes everything | "key split over two / three chunks"; "holds the newest chunk" |

---

## 5. Continuing: P1-09 checklist against the new shape

1. Read `TECHNOLOGY.md` §3.1 (adapter shape, verified by the spike), §3.4 (event model, the refinements list), and `docs/tasks/notes/P1-08-sdk-spike.md`.
2. Build the SDK adapter as a translator: one long-lived `query()` with streaming input per session; the inbox feeds it through `send()`; `PreToolUse` → `opts.gate.check()`; `canUseTool` → `agent.needs_input` (permission on `ask`, clarification for `AskUserQuestion`); `result` → `agent.idle` per turn and `agent.finished(cost)` at the end; `query.interrupt()` for `interrupt()`; `resume: sessionRef` for `resumeSession()`.
3. Spawn the CLI through `ProcessSupervisor.adopt()` from `spawnClaudeCodeProcess`, with `onOutcome` mapped as in §1 above and `ANTHROPIC_API_KEY` passed in `spec.env` only for `bare`.
4. Emit exactly one terminal event per session; call `managed.turnEnded()` when a turn ends so the graceful stop's step 2 can see it; call `expectExit()` before closing stdin yourself.
5. Run `describeAdapterConformance` with a `claude-sdk` target (P1-12, tagged local-only); it now also asserts one terminal event and clean deliveries.
6. Keep `adapters/` free of imports from `domain/` and `runtime/` other than the supervisor and `lib/event-queue.ts`.

Open follow-ups that already exist as tasks: P1-14/P1-15 (restart recovery and `agent.interrupted`; `message.sent` and `openQuestionsOf()` are the inputs for re-delivery), P1-16 (retention of ended status records — the refused-spawn and inbox halves are done), P1-13 (the adapters README should describe the gate, the send contract and the outcome mapping).
