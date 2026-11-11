# Phase 13 — Waykeeper approvals

**Current task:** — · **Task status:** all done (2026-11-11)
**Phase status:** done (2026-11-11) (8/8) — merged into `main` (PR #12)

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

P13-01…07 run in order; P13-08 runs beside P13-07.

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
