# Phase 2, batch 4 (wave 4: P2-08, P2-10, P2-21) — review

Branch `p2-wave4-brains` against `phase-2`, 2026-10-02. Three parallel agents in worktrees; merged by the coordinator (P2-21 cleanly; P2-08 one conflict in `createProject`; P2-10 six conflicts in shared brain and protocol files, resolved as unions). Integration by the coordinator: one set of shared supervisor tools (the Harmonizer keeps its own `report_status`), `spawn_waykeeper` wired at boot to the real Waykeeper brain (the Harmonizer test now uses it), and `Commands.spawnAgent` returning only the spawn's own events — a Steward that finished before its spawn returned never woke its supervisor (deterministic test with a stub runtime, mutation-checked).

An independent review then read the combined diff (server suite three times, no flakes) and confirmed decision 3 (nothing created or spawned before approval, no replay, plan cards decided only by the user), decisions 7/12 (no brain answers a permission question or one it does not hold) and git argument safety. A fix agent closed its findings on the branch, one test per fix, each failing without it:

| # | Finding | Fix |
|---|---|---|
| 1 | The Harmonizer's `spawn_steward` let the model run a Steward in a folder the user never approved (reproduced) | no `workspace` input; always the card's `task.meta.workspace`, refused when none |
| 2 | A task the Harmonizer added to a project never woke its Waykeeper | `task.created` wake rule (not for plan-proposed tasks, not for the Waykeeper's own); `create_task` reports `waykeeperId: null` when none runs |
| 3 | The user's "send the Steward back" answer on an external conflict could not be carried out | `merge_task{sendBack: true}`, allowed once the user answered; the send-back count restarts |
| 4 | A sub-project's closure request went to the parent Waykeeper; a dead parent Waykeeper could become supervisor | closure requests go to the Harmonizer; a sub-project Waykeeper needs a running parent Waykeeper |
| 5 | Nobody heard the decision on a Waykeeper's promotion card | the card belongs to the requesting project's Waykeeper |
| 6 | Parallel tool calls could spawn two Waykeepers for a project or two Stewards for a task | `spawnAgent` reserves `harmonizer` / `waykeeper:<project>` / `steward:<task>` synchronously |
| 7 | Merge classification failed open (a failed `rev-list` meant "own"); only the last merge was remembered | fails closed (`externalUnknown`); `meta.merges` keeps every merge's range; merge commits with hand edits documented as a limit |
| 8 | A sent-back Steward lost its task and instructions | stored at first spawn and replayed |
| 9 | Closing unmerged left the conflict question open | `DomainCommands.withdrawQuestion`; closing (and a later successful merge) withdraws it |
| 10 | The conflict question woke the Harmonizer on its way to the user | `OpenQuestionInput.toUser`: held by the user from the start, no hop |
| 11 | An asteroid in a related project's workspace ran under the global default policy | it gets the stricter of that project's policy and the default, per category |

## Deferred

- A Harmonizer resumed after a restart has no runner (tools, prompt, mailbox) — added to **P2-16**'s scope; until then a restart leaves no working Harmonizer.
- `task.meta.workspace` is trusted as the approved workspace; it is written by the Harmonizer's `create_task` from the approved card, and no brain tool exposes a generic `updateTask` on `meta`. If one ever does, the approved workspace needs its own field.
- P2-21's "a brain acting for a remote message is floored" holds through the seam (`originOfMessages`) only: no brain tool writes a policy yet.
