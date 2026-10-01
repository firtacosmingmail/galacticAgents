# Phase 2, batch 1 (wave 1: P2-01) — review

Branch `p2-wave1-domain-commands` against `phase-2`, reviewed 2026-10-01 by an independent reviewer agent reading the diff and reproducing with throwaway scripts outside the repo, plus the author's own mutation check of the conformance test (dropping the reducer's `agent.updated` fold fails it at the first re-parenting).

## Fixed on the branch

| # | Finding | Fix |
|---|---|---|
| 1 | `recordAgentEvent(agent.spawned)` logged a new session ref the row never got: replay and snapshot disagreed (reproduced) | routed through `recordSpawned`; tested |
| 2 | Project parent cycles accepted, after which neither project could be closed (reproduced) | `checkParent` walks the chain; an archived parent is refused |
| 3 | `archiveProject` skipped close's checks: `approved → archived`, active sub-projects and running tasks ignored, the body freed under live work (reproduced) | archive only from finished states (`proposed` drafts still archivable); refused while a sub-project or a task runs |
| 4 | `assignBody` and `moveTask` accepted finished hosts, reoccupying bodies without a reopen (reproduced) | refused with "reopen it instead/first"; reopen uses an internal `place()` |
| 5 | A second concurrent answer reached the adapter, and a refused log write after delivery was swallowed (race) | the runtime refuses an answer already under way (`stale`); the record error propagates; tested with two concurrent answers |
| 8 | A sub-project could sit on, or move to, another planet's moon (SPEC §3.2) | `checkSubProjectBody` on create, parent change, move and reopen |
| 10 | Re-opening a closed question id reset its version to 0 | the version keeps counting |
| 11 | Conformance walk missed `question.cancelled`, `control.archive`/`cancel`, `freeBody`, reopen on a fresh asteroid | added. Checkpoints are per commit (the last `seq` of each transaction), which is every state a client can observe |
| nits | local `OpenQuestionInput` shadowed the protocol name; a standalone Steward's `cwd` was silently ignored when it had a worktree | renamed `OpenQuestionRow`; refused |
| 6 | Docs (decision 24, TECHNOLOGY notes) not committed with the code | committed in the `done` commit |

## Deferred

- **7 — placement invariants** (Harmonizer on Earth, supervisors always set and of the right role, `taskId`/`projectId` agreement) and **9 — clearing optional fields** (patch semantics cannot clear `parentProjectId`, `permissionPolicy`, `worktreePath`, …): new task **P2-20**, after P2-02 seeds Earth.
- `decideProposal` ignores `by` (the proposal events carry no actor); add one if the history view (Phase 6) needs it.
