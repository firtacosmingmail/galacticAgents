# P2-10 — Waykeeper brain

Built in a worktree branched from `p2-wave4-brains`, 2026-10-02, alongside P2-08 and P2-21. No migration: plan cards and closure requests live in the existing `meta` columns. No new event type.

## What was built

| File | What it does |
| --- | --- |
| `brains/waykeeper/prompt.ts` | `WAYKEEPER_SYSTEM_PROMPT` covers coordination, planning once, worktrees, judging when work is done, answering from context (decision 12), escalation, promotion, closure and turn-ending tools. `stewardPrompt` is the seam P2-11 replaces. Also `sendBackPrompt`, `externalConflictText` and `EXTERNAL_CONFLICT_OPTIONS`. |
| `brains/waykeeper/tools.ts` | `plan_tasks`, `create_task`, `spawn_steward`, `merge_task`, `close_task`, `escalate`, `request_promotion`, `request_project_closure` (`WAYKEEPER_TOOLS`), plus the helpers `projectOf`, `taskOf`, `stewardsOf` and `MAX_SEND_BACKS` (2). |
| `brains/waykeeper/index.ts` | `waykeeperDefinition()` returns the Waykeeper tools plus `commonTools()`. Start it with `composed.startBrain(waykeeperDefinition(), { runtime, projectId, supervisorId })`. |
| `brains/common-tools.ts` | The shared supervision tools (API below). |
| Tests | `brains/waykeeper/waykeeper.test.ts` (5 tests: harness plus temp git repositories), `brains/common-tools.test.ts` (2), plan-card tests in `domain/proposals.test.ts` (4), and an external-conflict test in `workspace/workspaces.test.ts` (1). |

### Tool semantics

- **`plan_tasks {summary, rationale?, tasks:[{description, priority?, blockedBy?: positions}]}`** ends the turn. It calls `proposePlan`.
- **`create_task`** is allowed only after the plan was approved. It is refused while a plan card is waiting for the user. The new task is `approved`.
- **`spawn_steward {taskId, instructions}`**:
  - Refused when the task is proposed or finished, when its blockers are not completed, or when the task already has a live Steward.
  - If the workspace was never prepared, it calls `prepareProject` first. Without `initGit`, so an existing non-git folder stays as it is and the project is serialised.
  - Serialised project: only one live Steward per project, running in the workspace.
  - Otherwise: `createWorktree`, then `spawnAgent` with `supervisorId` = this brain and the brain's own runtime. The project policy is applied by `spawnAgent`.
- **`merge_task {taskId, commitPending?, note?}`**:
  - Serialised project: returns `merged: true, serialised: true`.
  - Refused while the task's Steward is busy (starting, working, waiting, stalled or paused).
  - Success: returns the merge facts and clears `meta.mergeConflict`.
  - Conflict with `external: false` and fewer than 2 send-backs: the Steward is sent back. A live Steward gets the instruction as a message; an ended one is spawned again on the same task, which reuses its kept worktree. The tool records `meta.mergeConflict.sentBack` and returns `action: 'steward_sent_back'`.
  - Conflict with `external: true`, or after 2 send-backs: the tool opens a clarification question from the Waykeeper and the system escalates it hop by hop until the user holds it. The question carries the files, both branches, the external commits and three options. Its id is kept in `meta.mergeConflict.questionId`, so asking again does not open a second question.
  - Any other failure (`worktree_dirty`, …) is returned as a value, not as an error.
- **`close_task {taskId, unmerged?}`**:
  - Refused while the task has an unmerged worktree, unless `unmerged: true`.
  - Refused while its Steward is busy.
  - Otherwise it closes the task and stops the task's live, idle Stewards. The result lists the open tasks; when none are left it carries `allTasksClosed: true` and a hint to call `request_project_closure`.
