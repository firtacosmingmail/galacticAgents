# P8-07 — ACP adapter (Codex / Gemini CLI / claude-agent-acp)

Branch `p8-07-acp`, from `p8-wave3-pids-push-acp` (368057c). 2026-10-06. TECHNOLOGY §3.2 (updated
with what was built), `apps/server/src/adapters/README.md` ("The ACP adapter").

## What was built

- **`apps/server/src/adapters/acp/`** — the `acp` runtime: GalacticAgents as an Agent Client
  Protocol *client* over stdio JSON-RPC, with the official TypeScript SDK.
  - `acp-adapter.ts`: the `AgentAdapter` (one agent process per session, through the supervisor).
  - `mapping.ts`: the pure translations (ACP tool call → the gate's call, permission option choice,
    form fields → clarification questions, plan → progress, the cost meter), unit-tested.
  - `preflight.ts`: the runtime check (the command on the `PATH`, the SDK version).
  - `fake-acp-agent.mjs` (+ `fake-agent.ts`, its path): a scripted ACP agent, no network, built on
    the SDK's agent side; asserts the client capability set; persists sessions so a new process can
    `session/load` them.
- **Registration:** `index.ts` registers the adapter when `acp.command` is configured
  (`config.json`: `"acp": {"command": "gemini", "args": ["--acp"], "passEnv": ["GEMINI_API_KEY"]}`,
  or `GALACTIC_ACP_COMMAND="codex-acp"`). Unconfigured, nothing changes.
- **Runtime selection:** a new `stewardRuntime` setting (protocol `Settings` / `SettingsPatch` /
  `SettingName`; `config.json`, `GALACTIC_STEWARD_RUNTIME`; the settings page's "Steward runtime"
  section after Budgets), read at every Steward spawn by the Harmonizer's and the Waykeeper's tools
  through `BrainToolContext.stewardRuntime` (compose option → runner → tool context). Absent = the
  spawning brain's own runtime (the old behaviour). Only a registered runtime is accepted (409
  `invalid` naming the available ones); local requests only (decision 51). The ops console's
  free-form spawn form already offers every registered runtime per spawn (`GET /api/runtimes`), so
  the per-spawn override needed no change.

## SDK

`@agentclientprotocol/sdk` **1.7.0**, license **Apache-2.0** (author Zed Industries; repository
`github.com/agentclientprotocol/typescript-sdk`), peer dependency `zod ^3.25 || ^4` (we have 4).
ACP protocol version 1. The adapter uses the current `client()` builder API (`ClientSideConnection`
is deprecated in 1.7); the fake agent uses `agent()`. The `@zed-industries/agent-client-protocol`
package (0.4.5, last published 2025-10) is the old name.

## The client capability set

`initialize` sends `clientCapabilities: {elicitation: {form: {}}}` and nothing else:

| Capability | Advertised | Why |
| --- | --- | --- |
| `elicitation.form` | yes | the only way an ACP agent asks the user a question |
| `elicitation.url` | no | nothing can open a URL for the user |
| `fs.readTextFile` / `fs.writeTextFile` | no | the agent reads/writes with its own tools in its cwd (the worktree); serving editor buffers faithfully is out of scope |
| `terminal` | no | the agent runs commands itself; its tool calls still reach the gate |
| `plan`, `session.*`, `subagents`, `auth.terminal`, `nes` | no | not needed; no interactive login |

Decision: **not advertising `fs/*` and `terminal/*`** is the simplest correct choice — implementing
them would put the server between the agent and the disk and duplicate its tools, for no gain in
control (every call is still reported as a tool call and gated). The fake agent refuses a client
that advertises them (tested).

## Design decisions

1. **One process per session, through `ProcessSupervisor.adopt()`** — like the Claude CLI: own
   process group, PID table row, `GALACTIC_AGENT_ID`, graceful stop. stdout feeds a web
   `ReadableStream` (the supervisor already reads the pipe), stdin is written through
   `ManagedProcess.write`. The supervisor's interrupt hook sends `session/cancel`, waits for the
   turn's end, then closes stdin (the agent exits on EOF) before any SIGTERM. Startup
   (`initialize` → `session/new|load`) is raced with the process's exit and a 60 s timeout; a
   failure kills the group and throws without events (the runtime logs `agent.failed(runtime)`
   or, on a resume, `agent.interrupted`). A missing cwd is refused before forking.
2. **A job ends in `agent.idle`** (`jobEnd: 'idle'`), like the SDK: an ACP session is long-lived.
   `agent.finished` only when the agent process exits cleanly on its own.
