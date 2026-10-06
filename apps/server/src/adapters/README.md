# Adapters — how to add a runtime

An adapter turns one agent runtime (the Claude Agent SDK, ACP agents, terminal CLIs) into the
server's one event vocabulary and the one control surface. It is a **translator, not a
scheduler**: the runtime layer (`apps/server/src/runtime/`) owns the per-agent inbox, the hard
caps, the permission policy, the event log, the status store and the transcript pipeline. An
adapter never imports from `domain/` or `runtime/` except the process supervisor and
`lib/event-queue.ts`, and nothing outside `adapters/` imports a runtime SDK (CLAUDE.md).

Four adapters exist: `fake/` (scripted scenarios, the reference implementation and the CI
target), `claude-sdk/` (the real one for Claude Code), `acp/` (any Agent Client Protocol agent,
P8-07) and `pty/` (any command-line agent under a pseudo-terminal, P8-08). Read `fake/fake-adapter.ts` first: every rule below is visible there in forty lines per
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
| `input?(sessionId, text)`                | Terminal runtimes only (PTY): type one line now, whatever the turn does. The runtime logs it as the user's message.                                                                                                                                                                                                                                        |
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
own process group, PID table, allow-listed environment) and map its `ProcessOutcome`s. The
supervisor records a launch intent before the fork (P8-11), so a server killed between the fork
and the PID-table row still finds the process at the next start; `adopt` throws (and reports
`start_failed`) when that intent cannot be written, e.g. on a full disk.

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
`spawnFailure`, `concurrentSessions`, `policyDeny`, `toolCalls`) with a reason. A runtime without
structured tool calls sets `toolCalls: false` and a `permissionEvidence` text; one that runs only
under some tables sets `spawnPolicy`. `fake/fake-adapter.conformance.test.ts` runs
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
`config.json`, or `GALACTIC_ACP_COMMAND` — whitespace-split, or a JSON array of strings): own
process group, PID table, `GALACTIC_AGENT_ID`, the graceful stop. Its environment is the
supervisor's allow-list, the routing variables of `ACP_PASS_ENV` (base URLs, provider switches,
region, profile — no credential) and what `acp.passEnv` names (every API key or token; never a
`GALACTIC_*` name). The session mode is set to `acp.mode` when configured; a session in a known
permissive mode (`PERMISSIVE_MODES`) is refused unless `acp.allowPermissiveMode` (decision 108).

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
| a tool call the agent runs without asking                                   | checked when it starts (or fails), again once if its input changes: `allow` reported; `ask` reported + a **hold**; `deny` stops the Steward (`agent.failed(runtime)` with the reason; not counted)                                             |
| `session/update` `current_mode_update` / mode `config_option_update`        | a switch away from the expected mode (`acp.mode`, else the mode at start) is a **hold**; allowed, the new mode is expected                                                                                                                     |
| a hold                                                                      | the turn is cancelled and `agent.needs_input(permission)` asks whether the agent may go on — no `agent.idle` meanwhile; allowed → a new turn ("carry on"), refused → stopped as for `deny`, interrupt → `agent.idle`                           |
| `elicitation/create` (form)                                                 | one `agent.needs_input(clarification)` per field; answered `accept` with typed values (re-asked up to three times when a number or yes/no does not read), `cancel` on interrupt/stop; URL mode → `decline`                                     |
| —                                                                           | pause/resume: SIGSTOP/SIGCONT on the process group                                                                                                                                                                                             |

**Translating tool calls for the gate** (`mapping.ts`, `gateCall`): the policy engine speaks
Claude Code's tool names, so an ACP call is mapped by its `kind` and raw input: `execute` +
command → `Bash {command}` (a `["bash","-lc",script]` argv keeps its script), `read` → `Read`,
a `cwd`/`workdir` becomes `cd '<dir>' && …`; `read` → `Read`, `edit` → `Edit` on the path,
`delete` → `Bash rm -r -- '<path>'` (destructive, and outside the workspace when it is), `move` →
`Edit` with both paths, `search` → `Glob` (its pattern located) unless plainly a content search
(`Grep`), `fetch` → `WebFetch`. Every distinct path a call names (path fields, a `paths` list,
every location) is judged (`paths` array), the strictest winning. A call that cannot be placed
keeps a name the engine does not know (`acp:<kind>`), so the table's `unclassified` entry decides
it (`ask` unless trusted; a push mentioned in its input or title still asks). `think` is
bookkeeping: no gate, no `agent.tool_call`; a `switch_mode` call run without asking is a hold
unless it names the expected mode. A call already judged when it started is checked with
`reserve: false` when the agent then asks about it: counted once.

