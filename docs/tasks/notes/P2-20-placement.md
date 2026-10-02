# P2-20 — Hierarchy placement invariants and clearable fields

From the P2-01 review (`P2-wave1-review.md`, findings 7 and 9).

## What was built

### Placement invariants (`apps/server/src/domain/agents.ts`, `domain/commands.ts`)

- `checkPlacement(reader, {role, id?, supervisorId?, taskId?, projectId?})` holds the rules. Both `Commands.spawnAgent` (before any session opens, so a refusal writes nothing) and `updateAgent` (on the row it would write) call it:
  - **Harmonizer:** no supervisor, no task, no project.
  - **Waykeeper:** has a project and no task. Its supervisor is the Harmonizer, or, when the project has a `parentProjectId`, the parent project's Waykeeper.
  - **Steward:** has a task, and its `projectId` equals the task's project (both are absent for an asteroid task). Its supervisor is the task's project's Waykeeper, or the Harmonizer for an asteroid task (decision 6).
  - The supervisor must exist (`not_found`) and must match the rule (`invalid`, with the expected supervisor named in the message: "needs a supervisor: the Waykeeper of project p-…" or "answers to the Harmonizer, not to waykeeper a-…").
- `spawnAgent` for the Harmonizer:
  - Places it on **Earth** (`EARTH_ID`) instead of a new asteroid. Earth is only the agent row's `bodyId`. No `body.assigned` is emitted, and Earth stays reserved and unhosted.
  - Refuses a second Harmonizer (`conflict`, "the Harmonizer is already running (a-…)") while another Harmonizer is *living* (`QuestionRouting.isLiving`: its last lifecycle event is `agent.spawned`). One that has ended can be replaced.
  - The order of checks is placement, then working directory, then uniqueness.
- `updateAgent`:
  - Runs `checkPlacement` whenever `supervisorId`, `taskId` or `projectId` changes. A promoted Steward is therefore handed over in one update (`{projectId, supervisorId}` after `moveTask`); half a hand-over is refused.
  - Refuses any body other than Earth for the Harmonizer.
  - A body-only move skips the rules, so rows from before the rules (Phase 1 ops console) can still fly.
- The Phase 1 ops console spawns through `AgentRuntime.spawn` directly (`/api/agents`) and is untouched. The invariants apply to the `DomainCommands` surface.

### Clearable fields (protocol → commands → reducer)

- `packages/protocol/src/events.ts`:
  - `ProjectChanges` / `TaskChanges` schemas (used by `project.updated` / `task.updated` and by `DomainCommands.updateProject` / `updateTask`). In them, `repoPath`, `parentProjectId` and `permissionPolicy` (project) and `worktreePath` and `branch` (task) are `.nullable()`.
  - `CLEARABLE_PROJECT_FIELDS` / `CLEARABLE_TASK_FIELDS`.
  - `applyChanges(row, changes)`: the one patch rule. `undefined` leaves a field unchanged, `null` removes it, any other value replaces it.
- `apps/server/src/domain/changes.ts` `effectiveChanges` (used by `updateProject` / `updateTask`):
  - drops `undefined`;
  - drops a `null` for a field that is already absent (a no-op emits nothing);
  - refuses `null` on any other field (`invalid`, "a task's description cannot be cleared").
  - The row is written with `applyChanges`, and the event carries the `null`.
- `apps/web/src/state/reduce.ts` `patch` folds with the same `applyChanges`.
- `workspace/workspaces.ts`:
  - A successful `mergeTask` now clears `worktreePath`, and clears `branch` when the branch was deleted. `meta.merge.branch` keeps the record.
  - `removeWorktree` clears `worktreePath`, and clears `branch` with `deleteBranch`.
  - A reopened task therefore gets a new worktree, and a Steward is never sent into a removed folder.

### Tests

- `domain/placement.test.ts` (new): `updateAgent` re-parenting, the Harmonizer rules, every supervisor rule, task/project agreement, the promotion hand-over, the Waykeeper/task refusal, and the body-only move. It replaces the old `updateAgent` case in `questions.test.ts`.
- `domain/commands.test.ts`, new `spawnAgent placement invariants (P2-20)` block:
  - Harmonizer on Earth without occupying it, with no asteroid created;
  - second Harmonizer refused while one runs, allowed after a stop;
  - Harmonizer with a supervisor or a project refused;
  - every missing or wrong supervisor refused with nothing written;
  - a sub-project Waykeeper under the parent's Waykeeper.
- Clearing:
  - `projects.test.ts`: detach / drop the policy / drop the repo path, re-attach, no-op, required fields refused;
  - `tasks.test.ts`: worktree and branch cleared, no-op, required fields refused;
  - `events.test.ts`: the schemas accept `null` only on clearable fields, plus `applyChanges`;
  - `workspaces.test.ts`: merge and remove clear the fields.
- `apps/web/src/state/conformance.test.ts`:
  - The scenario now has a Harmonizer on Earth, a Waykeeper under it, an asteroid Steward under the Harmonizer, and a promotion hand-over (`moveTask` then `updateAgent({projectId, supervisorId})`).
  - It clears `worktreePath`/`branch`, `parentProjectId`, `permissionPolicy` and `repoPath`, and checks that the folded world equals the server snapshot at every commit and that the cleared keys are absent (not `null`).
