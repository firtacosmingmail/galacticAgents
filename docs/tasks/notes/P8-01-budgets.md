# P8-01 — Dollar budgets per project and task

Built on `p8-01-budgets`, branched from `p8-wave1-drills-retention-budgets` (2db7b57). Migration **0012** (`0012_budgets.sql`; written as 0011 on the branch and renumbered at the merge into the wave branch, where P8-02's `0011_transcript_compactions.sql` came first). No real Claude runs: every cost in the tests is a fake one (the fake adapter's new `cost` step, or `finish`/`fail` with a cost).

## What was built

| Where | What |
| --- | --- |
| `packages/protocol/src/budget.ts` (new) | `AgentSpend` and `foldSpend` (the per-agent spend fold), `budgetUsage` / `budgetAgents` / `projectFamily` / `budgetLevel` (how a project or task stands), `formatUsd`, `DEFAULT_BUDGET_WARN_PERCENT` (80). One implementation for the server's projection and the client's fold. |
| `domain.ts` | `BudgetUsd` (positive dollars, ≤ 1 000 000), `BudgetTarget` (`{kind: project\|task, id}`), `Project.budgetUsd?`, `Task.budgetUsd?`, a card's `meta.budgetUsd` (`foldProposalMeta`'s `budgetUsd`, `proposalBudget`). |
| `events.ts` | `budget.set {target, usd?, previousUsd?, by}`, `budget.warning {target, spentUsd, budgetUsd, warnAtPercent}`, `budget.exceeded {target, spentUsd, budgetUsd}`, `budget.spawn_refused {target, role, taskId?, projectId?, supervisorId?, spentUsd, budgetUsd, reason}`. `ProjectChanges` / `TaskChanges` take `budgetUsd` (clearable with `null`); `proposal.edited` takes `budgetUsd` (nullable). Fixtures added. |
| `ws.ts` | `Snapshot.spend?: AgentSpend[]` (optional: older servers send none). |
| `commands.ts`, `rest.ts`, `panel.ts` | `DomainCommands.setBudget(target, usd \| null, by, write?)`; `budgetUsd` in a card's edit and in `POST /api/control` edit; `Settings.budgets?: {warnAtPercent}` / `SettingsPatch.budgets`, setting name `budgets`. |
| Migration 0012 | `projects.budget_usd`, `tasks.budget_usd` (REAL, `NULL` = none); `agent_spend` (per agent: `usd`, `reported`, `session`, `sessions` JSON); `budget_notices` (per target: the highest notice given for its current budget). |
| `db/tables.ts` | The columns; `tables.spend` and `tables.budgetNotices`. `Table` now prepares its statements on first use (an older schema can be opened by a migration test as long as only its columns are used). |
| `domain/event-log.ts` | The log's own in-transaction projection: every inserted event goes through `projectBudgetEvent` (spend, notices) in the command's transaction. A log written before 0012 is folded once at the next start (settings key `budget_projection`). `snapshot()` carries `spend`. |
| `domain/budgets.ts` (new) | `setBudget` (row change + `budget.set`, the remote rule), `checkSpawnBudget`, `noticeBudgets`, `budgetTargets` / `agentTargets`, `targetName`. |
| `domain/commands.ts` | `setBudget`; `spawnAgent` checks the budgets after placement and the one-live-agent slot, logs `budget.spawn_refused` and throws `DomainError('conflict', reason)`; `updateProject` / `updateTask` refuse `budgetUsd` (budgets go through `setBudget`). |
| `domain/control.ts` | A panel edit may carry `budgetUsd`: `control.edit` records it and `setBudget` applies it in the same transaction. |
| `domain/proposals.ts` | A card's budget is the user's (like its trust level); a plan card accepts a budget-only edit (pending/edited); the approval sets the budget of the project or task it creates, a plan card's on its project. |
| `runtime/budgets.ts` (new) | `BudgetWatcher`: after each cost report, `agent.updated`, `budget.set` and at start, logs the notices due; posts every notice and the first refused spawn per target and budget in the running Harmonizer's chat (a system `message.sent`, which never wakes it). A new threshold re-judges every budget. |
| `runtime/compose.ts`, `index.ts` | `budgets?: {warnAtPercent}`; `ComposedRuntime.budgets`. |
| `config/config.ts`, `config/settings.ts` | `budgets.warnAtPercent` in `config.json` or `GALACTIC_BUDGET_WARN_PERCENT` (1–100, default 80; env-decided = read-only); the settings page saves it locally only and applies it live. |
| `brains/wake.ts` | `budget.set`, `budget.warning`, `budget.exceeded` wake the brain that runs the work: the project's Waykeeper (or the task's project's), the Harmonizer for an asteroid task. Never the Harmonizer for a Waykeeper's project (its chat already shows the notice); `budget.spawn_refused` wakes no one (the asker has the tool error). |
| Harmonizer | `control_work` edit takes `budgetUsd` (dollars, `null` removes; raising/removing only for a local user's message). Prompt: a "Budgets" section. Waykeeper prompt: a "Budget" line (do not retry a refused spawn, report once, wait for "budget … is now"). |
| Fake adapter | A `cost` step sets the session's running cost; every later `agent.idle` of the session carries it (cumulative, like the SDK). |
| Web | `WorldState.spend` folded with `foldSpend` from the snapshot on (and a card's `budgetUsd` folded into its meta, as the server does); `budgetOf` / `budgetText` in `status-model.ts`; a budget line (`BudgetFact`) in the project status (and on each budgeted task row) and in the Steward view's task facts; a budget field in the project/task edit form, on the work card (shown in its facts) and on the plan card ("project budget"); a "Budgets" section on the settings page (after the wizard's sections: not a first-run step). |

## Design

### Cost aggregation: cumulative per session, summed over sessions

The runtimes report a **cumulative** cost (P1-08: every SDK `result` carries the session's running `total_cost_usd`; a resumed session continues from the total its transcript saved). Adding every report would count a turn many times; taking the last report would lose money on a fresh session. So per agent:

- the session a report belongs to is the one opened by the agent's last `agent.spawned` — its `sessionRef`, or `#<seq>` when the spawn had no ref (it cannot be a resume);
- a session's meter is the **highest** dollar figure it reported (`agent.idle`, `agent.finished`, `agent.failed`);
- the agent's spend is the **sum of its sessions' meters**.

A resume under the same ref (the SDK's, after a restart or a lost turn) keeps its meter — a report lower than before (a transcript saved before the last turn) changes nothing, and nothing is counted twice; a session reset or the fresh session that replaces a lost resume gets a new ref and adds its own meter. The fold is in the protocol (`foldSpend`), run by the server inside the event's transaction into `agent_spend` and by the client from the snapshot's `spend` on; the web's replay conformance test checks they agree at every commit. The table outlives the status records (24 h) and anything that trims the log; an old log is folded once.

A project's spend is its Waykeepers', its tasks' Stewards' and its sub-projects' (decision 10: a sub-project is part of its parent's project), by the agents' current rows (a handed-over Steward counts where it is now). A task's spend is its Stewards'. The Harmonizer counts against nothing.

### Subscription sessions: cost is reported

The P1-08 spike answered the design note's question: under a subscription login the SDK still reports `total_cost_usd` — an estimate, notional on a subscription. Budgets therefore apply to every Claude SDK agent, measured against that estimate, and the settings page says so. An agent whose runtime reports no dollar figure (a PTY or ACP adapter without usage, the fake adapter without a `cost` step) counts as nothing: the panel shows "cost not reported" (or "N of M agents did not report a cost") and a budget is not enforced on work none of whose agents reported — "cost not reported, so not enforced".

### Mid-run: warn, refuse new spawns, never stop

When the reported spend reaches the warning threshold (`budgets.warnAtPercent`, default 80 %), `budget.warning` is logged once per budget value; at the budget, `budget.exceeded` once (a jump straight past the budget logs only the exceeded notice). Both are posted in the Harmonizer's chat and wake the Waykeeper that runs the work. **Running agents are not stopped or paused** — a Steward half-way through a change is worth more than the cents it would save, and stopping it could leave a worktree in a broken state. What the budget does is refuse **new** Waykeepers and Stewards for the work (`spawnAgent`: `conflict` + `budget.spawn_refused`; the first refusal per target and budget is posted in the Harmonizer's chat). Resumes after a restart, the user's "Resume session" and session renewals are the same agent continuing, not new spawns, and are not refused (like the rate caps, P2-17). Raising or removing the budget re-arms the notices; lowering it below the spend logs `budget.exceeded` again for the new value.

Pausing the work at the budget was considered and left as an option for later (see the proposed decision): it would need a setting, and a pause of a Steward that holds a permission card or a merge would surprise more than it saves.

### Who may set a budget

Setting a budget or lowering it is a tightening: allowed from anywhere, the phone included (decision 90's spirit). Raising or removing it loosens a safety limit: allowed only for a local request, or with `autoApproveRemote` — like decision 37's floor for permission tables. An agent (unknown origin) may set or lower one; the Harmonizer's `control_work` passes the origin of the user message it acts on. A card's budget is the user's to give (a brain's edit is refused, like the trust level); the approval then sets it on the new row (a tightening). Approving a plan card whose budget would raise the project's existing budget from a remote client is refused as a whole; the user can drop the budget from the card or approve on the Mac.

## Proposed SPEC text

> | 97 | Dollar budgets | **Warn, refuse new agents, never stop running ones** (2026-10-05, P8-01; refines 18, §2.8): a project or task may have a dollar budget, given on its work card or plan card, its edit form, or by asking the Harmonizer. It is measured against the cost the runtimes report — an estimate, notional under a subscription login — summed over every agent that worked on it (a project: its Waykeepers, its tasks' Stewards and its sub-projects); a runtime that reports no cost counts as nothing and the panel says "cost not reported". At a share of the budget set in the settings (default 80 %) the user is warned in the Harmonizer's chat and the Waykeeper that runs the work is told; at the budget, no new Waykeeper or Steward is started for the work — the spawn is refused with the reason, which the Harmonizer's chat shows — but running agents go on and are not paused, and resuming an interrupted one is not a new spawn. Raising or removing the budget lets the work start agents again. Setting or lowering a budget works from anywhere; raising or removing one only on the Mac (or with `autoApproveRemote`), as decision 37 holds permission tables. Pausing work at its budget is a possible later option, not the default. |

SPEC §2.8 ("Cost safety") could end: "…dollar budgets per project and task warn at a threshold and refuse new agents beyond the budget (decision 97)". §4.6 (settings) could list "the budget warning threshold".

## Proposed TECHNOLOGY text

§5.4, append:

> **Dollar budgets (P8-01).** `projects.budget_usd` / `tasks.budget_usd` (migration 0012) hold the budgets; `setBudget` changes them (`project.updated`/`task.updated` + `budget.set`; raising or removing needs a local origin or `autoApproveRemote`). The event log projects every inserted event, in its transaction, through `projectBudgetEvent`: the per-agent spend (`agent_spend`, the protocol's `foldSpend`: per session the highest cumulative `cost.usd` reported, summed over sessions; a session is the last `agent.spawned`'s `sessionRef`) and the notices already given (`budget_notices`). `Commands.spawnAgent` refuses a Waykeeper or Steward whose task or any project above it has spent its budget (`budget.spawn_refused` + `DomainError('conflict')`); the Harmonizer, resumes and renewals are never refused. The `BudgetWatcher` logs `budget.warning` (at `budgets.warnAtPercent`, default 80) and `budget.exceeded` once per budget value and posts them, and the first refused spawn per budget, in the running Harmonizer's chat as system messages. Running agents are never stopped for money.

§5.2 (wake table): add `budget.set`, `budget.warning`, `budget.exceeded` — the brain that runs the work (a project's Waykeeper; the Harmonizer for an asteroid task only).

§6.2/§6.3: the snapshot carries `spend: AgentSpend[]`; the client folds it with `foldSpend` (`agent.spawned`, `agent.idle`, `agent.finished`, `agent.failed`).

§7 (vocabulary): `BudgetUsd`, `BudgetTarget`, `Project.budgetUsd`, `Task.budgetUsd`, `AgentSpend`, `foldSpend`, `budgetUsage`, `formatUsd`, the four `budget.*` events, `Snapshot.spend`, `DomainCommands.setBudget`, `Settings.budgets`, the fake adapter's `cost` step.

## Tests (all with fake costs)

- `packages/protocol/src/budget.test.ts` (10): cumulative per session, resume vs fresh session, spawns without a ref, reports without dollars, project family / task / unreported agents, levels and money formatting.
- `apps/server/src/domain/budgets.test.ts` (5): `setBudget` and its remote rule, the edit path, updates refused; card budgets (work card → task, plan card → project, brains refused); warning once, exceeded once, running Steward untouched, refused spawns (nothing written but the refusal, one chat line per budget), raise re-arms, lower re-judges; a task budget and the Harmonizer never refused; the spend across a restart (no repeated notice) and the one-time fold of an old log.
- `apps/server/src/brains/harmonizer/budget.test.ts` — **acceptance** with the scripted fake LLM: a card budget, a Steward failing with a cost over it, the user reopening the task, the Harmonizer's `spawn_steward` refused ("budget exceeded"); its chat (`History.conversation`, what `GET /api/agents/:id/conversation` serves) shows the server's "Budget exceeded" and "Spawn refused" lines and the Harmonizer's reply.
- `wake.test.ts`: the whitelist plus a budget test; `settings.test.ts`: the threshold (local only, env override, invalid value); `control-work.test.ts`: one message updated.
- Web: `state/conformance-budgets.test.ts` (replay vs snapshot with spend, budgets, card budgets, notices, a refused spawn, a session renewal), `status-views.test.tsx` (budget lines), `AgentCards.test.tsx` (edit form), `Inbox.test.tsx` (work card and plan card), `settings.test.tsx` (the Budgets section).

## Deferred / findings

- **Pause at the budget** as an opt-in setting (`budgets.onExceeded: warn | pause`), if dogfooding shows runaway Stewards.
- **Desktop and push notifications** for `budget.warning` / `budget.exceeded` (P25-07, P7-04): today they are chat lines and status lines only.
- **The Harmonizer's status view** ("needs attention") does not list budgets near or over; the project and task views do.
- **Agent cards** still show the agent's `costSoFar` (the status record), not its lifetime spend from `world.spend`; switching would make an ended agent's cost survive the 24 h status retention.
- **Per-agent budgets** and a **global daily budget** are not built.
- The budget is checked at spawn time; two spawns racing at the threshold may both start (each is under the budget when checked), which is acceptable for an estimate-based limit.