Brains do not run on ACP (their server tools would need an MCP bridge): a spawn with `tools` is
refused, and `bare` too. The fake ACP agent (`node acp/fake-acp-agent.mjs [--state dir]
[--no-load] [--no-cost] [--mode <id>] [--config-modes]`) picks a scenario from `scenario:<name>` in
its first prompt (`happy`, `asks`, `permission`, `long`, `echo`, `stalls`, `unasked`, `switches`,
`rewrites`, `failsUnasked`, `startsThenAsks`, `form`, `error`, `refusal`, `dies`) and echoes later
prompts; `--mode` gives it session modes (`default`, `plan`, `acceptEdits`, `bypassPermissions`),
`--config-modes` offers them as a `mode` config option.

## The PTY adapter (`pty/`, P8-08; TECHNOLOGY §3.3)

Any command-line agent with no machine protocol, run under a pseudo-terminal (`node-pty` 1.1.0,
MIT) and read like a person reads its screen. Configured as `pty: {command, args?, passEnv?,
idlePattern?, questionPatterns?, clarificationPatterns?, quietMs?, idleAfterMs?}` in `config.json` (or
`GALACTIC_PTY_COMMAND`); registered only then, and `node-pty` loads at the first spawn.

- **Process:** `ProcessSupervisor.adopt()` with the spec's `fork` hook (`pty-child.ts`, the only
  module that imports `node-pty`): the PTY behind the `ChildProcess` subset the supervisor uses,
  so launch intent, PID row, agent marker, graceful stop and group reaping are the usual ones. A
  fixed 120×32 terminal (`PTY_TERMINAL_SIZE` in the protocol). Environment: allow-list +
  `TERM`/`COLORTERM` + `pty.passEnv` (never `GALACTIC_*`).
- **Trust rule** (decision 112): before every spawn, every message and every clarification
  answer the gate is asked about `{toolName: 'pty:session', input: {command, cwd}}` with
  `reserve: false`; only `allow` (a table allowing unclassified calls: the trusted preset) runs it.
  Refused later, the agent ends: `agent.failed(runtime, TABLE_NO_LONGER_ALLOWS)`.
- **Turns:** the first prompt (for a Steward, its role instructions ahead of the task — the CLI
  reads them as ordinary input, not as a system prompt) and every message are typed as one line
  - Enter once the CLI is ready; `oneLine()` turns newlines into spaces and drops every other
    control character. A line over 1000 bytes goes through a 0600 file in `<cwd>/.galactic/pty/`
    (`Read your instructions from <path>`); `{promptFile}` in `args` passes the first prompt that
    way. After `quietMs` of silence the cursor's line is read (`detect.ts`): `idlePattern` →
    `agent.idle`; any question → `agent.needs_input(permission)` **without a tool call** (fail
    closed: only the user answers it; on a yes/no prompt allow types its yes token, anything else
    its no; on a free-form one allow presses Enter, anything else interrupts), unless a
    `clarificationPatterns` regex matched → `clarification`, its answer typed. `idleAfterMs` ends a
    turn on silence. A question the CLI moved on from is answered without typing.
- **Output:** raw bytes as `agent.output(kind: 'terminal')` (batched ≈100 ms / 8 KB) for the
  panel's xterm.js view, and the stripped text (`terminal-text.ts`) as `text` blocks; the first
  line of a turn and one every 30 s as `agent.progress`.
- **Ends:** exit 0 → `agent.finished` (last lines as result); other code → `agent.failed(runtime)`;
  signal → `agent.failed(crash)`. No cost. No `resumeSession`: the user's recover restarts it
  from its first prompt.
- **Controls:** interrupt = Ctrl-C (turn ends at the idle prompt, or quiet without one, ≤ 3 s);
  pause = SIGSTOP/SIGCONT; stop hook = Ctrl-C, turn end, Ctrl-D, then SIGTERM/SIGKILL;
  `input(sessionId, text)` types a line now (the Mac's own browser only, logged as the user's
  message, redacted); typed while idle it opens a turn.

The scripted terminal agent `pty/fake-pty-agent.sh` (bash; `fixture> ` prompt; scenarios `happy`,
`asks`, `permission`, `long`, `echo`, `stalls`, `movesOn`, `env`, `fails`, `aider`, `spinner`,
`size` from `scenario:<name>` in the first line; `--prompt-file <path>` and `Read your instructions
from <path>` lines are understood; `FAKE_PTY_CLARIFICATIONS` lists its free-form questions) drives `pty/pty.conformance.test.ts` in CI with `toolCalls: false`,
`permissionEvidence: 'deleted build'`, the trusted `spawnPolicy`, and the optional `policyDeny` and
`toolCalls` cases skipped.