- Existing tests now build a real hierarchy instead of weakening the rule:
  - new helper `apps/server/src/test/hierarchy.ts` (`spawnHarmonizer`, `spawnWaykeeper`, `projectHierarchy`), used by `commands.test.ts`, `catalogue.test.ts`, `agent-routes.test.ts` (concurrency cap raised to 3 for the control test) and `work-state-deriver.test.ts`;
  - in that file, an escalated question now goes Waykeeper → Harmonizer → user;
  - `brains/runner.test.ts` (minimal): its Waykeeper brain gets a Harmonizer row as supervisor.

Counts: protocol 48, server 581 (+1 skipped), web 31. All green; build, typecheck, lint and format:check pass.

## Decisions (proposed text, ready to paste)

**SPEC §7, decision N. Placement invariants (2026-10-01, P2-20).**
- **The Harmonizer.** It lives on Earth, the headquarters. Placing an agent on a body is not hosting work, so Earth stays reserved and unassigned. There is at most one *running* Harmonizer: a second spawn is refused while one runs, and one that has ended (stopped, failed, interrupted) may be replaced. After a restart, the resume path brings the old one back instead (P2-16). The Harmonizer never has a supervisor, a task or a project.
- **Supervisors.** Every Waykeeper and Steward has the supervisor SPEC §2 prescribes:
  - a Waykeeper: the Harmonizer; for a sub-project, the parent project's Waykeeper;
  - a project Steward: its project's Waykeeper;
  - an asteroid Steward: the Harmonizer (decision 6).
- **How the match is made.** Supervisors are matched by role and project: any Harmonizer, or a Waykeeper of exactly that project. They are not matched by a fixed agent id or by liveness. A replacement Waykeeper of the same project can therefore take a Steward over, and a Steward whose supervisor died keeps its row: its questions go to the next living supervisor (decision 26).
- **Project changes.** A Steward's project is always its task's project. Promoting work (a task joining a project) re-parents its Steward in the same update that changes its project.

**SPEC §7, decision N+1. Clearing a field (2026-10-01, P2-20).**
- An update clears an optional field with an explicit `null`. Only these fields can be cleared: a project's `parentProjectId` (the sub-project becomes an independent project on its moon, decision 10), `permissionPolicy` (back to the global default) and `repoPath`, and a task's `worktreePath` and `branch`.
- Required fields cannot be cleared. A task leaves a project only by moving, and a body changes only by moving.
- A merged or removed worktree is cleared from its task (and its branch too, once deleted); `meta.merge` keeps the record.

**TECHNOLOGY §6.2, addition to "Domain state is derived twice by design".**
> *Patch rule (P2-20).*
> - `project.updated` / `task.updated` carry `changes` validated by `ProjectChanges` / `TaskChanges` (`packages/protocol`). A key that is absent or `undefined` is unchanged. An explicit `null` removes the field. That is allowed only on the clearable fields (`CLEARABLE_PROJECT_FIELDS`: `repoPath`, `parentProjectId`, `permissionPolicy`; `CLEARABLE_TASK_FIELDS`: `worktreePath`, `branch`), and the commands refuse it anywhere else.
> - The server's commands and the web reducer apply changes with the same `applyChanges` from the protocol package, so the cleared key is absent on both sides, never stored as `null`.
> - Clearing an absent field is a no-op and emits nothing.
> - JSON carries `null` unchanged, so a dedicated "cleared" event is unnecessary.
> - `agent.updated` has no clearable fields: no agent row is ever left without a supervisor it must have (§5, placement invariants).

**TECHNOLOGY §5 (brains / hierarchy), one line.**
> *Placement (P2-20).* `checkPlacement` (`domain/agents.ts`) holds the hierarchy rules for `spawnAgent` and `updateAgent`: the Harmonizer on Earth, one at a time, unsupervised; every other agent under the supervisor SPEC decision N prescribes, matched by role and project. The Phase 1 ops console (`/api/agents` → `AgentRuntime.spawn`) is outside these rules.

## Deferred

- **Re-parenting on detach / attach.** `updateProject({parentProjectId: null | id})` does not re-parent the project's Waykeeper, so after a detach its supervisor (the old parent's Waykeeper) no longer matches the rule. The next `updateAgent` on it that touches placement must fix the supervisor. P2-12 (promotion and moves) should do the hand-over in the same command.
- **Uniqueness race.** The living-Harmonizer check runs before the async runtime spawn, outside the transaction, so two spawns started at the same moment could both pass. P2-08 starts exactly one Harmonizer at boot, and P2-16 must resume an interrupted Harmonizer instead of spawning a new one.
- **Concurrency cap.** The cap counts brains: the Harmonizer and the Waykeepers use slots under `maxConcurrentAgents`. Whether brains should count against the cap is for P2-17 / P2-08 to decide.
- **Living supervisors.** `spawnAgent` does not require the supervisor to be living (it is matched by role and project only). A brain spawning a Steward is live by definition. Spawning under an ended supervisor leaves an orphan whose questions route upward (decision 26).
