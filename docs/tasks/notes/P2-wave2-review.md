# Phase 2, batch 2 (wave 2: P2-02, P2-03, P2-05, P2-06, P2-14, P2-15) — review

Branch `p2-wave2-services` against `phase-2`, 2026-10-01. The six tasks were built by parallel agents in separate worktrees (each from the batch branch) and merged by the coordinator; the review was an independent agent reading the combined diff, reproducing with throwaway tests outside the repo, and running the server suite three times (no flakes).

## Found and fixed while merging

| Clash | Fix |
|---|---|
| P2-15 × P2-14: a cancel's explicit task and project states were re-derived mid-commit — the deriver handled `task.state_changed` before the project's hold was folded and wrote `in_progress` over the cancelled project | the deriver collects the commit's items and derives once its last event is folded |
| P2-15 widened the transition table, so pause/stop on a cancelled (failed) task were accepted | pause and stop refuse finished work explicitly |
| P2-02 seeds the catalogue by migration; other agents' tests inserted their own bodies | tests use the seeded catalogue |
| P2-14 × P2-06: `concernedSupervisors` was not consulted by the mailbox | `WakeScope.concerned` (a sub-project's parent Waykeeper, a standalone task's Harmonizer) |

## Review findings, fixed on the branch

| # | Finding | Fix |
|---|---|---|
| 1 | A brain's session reset (P2-06 `renewSession`) ran the agent-end path: questions the brain held were re-routed up (task shown `blocked_on_user`) and its own were cancelled (reproduced) | `recordEnd(…, {keepHeld})`: a reset keeps held questions; tested and mutation-checked |
| 2 | An explicit pause could not hold against a user-held question, so resume was then refused (P2-15 × P2-14, reproduced) | an explicit pause outranks "blocked on user" like an explicit failure (SPEC §4.4, decision 29); integration test through the runtime, mutation-checked |
| 3 | `Commands.control` returned every event logged during its runtime calls; a brain's mailbox drops a tool call's events as its own, so a concurrent user action never woke it (reproduced) | `effectEvents`: only the call's own transaction plus its agent effects carrying its actor (a stop of an affected agent counts whoever the adapter names); deterministic test with a stub runtime |
| 4 | Earlier holders were not woken when a question was answered or cancelled (no `question.cancelled` rule; `holders` ignored) | `question.answered` / `question.cancelled` wake every agent in `holders` (clarifications only); tested |
| 5 | Worktree git commands took `task.branch` and `meta.worktree.root` — fields any brain can write through `updateTask` — as positional arguments | the root is always derived (`worktreeRoot`), a stored branch must be a valid `galactic/…` ref (`checkBranch`); test with a planted option-like branch and a planted root |
| 6 | An answer delivered by the adapter could be refused by the log afterwards (the holder moved meanwhile) | the runtime checks fully before delivery and records with `delivered: true` (open is enough) |
| nit | `POST /api/control` mapped every refusal to 409 | `invalid` → 400, non-domain errors → 500 (logged); tested |
| nit | stale decision numbers in the P2-05 / P2-14 notes | renumbered to SPEC 27 / 28 |

## Deferred

- Filter drivers in the repository's shared `.git/config` still run for server-run `git status` / `add` (documented in TECHNOLOGY §8; the permission table already treats `.git/` as outside the workspace).
- A project's explicit hold is lifted by a (re)spawn of any of its tasks' Stewards — defensible (work resumed), revisit with P2-16.
- `Commands.setTaskState` / `setProjectState` emit without `by`, so a panel calling them directly looks like derivation — P2-18 passes the actor.
- Deriver cost: `currentSeq()` per event and a questions scan per derivation; fine at this size.
- The merge-conflict question (SPEC §8) is left to the user, with P2-05's recommendation recorded there.