- **`escalate {questionId}`** passes a held question up the hierarchy (refused for permission questions). **`escalate {text, options?}`** opens the brain's own question, held by its supervisor. It ends the turn.
- **`request_promotion {taskId, to: moon|planet, reason}`** creates a pending proposal with `meta.promotion = {taskId, fromProjectId, requestedBy, noFreeBody?}`. Its body is suggested by `chooseBody`; for a moon that is a sub-project of this project. It ends the turn. P2-12 does the move.
- **`request_project_closure {summary}`**:
  - Refused while any task is open (anything other than completed, archived or moved), when no task was ever completed, or while Stewards are still running.
  - Records `project.meta.closureRequest = {by, summary, tasks}`.
  - Sends the report "every task is closed …" to the supervisor, which wakes the Harmonizer.
  - It ends the turn. P2-13 completes the closure.

## The plan card

A plan card is an ordinary `Proposal` that carries `meta.plan = ProposalPlan{projectId, waykeeperId, taskIds}`. Its `kind`, `proposedBody` and `workspace` repeat the project's, so the existing card UI and reducer show it unchanged.

- **`DomainCommands.proposePlan`** (new) creates the tasks `proposed` and the card in **one transaction**: `task.created`×N, then `proposal.created`.
- **One plan per project.** A new plan is refused while a card is pending, edited or parked, and after one was approved. A plan made after a rejection replaces the rejected draft: that draft's tasks that are still `proposed` are archived.
- **`decideProposal` on a plan:**
  - Only a non-agent actor may decide it (decision 3).
  - `approve` approves, in the same transaction, every plan task that is still `proposed`. A task the user archived meanwhile stays archived.
  - `reject` keeps the draft.
  - `edit` and `park` are refused: a plan is edited through its tasks (`updateTask`, or archive one).
- **Wake rule.** `WakeScope.ownsProposal` gives a plan card to the Waykeeper of `plan.projectId`, by role and project, so a replacement Waykeeper learns the decision too. Every other proposal still belongs to the Harmonizer. The Harmonizer is never woken by a plan decision (tested).
- `createProposal` refuses a `meta.plan` (a plan card must come with its tasks). `proposalPlan(p)` is exported from the protocol for P2-09 and P2-18.

## Merge conflicts: `external` (decision 30)

`MergeConflict` now carries `external`, `externalCommits: {id, subject, author?}[]` (at most 20, newest first) and `externalCount`.

