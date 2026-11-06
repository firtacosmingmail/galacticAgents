# Phase 12 — Steward launch flags (`--chrome` first)

**Current task:** P12-10 · **Task status:** P12-01 to P12-09 done (2026-11-05); P12-10 in progress — real run pending Cosmin's approval
**Phase status:** in progress (9/10 done) — branch `agent-launch-flags`; batch branch `p12-1-launch-flags`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

A Waykeeper can ask to start a Steward with a catalogued launch flag (first: `--chrome`, so a Steward can drive Cosmin's Chrome to take screenshots and attach them to a PR). Cosmin approves the exact command and the reason on a card, and while the Steward runs, every use of the flag's tools is checked against the Steward's approvals. The first off-script use pauses the Steward (a held call) and asks Cosmin.

## Entry criteria

- Phase 11 merged into `main` (done 2026-11-04); this phase is cut from `main`.
- The design approved by Cosmin: `docs/superpowers/specs/2026-11-05-steward-launch-flags-design.md`.
- Claude Code CLI with `--chrome` and the Claude in Chrome extension installed on this Mac (for the P12-01 spike).

## References

- Spec (authority for this phase): `docs/superpowers/specs/2026-11-05-steward-launch-flags-design.md`.
- Plan: `docs/superpowers/plans/2026-11-05-steward-launch-flags.md` (Global Constraints, Review Focus, Tasks 1–10).
- `SPEC.md` §2.6 (permission questions never answered by an LLM; narrow exception written in P12-10), decisions 138, 147; new decision 151 is written in P12-10.
- `TECHNOLOGY.md` adapter layer and permission gate; a new subsection is written in P12-10.
- Spike notes: `docs/tasks/notes/P12-01-chrome-spike.md` (exact Chrome tool names, canUseTool behaviour, the Ruling).
- Code precedents: `spend` and `publish` questions (user-held, never escalated), `extraArgs: { bare: null }` in `apps/server/src/adapters/claude-sdk/claude-sdk-adapter.ts`, the permission gate in `apps/server/src/runtime/permission-gate.ts`.

## Design notes for implementation

These are the plan's Global Constraints; they bind every task.

- Only catalogued flags can be requested. The first and only entry is `chrome`: CLI `--chrome`, runtime `claude-sdk`, label "controls your Chrome browser". The spike in P12-01 confirms its tools.
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

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P12-01 | Phase file and Chrome spike (plan Task 1). On a `stop` Ruling the phase ends here. |
| 2 | P12-02 | Protocol (Task 2). |
| 3 | P12-03 | Spawning with flags (Task 3). |
| 4 | P12-04 | Gate routes flag tools to the watch (Task 4). |
| 5 | P12-05 | Scope judge (Task 5). |
| 6 | P12-06 | Runtime scope watch (Task 6). |
| 7 | P12-07 | Launch approval in the domain (Task 7). |
| 8 | P12-08 | Waykeeper tool, prompt and final check (Task 8). |
| 9 | P12-09 | Web cards and badge (Task 9). |
| 10 | P12-10 | End-to-end, docs and phase exit (Task 10). |

All ten run in order in batch branch(es) `p12-<n>-<slug>`.

## Tasks

### P12-01 — Phase file and Chrome spike
- **Status:** done (2026-11-05) · **Depends on:** — · **Parallel with:** —
- Plan Task 1: this file; `scripts/spikes/chrome-sdk-probe.mjs`; a real run of the Agent SDK with `extraArgs: { chrome: null }`.
- **Acceptance:** `docs/tasks/notes/P12-01-chrome-spike.md` gives the exact Chrome tool names and prefix, whether calls reach `canUseTool`, the two-session behaviour and the screenshot-to-PR path (marked "not exercised" where it was), and ends with a `Ruling: go` or `stop` line.
- **Done:** Ruling `go`: Chrome tools are `mcp__claude-in-chrome__*` (22 tools), reach `canUseTool` after a `PreToolUse` `ask` (not always without it), two sessions run at once on the shared browser.

### P12-02 — Protocol
- **Status:** done (2026-11-05) · **Depends on:** P12-01 · **Parallel with:** —
- Plan Task 2: `launch-flags.ts` (catalogue, `flagOfTool`, `launchCommand`, contexts, `AgentLaunch`, `ScopeJudge`), `QuestionKind` `launch`, `SpawnOptions.launchFlags`, `SpawnAgentInput` fields.
- **Acceptance:** every new type round-trips; `dangerously-skip-permissions` is not a `LaunchFlag`; typecheck is green with `launch` treated like `spend`.

### P12-03 — Spawning with flags
- **Status:** done (2026-11-05) · **Depends on:** P12-02 · **Parallel with:** —
- Plan Task 3: the Claude adapter maps flags to `extraArgs`; the runtime refuses unsupported runtimes and brains, stores `meta.launch`, and resume keeps the flags.
- **Acceptance:** `extraArgs` is `{ chrome: null }` (merged with `bare`); a codex Steward or a Waykeeper with flags is refused; a recovered agent resumes with its flags.

### P12-04 — Gate routes flag tools to the watch
- **Status:** done (2026-11-05) · **Depends on:** P12-03 · **Parallel with:** —
- Plan Task 4: `GateOptions.launchFlags`; a flag tool call returns `ask` with `launchFlag`, skipping the policy table and rules but not the call cap.
- **Acceptance:** a flag call asks even when the policy denies network; non-flag calls follow the policy; no rule is consulted for a flag call.

### P12-05 — Scope judge
- **Status:** done (2026-11-05) · **Depends on:** P12-04 · **Parallel with:** —
- Plan Task 5: one-shot SDK scope judge (no tools, one turn) and a scripted fake, wired as `scopeJudge`.
- **Acceptance:** malformed reply, error or abort is `off_script`; the prompt carries `expectedUse`, precedents and the call; the judge gets no tools.

### P12-06 — Runtime scope watch
- **Status:** done (2026-11-05) · **Depends on:** P12-05 · **Parallel with:** —
- Plan Task 6: `ScopeWatch` holds a flag call until the verdict; off-script opens a user-held permission question with `offScript` context; approve adds a precedent, stop denies and stops.
- **Acceptance:** a judge that never settles gives an off-script question after 20 s; the judge and log see redacted input; dismissal denies without stopping; a restart keeps flags and precedents.

### P12-07 — Launch approval in the domain
- **Status:** done (2026-11-05) · **Depends on:** P12-06 · **Parallel with:** —
- Plan Task 7: `requestLaunch` and `takeLaunchApproval`; `launch` questions are user-only, never escalated.
- **Acceptance:** an approval can be taken once, only for its task and only by the origin Waykeeper; an agent cannot answer a launch question.

### P12-08 — Waykeeper tool, prompt and final check
- **Status:** done (2026-11-05) · **Depends on:** P12-07 · **Parallel with:** —
- Plan Task 8: `spawn_steward` with `launchFlags` (opens the card, returns waiting) and `launchApprovalId` (spawns); prompt additions; the finished-Steward check reminder.
- **Acceptance:** a reused approval is refused; a second live `chrome` Steward is a conflict; without launch fields the tool behaves as before.

### P12-09 — Web cards and badge
- **Status:** done (2026-11-05) · **Depends on:** P12-08 · **Parallel with:** —
- Plan Task 9: `LaunchCard`, the off-script card body (no "Allow similar"), beacons, the `--chrome` badge, any quick-answer surface excludes these questions (the desktop menu bar lists an off-script request under Questions, open-only, never with Allow once; `launch` was already there).
- **Acceptance:** fixed button labels send exactly those answers; a flagged Steward shows the badge, a normal one does not.

### P12-10 — End-to-end, docs and phase exit
- **Status:** in progress · **Depends on:** P12-09 · **Parallel with:** —
- Plan Task 10: `launch-flags.flow.test.ts`; SPEC decision 151, §2.6 and decision 147 notes; TECHNOLOGY subsection; plan line; adapters README; phase exit.
- **Acceptance:** the flow test passes in the specified order; the full gates are green; SPEC, TECHNOLOGY and the plan agree.
- **Progress (2026-11-05):** flow test, docs (SPEC decision 151, §2.6, §3.6, decision 147 note; TECHNOLOGY §3.9; plan Phase 12; adapters README) and gates done; the review fix "one `chrome` Steward across every project" landed with a test. **Real run pending Cosmin's approval** — it drives his Chrome and posts to a GitHub PR; the procedure is in `docs/tasks/notes/P12-10-real-run.md` (not yet run). The phase is not marked done until it is.

## Exit criteria check (P12-10)

Each Global Constraint, and where it is held. Paths are under `apps/server/src/` unless they start with a package or `docs/`.

| Global Constraint | Test | Doc |
|---|---|---|
| Only catalogued flags; the one entry is `chrome` (`--chrome`, `claude-sdk`, "controls your Chrome browser") | `packages/protocol/src/launch-flags.test.ts` (maps a flag tool, reports flags a runtime cannot carry); `brains/waykeeper/launch.test.ts` "refuses unknown flags with the allowed names"; `runtime/agent-runtime.test.ts` "refuses a flag the runtime cannot carry" | SPEC decision 151 "Catalogue"; TECHNOLOGY §3.9 "Catalogue" |
| Never catalogued: `--dangerously-skip-permissions`, `--permission-mode`, `--allowedTools`, `--mcp-config`, … | `packages/protocol/src/launch-flags.test.ts` "never catalogues a permission-changing flag" | SPEC decision 151; TECHNOLOGY §3.9 |
| Brains never get launch flags | `runtime/agent-runtime.test.ts` "never gives a brain launch flags" | SPEC decision 151; TECHNOLOGY §3.9 "Spawning" |
| No LLM grants a flag or approves an inconsistent action; launch and off-script questions are user-held: no escalation, no supervisor answer, no "Allow similar", no menu bar | `domain/launch.test.ts` "accepts only the exact labels and only from the user", "refuses an agent answering a launch question"; `runtime/scope-watch.test.ts` "offScript question is never escalated nor answerable by an agent…"; `apps/desktop/src/tray-menu.test.ts` "never offers Allow once for an off-script request or a launch approval"; `apps/web/src/panel/cards/launch-cards.test.tsx` "never Allow similar" | SPEC §2.6 (the one-sentence exception), decision 151; TECHNOLOGY §3.9 "The off-script answer", "The launch question" |
| Only a flag's tool calls skip the policy table; every other call goes through the table and rules | `runtime/permission-gate.test.ts` "asks for a flag tool even when the policy denies the network", "follows the policy when the Steward has no flags", "does not consult rules or allowOnce for a flag call", "still applies the tool-call cap"; `runtime/scope-watch.test.ts` "non-flag calls of a flagged Steward still follow the policy" | SPEC decision 151 "The live watch"; TECHNOLOGY §3.9 "The gate" |
| The scope check fails closed: error, malformed reply or 20 s timeout is `off_script` | `runtime/scope-watch.test.ts` "judge never settles → off-script after 20 s", "judge throws", "no judge configured"; `adapters/claude-sdk/scope-judge.test.ts` "fails closed when the SDK throws", "is off_script when the signal is already aborted", "treats %j as off_script" (malformed replies) | SPEC decision 151; TECHNOLOGY §3.9 "The scope watch", "The scope judge" |
| A held call never runs before its verdict | `runtime/launch-flags.flow.test.ts` (the log order: each `agent.tool_call` follows its `permission.decided` or answered question; the off-script PR comment never runs); `runtime/scope-watch.test.ts` "off_script opens a user-held permission question" (no adapter answer until the user's) | SPEC decision 151; TECHNOLOGY §3.9 "The scope watch" |
| "Pause" is a held call, never `adapter.pause` | `runtime/launch-flags.flow.test.ts` (no `agent.paused` in the sequence; the Steward waits on the question); `runtime/scope-watch.ts` never calls `pause` | SPEC decision 151 ("never a frozen process"); TECHNOLOGY §3.9 ("no `adapter.pause`") |
| Each approval covers one Steward; a resumed Steward keeps its flags and precedents | `domain/launch.test.ts` "succeeds once after approval and is refused the second time", "is refused for another task, another agent"; `brains/waykeeper/launch.test.ts` "launchApprovalId after approval spawns … once"; `runtime/agent-runtime.test.ts` "keeps the launch record in meta and resumes with its flags after a restart"; `runtime/scope-watch.test.ts` "resume keeps launch flags and precedents" | SPEC decision 151; TECHNOLOGY §3.9 "Spawning", "The launch question" |
| Only one live Steward with `chrome` at a time | `brains/waykeeper/launch.test.ts` "a second chrome Steward while one is live is a conflict", "a live chrome Steward of another project's Waykeeper is a conflict too" (P12-10 fix) | SPEC decision 151; TECHNOLOGY §3.9 "The Waykeeper" |
| Nothing outside `adapters/` knows how a flag reaches a runtime; shared types in `packages/protocol`; speculative fields in `meta` | `adapters/claude-sdk/claude-sdk-adapter.test.ts` "passes catalogued launch flags as extraArgs, merged with bare"; `runtime/launch-flags.flow.test.ts` "the Claude adapter launches the approved flags as extraArgs { chrome: null }"; `git grep extraArgs` outside tests: only `adapters/claude-sdk/` | `apps/server/src/adapters/README.md` (`launchFlags`); TECHNOLOGY §3.9 "Shapes" (`meta.launch`), "Storage" |
| Answer labels exactly: launch `Approve and start` / `Start without flags` / `Deny`; off-script `Approve and continue` / `Stop the Steward` | `domain/launch.test.ts` "accepts only the exact labels"; `runtime/scope-watch.test.ts` (refuses `allow`); `apps/web/src/panel/cards/launch-cards.test.tsx` "Approve and start sends that exact answer", "Stop the Steward sends that exact answer"; `runtime/launch-flags.flow.test.ts` | SPEC decision 151; TECHNOLOGY §3.9 "Shapes" |
| Branch flow: phase branch `agent-launch-flags`, batch `p12-1-launch-flags`, task-prefixed commits, Cosmin merges | — | this file's header; `git log` (every commit `P12-nn: …`) |
| Gates green before asking to merge | `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` — all green on 2026-11-05 (P12-10) | — |
| Phase exit: one local real run recorded | **pending** — not yet run, awaiting Cosmin | `docs/tasks/notes/P12-10-real-run.md` |
