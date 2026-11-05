# Steward Launch Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Waykeeper can ask to start a Steward with a catalogued launch flag (first: `--chrome`). Cosmin approves the exact command and reason on a card, and while the Steward runs, every use of the flag's tools is checked against the Steward's approvals. The first off-script use pauses the Steward and asks Cosmin.

**Architecture:** A flag catalogue in `packages/protocol` names each flag, its runtimes and the tools that count as using it. The Waykeeper's `spawn_steward` opens a user-only `launch` question. A second call with the approved question id spawns the Steward with the flags, and the Claude adapter maps them to `extraArgs`. The permission gate returns `ask` for a flag's tools without consulting the policy table. The runtime intercepts those requests and runs an async **scope judge**: a one-shot model call implemented inside `adapters/claude-sdk`, with a scripted fake for tests. A consistent call is allowed and logged as decided by the Waykeeper. An off-script call becomes a user-held `permission` question with an `offScript` context. Approving it adds a precedent; stopping it denies the call and stops the Steward.

**Tech Stack:** TypeScript, zod, Fastify/ws, SQLite event log, Claude Agent SDK (`extraArgs`, one-shot `query`), React 19 panel, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-steward-launch-flags-design.md`

## Global Constraints

- Only catalogued flags can be requested. The first and only entry is `chrome`: CLI `--chrome`, runtime `claude-sdk`, label "controls your Chrome browser". The spike in Task 1 confirms its tools.
- Never in the catalogue: `--dangerously-skip-permissions`, `--permission-mode`, `--allowedTools`, `--mcp-config`, or any flag that changes permissions or tool configuration.
- Brains (Harmonizer, Waykeepers) never get launch flags.
- No LLM grants a flag or approves an action that is inconsistent with the Steward's approvals. The `launch` question and the off-script question are held and answered by the user only: no escalation, no supervisor answer, no "Allow similar" rule, no menu bar.
- Only calls to a flag's tools skip the policy table. Every other call of a flagged Steward goes through the table and rules unchanged.
- The scope check fails closed: an error, a malformed reply or a timeout (20 s) is treated as `off_script`.
- A held call never runs before its verdict.
- "Pause" means a held call. Never use `adapter.pause` (SIGSTOP) for this.
- Each approval covers one Steward, and a resumed Steward keeps its flags and precedents.
- Only one live Steward with `chrome` at a time.
- Nothing outside `apps/server/src/adapters` knows how a flag reaches a runtime. Shared types live in `packages/protocol`. Speculative fields go in `meta`.
- Answer labels exactly: launch `['Approve and start', 'Start without flags', 'Deny']`; off-script `['Approve and continue', 'Stop the Steward']`.
- Branch flow: the phase branch is `agent-launch-flags`. Each batch branches from it as `p12-<n>-<slug>`, and Cosmin merges. Commits are prefixed with the task id (`P12-03: …`).
- Gates before asking to merge: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.

## Review Focus

1. **The judge hangs or the network is down.** The call is held at most 20 s, then becomes an off-script card. The Steward is never left blocked forever, and the call is never allowed silently. Test in Task 6: `judge never settles → off-script question after 20 s (fake timers)`.
2. **An approved launch is replayed.** The Waykeeper calls `spawn_steward` twice with the same `launchApprovalId`, or uses it for another task. The second call is refused. Test in Task 8.
3. **The server restarts while an off-script card is open.** The question is cancelled by the existing restart path. The resumed Steward has the same flags and precedents and is told to retry. Test in Task 6: `resume keeps launch flags and precedents`.
4. **The Steward is stopped, or the user dismisses the off-script card.** Dismissal denies the call and never allows it, and the Steward is not left running with a stale held call. Test in Task 6.
5. **A Chrome tool call carries secrets in its input,** such as typed text or cookies. The judge receives the redacted call (`redactValue`) and so does the log. Test in Task 6: `judge sees redacted input`.

---

### Task 1: Phase file and Chrome spike (P12-01)

**Files:**
- Create: `docs/tasks/PHASE_12_LAUNCH_FLAGS.md` (purpose, references to the spec and this plan, design notes = Global Constraints, execution order, tasks P12-01 … P12-10 mirroring this plan's Tasks 1–10)
- Modify: `docs/tasks/README.md` (row for Phase 12; the order line gains `→ 12`)
- Create: `scripts/spikes/chrome-sdk-probe.mjs`
- Create: `docs/tasks/notes/P12-01-chrome-spike.md`

- [ ] **Step 1:** Write the phase file and README row. Claim P12-01 following the ticket flow. Commit `P12-01: start phase 12 and the Chrome spike`.
- [ ] **Step 2:** Write `chrome-sdk-probe.mjs`. It runs the SDK `query()` with `extraArgs: { chrome: null }`, a `canUseTool` that logs and allows, and the prompt "open http://localhost:<port> served by the script and take a screenshot". It prints every tool name and input shape it sees.
- [ ] **Step 3:** Run it locally with Chrome and the Claude in Chrome extension installed. Expected: at least one `mcp__claude-in-chrome__…` tool call reaches `canUseTool`.
- [ ] **Step 4:** Write the notes file. Include the exact tool names and the prefix to use in the catalogue, whether the calls reach `canUseTool` after a `PreToolUse` `ask`, what happens with two sessions at once, and how a screenshot gets into a GitHub PR comment (the upload path through the browser). End with a **Ruling** line: `go` or `stop`. On `stop`, end the phase there and report to Cosmin.
- [ ] **Step 5:** Commit `P12-01: done — Chrome spike (<ruling>)`.

### Task 2: Protocol (P12-02)

**Files:**
- Create: `packages/protocol/src/launch-flags.ts`, `packages/protocol/src/launch-flags.test.ts`
- Modify: `packages/protocol/src/enums.ts:79` (`QuestionKind` gains `'launch'`; doc comment: user-only like `spend`)
- Modify: `packages/protocol/src/domain.ts:538` (`QuestionContext` gains `launch: LaunchContext.optional()`, `offScript: OffScriptContext.optional()`)
- Modify: `packages/protocol/src/adapter.ts` (`SpawnOptions.launchFlags?: LaunchFlag[]`; `ScopeJudge` interface)
- Modify: `packages/protocol/src/commands.ts` (`SpawnAgentInput.launchFlags?: LaunchFlag[]`, `SpawnAgentInput.launch?: AgentLaunch`)
- Modify: `packages/protocol/src/index.ts` (export)

**Interfaces (Produces):**
```ts
export const LaunchFlag = z.enum(['chrome']);
export interface LaunchFlagSpec { cli: string; label: string; runtimes: readonly AgentRuntime[]; toolPrefixes: readonly string[] }
export const LAUNCH_FLAGS: Record<LaunchFlag, LaunchFlagSpec>;          // chrome: '--chrome', 'controls your Chrome browser', ['claude-sdk'], [<prefix from P12-01>]
export function flagOfTool(flags: readonly LaunchFlag[], toolName: string): LaunchFlag | undefined;
export function launchCommand(flags: readonly LaunchFlag[]): string;   // 'claude --chrome'
export function unsupportedFlags(flags: readonly LaunchFlag[], runtime: AgentRuntime): LaunchFlag[];
export const LaunchRequest = z.object({ flags: z.array(LaunchFlag).min(1).max(4), reason: z.string().min(1).max(2000), expectedUse: z.string().min(1).max(2000), check: z.string().min(1).max(2000) });
export const LaunchContext = LaunchRequest.extend({ taskId: Id, command: z.string(), cwd: z.string(), instructions: z.string().min(1) });
export const LAUNCH_ACTIONS = ['Approve and start', 'Start without flags', 'Deny'] as const;
export const OffScriptContext = z.object({ flag: LaunchFlag, expectedUse: z.string(), precedents: z.array(z.string()), judgeReason: z.string() });
export const OFF_SCRIPT_ACTIONS = ['Approve and continue', 'Stop the Steward'] as const;
export const AgentLaunch = z.object({ flags: z.array(LaunchFlag).min(1), expectedUse: z.string(), check: z.string(), approvalId: Id, precedents: z.array(z.string()) });
export function launchOf(agent: Pick<Agent, 'meta'>): AgentLaunch | undefined;   // parses agent.meta.launch, undefined when absent or invalid
export interface ScopeJudgeInput { flag: LaunchFlag; expectedUse: string; precedents: readonly string[]; toolCall: ToolCall /* already redacted */ }
export interface ScopeVerdict { verdict: 'consistent' | 'off_script'; reason: string }
export interface ScopeJudge { judge(input: ScopeJudgeInput, signal: AbortSignal): Promise<ScopeVerdict> }
```

- [ ] **Step 1: Write failing tests** in `launch-flags.test.ts`:
  - `flagOfTool(['chrome'], '<prefix>navigate') === 'chrome'`; `flagOfTool(['chrome'], 'Bash') === undefined`; `flagOfTool([], '<prefix>navigate') === undefined`
  - `launchCommand(['chrome']) === 'claude --chrome'`
  - `unsupportedFlags(['chrome'], 'codex')` equals `['chrome']`; `unsupportedFlags(['chrome'], 'claude-sdk')` equals `[]`
  - `LaunchFlag.safeParse('dangerously-skip-permissions').success === false`
  - every `LAUNCH_FLAGS` entry's `cli` matches none of `/dangerously|permission|allowed-?tools|mcp-config/i`
  - `launchOf({ meta: { launch: { flags: ['chrome'], expectedUse: 'x', check: 'y', approvalId: 'q1', precedents: [] } } })?.flags` equals `['chrome']`; `launchOf({ meta: { launch: { flags: ['nope'] } } }) === undefined`
  - `QuestionKind.options` contains `'launch'`
- [ ] **Step 2:** Run `pnpm --filter @galactic/protocol test launch-flags`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the module and the schema additions listed above.
- [ ] **Step 4:** Run `pnpm --filter @galactic/protocol test` and `pnpm typecheck`. Expected: PASS. Any exhaustive `switch` over `QuestionKind` that typecheck flags in the server or web is fixed by treating `launch` like `spend`: user-held, never escalated.
- [ ] **Step 5:** Commit `P12-02: launch flag catalogue, launch and off-script question contexts`.

### Task 3: Spawning with flags (P12-03)

**Files:**
- Modify: `apps/server/src/adapters/claude-sdk/claude-sdk-adapter.ts:457` (`extraArgs` from `bare` plus `launchFlags`)
- Modify: `apps/server/src/adapters/fake/fake-adapter.ts` (records `launchFlags` on the session for assertions)
- Modify: `apps/server/src/runtime/agent-runtime.ts` (`spawn` refuses `unsupportedFlags` and brains with flags; stores `input.launch` in `agent.meta.launch`; `resume`/`recoverAgent` pass `launchOf(agent)?.flags`)
- Modify: `apps/server/src/domain/commands.ts` (`spawnAgent` carries `launchFlags` and `launch` through)
- Test: `apps/server/src/adapters/claude-sdk/claude-sdk-adapter.test.ts`, `apps/server/src/runtime/agent-runtime.test.ts`

**Interfaces:** Consumes `LaunchFlag`, `LAUNCH_FLAGS`, `unsupportedFlags`, `AgentLaunch`, `launchOf` (Task 2). Produces: an agent row whose `meta.launch` is an `AgentLaunch`, and a spawn whose adapter options carry `launchFlags`.

- [ ] **Step 1: Write failing tests:**
  - adapter: `spawn({ …, launchFlags: ['chrome'] })` → the fake SDK's captured options have `extraArgs` equal to `{ chrome: null }`; with `bare: true` too → `{ bare: null, chrome: null }`; without flags → no `chrome` key.
  - runtime: spawning a Steward on `codex` with `launchFlags: ['chrome']` → `{ ok: false, reason: matching /chrome.*not supported/ }`; spawning a Waykeeper with flags → refused with `/brains never/`.
  - runtime: spawn with `launch: {…}` → `tables.agents.get(id).meta.launch` deep-equals the input; after a simulated restart, `recoverAgent` → the fake adapter's resumed session has `launchFlags: ['chrome']` (Review Focus 3).
- [ ] **Step 2:** Run `pnpm --filter @galactic/server test claude-sdk-adapter agent-runtime`. Expected: FAIL.
- [ ] **Step 3:** Implement. The adapter turns each flag into the CLI flag name without the dashes as the `extraArgs` key, e.g. `LAUNCH_FLAGS.chrome.cli.replace(/^--/, '')`.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit `P12-03: spawn and resume Stewards with catalogued launch flags`.

### Task 4: Gate routes flag tools to the watch (P12-04)

**Files:**
- Modify: `apps/server/src/runtime/permission-gate.ts` (`GateOptions.launchFlags?: () => readonly LaunchFlag[]`; in `decideCall`, after the tool-call cap reservation and before the policy table, a call where `flagOfTool(launchFlags(), call.toolName)` is defined returns `{ decision: 'ask', reasons: ['uses --<flag>: checked against the Steward's approvals'] }`; `Decision` gains `launchFlag?: LaunchFlag`)
- Modify: `apps/server/src/runtime/agent-runtime.ts` (`createPermissionGate({ …, launchFlags: () => launchOf(currentAgentRow)?.flags ?? [] })`)
- Test: `apps/server/src/runtime/permission-gate.test.ts`

- [ ] **Step 1: Write failing tests:**
  - with `launchFlags: () => ['chrome']` and a policy that **denies** network: `check({ toolName: '<prefix>navigate', input: { url: 'https://github.com' } })` → `decision: 'ask'`, and `decide()` → `launchFlag: 'chrome'`
  - the same gate, `Bash` `curl https://x` → the policy's `deny` (unchanged)
  - `launchFlags: () => []` → a `<prefix>navigate` call follows the policy (an unknown tool asks, with no `launchFlag`)
  - a flag call over the tool-call cap → `deny` (the cap still applies)
  - a project "Allow similar" rule matching the call is **not** consulted for a flag call (`onRuleAllow` never called)
- [ ] **Step 2:** Run `pnpm --filter @galactic/server test permission-gate`. Expected: FAIL.
- [ ] **Step 3:** Implement as described in Files.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit `P12-04: gate sends a launch flag's tools to the scope watch`.

### Task 5: Scope judge (P12-05)

**Files:**
- Create: `apps/server/src/adapters/claude-sdk/scope-judge.ts`, `scope-judge.test.ts`
- Create: `apps/server/src/adapters/fake/fake-scope-judge.ts`
- Modify: `apps/server/src/adapters/claude-sdk/sdk-surface.ts` (if the one-shot `query` shape is not already exposed)
- Modify: `apps/server/src/index.ts` / `runtime/compose.ts` (wire the judge into the runtime options as `scopeJudge`; the fake when `GALACTIC_HARMONIZER=fake`)

**Interfaces:** Produces `createSdkScopeJudge(opts: { sdk: SdkSurface; model?: string }): ScopeJudge` (the default model is `claude-haiku-5-5`) and `createFakeScopeJudge(script: (input: ScopeJudgeInput) => ScopeVerdict | Promise<ScopeVerdict>): ScopeJudge`.

The judge makes one turn with no tools, `maxTurns: 1` and `permissionMode` left at its default, plus a system prompt. The prompt says that `expectedUse` and `precedents` are the only things the user approved. A call is `consistent` only if it serves `expectedUse` or is the same kind of action on the same target as a precedent, and anything else is `off_script`. The reply must be the JSON `{"verdict": "...", "reason": "..."}`. The tool call goes in as data inside a fenced block, labelled untrusted.

- [ ] **Step 1: Write failing tests** with the fake SDK:
  - the SDK replies `{"verdict":"consistent","reason":"localhost screenshot"}` → `{ verdict: 'consistent', reason: 'localhost screenshot' }`
  - a reply that is not JSON, or has `verdict: 'maybe'` → `{ verdict: 'off_script', reason: matching /could not read the check/ }`
  - the SDK throws → `off_script` with `/check failed/`
  - the aborted `signal` → rejects or returns `off_script` (either one; the runtime treats both as off-script)
  - the prompt sent contains `expectedUse`, every precedent and the tool call's JSON, and its options carry `tools: []` / no `canUseTool` allowance
- [ ] **Step 2:** Run `pnpm --filter @galactic/server test scope-judge`. Expected: FAIL.
- [ ] **Step 3:** Implement both judges and the wiring.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit `P12-05: one-shot scope judge (SDK and scripted fake)`.

### Task 6: Runtime scope watch (P12-06)

**Files:**
- Create: `apps/server/src/runtime/scope-watch.ts`, `scope-watch.test.ts`
- Modify: `apps/server/src/runtime/agent-runtime.ts`: in the `agent.needs_input` branch, before `rulePermission`, if `live.gate.decide(call).launchFlag` is set, hand the event to `scopeWatch.handle(…)` and return. `answer()` maps an off-script question's answers to the adapter.
- Modify: `apps/server/src/domain/questions.ts` / `question-service.ts`: an `offScript` permission question is held by the user, never escalated, and offers no "Allow similar".

**Interfaces:**
- Consumes `ScopeJudge` (Task 5), `Decision.launchFlag` (Task 4), `launchOf`/`AgentLaunch` (Tasks 2–3), `OFF_SCRIPT_ACTIONS`, `OffScriptContext`.
- Produces `class ScopeWatch { constructor(deps: { judge: ScopeJudge; timeoutMs: number /* 20_000 */; now: () => number }); handle(live: Live, raw: NeedsInput, event: NeedsInput, flag: LaunchFlag): void }`.

Behaviour:
- It calls `judge` with the redacted call (`redactValue`), `expectedUse` and the precedents from `launchOf(agent)`, under a 20 s `AbortSignal` timeout.
- **consistent:** `permissionDecided(live, { decision: 'allow', reason: 'consistent with the Steward's approvals: <reason>' })` with `decidedBy: { type: 'agent', id: <the Steward's supervisorId> }`, then `adapter.answer(questionId, 'allow')`.
- **off_script, an error or a timeout:** the `agent.needs_input` event plus a `permission` question with `context.offScript = { flag, expectedUse, precedents, judgeReason }`, `options: [...OFF_SCRIPT_ACTIONS]` and holder `user`, opened in one transaction (the existing `openFromNeedsInput` path, with the context added). The usual notification for a user-held permission question fires.
- **'Approve and continue':** `adapter.answer(q, 'allow')`, then append `"<toolName> <one-line summary of the redacted input>"` to `meta.launch.precedents` in the same command that records `question.answered`.
- **'Stop the Steward':** `adapter.answer(q, 'deny: stopped by the user')`, then `stopAgent(agentId, user)`.
- **Dismissal:** denies, as for any permission question (existing behaviour). The Steward is not stopped.

- [ ] **Step 1: Write failing tests** (fake adapter, fake judge, fake timers):
  - `consistent verdict allows the call and logs permission.decided by the Waykeeper`: the log has `permission.decided{decision:'allow', decidedBy:{type:'agent', id: waykeeperId}}`, no question row, and the adapter got `'allow'`
  - `off_script opens a user-held permission question with offScript context`: `question.kind === 'permission'`, `holder.type === 'user'`, `context.offScript.judgeReason` set, `context.options` deep-equals `OFF_SCRIPT_ACTIONS`, and the adapter has no answer yet
  - `judge never settles → off-script question after 20 s` (Review Focus 1)
  - `judge throws → off-script question`
  - `Approve and continue allows and records a precedent`: the adapter got `'allow'`, and `launchOf(agent).precedents` has length 1 and contains the tool name
  - `Stop the Steward denies and stops`: the adapter got an answer starting with `'deny'`, and the agent reaches `stopped`
  - `dismissing the off-script card denies without stopping` (Review Focus 4)
  - `judge sees redacted input`: a call with `input: { text: 'ghp_' + 'x'.repeat(36) }` → the judge's input contains no `ghp_` token (Review Focus 5)
  - `non-flag calls of a flagged Steward still follow the policy`: `Bash` under an `ask` policy → an ordinary permission question without `offScript`
  - `offScript question is never escalated nor answerable by an agent`: `answerQuestion` by the Waykeeper actor → refused
  - `resume keeps launch flags and precedents`: an open off-script question is cancelled by the restart, and the resumed agent's `launchOf` is unchanged (Review Focus 3)
- [ ] **Step 2:** Run `pnpm --filter @galactic/server test scope-watch agent-runtime`. Expected: FAIL.
- [ ] **Step 3:** Implement `ScopeWatch` and the runtime hooks.
- [ ] **Step 4:** Run the same tests and the whole server suite (`pnpm --filter @galactic/server test`). Expected: PASS.
- [ ] **Step 5:** Commit `P12-06: watch a flagged Steward's flag tools live; off-script calls wait for the user`.

### Task 7: Launch approval in the domain (P12-07)

**Files:**
- Create: `apps/server/src/domain/launch.ts`, `launch.test.ts`
- Modify: `apps/server/src/domain/questions.ts` (`checkAnswer`: a `launch` question accepts only `LAUNCH_ACTIONS` and only from the user), `question-service.ts` (a `launch` question is held by the user, never escalated or reassigned)
- Modify: `packages/protocol/src/commands.ts` (`DomainCommands.requestLaunch(input: RequestLaunchInput): Promise<CommandResult<{ questionId: Id }>>`, `DomainCommands.takeLaunchApproval(input: { questionId: Id; taskId: Id; by: Actor }): Promise<CommandResult<LaunchContext>>`), `apps/server/src/domain/commands.ts` (wire)

**Interfaces:**
```ts
export interface RequestLaunchInput { originAgentId: Id; taskId: Id; request: LaunchRequest; instructions: string; cwd: string; runtime: AgentRuntime }
```
- `requestLaunch` refuses: unsupported flags for `runtime`, an origin that is not the task project's Waykeeper, and a task that already has an open `launch` question. It opens a `launch` question whose `context.text` is `"Start a Steward for <task title> with <command>?"`, whose `context.launch` is `{ …request, taskId, command: launchCommand(flags), cwd, instructions }` and whose options are `LAUNCH_ACTIONS`.
- `takeLaunchApproval` returns the `LaunchContext` when the question is `answered` with `'Approve and start'`, its `taskId` matches, the caller is the origin Waykeeper and `meta.launchUsed` is unset. It sets `meta.launchUsed = true` in the same transaction. Otherwise it throws `DomainError('invalid_transition', …)` with a message the Waykeeper can act on.

- [ ] **Step 1: Write failing tests:**
  - `requestLaunch` opens a `launch` question held by the user with `context.launch.command === 'claude --chrome'`
  - refuses `runtime: 'codex'` (`/not supported/`) and a second open request for the same task (`/already waiting/`)
  - `checkAnswer` refuses `'Approve'` (not in `LAUNCH_ACTIONS`) and refuses an agent actor
  - `takeLaunchApproval` succeeds once after `'Approve and start'` and is refused the second time (`/already used/`, Review Focus 2); refused for another task id; refused after `'Deny'` or `'Start without flags'`
- [ ] **Step 2:** Run `pnpm --filter @galactic/server test launch questions`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit `P12-07: launch approvals held by the user, used once`.

### Task 8: Waykeeper tool, prompt and final check (P12-08)

**Files:**
- Modify: `apps/server/src/brains/waykeeper/tools.ts:326` (`spawn_steward`)
- Modify: `apps/server/src/brains/waykeeper/prompt.ts`
- Modify: `apps/server/src/brains/wake.ts` (`agent.finished` of a Steward with `launchOf` → append the check reminder)
- Test: `apps/server/src/brains/waykeeper/tools.test.ts`, `apps/server/src/brains/wake.test.ts`

**Interfaces:** Consumes `requestLaunch`, `takeLaunchApproval` (Task 7), `SpawnAgentInput.launchFlags/launch` (Tasks 2–3).

`spawn_steward` input schema gains two optional fields. `launchFlags: { flags: string[]; reason: string; expectedUse: string; check: string }` is used on the first call. `launchApprovalId: string` is used on the call after Cosmin approved.

1. With `launchFlags`, the tool runs the existing checks, places the worktree (`placeSteward`), and calls `requestLaunch` with `stewardChoiceOf(...).runtime`. It returns `{ waiting: true, questionId, note: 'Cosmin decides on the card; you will be told. End your turn.' }` and spawns nothing.
2. With `launchApprovalId`, it calls `takeLaunchApproval`, ignores the `instructions` argument and uses the approved `instructions`. It refuses if another live Steward has `launchOf(...).flags` including `chrome` (`conflict`: "another Steward is using Chrome (<id>); start this one when it finishes"). Then it calls `spawnAgent({ …, launchFlags: ctx.flags, launch: { flags, expectedUse, check, approvalId, precedents: [] } })`.
3. Both fields at once are refused. Without either, the tool behaves exactly as today.

Prompt additions, kept short:
- Ask for a flag only when the task cannot be done without it. Never ask "just in case".
- `expectedUse` must name the concrete targets, e.g. the dev server URL and the PR.
- On "Approve and start", call `spawn_steward` again with `launchApprovalId` at once.
- On "Start without flags", spawn a normal Steward.
- On "Deny", re-plan or report.
- A running Steward's flags never change. A later need means a new Steward.
- On the woken `agent.finished` line, verify the `check` and report the result to Cosmin.

- [ ] **Step 1: Write failing tests:**
  - `launchFlags → opens a launch question, spawns nothing, returns waiting`
  - `launchApprovalId after approval → spawns with launchFlags ['chrome'] and meta.launch, using the approved instructions`
  - `launchApprovalId reused → refused` (Review Focus 2)
  - `second chrome Steward while one is live → conflict`
  - `launchFlags and launchApprovalId together → refused`
  - `no launch fields → unchanged behaviour` (the existing tests stay green)
  - wake: `agent.finished` of a flagged Steward describes `"… ran with --chrome; verify: <check>, then report the result to the user"`
- [ ] **Step 2:** Run `pnpm --filter @galactic/server test waykeeper wake`. Expected: FAIL.
- [ ] **Step 3:** Implement the tool, the prompt and the wake line.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit `P12-08: Waykeeper asks for, starts and checks flagged Stewards`.

### Task 9: Web cards and badge (P12-09)

**Files:**
- Create: `apps/web/src/panel/cards/LaunchCard.tsx`, `launch-cards.test.tsx`
- Modify: `apps/web/src/panel/cards/QuestionCard.tsx` (routes `kind === 'launch'` to `LaunchCard`; a `permission` question with `context.offScript` renders the off-script body and hides `AllowSimilar`)
- Modify: `apps/web/src/panel/inbox-model.ts`, `apps/web/src/scene/beacons/beacon-model.ts`, `beacon-look.ts` (treat `launch` like `publish`: user-held, raises the beacon)
- Modify: `apps/web/src/panel/AgentCards.tsx` / `agent-cards-model.ts` (a `--chrome` badge from `launchOf(agent)` whose title is the agent's `expectedUse`)
- Check: `grep -rn "decision 136" apps/` for whatever offers quick answers outside the panel, such as the menu bar or a phone notification action. If one exists, `launch` and `offScript` questions are excluded from it, with a test. If none exists in this repo, record that in the task.

`LaunchCard` lays out, in this order: the label "Waykeeper · <project> · needs your approval", the title "Start Steward with extra access", **Task**, **Why** (`reason`), **Command** (`command`, monospace, with `cwd`), **New compared to a normal Steward** (each flag's `LAUNCH_FLAGS[f].cli` and `label`), **Waykeeper will watch for** (`expectedUse`), **and check** (`check`), and the buttons from `LAUNCH_ACTIONS`. The off-script body shows "The Steward tried to:" with the tool name and pretty input, "Approved:" with `expectedUse` and the precedents as a list, "Why it was stopped:" with `judgeReason`, and the buttons from `OFF_SCRIPT_ACTIONS`.

- [ ] **Step 1: Write failing tests** (Testing Library):
  - the launch card shows `claude --chrome`, the reason, `controls your Chrome browser`, and three buttons named exactly as `LAUNCH_ACTIONS`; clicking `Approve and start` sends `answerQuestion` with that text
  - the off-script card shows the tool name, the approved use and the precedents; it has no "Allow similar" button; `Stop the Steward` sends that answer
  - the agent card of a flagged Steward shows a `--chrome` badge; a normal Steward's card has none
- [ ] **Step 2:** Run `pnpm --filter @galactic/web test launch-cards AgentCards`. Expected: FAIL.
- [ ] **Step 3:** Implement, reusing `PublishCard`'s structure and styles.
- [ ] **Step 4:** Run the web suite. Expected: PASS.
- [ ] **Step 5:** Commit `P12-09: launch and off-script cards, flag badge`.

### Task 10: End-to-end, docs and phase exit (P12-10)

**Files:**
- Create: `apps/server/src/runtime/launch-flags.flow.test.ts`
- Modify: `docs/SPEC.md`:
  - §7 decision **151** "Steward launch flags": Cosmin's words, the catalogue, the launch card, the live watch and precedents, and the final check.
  - §2.6: one sentence naming the exception, that the Waykeeper may allow a flag's tool call consistent with the Steward's approvals.
  - Decision 147: a note that publishing through a flag's tools follows decision 151.
- Modify: `docs/TECHNOLOGY.md` (a new subsection in the adapter/permissions area: catalogue, `extraArgs`, gate `launchFlags`, `ScopeWatch`, `ScopeJudge`, the 20 s fail-closed timeout, `meta.launch`)
- Modify: `docs/IMPLEMENTATION_PLAN.md` (the Phase 12 line)
- Modify: `apps/server/src/adapters/README.md` (`launchFlags` in the spawn options)
- Modify: `docs/tasks/PHASE_12_LAUNCH_FLAGS.md`, `docs/tasks/README.md` (statuses, phase exit)

- [ ] **Step 1: Write the failing flow test.** It uses the fake Waykeeper LLM script, the fake SDK and the fake judge:
  1. The Waykeeper calls `spawn_steward` with `launchFlags`, and a `launch` question opens.
  2. The user answers `Approve and start`. The Waykeeper is woken, calls `spawn_steward` with `launchApprovalId`, and the Steward spawns with `extraArgs { chrome: null }`.
  3. A Steward Chrome call to `http://localhost:5173` gets `consistent`, so it is allowed and no question opens.
  4. A call to `https://news.ycombinator.com` gets `off_script`, and a question opens. The user answers `Approve and continue`, so the call is allowed and a precedent is stored.
  5. A call to the same host again gets `consistent` (the scripted judge sees the precedent).
  6. A comment on another repository's PR gets `off_script`. The user answers `Stop the Steward`, and the Steward is stopped.

  The whole sequence is visible in the event log in that order.
- [ ] **Step 2:** Run `pnpm --filter @galactic/server test launch-flags.flow`. Expected: PASS once Tasks 2–9 are in. Fix the gaps it finds in their owning files.
- [ ] **Step 3:** Write the docs. SPEC, TECHNOLOGY and the plan must agree, per CLAUDE.md.
- [ ] **Step 4:** Run the gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. Expected: all green.
- [ ] **Step 5:** Local real run, untagged in CI. A real Waykeeper and Steward take one screenshot of a local page and attach it to a PR in a scratch repository. Record the result in `docs/tasks/notes/P12-10-real-run.md`.
- [ ] **Step 6:** Verify the exit criteria in the phase file: each Global Constraint is pointed to a test or a doc line. Mark the phase done and commit `P12-10: done — Steward launch flags`. Then ask Cosmin to merge.