3. **Per-block output:** message and thought chunks are joined until the block ends (another kind,
   a tool call, a plan, a question, the turn's end, a pause).
4. **Permission requests are checked once by the adapter** (`gate.check`, which also reserves the
   call against the tool-call cap — TECHNOLOGY §3.1 says an adapter without a hook must), then the
   runtime's `decide()` sees the same verdict: `allow`/`deny` are answered at once (`allow_once` /
   `reject_once`), `ask` becomes the user's permission card with the call attached and the policy
   category. **Never an `*_always` option** while a `*_once` exists: an "always" lets the agent skip
   asking next time, and every call must reach the gate (the fake agent fails a turn answered
   `allow_always`).
5. **Tool calls in the gate's vocabulary** (`gateCall`): the engine speaks Claude Code tool names,
   so ACP kinds are mapped (`execute`+command → `Bash`, with `cd '<dir>' && ` for a `cwd`,
   `read` → `Read`, `edit` → `Edit`, `delete` → `Bash rm -r -- '<path>'`, `move` → `Edit` with both
   paths, `search` → `Glob` unless plainly a grep, `fetch` → `WebFetch`); every distinct path is
   judged (the engine reads a `paths` array); what cannot be placed stays unclassified
   (`acp:<kind>`) and so asks unless trusted — never made to look safer; the engine adds `push`
   when an unknown tool's input or title mentions one. The original kind and title travel along
   in the input (`acp: {kind, title}`) for the card. `think` is bookkeeping (no gate, no
   `agent.tool_call`).
6. **Calls the agent runs without asking** are judged when they start (decision 108, as amended
   after the review): `ask` → a hold (turn cancelled, permission card, no idle until answered;
   refused → stopped), `deny` → the Steward stopped as `agent.failed(runtime)` with the reason.
   Judged on `failed` too, once more if the input changes, reserved against the cap once. Session
   modes: `acp.mode` is set at start, a known permissive mode is refused unless
   `acp.allowPermissiveMode`, a switch away from the expected mode is a hold.
7. **Form elicitation → one clarification per field**, required fields first; enum/`oneOf` →
   options matched back to values, boolean → yes/no, numbers parsed (an unreadable answer is asked
   again, up to three times, then `decline`), multi-select comma-separated. Interrupt/stop →
   `cancel`; URL mode → `decline`.
8. **Resume** = `session/load` when the agent advertises `loadSession` (`sessionRef` =
   `acp:<id>`); the replay the agent sends during the load is dropped; the runtime's resume prompt
   is the first turn. Without `loadSession` the resume throws and the agent stays `interrupted`
   with the restart action — the PTY rule (TECHNOLOGY §3.3).
9. **Cost:** dollars = the latest `usage_update.cost.amount` (cumulative per session per the
   schema; USD only), tokens = the sum of every prompt response's `usage` (incl. cached and thought
   tokens). Nothing reported → no `cost` → "cost not reported" in budgets (P8-01).
10. **Ordering fix:** the SDK resolves a response synchronously but runs notification handlers
    through an async chain, so the last `session/update`s of a turn (its `usage_update`, its last
    chunks) arrived *after* the prompt's response in the first conformance run (cost missing on the
    idle). The adapter ends a turn one macrotask (`setImmediate`) after the response.
11. **Brains stay on the Claude SDK** (decision 109): the ACP adapter refuses a spawn with
    server `tools` (they would need an MCP bridge) and `bare` (a Claude notion). A Steward's
    `systemPrompt` is put before its first prompt.
