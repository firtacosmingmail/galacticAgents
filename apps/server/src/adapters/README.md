# Adapters — how to add a runtime

An adapter turns one agent runtime (the Claude Agent SDK today; ACP and PTY later) into the
server's one event vocabulary and the one control surface. It is a **translator, not a
scheduler**: the runtime layer (`apps/server/src/runtime/`) owns the per-agent inbox, the hard
caps, the permission policy, the event log, the status store and the transcript pipeline. An
adapter never imports from `domain/` or `runtime/` except the process supervisor and
`lib/event-queue.ts`, and nothing outside `adapters/` imports a runtime SDK (CLAUDE.md).

Three adapters exist: `fake/` (scripted scenarios, the reference implementation and the CI
target), `claude-sdk/` (the real one for Claude Code) and `acp/` (any Agent Client Protocol agent,
P8-07). Read `fake/fake-adapter.ts` first: every rule below is visible there in forty lines per
concern.

## The interface

`packages/protocol/src/adapter.ts`:

| Call                                     | Contract                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn(opts) → {sessionId, sessionRef?}` | Start a session in `opts.cwd` with `opts.prompt`. `sessionRef` is whatever `resumeSession` needs later; the runtime persists it on the agent row. Resolve as soon as the session exists; events may already be flowing.                                                                                                                                    |
| `send(sessionId, message, {interrupt?})` | **Start a new turn now.** The runtime's inbox only calls this when the session is idle, or right after it called `interrupt` (then `interrupt: true`). Keep no queue; reject a message that arrives mid-turn without `interrupt`. The runtime logs `message.delivered` once `send()` resolves (a rejected delivery is retried from the head of the inbox). |
| `answer(questionId, answer)`             | Resolve a pending `agent.needs_input`. Unknown or already-answered ids throw.                                                                                                                                                                                                                                                                              |
| `interrupt(sessionId)`                   | Cancel the current turn. The session reports `agent.idle` when it has; no failure. The runtime resumes a paused agent before interrupting it (a frozen process cannot end a turn); an adapter that gets `interrupt` while paused thaws first and emits `agent.resumed`.                                                                                    |
| `pause` / `resume`                       | Hold the session and let it continue. Emit `agent.paused` / `agent.resumed` (`by: system`; the actor is in the runtime's `control.*` event). Nothing else may be emitted while paused. `pause` throws when there is nothing to freeze (no process yet, or it exited): the runtime then undoes its own pause.                                               |
| `stop(sessionId, {graceMs?})`            | Graceful: interrupt → wait for the turn to end (at most `graceMs`) → terminate → kill. Ends with exactly one `agent.stopped`. Idempotent; a no-op after any terminal event.                                                                                                                                                                                |
| `resumeSession?(sessionRef, opts)`       | Reopen a saved session after a restart. Absent when the runtime cannot (PTY). A reopened session re-asks any question that was pending.                                                                                                                                                                                                                    |
| `events`                                 | One `AsyncIterable<AgentEvent>` for every session of the adapter (`lib/event-queue.ts` is the usual implementation). The only source of `agent.*` events for its sessions.                                                                                                                                                                                 |
| `dispose()`                              | Stop every session, close the stream.                                                                                                                                                                                                                                                                                                                      |

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
"no answer" and let the runtime's event (`agent.idle` / `agent.stopped`) explain. The question
row is the runtime's to close: it logs `question.cancelled` in the same command as the agent's
terminal or `agent.interrupted` event, and when the agent goes idle with a question still open (an
interrupt withdrew it). The adapter never reports a cancellation itself.

## The permission gate

Every tool call goes through `opts.gate.check({toolName, input})` **before it runs**:

| Verdict                               | Do                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `{decision: 'allow'}`                 | Run it; emit `agent.tool_call`.                                                                    |
| `{decision: 'deny', reason}`          | Refuse it; tell the model the reason; emit an `agent.output` line.                                 |
| `{decision: 'ask', action?, reasons}` | Open a `permission` question with `toolCall` and `permissionAction: action`; block until answered. |

The runtime decides every `permission` request again with the same gate before it opens a question
(P2-04): `allow` and `deny` are answered at once through `answer()` (`allow`, or `deny: <reason>`)
and logged as `permission.decided`, so an adapter whose runtime asks about calls on its own (a PTY
prompt, an ACP `session/request_permission`) may emit the request without checking the gate first.
Always put the call in `question.toolCall`: a request without one cannot be judged and goes to the
user.

The gate is synchronous and already pre-flights the tool-call cap (a call refused for the cap also
trips the cap, so the runtime stops the agent). Do not read the policy or the caps yourself.

**One check, one `agent.tool_call` per tool use.** When a runtime offers two permission hooks for
the same call, ask the gate once: the SDK adapter remembers the `PreToolUse` hook's verdict per
`toolUseId` and reuses it in `canUseTool`, so a call is gated once (and asks at most one
question), and it emits `agent.tool_call` once per `toolUseId`, whichever hook let it run. Report
the `toolUseId` when the runtime has one.

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
real runtime (`composeRuntime`). The happy paths: spawn → output → tool call → job end
(`finished`, or `idle` for a long-lived session: `jobEnd`); a clarification answered; a permission
answered (allow runs the tool); pause without events and resume to completion; interrupt → idle
with messages delivered in order, interrupts first; echo of a message sent while idle; stop from
every state (working, waiting, paused, idle, after the end); `resumeSession` after the adapter
went away; stall detection.

The failure paths (P1-38):

- a permission answered **deny**: the tool does not run (no `agent.tool_call` with its input), the question is `answered`, the agent carries on to its job end without failing;
- a **policy deny** (`target.denyPolicy`, default `{rules: {destructive: 'deny'}}` with the `permission` prompt): no question, no `tool_call`, the reason in the transcript;
- **one `agent.tool_call` per tool use**: the allowed call is reported once and no `toolUseId` twice;
- **interrupt while paused**: the agent is resumed (`agent.resumed` before the `agent.idle`), ends the turn and takes the next message;
- **interrupt while a question is open**: idle, the question row `cancelled` with a `question.cancelled` event, a late answer refused;
- **send while paused**: the message is held, and its `message.delivered` comes after the `control.resume`;
- an **external kill** (`instance.crash(agentId)`): exactly one `agent.failed(reason: crash)`, nothing live, a later stop is a no-op;
- a **spawn that cannot start** (a cwd that does not exist): one `agent.failed(reason: runtime)`, no live agent; `spawn()` returns `ok: false` unless the target says the runtime fails after the session exists (`spawnFailure: 'event'`);
- **two sessions at once**: each transcript and each `message.delivered` only its own;
- **resume from an invalid or a missing session ref** (resumable targets): `recoverAgent()` returns `ok: false`, the agent stays `interrupted`, nothing live, no second `agent.spawned`.

Checked throughout: one terminal event per agent and no delivery ever refused (no message handed
to the adapter mid-turn). A target supplies a fresh adapter per test (with an optional `crash`
hook), the prompts that make its agent do each thing, and may `skip` the optional cases (`crash`,
`spawnFailure`, `concurrentSessions`) with a reason. `fake/fake-adapter.conformance.test.ts` runs
in CI (the fake adapter with `checkCwd: true` and its `crash()` test hook);
`claude-sdk/claude-sdk.conformance.test.ts` runs with `GALACTIC_REAL_CLAUDE=1` (crash = `SIGKILL`
to the CLI's process group through the supervisor; `spawnFailure: 'event'`).
`acp/acp.conformance.test.ts` runs in CI against the fake ACP agent (`acp/fake-acp-agent.mjs`, a
real child process speaking ACP through the official SDK); `acp/acp-real.conformance.test.ts` runs
with `GALACTIC_REAL_ACP="<agent command line>"` against a real ACP agent, local-only.

## The ACP adapter (`acp/`, P8-07; TECHNOLOGY §3.2)

The server is an ACP _client_ (like an editor) over stdio JSON-RPC, with the official TypeScript
SDK `@agentclientprotocol/sdk` (Apache-2.0). One agent process per session, started through
`ProcessSupervisor.adopt()` from the configured command (`acp.command` / `acp.args` in
`config.json`, or `GALACTIC_ACP_COMMAND`): own process group, PID table, `GALACTIC_AGENT_ID`, the
graceful stop.

**The capability set it advertises in `initialize`** (`CLIENT_CAPABILITIES`), asserted by the fake
agent:

| Capability                                               | Advertised | Why                                                                                                                                                |
| -------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elicitation.form`                                       | **yes**    | the only way an ACP agent can ask the user a question; without it the agent's question tool is off                                                 |
| `elicitation.url`                                        | no         | nothing here can open a URL for the user                                                                                                           |
| `fs.readTextFile` / `fs.writeTextFile`                   | no         | the agent reads and writes with its own tools in its own cwd (the Steward's worktree); a headless server has no editor buffers to serve faithfully |
| `terminal`                                               | no         | likewise: the agent runs commands itself; its tool calls still reach the gate                                                                      |
| `plan`, `session.*`, `subagents`, `auth.terminal`, `nes` | no         | not needed (a plan arrives as `session/update` anyway); nothing here can run a login                                                               |

An agent that calls an unadvertised method gets `method not found` from the SDK.

| ACP                                                                         | Adapter                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` → `session/new {cwd, mcpServers: []}` → first `session/prompt` | `spawn` (a failure before the first prompt throws; the runtime reports it)                                                                                                                                                                     |
| `session/prompt` and its response                                           | `send` (one prompt per turn) → `agent.idle` with the running cost; a stop reason other than `end_turn`/`cancelled` is a transcript line; an error response is a transcript line + `agent.idle`                                                 |
| `session/update` `agent_message_chunk` / `agent_thought_chunk`              | joined into one `agent.output` per block (`text` / `thinking`)                                                                                                                                                                                 |
| `session/update` `tool_call` / `tool_call_update`                           | merged per `toolCallId`; `agent.tool_call` when it runs (after the gate); its result as `agent.output(kind: tool)`                                                                                                                             |
| `session/update` `plan`                                                     | `agent.progress{summary, progress}`                                                                                                                                                                                                            |
| `session/update` `usage_update.cost`                                        | the session's dollars (cumulative, USD only)                                                                                                                                                                                                   |
| `session/update` `notice`                                                   | a transcript line; other updates (modes, commands, replay of our prompt) are ignored                                                                                                                                                           |
| `session/cancel`                                                            | `interrupt` (pending permission/elicitation requests answered "cancelled" first)                                                                                                                                                               |
| `session/load` (capability `loadSession`)                                   | `resumeSession("acp:<sessionId>")`; the replay during the load is not transcript; without `loadSession` the resume fails and the agent stays `interrupted`                                                                                     |
| `session/request_permission`                                                | **permission-kind**: the call is translated (`gateCall`) and checked once — `allow` → `allow_once` + `agent.tool_call`, `deny` → `reject_once` + "permission denied" line, `ask` → `agent.needs_input(permission)`; never an `*_always` option |
| a tool call the agent runs without asking                                   | checked when it starts: `allow` reported, `ask` reported with a warning line, `deny` cancels the turn (not counted)                                                                                                                            |
| `elicitation/create` (form)                                                 | one `agent.needs_input(clarification)` per field; answered `accept` with typed values (re-asked up to three times when a number or yes/no does not read), `cancel` on interrupt/stop; URL mode → `decline`                                     |
| —                                                                           | pause/resume: SIGSTOP/SIGCONT on the process group                                                                                                                                                                                             |

**Translating tool calls for the gate** (`mapping.ts`, `gateCall`): the policy engine speaks
Claude Code's tool names, so an ACP call is mapped by its `kind` and raw input: `execute` +
command → `Bash {command}` (a `["bash","-lc",script]` argv keeps its script), `read` → `Read`,
`edit`/`delete` → `Edit` on the path, `move` → `Edit` with both paths, `search` → `Grep`, `fetch`
→ `WebFetch`. A call that cannot be placed keeps a name the engine does not know (`acp:<kind>`), so
the table's `unclassified` entry decides it (`ask` unless trusted). `think` and `switch_mode` are
bookkeeping: no gate, no `agent.tool_call`.

Brains do not run on ACP (their server tools would need an MCP bridge): a spawn with `tools` is
refused, and `bare` too. The fake ACP agent (`node acp/fake-acp-agent.mjs [--state dir]
[--no-load] [--no-cost]`) picks a scenario from `scenario:<name>` in its first prompt (`happy`,
`asks`, `permission`, `long`, `echo`, `stalls`, `unasked`, `form`, `error`, `refusal`, `dies`) and
echoes later prompts.

## Notes for the next adapters

**PTY** (`pty/`, TECHNOLOGY §3.3): `node-pty`, stream the terminal as `agent.output(kind: text)`
per line or per prompt-detected block, derive `agent.idle` from prompt detection and
`agent.finished` from the exit code. No structured permissions: every detected shell prompt that
looks like a confirmation becomes a `permission` question with the best-effort command as the
tool call; questions detected by regex are `clarification`s. **No `resumeSession`** (`resumable:
false`): an interrupted PTY agent stays `interrupted` with a restart action. Interrupt is Ctrl-C;
pause/resume are SIGSTOP/SIGCONT.
