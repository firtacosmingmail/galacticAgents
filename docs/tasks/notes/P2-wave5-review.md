# Phase 2, batch 5 (wave 5: P2-09, P2-11, P2-12, P2-13, P2-17) — review

Branch `p2-wave5-flows` against `phase-2`, 2026-10-02. Five parallel agents (four at a time) in worktrees; merged by the coordinator. P2-13 and P2-09 merged cleanly; P2-11 and P2-12 conflicted in shared protocol, wake and prompt files (resolved as unions; the Harmonizer prompt follows P2-09's "approval creates the work" and P2-11's reports); P2-17's strict acceptance test was given a rule for P2-11's Steward reports. The coordinator checked that P2-09's approval and P2-12's promotion flow never both act on one card. A lesson for the batch flow: reserved migration numbers per agent fail because the runner rejects gaps — agents now take the next free number and the coordinator renumbers at merge.

An independent review (server suite three times, no flakes) confirmed decision 3 (un-parking never approves; retention, reopen and un-parking spawn nothing), replay vs snapshot for the new events, Steward reports going to the current supervisor, caps on every spawn path, the retention clock and the archival timer. A fix agent closed its findings on the branch; every new test but one fails without its fix:

| # | Finding | Fix |
|---|---|---|
| 1 | One parked card that could not be placed made every body-freeing command fail (archival, marker sweep, reopen, free) (reproduced); `propose_promotion` allowed a planet project "promoted" down to a moon | `unparkWaiting` skips a card it cannot place; only bigger promotions (a moon project to a planet; tasks to a moon or planet; a standalone task into a project) |
| 2 | A Waykeeper's promotion card never parked and its approval failed with no free moon; two body rules; the body not reserved at approval (reproduced) | one body rule (`bodyRequestOf` covers both card shapes, `promotionRoom` is `roomFor`); approval creates the promoted project (or moves the project) on the chosen body in its own transaction |
| 3 | A failed promotion left an empty project holding a body and never retried (reproduced) | transient failures (no running supervisor, a refused Waykeeper spawn) retry for up to 2 h; a Waykeeper someone else started is adopted; a final failure fails the new project and frees its body; the flow starts after the Harmonizer |
| 4 | Paused agents ran down their wall-clock cap; dead Stewards listed as "handed over" | the wall clock stops for every pause; live Stewards only |
| 5 | A restart did not re-pause the Stewards of pending promotion cards | `start()` re-pauses them |
| 6 | Decision 11 enforced only by the prompt: the Harmonizer could close or archive with no user signal | closing needs the user's "Close …" answer to the closure question, or an `ask_confirmation` answered for that exact action and target; archive, pin, unpin, reopen always need one; the panel unaffected |
| 7 | Reopen freed the old body before placing on the new one (a false "free" un-park) | un-parks after the new body is taken |
| 8 | Un-parking chose bodies without the running check approval uses | one running check for both |
| 9 | A refused `spawn_steward` left its worktree; `tell_steward` → report loops unbounded | the worktree (and a new branch) are removed on refusal; at most 20 `tell_steward` per Steward per hour |
| 10 | The promotion flow was never stopped on shutdown | stopped with the runtime |

## Deferred

- To **P2-16**: missed Steward reports while a supervisor was down; closure requests recorded while the Harmonizer was down; the in-memory promotion retry queue; Stewards of a card created before the flow starts are not paused.
- An `ask_confirmation` answer can be reused for the same action and target.
