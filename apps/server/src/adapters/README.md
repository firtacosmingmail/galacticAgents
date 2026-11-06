# Adapters — how to add a runtime

An adapter turns one agent runtime (the Claude Agent SDK, ACP agents, terminal CLIs) into the
server's one event vocabulary and the one control surface. It is a **translator, not a
scheduler**: the runtime layer (`apps/server/src/runtime/`) owns the per-agent inbox, the hard
caps, the permission policy, the event log, the status store and the transcript pipeline. An
adapter never imports from `domain/` or `runtime/` except the process supervisor and
`lib/event-queue.ts`, and nothing outside `adapters/` imports a runtime SDK (CLAUDE.md).

Six adapters exist: `fake/` (scripted scenarios, the reference implementation and the CI
target; in development mode also standing in for `codex` and `agy`, P11-10), `claude-sdk/` (the real one for Claude Code), `codex/` (OpenAI's Codex CLI over
`codex app-server`, P11-04), `agy/` (Google's Antigravity CLI behind a fail-closed hook, P11-05), `acp/` (any Agent Client Protocol agent, P8-07) and `pty/` (any
command-line agent under a pseudo-terminal, P8-08). Read `fake/fake-adapter.ts` first: every rule below is visible there in forty lines per
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
| `commands?(sessionId)`                   | The session's slash commands (P8-13), normalised with `normalizeSlashCommands`: the runtime's last report, kept per session, `[]` until one and for an ended or unknown session; never throws. Runtime state, never an event. Absent when the runtime has none (PTY).                                                                                      |
| `events`                                 | One `AsyncIterable<AgentEvent>` for every session of the adapter (`lib/event-queue.ts` is the usual implementation). The only source of `agent.*` events for its sessions.                                                                                                                                                                                 |
| `dispose()`                              | Stop every session, close the stream.                                                                                                                                                                                                                                                                                                                      |

`SpawnOptions` also carries `role` (`steward` runs with the repository's context; a brain gets
its own `systemPrompt` and `tools`), `caps` (informational — the runtime enforces them) and the
**permission gate** (below). `bare` is an opt-in that skips repository context and the
subscription login; refuse it when the runtime cannot honour it.