12. **Environment:** the supervisor's allow-list plus `ACP_PASS_ENV` (routing only: base URLs,
    the Bedrock/Vertex switches, region, profile) plus `acp.passEnv`. Every credential
    (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*` tokens and keys, `GEMINI_API_KEY`, `GOOGLE_*`
    credentials, `OPENAI_*` keys) must be named in `passEnv`; `GALACTIC_*` names are refused.
    `GALACTIC_ACP_COMMAND` takes a whitespace-split line or a JSON array of strings.

## SPEC decisions (recorded in §7 as 108 and 109)

Decision 108 was amended after the wave 3 review (conservative judging: modes, holds, stops); the
text in SPEC §7 is the reference. 109 as recorded:

> **decision 109 — Which runtime Stewards run on.** The settings name the runtime new
> Stewards run on ("Steward runtime": same as their brain — the default —, Claude Code, or an ACP
> agent such as Codex, Gemini CLI or claude-agent-acp, once one is set up in `config.json`). It
> applies to the next Steward a Waykeeper or the Harmonizer starts; running Stewards keep theirs.
> The Harmonizer and Waykeepers always run on Claude Code (their tools are the server's). The ops
> console can start a single agent on any set-up runtime. An ACP agent that cannot resume
> sessions is shown interrupted after a restart, with its restart action.

## Conformance results

`describeAdapterConformance` against the fake ACP agent (`acp/acp.conformance.test.ts`, in CI):
**23/23 green** — every case runs (none skipped): spawn → output/tool call → idle with cost,
clarification, permission allow, pause/resume, interrupt with queued messages (gamma, alpha,
beta), echo while idle, stop from working/waiting/paused/idle, permission deny, policy deny, one
`tool_call` per tool use (and `caps.toolCalls.used` matching), interrupt while paused, interrupt
with a question open (cancelled), send while paused, crash (`SIGKILL` to the group →
`failed(crash)`), spawn in a missing cwd (`ok: false`, one `failed(runtime)`), two sessions at
once, resume from an invalid / a missing ref, resume after the adapter went away (the question
asked again), stall detection. Stable over repeated runs (×4 locally).

Optional capabilities per the interface: `resumeSession` is present; it fails (agent stays
`interrupted`) for an agent without `loadSession` — tested in `acp-adapter.test.ts`. A real
non-resumable agent runs the suite with `GALACTIC_REAL_ACP_RESUMABLE=0`.

## Real-runtime check

**Not run: no real ACP runtime is installed on this machine.** `claude-agent-acp`,
`claude-code-acp`, `codex-acp` and `gemini` are not on the `PATH`; `/opt/homebrew/bin/codex` is a
broken symlink (its Homebrew cask 0.104.0 is gone), and Codex's ACP mode is the separate
`codex-acp` anyway. Nothing was downloaded or logged in for this. To run it:

```
npm i -g @agentclientprotocol/claude-agent-acp     # 0.86.0 on npm today, Apache-2.0
GALACTIC_REAL_ACP="claude-agent-acp" pnpm --filter @galactic/server exec vitest run acp-real
```

(or `GALACTIC_REAL_ACP="gemini --acp"`, `"codex-acp"`). Still to confirm there: what each agent
reports for cost (`usage_update.cost`), whether it advertises `loadSession`, whether its question
tool uses form elicitation, and how its tool calls' `rawInput` looks to `gateCall` (an `execute`
whose command we cannot read stays unclassified and asks). The task's acceptance ("against one
real ACP runtime locally") is therefore **open**.

## Tests

- `acp/acp.conformance.test.ts`: 23 (the suite).
- `acp/acp-adapter.test.ts`: 18 — capability set (and the fake agent refusing fs/terminal), block
  joining + thinking, cost (one turn, cumulative over two, none reported), unasked calls (`ask` →
  warning, `deny` → turn cancelled), typed form fields with a re-ask, permission ask → allow
  (`allow_once`, one gate check), error turn, refusal stop reason, agent exiting mid-turn
  (`failed(crash)` once), resume with the replay ignored, resume without `loadSession`, unknown
  session, refused spawns (tools, bare, missing cwd), missing command, pause + interrupt while
  paused.
- `acp/mapping.test.ts`: 10 — `gateCall` per kind and judged by the real engine, unclassified
  fallbacks, `mergeTool`, `chooseOption`, `CostMeter`, `formFields`, `planProgress`,
  `toolResultText`, `resolveCommand`.
- Wave 3 review fixes: `mapping.test.ts` 16 (+ delete as `rm -r`, every path, Glob vs Grep, cwd,
  pushes in unreadable calls, modes); `acp-adapter.test.ts` 31 (holds allowed / refused /
  withdrawn, deny stops, `failed` judged, re-judge on changed input, cap counted once, modes:
  permissive refused / opted in / set via `set_mode` and the config option / unknown mode / no
  modes / a switch refused and allowed, `passEnv` defaults and `GALACTIC_*` refused);
  `config.test.ts` +1 (`acp.mode`, JSON command, `GALACTIC_*` refused).
- `acp/acp-real.conformance.test.ts`: skipped unless `GALACTIC_REAL_ACP`.
- `brains/steward-runtime.test.ts`: 2 — a fake-runtime Harmonizer's asteroid Steward runs on the
  ACP runtime (a real fake-agent process) when the setting says `acp`, and on `fake` when unset.
- `config/config.test.ts` +1, `config/settings.test.ts` +1, `protocol panel.test.ts` +1, web
  `settings.test.tsx` +1 (the Steward runtime section).

## Left / follow-ups

- The real-runtime run (above), and the facts it settles in TECHNOLOGY §3.2.
- Decisions 108 and 109 are recorded in SPEC §7.
- A resumed ACP session whose agent restarts its own cost tally is under-counted until it passes
  its earlier total (the spend fold keeps the highest figure per session).
- The fake ACP agent is not copied into `dist/` (it lives next to the sources; `fake-agent.ts`
  points at it), so trying the ACP runtime from a built install needs the source path.
- No MCP bridge, so brains cannot run on ACP; not planned.
