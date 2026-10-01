# Adapters — how to add a runtime

An adapter turns one agent runtime (the Claude Agent SDK today; ACP and PTY later) into the
server's one event vocabulary and the one control surface. It is a **translator, not a
scheduler**: the runtime layer (`apps/server/src/runtime/`) owns the per-agent inbox, the hard
caps, the permission policy, the event log, the status store and the transcript pipeline. An
adapter never imports from `domain/` or `runtime/` except the process supervisor and
`lib/event-queue.ts`, and nothing outside `adapters/` imports a runtime SDK (CLAUDE.md).

Two adapters exist: `fake/` (scripted scenarios, the reference implementation and the CI target)
and `claude-sdk/` (the real one). Read `fake/fake-adapter.ts` first: every rule below is visible
there in forty lines per concern.

## The interface

`packages/protocol/src/adapter.ts`:

| Call                                     | Contract                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn(opts) → {sessionId, sessionRef?}` | Start a session in `opts.cwd` with `opts.prompt`. `sessionRef` is whatever `resumeSession` needs later; the runtime persists it on the agent row. Resolve as soon as the session exists; events may already be flowing.           |
| `send(sessionId, message, {interrupt?})` | **Start a new turn now.** The runtime's inbox only calls this when the session is idle, or right after it called `interrupt` (then `interrupt: true`). Keep no queue; reject a message that arrives mid-turn without `interrupt`. |
| `answer(questionId, answer)`             | Resolve a pending `agent.needs_input`. Unknown or already-answered ids throw.                                                                                                                                                     |
| `interrupt(sessionId)`                   | Cancel the current turn. The session reports `agent.idle` when it has; no failure.                                                                                                                                                |
| `pause` / `resume`                       | Hold the session and let it continue. Emit `agent.paused` / `agent.resumed` (`by: system`; the actor is in the runtime's `control.*` event). Nothing else may be emitted while paused.                                            |
| `stop(sessionId, {graceMs?})`            | Graceful: interrupt → wait for the turn to end (at most `graceMs`) → terminate → kill. Ends with exactly one `agent.stopped`. Idempotent; a no-op after any terminal event.                                                       |
| `resumeSession?(sessionRef, opts)`       | Reopen a saved session after a restart. Absent when the runtime cannot (PTY). A reopened session re-asks any question that was pending.                                                                                           |
| `events`                                 | One `AsyncIterable<AgentEvent>` for every session of the adapter (`lib/event-queue.ts` is the usual implementation). The only source of `agent.*` events for its sessions.                                                        |
| `dispose()`                              | Stop every session, close the stream.                                                                                                                                                                                             |

`SpawnOptions` also carries `role` (`steward` runs with the repository's context; a brain gets
its own `systemPrompt` and `tools`), `caps` (informational — the runtime enforces them) and the
**permission gate** (below). `bare` is an opt-in that skips repository context and the
subscription login; refuse it when the runtime cannot honour it.

## Event mapping

Emit the normalised events of `packages/protocol/src/events.ts`:

| Runtime happening                          | Event                                                | Notes                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| model text / thinking, tool output         | `agent.output{kind: text\|thinking\|tool, text}`     | **Per content block, never per token** (redaction is per chunk; one row per token is not a transcript). Never enters the event log: the runtime routes it to transcripts. |
| a tool call **the gate let run**           | `agent.tool_call{toolName, toolUseId?, input}`       | Emitted when the call runs, not when the model proposed it; a refused call is an `agent.output` line explaining why. Counted against the tool-call cap by the runtime.    |
| the runtime reports progress               | `agent.progress{summary, progress?}`                 | Optional; the status store shows it as the current activity.                                                                                                              |
| the agent needs the user                   | `agent.needs_input{questionId, kind, question}`      | See _Question kinds_. Blocks the turn until `answer()`.                                                                                                                   |
| a turn ended, waiting for the next message | `agent.idle{cost?}`                                  | Every turn, including a turn cancelled by `interrupt()`. Carry the running cost when the runtime meters per turn.                                                         |
| the runtime itself detected a stall        | `agent.stalled{silentForMs}`                         | Optional; the status store also detects silence on its own.                                                                                                               |
| paused / resumed                           | `agent.paused{by}` / `agent.resumed{by}`             | `by: {type: 'system'}`.                                                                                                                                                   |
| the session ended on its own               | `agent.finished{result?, cost?}`                     | A scripted or process-per-job runtime; a long-lived session (SDK) ends in `idle` instead and the runtime stops it later.                                                  |
| the runtime died or could not start        | `agent.failed{error, reason: crash\|runtime, cost?}` | `reason: cap` is the runtime's, never an adapter's.                                                                                                                       |
| a stop completed                           | `agent.stopped{by}`                                  |                                                                                                                                                                           |

Rules the runtime relies on:

- **One terminal event per session** (`finished` \| `failed` \| `stopped`), then nothing. A straggler is dropped; an event for a session the runtime never spawned is reported as an adapter bug.
- `agent.spawned` and `agent.interrupted` are the runtime's; never emit them.
- Every event carries the `agentId` from `SpawnOptions`.

## Question kinds

A question is a `Question` row the server owns; the adapter only needs a stable, unique
`questionId` per question and must resolve it on `answer()`:

- **`permission`** — a tool call the gate said `ask` about. `question: {text, toolCall: {toolName, input}, permissionAction?}`. `allow` / `yes` / `y` / `ok` means run it (then emit `agent.tool_call`); anything else refuses it and the agent is told why. Resolved by the policy table or the user, never by a brain.
- **`clarification`** — the agent's own question (`AskUserQuestion` in Claude Code, `elicitation/create` in ACP). `question: {text, options?}`. The answer text is fed back to the agent as the user's reply.

A pending question is withdrawn when the turn is interrupted or the session stops: resolve it as
"no answer" and let the runtime's event (`agent.idle` / `agent.stopped`) explain.

## The permission gate

Every tool call goes through `opts.gate.check({toolName, input})` **before it runs**:

| Verdict                               | Do                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `{decision: 'allow'}`                 | Run it; emit `agent.tool_call`.                                                                    |
| `{decision: 'deny', reason}`          | Refuse it; tell the model the reason; emit an `agent.output` line.                                 |
| `{decision: 'ask', action?, reasons}` | Open a `permission` question with `toolCall` and `permissionAction: action`; block until answered. |

The gate is synchronous and already pre-flights the tool-call cap (a call refused for the cap also
trips the cap, so the runtime stops the agent). Do not read the policy or the caps yourself.

## Processes and the supervisor

If the runtime is a child process, spawn it through `ProcessSupervisor.adopt(spec)` (synchronous,
own process group, PID table, allow-listed environment) and map its `ProcessOutcome`s:

| Outcome                                            | Event                                                        |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `start_failed`                                     | `agent.failed(reason: runtime)`                              |
| `crashed`                                          | `agent.failed(reason: crash)`                                |
| `exited` (clean, or announced with `expectExit()`) | `agent.finished` — or `agent.stopped` if a stop is under way |
| `stopped`                                          | `agent.stopped`                                              |
| `restarting`                                       | `agent.progress`                                             |

Give the spec an `interrupt` hook (the runtime's "end the current turn": `query.interrupt()` for
the SDK, Ctrl-C for a PTY) and call `managed.turnEnded()` when a turn ends, so the supervisor's
graceful stop can see it. Call `managed.expectExit()` before closing stdin yourself. Pass only the
environment the runtime needs (`spec.env`); children never inherit the server's secrets.

## What the conformance suite checks

`adapters/conformance.ts` — `describeAdapterConformance(target)` — runs every adapter through the
real runtime (`composeRuntime`): spawn → output → tool call → job end (`finished`, or `idle` for a
long-lived session: `jobEnd`); a clarification answered; a permission answered (allow runs the
tool); pause without events and resume to completion; interrupt → idle with messages delivered
in order, interrupts first; echo of a message sent while idle; stop from every state (working,
waiting, paused, idle, after the end); `resumeSession` after the adapter went away; stall
detection; one terminal event per agent; no delivery ever refused. A target supplies a fresh
adapter per test and the prompts that make its agent do each thing. `fake/fake-adapter.conformance.test.ts`
runs in CI; `claude-sdk/claude-sdk.conformance.test.ts` runs with `GALACTIC_REAL_CLAUDE=1`.

## Notes for the next adapters

**ACP** (`acp/`, TECHNOLOGY §3.2): the server is an ACP _client_ over stdio JSON-RPC.
`session/new` → `spawn`, `session/prompt` → `send` (one prompt per turn; the `result` of the
prompt is `agent.idle`), `session/update` → `agent.output` / `agent.tool_call` (emit the tool call
when the agent reports it running, after the gate), `session/cancel` → `interrupt`,
`session/load` (capability `loadSession`) → `resumeSession`. **`session/request_permission` is
permission-kind** (gate → ask → `permission` question; answer with the chosen option id).
**Clarification questions arrive only if the client advertises `clientCapabilities.elicitation.form`
in `initialize`** — advertise it and map `elicitation/create` → `clarification` (the form's first
field is the question, its enum the options). Do not advertise `fs/*` or `terminal/*` unless
implemented. Pause: no ACP primitive — SIGSTOP/SIGCONT on the process group like the SDK adapter.
Cost: whatever the agent reports in `session/update` usage, else none (`metered: false`).

**PTY** (`pty/`, TECHNOLOGY §3.3): `node-pty`, stream the terminal as `agent.output(kind: text)`
per line or per prompt-detected block, derive `agent.idle` from prompt detection and
`agent.finished` from the exit code. No structured permissions: every detected shell prompt that
looks like a confirmation becomes a `permission` question with the best-effort command as the
tool call; questions detected by regex are `clarification`s. **No `resumeSession`** (`resumable:
false`): an interrupted PTY agent stays `interrupted` with a restart action. Interrupt is Ctrl-C;
pause/resume are SIGSTOP/SIGCONT.