`launchFlags` (P12, SPEC decision 151, TECHNOLOGY §3.9) are catalogued launch flags
(`LAUNCH_FLAGS` in `packages/protocol/src/launch-flags.ts`; today only `chrome`) the user
approved for this Steward. The runtime has already checked them — a Steward only, the flag lists
this runtime, an approved `launch` record names the same set — so an adapter only applies them:
the Claude adapter passes each as a CLI flag through `extraArgs` via its own `SDK_FLAG_ARG` table
(`chrome` → `{ chrome: null }`, merged with `bare`'s `{ bare: null }`) and turns every catalogued
flag a session was not started with off (`{ 'no-chrome': null }` — brains included), so a
user setting cannot hand a flag's tools to an unapproved session; the fake adapter records them (`launchFlagsOf`); an
adapter whose runtime the catalogue does not list never receives any. A resumed session gets the
same flags. How a flag reaches a runtime is known only here: nothing outside `adapters/` builds
`extraArgs`. The flag's tools still go through the gate like any call: the gate answers `ask` for
them (and `deny` to an agent not started with the flag) and the runtime's scope watch decides, so a hook-based adapter must turn that `ask` into a
`canUseTool` round-trip (the Claude adapter's `PreToolUse` hook does), never into an allow.

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
Sessions run with isolated settings: `session/new` / `session/load` carry
`_meta.claudeCode.options.settingSources: []` (and `allowDangerouslySkipPermissions: false`), so
`claude-agent-acp` loads none of the user's or the repository's Claude settings; `acp.userSettings`
lifts it, `acp.sessionMeta` adds `_meta` for other agents (decision 108 amendment).

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

| ACP                                                                         | Adapter                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` → `session/new {cwd, mcpServers: []}` → first `session/prompt` | `spawn` (a failure before the first prompt throws; the runtime reports it)                                                                                                                                                                                              |
| `session/prompt` and its response                                           | `send` (one prompt per turn) → `agent.idle` with the running cost; a stop reason other than `end_turn`/`cancelled` is a transcript line; an error response is a transcript line + `agent.idle`                                                                          |
| `session/update` `agent_message_chunk` / `agent_thought_chunk`              | joined into one `agent.output` per block (`text` / `thinking`)                                                                                                                                                                                                          |
| `session/update` `tool_call` / `tool_call_update`                           | merged per `toolCallId`; `agent.tool_call` when it runs (after the gate); its result as `agent.output(kind: tool)`                                                                                                                                                      |
| `session/update` `plan`                                                     | `agent.progress{summary, progress}`                                                                                                                                                                                                                                     |
| `session/update` `usage_update.cost`                                        | the session's dollars (cumulative, USD only)                                                                                                                                                                                                                            |
| `session/update` `notice`                                                   | a transcript line; other updates (modes, commands, replay of our prompt) are ignored                                                                                                                                                                                    |
| `session/cancel`                                                            | `interrupt` (pending permission/elicitation requests answered "cancelled" first)                                                                                                                                                                                        |
| `session/load` (capability `loadSession`)                                   | `resumeSession("acp:<sessionId>")`; the replay during the load is not transcript; without `loadSession` the resume fails and the agent stays `interrupted`                                                                                                              |
| `session/request_permission`                                                | **permission-kind**: the call is translated (`gateCall`) and checked once — `allow` → `allow_once` + `agent.tool_call`, `deny` → `reject_once` + "permission denied" line, `ask` → `agent.needs_input(permission)`; never an `*_always` option                          |
| a tool call the agent runs without asking                                   | checked when it starts (or fails), again once if its input changes: `allow` reported; `ask` reported + a **hold**; `deny` stops the Steward (`agent.failed(runtime)` with the reason; not counted)                                                                      |
| `session/update` `current_mode_update` / mode `config_option_update`        | a switch away from the expected mode (`acp.mode`, else the mode at start) is a **hold**; allowed, the new mode is expected                                                                                                                                              |
| a hold                                                                      | the turn is cancelled and `agent.needs_input(permission)` asks whether the agent may go on — no `agent.idle` meanwhile; allowed → a new turn ("carry on"), refused → stopped as for `deny`, interrupt → `agent.idle`                                                    |
| `elicitation/create` (form)                                                 | one `agent.needs_input(clarification)` per field — several fields at once as one question set (P8-20); answered `accept` with typed values (re-asked alone, up to three tries, when a number or yes/no does not read), `cancel` on interrupt/stop; URL mode → `decline` |
| —                                                                           | pause/resume: SIGSTOP/SIGCONT on the process group                                                                                                                                                                                                                      |

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

## The Codex adapter (`codex/`, P11-04; TECHNOLOGY §3.6)

Stewards of the `chatgpt` provider, on the Codex CLI with the user's ChatGPT login, over
`codex app-server` (JSON-RPC 2.0, one JSON object per line on stdio; `rpc.ts`). Message shapes are
P11-01's (`docs/tasks/notes/P11-01-provider-spikes.md`, the transcripts in `codex/fixtures/`).
Registered when `codex.command` is in `config.json` or `codex` is on the `PATH`. Stewards only (a
brain or a `bare` spawn is refused); `canPublish: true`.

- **Process**: one `codex app-server` per session through `ProcessSupervisor.adopt()`, with
  `APP_SERVER_ARGS` (`--disable` plugins, apps, image_generation, browser_use, computer_use and
  hooks; `-c web_search="disabled"`); environment = allow-list + `CODEX_HOME` = Mission
  Control's own Codex home (`home` option; production `<data dir>/codex-home`, ruling R7: its
  `config.toml` written by Mission Control, no `mcp_servers`; its `auth.json` a symlink to the
  user's login file, never read — a regular file in its place (a login Codex refreshed by
  write-and-rename) is renamed over the user's own `auth.json`, unread, and relinked (ruling R27,
  replacing R9's delete: that file may hold the only valid rotated refresh token; a failed rename
  refuses the start and deletes nothing; not yet observed with a real refresh);
  preflight says `not_logged_in` when the login file is absent). `initialize`
  (`experimentalApi: true`) → `thread/start` with `SAFE_THREAD_CONFIG` (`approvalPolicy:
"untrusted"`, `approvalsReviewer: "user"`, sandbox `workspace-write`, network off, web search,
  MCP servers, apps/plugins, image generation off), the model, the Steward's `systemPrompt` +
  `ASK_USER_NOTE` as `developerInstructions`, the server's tools + `ask_user` as `dynamicTools`
  (kept with the thread: `thread/resume` carries none, a resumed thread still has them) →
  `turn/start` (repeats the
  policy, `sandboxPolicy.networkAccess: false` and the model).

| app-server                                   | Adapter                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `item/commandExecution/requestApproval`      | `Bash {command}` (the script unwrapped from `/bin/zsh -lc '…'`; `cd '<dir>' &&` when it runs elsewhere) through the gate                                                                   |
| `item/fileChange/requestApproval`            | `Edit {file_path}` per path of the `fileChange` item started before it (a deletion: `rm -- '<path>'`); first check reserves, every path must be allowed; one question for the whole change |
| `item/permissions/requestApproval`           | network alone: `codex:network` (the `network` category); anything else: `codex:permissions` (the `unclassified` entry); granted for the turn only, refused as `{permissions: {}}`          |
| gate `allow` / `deny` / `ask`                | `accept` + `agent.tool_call` / `decline` + a transcript line / `agent.needs_input(permission)`, answered when `answer()` comes (no timeout); withdrawn by an interrupt or stop: `cancel`   |
| `mcpServer/elicitation/request`              | `decline`, always (MCP is off)                                                                                                                                                             |
| `item/tool/call`                             | a server tool by its bare name: gate (allowed as a server tool), handler, `{contentItems: [{type: inputText, text: <JSON>}], success}`; unknown tool or handler error → `success: false`   |
| `item/tool/call` `ask_user`                  | the adapter's own question tool (ruling R6): `agent.needs_input(clarification)` with `{text: question, options?}`, no gate, no `agent.tool_call`; the answer is the result                 |
| `item/tool/requestUserInput`                 | `agent.needs_input(clarification)` per question (several: one question set); answers by question id (Codex sends it in plan mode only)                                                     |
| `item/started` `mcpToolCall`                 | `agent.tool_call` `mcp__<server>__<tool>` for the log and the cap — run by Codex without asking (below), never reported as approved                                                        |
| `item/completed`                             | one `agent.output` per item: message (`text`), reasoning summary (`thinking`), command output / files changed / MCP result (`tool`); deltas ignored                                        |
| `turn/plan/updated`                          | `agent.progress`                                                                                                                                                                           |
| `turn/completed`                             | `agent.idle` (a failed turn's error first as a line); `turn/interrupt` is `interrupt()`                                                                                                    |
| `error` `codexErrorInfo: usageLimitExceeded` | `account/rateLimits/read` → `agent.failed{reason: 'limit', error: 'ChatGPT usage limit reached', resetsAt}`, the one terminal event                                                        |
| `thread/resume`                              | `resumeSession("codex:<threadId>")` in a new process, same settings                                                                                                                        |
| —                                            | pause/resume: SIGSTOP/SIGCONT on the process group; no cost (a subscription)                                                                                                               |

Never `acceptForSession`, never an execpolicy or network amendment. `preflight()` runs `codex
--version` (a version outside `KNOWN_CODEX_VERSIONS = '>=0.166 <0.200'` is a warning) and `codex
login status` (logged out: `not_logged_in`, "Run codex login in Terminal"; an API key:
`not_subscription`); `models()` (`model/list`) and `usage()` (`account/rateLimits/read` +
`account/read`) each run a short-lived app-server outside the supervisor. `~/.codex/auth.json` is
never read.

**`node_repl` and the user's MCP servers (rulings R5, R7).** Codex runs an MCP tool marked
`readOnlyHint` with no approval request under `untrusted`, and no thread `config` or `-c` override
removes a server the user's `~/.codex/config.toml` declares (here `node_repl`, tool `js`, written
by the ChatGPT desktop app). The managed Codex home is the fix: run with it, the server list is
empty and the model has no `js`. Any `mcpToolCall` is still reported as `agent.tool_call`, never
as approved.

The fake CLI (`node codex/fake-codex-agent.mjs [--state dir] [--record file] <subcommand>`)
answers `--version` (`FAKE_CODEX_VERSION`), `login status` (`FAKE_CODEX_LOGGED_OUT=1`,
`FAKE_CODEX_LOGIN_TEXT`) and `app-server`; `--record` writes its argv and every client message.
Its first prompt picks a scenario (`happy`, `asks`, `asks-set`, `permission`, `long`, `echo`,
`stalls`, `tool`, `elicit`, `asks-input`, `limit`, `limit-dies`, `error`, `file`, `perms`, `unasked`, `dies`, or
`replay-<fixture>` to replay a P11-01 transcript); later prompts are echoed. It drives
`codex/codex.conformance.test.ts` in CI; `codex/codex-real.conformance.test.ts` runs with
`GALACTIC_REAL_CODEX=1`, local-only.

## The Antigravity adapter (`agy/`, P11-05; TECHNOLOGY §3.7)

Stewards of the `gemini` provider, on Google's Antigravity CLI (`agy`) with the user's Google
login, driven headless: `agy -p <prompt> --output-format stream-json --disable-slash-commands
--print-timeout 0s [--model m] [--conversation id]`, never `--dangerously-skip-permissions`.
Shapes are P11-01's (`docs/tasks/notes/P11-01-provider-spikes.md`, agy 1–8, the transcripts in
`agy/fixtures/`); its Ruling puts agy in full-tool mode. Registered when `agy.command` is in
`config.json` or `agy` is on the `PATH`. Stewards only (a brain or a `bare` spawn is refused);
`canPublish: false` (no publishing step on agy in this phase).

- **One process per turn** (`ProcessSupervisor.adopt()`; agy has no in-band control channel):
  the first turn's `init` gives the conversation id (`sessionRef` = `agy:<id>`), later turns and
  `resumeSession` continue it with `--conversation`. The process exiting ends the turn
  (`agent.idle`). `interrupt()` = SIGINT to the group (SIGKILL after `graceMs`), pause =
  SIGSTOP/SIGCONT (an idle session has no process: pause only holds its messages), stop = the
  supervisor's graceful stop. Environment: the allow-list + `HOME`, `GALACTIC_AGY_SECRET` (a
  random per-session secret) and `GALACTIC_AGY_URL` (the bridge), which agy passes to its hook
  and MCP processes. agy has no system-prompt flag: the Steward's `systemPrompt` and
  `ASK_USER_NOTE` lead the first prompt.
- **The managed global entries** (`global-entries.ts`): `--settings` cannot carry hooks or MCP
  servers and a workspace `.agents/` file is agent-writable, so the adapter adds one entry keyed
  `galactic` and tagged `"galactic": true` to `~/.gemini/config/hooks.json` (PreToolUse, matcher
  `*`, `timeout: 86400`, the hook script) and to `~/.gemini/config/mcp_config.json` (the tool
  server script), at the first spawn, and removes only those on `dispose()`. The scripts are
  copied to the adapter's `stateDir` (production `<data dir>/agy`) first. Writes are atomic;
  every other entry stays; when a file is unchanged since Mission Control's write, removal puts
  back its exact original bytes (or deletes a file that was absent) — the originals are kept in
  `<stateDir>/global-entries.json`. A file that is not JSON, or a `galactic` key without the tag,
  is never touched: the spawn is refused (the preflight says why). Both scripts pass through
  when `GALACTIC_AGY_SECRET` is absent, so the user's own `agy` runs see no hook decision
  (`allow`) and no tools.
- **The hook bridge** (`hook-bridge.ts`, `galactic-agy-hook.mjs`, `http/agy-hook-routes.ts`):
  the hook POSTs agy's payload to `POST /api/agy-hook` (loopback only, never through a proxy;
  `x-galactic-hook: <secret>`; a long poll, the hook having no timeout of its own) and prints the
  decision: the bridge's `allow` as agy's `auto_approve` (a plain `allow` still lets agy's
  headless permission check refuse, P11-01 agy 2), `deny` with its reason. **Fail closed**: an
  unknown secret, a non-200 answer, Mission Control unreachable (after waiting up to 15 s for a
  server that is still starting), output that is not a decision → `{"decision":"deny"}`; agy
  itself denies when the hook times out, crashes or prints garbage (P11-01 agy 3). The hook
  never answers `ask` or `force_ask`.

| agy tool (hook name)                                    | Hook / gate                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `run_command {CommandLine, Cwd?}`                       | `Bash {command}` (`cd '<dir>' &&` when `Cwd` is elsewhere) through the gate                                                          |
| `read_file`/`view_file {Path}`                          | `Read {file_path}`, or `WebFetch {url}` for a URL; a `galactic` tool's descriptor or agy's built-in skills: allowed without the gate |
| `write_file`/`write_to_file`, `edit_file`/`replace_…`   | `Write`/`Edit {file_path}`; a path under `.agents/` or `.gemini/` is denied without asking                                           |
| `list_dir`, `find_by_name`, `grep_search`               | `LS`, `Glob`, `Grep` with the path                                                                                                   |
| `search_web`, `read_url_content`                        | `WebSearch`, `WebFetch` (the `network` category)                                                                                     |
| `generate_image`                                        | `agy:generate_image` (the table's `unclassified` entry: an image costs a large share of the weekly quota)                            |
| `call_mcp_tool {ServerName: galactic, ToolName}`        | a server tool by its bare name (allowed as a server tool); `ask_user` without the gate; any other server: deny                       |
| `invoke_subagent`, `send_message`, `wait`, `finish`, …  | allowed, reported as `agent.tool_call` (a subagent's own calls reach the hook too)                                                   |
| browser tools, `ask_question`/`ask_permission`, unknown | deny (the question tools' reason points to `ask_user`)                                                                               |
| gate `allow` / `deny` / `ask`                           | `auto_approve` + `agent.tool_call` / `deny` + a transcript line / `agent.needs_input(permission)` until answered                     |

- **The tool server** (`tool-server.ts`, `galactic-agy-tools.mjs`): a stdio MCP server that
  forwards `tools/list` and `tools/call` to `POST /api/agy-hook/tools|call` with the secret. It
  lists the session's server tools and `ask_user {question, options?}` (ruling R6: agy's own
  question tools cannot ask anyone headless); a call runs only after the hook let a
  `call_mcp_tool` of that tool through (one pass per allowed call). `ask_user` becomes
  `agent.needs_input(clarification)` and its answer is the result.
- **Images** (`images.ts`): the image files new in
  `~/.gemini/antigravity-cli/brain/<conversationId>/` since the turn's `init` are copied into
  `<cwd>/generated-images/` (never overwriting) before the turn's end is reported.
- **Limits** (`limits.ts`): exit 3 with an `AGY_ERROR` in the quota's words (or a final `result`
  with `status: ERROR` and such an error) → `agy -p /usage --output-format json` →
  `agent.failed{reason: 'limit', error: 'Gemini usage limit reached', resetsAt}` (an exhausted
  bucket's reset, else the model group's), the one terminal event.
- **Refusals at spawn**: a worktree (or a folder above it) holding `.agents/hooks.json` or
  `.agents/mcp_config.json` — it could approve calls or start servers before the hook sees them.

- **Fix round 1 (P11-05 review):**
  - A call whose expected argument is missing is denied, never judged as if it named the worktree. Examples: a read or search with none of the known path keys, a `run_command` without `CommandLine`, a web search without a query. Every path key a call names goes to the gate (`paths`).
  - Writes into `.agents/`/`.gemini/` are judged on the real path too, so a link into one is denied.
  - The workspace `.agents/` check runs before **every** turn. Each turn is a new agy process that reloads those files, so a file that appears mid-session ends the session with `agent.failed{reason: 'runtime'}`. A symlink there counts too.
  - A tool-server pass is bound to the exact call (tool and canonical arguments).
  - The image copy follows no symlink at either end.
  - The global files are written through a symlink and keep their mode.
- **agy's MCP deadline (ruling R12).** agy gives up on an MCP `tools/call` after **3 minutes** (`context deadline exceeded`, measured in a real probe). So `ask_user` holds its call for at most 150 s (`askHoldMs`). After that it returns "The user has not answered yet… end your turn now"; the question stays open, and so does the turn (no `agent.idle`). The answer, or a dismissal's text, becomes the prompt of a new agy run in the same conversation. An interrupt or a stop withdraws it. This was verified with the real CLI. A second `ask_user` while one holds or waits is refused ("A question is already waiting…"), never replacing the first.
- **Several PreToolUse hooks.** A real probe placed a user hook group answering `auto_approve` to everything both before and after Mission Control's. Mission Control's `deny` won both times and the command did not run, so a user's own hooks cannot approve what the gate refused.
- **Probes.** `agy/agy-real.probes.test.ts` (`GALACTIC_REAL_AGY_PROBES=1`) re-runs the hook-combination, MCP-deadline and deferred-question probes. The real conformance target skips the policy-deny case (ruling R11): after a deny, Gemini explores outside the workspace and each read rightly asks.

`preflight()` runs `agy --version` (outside `KNOWN_AGY_VERSIONS = '>=1.4.12 <1.5'`: a warning)
and `agy -p /usage --output-format json` (no turn; "Authentication required" or a failure:
`not_logged_in`, "Run agy in Terminal and sign in with your Google account"), plus the global
entries' check; `models()` parses `agy models` (`gemini-*`: `['text', 'image']`, else `['text']`;
the family from the id's prefix); `usage()` reads `/usage` (one window per bucket, "Gemini Models ·
weekly"). No credentials are read; no cost (a subscription).

The fake CLI (`node agy/fake-agy.mjs …`) reads its hooks and MCP server from
`$HOME/.gemini/config` like agy, runs the hooks (fail closed) and the real tool server, and keeps
conversations under `$HOME`. Its first prompt picks a scenario (`happy`, `asks`, `permission`,
`long`, `echo`, `stalls`, `tool`, `image`, `limit`, `limit-result`, `write-config`, `browser`);
later prompts are echoed. Environment: `FAKE_AGY_RECORD`, `FAKE_AGY_VERSION`,
`FAKE_AGY_LOGGED_OUT=1`, `FAKE_AGY_USAGE_EXHAUSTED=1`. It drives `agy/agy.conformance.test.ts` in
CI; `agy/agy-real.conformance.test.ts` runs with `GALACTIC_REAL_AGY=1`, local-only (it adds and
removes the entries in the real `~/.gemini/config`).

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
