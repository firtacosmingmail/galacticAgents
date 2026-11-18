# Phase 13 — Waykeeper approvals

**Current task:** P13-28 · **Task status:** P13-09–P13-18 done (2026-11-14); P13-19, P13-20 done (2026-11-15); P13-21, P13-22 done (2026-11-16); P13-23–P13-27 done (2026-11-18) (branch `agent-auto-grants`)
**Phase status:** feature done (2026-11-11), merged into `main` (PR #12); follow-up 27/31

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

On a project where Cosmin turned it on, a Steward's `ask` permission request is judged on the Waykeeper's behalf: approved without a card when it fits the task, or forwarded to Cosmin with the reason. Repeated similar approvals can become standing approvals for the project, ended when the project ends.

## References

- Spec (authority for this phase): `docs/superpowers/specs/2026-11-09-waykeeper-approvals-design.md`.
- Plan: `docs/superpowers/plans/2026-11-09-waykeeper-approvals.md` (Global Constraints, Review Focus, Tasks 1–7).
- Code precedents: `apps/server/src/domain/project-rules.ts` (rules on the project row, `endProjectRules`), the scope judge and watch of Phase 12 (`launch-flags.ts`, `runtime/scope-watch.ts`), the permission gate in `apps/server/src/runtime/permission-gate.ts`.

## Design notes for implementation

The plan's Global Constraints bind every task. Branch flow: the phase branch is `agent-waykeeper-approvals`; commits are prefixed with the task id (`P13-nn: …`). Gates before asking to merge: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P13-01 | Protocol, storage and domain commands (plan Task 1). |
| 2 | P13-02 | The judge-only command splitter (Task 2). |
| 3 | P13-03 | The request judge, SDK and fake (Task 3). |
| 4 | P13-04 | The approval watch in the runtime (Task 4). |
| 5 | P13-05 | Answers, standing approvals and routes (Task 5). |
| 6 | P13-06 | The panel (Mac and phone) and the menu bar (Task 6). |
| 7 | P13-07 | Docs, task board and the real run (Task 7). |
| 7 | P13-08 | Steward scratch checkouts stay in the workspace (found in the test run; added 2026-11-09). |

| 8 | P13-09, P13-10, P13-11 | Follow-up from real use (added 2026-11-14): the Waykeeper approved none of 14 requests. |
| 9 | P13-12 | Pre-existing gaps found in the follow-up's review (added 2026-11-14). |
| 10 | P13-13 → P13-14 → P13-15 → P13-16 → P13-17 → P13-18 | Auto mode (added 2026-11-14), in order; plan `docs/superpowers/plans/2026-11-14-waykeeper-auto-mode.md`. |
| 11 | P13-19 | The switch from the phone (added 2026-11-15). |
| 12 | P13-20 | Auto approves git pushes, never to main (added 2026-11-15). |
| 13 | P13-21 | A push or a PR is not publishing; `=` separators are readable (added 2026-11-16). |
| 14 | P13-22 | Outward steps last: publishing, pushes, deploys, account changes and cleanup in small final steps (added 2026-11-16). |
| 15 | P13-23 | Protocol shapes, events, projection, migration, board (added 2026-11-18); plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`. |
| 16 | P13-24 | Domain — grants and the standalone scope (added 2026-11-18); plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`. |
| 17 | P13-25 | The request judge's `grants` mode (added 2026-11-18); plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`. |
| 18 | P13-26 | The approval watch's new Auto path (added 2026-11-18); plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`. |
| 19 | P13-27 | Runtime — no bypass paths; holding a send (added 2026-11-18); plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`. |
| 20 | P13-28 | The Waykeeper's `answer_send_permission` (added 2026-11-18); plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`. |
| 21 | P13-29 | `request_publish` in Auto (added 2026-11-18); plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`. |
| 22 | P13-30 | Web — grants, the send card, standalone settings, log labels (added 2026-11-18); plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`. |
| 23 | P13-31 | Docs and the board (added 2026-11-18); plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`. |

P13-01…07 run in order; P13-08 runs beside P13-07; P13-09…11 run together.

## Tasks

### P13-01 — Protocol, storage and domain commands
- **Status:** done (2026-11-09) · **Depends on:** — · **Parallel with:** —
- Plan Task 1: `waykeeper-approvals.ts` in the protocol, four events, migration 0019, domain commands, `endStandingApprovals`.
- **Acceptance:** the plan's Task 1 tests pass; typecheck is green.

### P13-02 — Command splitter
- **Status:** done (2026-11-09) · **Depends on:** P13-01 · **Parallel with:** —
- Plan Task 2.

### P13-03 — Request judge
- **Status:** done (2026-11-09) · **Depends on:** P13-02 · **Parallel with:** —
- Plan Task 3.

### P13-04 — Approval watch
- **Status:** done (2026-11-09) · **Depends on:** P13-03 · **Parallel with:** —
- Plan Task 4.

### P13-05 — Answers, standing approvals and routes
- **Status:** done (2026-11-09) · **Depends on:** P13-04 · **Parallel with:** —
- Plan Task 5.

### P13-06 — Panel and menu bar
- **Status:** done (2026-11-09) · **Depends on:** P13-05 · **Parallel with:** —
- Plan Task 6.

### P13-07 — Docs and real run
- **Status:** done (2026-11-11) · **Depends on:** P13-06 · **Parallel with:** —
- Plan Task 7.
- Done: SPEC decision 154, TECHNOLOGY §3.10, IMPLEMENTATION_PLAN Phase 13, the design and plan wording fixes (a stopping Steward drops the held call; `StandingApprovalResult`), the task board, the full gates, and the manual procedure `docs/tasks/notes/P13-07-real-run.md`. Open: Cosmin runs that procedure on a scratch repository and records the result there; only then is the task `done (<date>)` and the phase exit verified. Closed 2026-11-11: Cosmin marked the real run done after using the feature on real projects (see the notes file).

### P13-08 — Steward scratch checkouts stay in the workspace (added 2026-11-09)
- **Status:** done (2026-11-09) · **Depends on:** — · **Parallel with:** P13-07
- Found in Cosmin's test run: a Steward reviewing a PR ran `git worktree add /tmp/pr83 pr-83` (its prompt forbids switching branches and named no place for another checkout).
- Done: a project Steward's prompt names its scratch folder `<workspace>/.galactic/scratch/<task-id>` and forbids files, clones and worktrees outside the workspace (other refs are read with `git log`/`git diff`/`git show`); `Workspaces.mergeTask` and `removeWorktree` remove that folder and any git worktree registered in it. SPEC decision 27 amended. Asteroid Stewards get no scratch folder (their folder may be someone's working copy). A `git worktree add` there still writes into `.git`, so it still asks.

### P13-09 — A Steward's own scratch and temp files are its own (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** — · **Parallel with:** P13-10, P13-11
- Found in real use: 8 of the Waykeeper's 14 forwards were "deletes outside the Steward's worktree" for the Steward's own temporary files: `rm -f /tmp/claude-501/t964-*.log` (Claude Code's temp folder), `SD=<its scratch folder>; rm $SD/*.log` (the variable is not resolved, so the target "cannot be placed"), and deletes in its scratch folder, which does not count as its own.
- Do: a destructive part inside the Steward's scratch folder counts as inside its workspace; a `NAME=<literal path>` assignment earlier in the same command is resolved when placing later parts; the Steward's processes get its scratch folder as their temp folder, so its temp files land there. Never: anything outside both the worktree and the scratch folder.
- Done: SPEC 154 and TECHNOLOGY §3.10 amended. The scratch folder counts as the Steward's own in the splitter and the watch; `SpawnOptions.tempDir` sets `CLAUDE_CODE_TMPDIR` and `TMPDIR` for a project Steward in its own worktree. A literal variable set exactly once in the line places targets; loops, whitespace values, `IFS`, `trap`, namerefs, `eval`/`source` make names unknown (final review findings 1–3).

### P13-10 — Cosmin's picked answers and relayed questions grant a push (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** — · **Parallel with:** P13-09, P13-11
- Found in real use: Cosmin picked "Push and post the 4 replies" on a Harmonizer question relaying the Waykeeper's "May I push?", and the push was still forwarded: a picked option was not his words, and the Harmonizer's question was not one of the project's. 5 of 14 forwards were pushes.
- Do (amends decision 154, Cosmin's call 2026-11-14): his answer to a question the Harmonizer asked to relay a question of the project's agents counts; an option he picked counts as his words when the option names the action. The server's quote check (15 characters, verbatim) stays. The "Approved 3 times before" button is not offered on a push or an upload (it was offered and then refused).
- Done: SPEC 154 and TECHNOLOGY §3.10 amended. The Harmonizer's `ask_user` takes `questionId` (stored as `meta.relaysQuestionId`). A picked option naming the action counts unless it holds back or negates, and is quoted only whole (`PICKED_OPTION_PREFIX`; final review finding 4). Pushes and uploads never record or offer a standing approval.

### P13-11 — A `gh --jq` filter is not a path (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** — · **Parallel with:** P13-09, P13-10
- Found in real use: `gh api …/reviews --jq '.[].user.login'` was classified as "agent or git configuration" (guarded), so it could never be approved. The filter of `--jq`/`-q` and the template of `--template`/`-t` are not paths. This also affects the normal permission table.
- Done: the value of `gh`'s `--jq`/`-q`/`--template`/`-t` is never a path, in the gate and the splitter.

### P13-12 — Unplaceable delete targets and symlinks (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** P13-09 · **Parallel with:** —
- Found in the final review of P13-09–P13-11, already true on `main`: a delete whose target is a bare variable the line never sets (`rm -rf $X` with `X` from the environment, `$1`, `$@`, `${!X}`) is not marked unplaceable, so it reaches the judge instead of Cosmin; and paths are compared as text, so a symlink planted in the worktree or scratch folder (`ln -s / $SD/l; rm -rf $SD/l/etc`) reads as inside. Decide with Cosmin first: forwarding every such delete adds cards (e.g. `git branch -D "$b"`).
- **Cosmin's decision (2026-11-14):** keep asking for `rm -rf $X`; no agent creates symlinks; topic closed. SPEC decision 158. Done: every variable the line does not set to a literal, and every parameter, indirect name or command output, makes a delete unplaceable (forwarded); the gate refuses any command that makes a symbolic link, whatever the table or a rule says.

### P13-13 — Auto flag, approval marks and approval parts: protocol and storage (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** P13-12 · **Parallel with:** —
- Plan Task 1. Spec: `docs/superpowers/specs/2026-11-14-waykeeper-auto-mode-design.md`.

### P13-14 — Approval marks: deriving and matching (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** P13-13 · **Parallel with:** —
- Plan Task 2. Spec: `docs/superpowers/specs/2026-11-14-waykeeper-auto-mode-design.md`.

### P13-15 — The Auto judge (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** P13-14 · **Parallel with:** —
- Plan Task 3. Spec: `docs/superpowers/specs/2026-11-14-waykeeper-auto-mode-design.md`.

### P13-16 — Auto mode and marks in the watch, the runtime and the routes (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** P13-15 · **Parallel with:** —
- Plan Task 4. Spec: `docs/superpowers/specs/2026-11-14-waykeeper-auto-mode-design.md`.

### P13-17 — Web: three-way switch, approvals log by category, marks (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** P13-16 · **Parallel with:** —
- Plan Task 5. Spec: `docs/superpowers/specs/2026-11-14-waykeeper-auto-mode-design.md`.

### P13-18 — Docs and gates (added 2026-11-14)
- **Status:** done (2026-11-14) · **Depends on:** P13-17 · **Parallel with:** —
- Plan Task 6. Spec: `docs/superpowers/specs/2026-11-14-waykeeper-auto-mode-design.md`.

### P13-19 — The switch from the phone (added 2026-11-15)
- **Status:** done (2026-11-15) · **Depends on:** P13-18 · **Parallel with:** —
- Cosmin: "I want to be able to activate and deactivate the switch from the mobile phone as well." SPEC decision 160.
- **Acceptance:** `setWaykeeperApprovals` no longer refuses a remote origin (Off, fits the task, Auto); an agent is still refused (`invalid` in the command, 403 `agent_peer` at the route); the command and route tests cover a remote on and Auto on; SPEC 154/159, TECHNOLOGY §3.10 and the panel comment say so.

### P13-20 — Auto approves git pushes, never to the main branch (added 2026-11-15)
- **Status:** done (2026-11-15) · **Depends on:** P13-19 · **Parallel with:** —
- Cosmin: "We need to approve the pushing to git as well. add a restriction on pushing to the main branch." SPEC decision 161.
- **Acceptance:** in Auto a `git push` to a branch other than `main`/`master`/the default branch is approved without a quote; a push to the main branch, or one whose branch cannot be told (`--all`, `--mirror`, a pattern, a variable, a `cd`/`-C` with no refspec), is forwarded in both modes; `gh pr create` and other pushes still need a quote; the Auto label says "pushing to main"; tests in `git-push.test.ts`, `git-read.test.ts`, `approval-watch.test.ts`, `request-judge.test.ts`.

### P13-21 — A push or a PR is not publishing; `echo =====` is readable (added 2026-11-16)
- **Status:** done (2026-11-16) · **Depends on:** P13-20 · **Parallel with:** —
- Found in Cosmin's test (screenshots of 2026-11-16): on an Auto project every request of the "Common calendar + PR" Steward came to him, even `git branch -r | head`. The Waykeeper had planned the task `publishes` because it ended in a push and a PR; a publishing step's Steward runs under the publishing policy (every workspace command and network call asks) and is never judged by the Waykeeper (`watchApproval` skips publishing runs). Separately, `echo =====` (a separator) made a call unreadable: zsh `=` expansion. SPEC decision 162.
- **Acceptance:** the Waykeeper's `publishes` field, its prompt and the Harmonizer's `check_model` say publishing is posting content in Cosmin's name with `request_publish`, and that pushing a branch, opening or commenting on a PR or a CI deploy is not; a word of `=` signs only is readable as an argument of `echo` or `printf`, and stays unreadable as a command word, a redirect target or another program's argument (`permission-findings.test.ts`, `providers.test.ts`). A task already flagged keeps its flag.

### P13-22 — Outward steps last, in small final steps (added 2026-11-16)
- **Status:** done (2026-11-16) · **Depends on:** P13-21 · **Parallel with:** —
- Cosmin: the Steward did a lot of other work (reading PRs, Figma, branching); "the publishing part should have been in the end". Then: "I want the publishing tasks to be as granular as possible with commands that are only for that, and as close as possible to the end of the project or task. The same thing for the cleanup tasks. […] For the last ones ask for input. But don't block the work that does not need me, for something that can be postponed in the end of the task." Today `publishes` is a property of the whole task (decision 146), so the publishing policy and the bypass of Waykeeper approvals cover the Steward's whole run; the fix is to make the publishing task small and last, not to change the policy. SPEC decision 163.
- **Acceptance:** the Waykeeper's prompt plans what needs nobody first (fetch, read, implement, review, test locally) and the outward steps last (push and PR, database changes and deploys to shared environments, account or settings changes, publishing, cleanup): a Steward may push its own branch and open its PR as the last step of its task; every other outward step and every publish is its own final task, blockedBy the tasks it needs, naming only those commands; questions about the final steps wait for the final task. A publishing task waits only for the tasks it needs (Cosmin: "a publishing task should wait for tasks that it needs for the publishing"); no server check, since the server cannot tell which those are. Every Steward's etiquette says the same order, and that a question only about a final step waits until the rest is done. Tests in `providers.test.ts` and `steward-prompt.test.ts`.

### P13-23 — Protocol shapes, events, projection, migration, board (added 2026-11-18)
- **Status:** done (2026-11-18) · **Depends on:** P13-22 · **Parallel with:** —
- Auto approves everything; sends and spends need a grant (SPEC decision lands with P13-31; design `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md`). Task 1 of plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`: its steps and acceptance are there.

### P13-24 — Domain — grants and the standalone scope (added 2026-11-18)
- **Status:** done (2026-11-18) · **Depends on:** P13-23 · **Parallel with:** —
- Auto approves everything; sends and spends need a grant (SPEC decision lands with P13-31; design `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md`). Task 2 of plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`: its steps and acceptance are there.

### P13-25 — The request judge's `grants` mode (added 2026-11-18)
- **Status:** done (2026-11-18) · **Depends on:** P13-23 · **Parallel with:** —
- Auto approves everything; sends and spends need a grant (SPEC decision lands with P13-31; design `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md`). Task 3 of plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`: its steps and acceptance are there.

### P13-26 — The approval watch's new Auto path (added 2026-11-18)
- **Status:** done (2026-11-18) · **Depends on:** P13-24, P13-25 · **Parallel with:** —
- Auto approves everything; sends and spends need a grant (SPEC decision lands with P13-31; design `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md`). Task 4 of plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`: its steps and acceptance are there.

### P13-27 — Runtime — no bypass paths; holding a send (added 2026-11-18)
- **Status:** done (2026-11-18) · **Depends on:** P13-26 · **Parallel with:** —
- Auto approves everything; sends and spends need a grant (SPEC decision lands with P13-31; design `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md`). Task 5 of plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`: its steps and acceptance are there.

### P13-28 — The Waykeeper's `answer_send_permission` (added 2026-11-18)
- **Status:** todo · **Depends on:** P13-27 · **Parallel with:** —
- Auto approves everything; sends and spends need a grant (SPEC decision lands with P13-31; design `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md`). Task 6 of plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`: its steps and acceptance are there.

### P13-29 — `request_publish` in Auto (added 2026-11-18)
- **Status:** todo · **Depends on:** P13-27 · **Parallel with:** —
- Auto approves everything; sends and spends need a grant (SPEC decision lands with P13-31; design `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md`). Task 7 of plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`: its steps and acceptance are there.

### P13-30 — Web — grants, the send card, standalone settings, log labels (added 2026-11-18)
- **Status:** todo · **Depends on:** P13-24, P13-28 · **Parallel with:** —
- Auto approves everything; sends and spends need a grant (SPEC decision lands with P13-31; design `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md`). Task 8 of plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`: its steps and acceptance are there.

### P13-31 — Docs and the board (added 2026-11-18)
- **Status:** todo · **Depends on:** P13-29, P13-30 · **Parallel with:** —
- Auto approves everything; sends and spends need a grant (SPEC decision lands with P13-31; design `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md`). Task 9 of plan `docs/superpowers/plans/2026-11-18-auto-approves-all.md`: its steps and acceptance are there.