- **The base side** is `git rev-list --full-history --no-merges <merge-base>..HEAD -- <conflicting files>`, or the whole range if that comes back empty.
- **A commit is the project's own** when the merge of one of the project's tasks brought it in, that is, when it is in the range `before..commit` of that task's merge.
- To make that range available, a successful merge now records `before` (the base branch's head before the merge) in `MergeResult` and in `Task.meta.merge` (`MergeRecord`).

## Shared tools API (`brains/common-tools.ts`)

```ts
COMMON_TOOLS: readonly BrainTool[]   // stop_agent, pause_agent, resume_agent, get_agent_status,
                                     // list_supervised_agents, answer_question, report_status
commonTools(only?: string[]): BrainTool[]
isBelow(queries, brainId, agentId): boolean   // the supervisor chain reaches brainId
agentBelow(ctx, agentId): Agent               // the agent, or a DomainError (not_found / invalid)
describeAgent(ctx, agent)                     // what get_agent_status / list_* return
isLive(status): boolean
```

The actor is always `ctx.actor`, and every refusal is a thrown `DomainError`.

- **Reach.** `stop_agent`, `pause_agent` and `resume_agent` act on any agent below the caller, never on itself. `get_agent_status` works for the caller or any agent below it. `list_supervised_agents` lists direct reports.
- **`answer_question {questionId, answer, version?}`** answers clarification questions only (permission → `invalid`, decision 7). The caller must hold the question (otherwise `conflict`). An answered question goes to the command, which replies "already answered by …". The answer is logged with `answeredBy` = the caller.
- **`report_status {text}`** sends the text to the caller's supervisor (`ctx.send`). A brain without a supervisor (the Harmonizer) gets `{to: 'user', note}` back and tells the user in its reply. P2-08 may prefer its own version.

## Shared files touched (small, additive)

- **`packages/protocol`**:
  - `ProposalPlan` and `proposalPlan()` (domain.ts).
  - `CreateProposalInput.meta?`, `PlanTaskInput`, `ProposePlanInput` and `DomainCommands.proposePlan` (commands.ts).
  - `interfaces.test.ts` gets the new method.
- **`domain/proposals.ts`**: `proposePlan`, `plansOf`; `createProposal` stores `meta`; `decideProposal(ctx, id, decision, by?)` handles plan cards.
- **`domain/commands.ts`**: wires `proposePlan` and passes `by` to `decideProposal`.
- **`workspace/workspaces.ts`**: `external*` on `MergeConflict`, `before` on success, `MergeRecord`, `ExternalCommit`, `EXTERNAL_COMMITS_SHOWN`. The new names are also exported from `lib.ts`.
- **`brains/definition.ts`**: `BrainQueries.task`, `.question` and `.proposals`. `BrainToolContext.send(agentId, text)` sends a line as the brain; it wakes only its addressee. `BrainToolContext.workspaces?` is new.
- **`brains/seed.ts`**: the queries above and `ownsProposal` for plan cards.
- **`brains/runner.ts`**: `BrainRunnerOptions.workspaces?`; the tool context gets `send` and `workspaces`.
- **`runtime/compose.ts`**:
  - `ComposeOptions.workspaces?: Omit<WorkspacesOptions, 'commands'|'tables'>` builds `Workspaces` over the composed commands and tables.
  - The result is exposed as `ComposedRuntime.workspaces?` and handed to every brain.
- **`index.ts`**: passes `{ projectsRoot: config.projectsRoot, dataDir: config.dataDir }`. **This is the `Workspaces` seam.** Tests pass the same option through `brainHarness({ compose: { workspaces } })`.
- **P2-21 (remote floor).** No Waykeeper tool writes `permissionPolicy`. `request_project_closure` updates only `meta`, so no origin is needed. A future Waykeeper tool that writes a policy must pass the turn's origin.

## Decisions — proposed text

**SPEC §7, decision N — Plan cards (2026-10-02, P2-10).** A Waykeeper's plan is one card: its tasks exist as `proposed` tasks on the project's body from the moment it is shown. The user approves the plan as a whole, which approves every task still proposed; or rejects it with a reason, and the draft stays until the Waykeeper presents a better plan, which archives the old draft's tasks. The plan is edited through its tasks (edit a description, drop a task) before approving; the card itself has no size, body or workspace to edit. Only the user decides a plan. One plan per project: after approval the Waykeeper adds discovered work task by task, without a card.

**SPEC §7, decision N+1 — Merging and closing (2026-10-02, P2-10).** The Waykeeper merges a task before it closes it. Closing a task with an unmerged worktree needs an explicit "close unmerged", which keeps the branch and worktree. Closing stops the task's idle Steward. A conflict with the project's own work sends the task's Steward back at most twice. After that, as for external commits (decision 30), the user is asked: the question is opened by the Waykeeper and escalated to the user directly, with the files, both branches, the external commits and three suggested answers. A project's closure request is refused while a task is open or a Steward runs; it is recorded on the project and reported to the Harmonizer.

**TECHNOLOGY §5.1, after the tool table:**

> **Waykeeper (P2-10).** `brains/waykeeper/` holds the prompt and the tools; `brains/common-tools.ts` holds the supervision tools shared with the Harmonizer (`stop/pause/resume_agent`, `get_agent_status`, `list_supervised_agents`, `answer_question`, `report_status`). Their reach is the caller's subtree (`supervisorId` chain), and a refusal is a `DomainError` returned to the model. Tools get `ctx.send(agentId, text)` (a `message.sent` from the brain, which wakes only its addressee) and `ctx.workspaces` (the `Workspaces` service, built by `composeRuntime` from `ComposeOptions.workspaces`, which `index.ts` fills from `projectsRoot`/`dataDir`). A plan card is a `Proposal` with `meta.plan = ProposalPlan{projectId, waykeeperId, taskIds}`, made with its `proposed` tasks in one transaction by `DomainCommands.proposePlan`. Approving the card approves its tasks in the same transaction. The card's decision wakes the project's Waykeeper (`WakeScope.ownsProposal`), never the Harmonizer.

**TECHNOLOGY §8 (server-run git), one bullet:**

> `mergeTask` tells a conflict with the project's own work from one with external changes (SPEC decision 30). The base side is `rev-list --full-history --no-merges <merge-base>..HEAD -- <conflicting files>`. A commit is the project's own when an earlier merge of one of its tasks brought it in (`Task.meta.merge.before..commit`, recorded on every successful merge). The other commits are listed as `externalCommits` (short id, subject, author; at most 20 shown, `externalCount` in all).

## Seams for the next wave

- **P2-11 (Steward lifecycle).**
  - Replace `stewardPrompt` with the real template. Keep the Waykeeper's instructions in it.
  - The fake test Stewards pick their scenario from the leading `scenario:<name>` line; `merge_task`'s `note` is placed first for the same reason.
  - "Done report → supervisor decides": the Waykeeper is woken today by `agent.finished` and by a `message.sent` from a Steward it supervises. A Steward that only goes idle does not wake it: `agent.idle` has no wake rule. P2-11 should add a done report, either a Steward tool or treating idle-after-work as a report.
- **P2-13 (closure).** Read `project.meta.closureRequest`; the Harmonizer is woken by the report line. On user closure, stop the Waykeeper.
- **P2-17 (caps).** `spawn_steward` is the place for "max Stewards per Waykeeper" and the hourly spawn budget. A refusal thrown there reaches the model as `{error, message}`, and the prompt tells the Waykeeper to `report_status` it.
- **P2-09 (proposal flow).** Plan cards must be excluded from "approval triggers body assignment and spawns" (`proposalPlan(p) !== undefined`). Promotion requests are recognised by `meta.promotion`.
- **P2-12.** `request_promotion` creates the card only.
- **P2-18.** The plan card shows `meta.plan.taskIds` (the tasks' rows) with approve and reject only.

## Deferred / findings

- **A very fast subordinate can be missed.** `Commands.spawnAgent` returns every event of the new agent logged before the spawn resolved, and the runner drops those from the mailbox as the brain's own. A Steward that *finishes* before `spawnAgent` resolves would never wake its supervisor. A model never finishes that fast; the test Stewards wait 15 ms. A cleaner fix is to return only `agent.created`/`agent.spawned` from `spawnAgent`.
- **A sent-back Steward is a new agent.** It runs in the kept worktree, not in the old session: resuming a *finished* session is not supported by the runtime. P2-16 could add it.
- **A plan cannot change after approval.** There is no "re-plan" beyond `create_task`.
- **Merge failures other than conflicts are not escalated.** `worktree_dirty`, `workspace_dirty`, `not_on_base_branch` and `failed` are returned to the Waykeeper to handle (`commitPending`, or asking the user).
- **`report_status` for the Harmonizer** does not reach the user through an event; P2-08 decides.
- **The conformance walk does not include a plan card.** No new event or reducer rule was needed: plan approval is `proposal.approved` plus `task.state_changed`, which the reducer already folds.

## Tests

`pnpm test` — protocol 48, server 624 (+1 skipped), web 31. New: 5 Waykeeper acceptance tests (plan → single card; done → merge + close → closure request; conflict with the project's own work → Steward sent back and merged; external commits → user question; serialised workspace), 2 common-tools tests, 4 plan-card domain tests, 1 external-conflict workspace test.
