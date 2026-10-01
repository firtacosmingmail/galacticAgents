# P2-15 — Task and project state derivation

Date: 2026-10-01 · Branch: `worktree-agent-ac686e7eb970ac58c` (from `p2-wave2-services`)

## What was built

- `apps/server/src/domain/work-states.ts`: a pure derivation, evaluated as **ordered rule tables** (`TASK_RULES`, `PROJECT_RULES`). The first rule that matches decides. `keep` means derivation has no opinion and the row stays as it is. The inputs (`WorkFacts`) are the item's current state, whether that state is an *explicit hold*, the count of open **user-held** questions (`holder.type === 'user'`) asked by the item's agents, the item's agents reduced to `AgentPhase` (`running | idle | paused | finished | failed | stopped | interrupted`), and, for a project, its tasks' states.
- `apps/server/src/runtime/work-state-deriver.ts`: `WorkStateDeriver`, a log subscriber wired in `composeRuntime` after the status store. After each committed event it recomputes the tasks and projects that event concerns. When the derived state differs from the row, it writes the new state through `setTaskState` / `setProjectState` as `task.state_changed` / `project.state_changed` **without `by`**. It keeps its own small agent-phase table, folded from `agent.*` events (no retention, unlike the status store), plus a table of explicit holds.
- `apps/server/src/domain/states.ts`: the transition table now has the moves an agent can cause on its own: `approved → awaiting_closure`; `awaiting_closure → interrupted`; `paused → awaiting_closure`; `interrupted → awaiting_closure`; `failed → blocked_on_user | awaiting_closure | paused | interrupted`. A test checks every derived change against the table.
- `packages/protocol/src/summary.ts`: `summarize({questions, tasks, projects}) → SystemSummary` returns `openQuestions`, `userQuestions`, `blockedTasks`, `blockedProjects` and `blockedItems`. The web exposes `summaryOf(world)`.
- Tests: 48 table rows, a transition-table property test and two rule-table checks (`work-states.test.ts`) and 6 runtime integration tests (`work-state-deriver.test.ts`). The integration tests cover:
  - the `asks` scenario: task `in_progress → blocked_on_user → in_progress → awaiting_closure`, and the project follows it to `awaiting_closure` once the task is closed and the Waykeeper stopped. The test also works with P2-03 routing: if the Waykeeper holds the question, the task stays `in_progress` until the question is escalated to the user.
  - a failure followed by a retry.
  - explicit holds.
  - no loops, and a restart writes nothing.
  - `reconcile` after a crash.
  - restart → `interrupted` → resume → `in_progress`.
  - The conformance walk also asserts that derived changes carry no `by` and that the client's summary equals the server's.

## Precedence

Task rules, first match wins:

| # | Rule | When | State |
|---|---|---|---|
| 1 | sticky state | current ∈ {proposed, completed, archived, moved} | keep |
| 2 | user-held question | ≥1 open question held by the user from the task's agents, unless the item is explicitly `failed` | blocked_on_user |
| 3 | explicit state | the current state was set with `by` and no agent of the item has been spawned or resumed since | keep |
| 4 | running agent | any agent starting/working/stalled/waiting | in_progress |
| 5 | paused agent | any agent paused | paused |
| 6 | idle agent | any agent idle (ended its turn: its supervisor decides, §2.7) | awaiting_closure |
| 7 | latest ended agent | the most recently ended agent: finished → awaiting_closure, failed → failed, interrupted → interrupted, stopped or no agent → keep | … |

Project rules: rules 1–3 as for tasks. Rule 2 counts user-held questions from the Waykeeper **and from every task's agents**. After that:

| # | Rule | When | State |
|---|---|---|---|
| 4 | work running | a project-level agent (the Waykeeper) is running, or a task is approved / in_progress / blocked_on_user / awaiting_closure (a task awaiting closure waits on the Waykeeper, not on the user) | in_progress |
| 5 | work paused | Waykeeper paused or a task paused | paused |
| 6 | work interrupted | Waykeeper interrupted or a task interrupted | interrupted |
| 7 | all tasks closed | ≥1 completed task and every task completed/archived/moved | awaiting_closure |
| 8 | otherwise | — | keep |

Notes on these rules:

- `proposed` is sticky because the plan card has not been approved.
- `failed` is **not** sticky. A new Steward on a failed task takes it back to `in_progress`. An explicit `failed` set with `by` (a cancel) holds.
- An explicit hold ends when its item next gets a derived write. This means an explicit pause that was overtaken by a user question is not stuck in `blocked_on_user` after the answer.

## Decisions (ready to paste)

**SPEC §4.4, add after the state line:**

> States are derived by the server from agents, questions and explicit commands, with this precedence: `completed`, `archived`, `moved` and `proposed` change only by explicit command. **Blocked on user** applies whenever an open question held by the user exists for the item (for a project, from any of its agents or its tasks' agents); it overrides everything except those sticky states and an explicit failure. A user's or supervisor's explicit state (pause, cancel, reopen) holds until one of the item's agents is started or resumed again. Otherwise: an agent running → in progress; all live agents paused → paused; a Steward that ended its turn or finished → awaiting closure (its supervisor closes it or sends it back to work); the most recent Steward failed → failed (a new Steward takes the task up again); interrupted after a restart until resumed. A project is in progress while its Waykeeper works or any task is open, and awaiting closure once every task is closed: the user's "anything else?" moment.

**SPEC §7, new decision (next free number):**

> | n | States | **Derived by the server, explicit wins** (2026-10-01, P2-15): task and project states are a server projection over the event log, never folded by clients. Finished states and explicit panel/supervisor states are never overwritten by derivation; "blocked on user" keys on the question's holder (`user`), not on any open question. |

**TECHNOLOGY §6.2 (task/project states are projections), add:**

> `WorkStateDeriver` (runtime, P2-15) is a log subscriber placed after the status store. For every committed event it recomputes the tasks and projects the event concerns, using an ordered rule table (`domain/work-states.ts`). It writes any difference through `setTaskState` / `setProjectState` as `*.state_changed` **without `by`**. Clients therefore receive derived states as ordinary row changes, and the replay-vs-snapshot conformance test still holds. Derivation goes through the shared transition table and never forces a move the table lacks.
>
> Loop safety: a task's own state change re-triggers only its project, and a project's state change re-triggers nothing. Unchanged states write nothing.
>
> Restart: `rebuild` replays the log into its agent-phase and hold tables without writing. `reconcile` then rewrites only rows that a crash between a commit and its derivation left stale.
>
> Derivation reads only logged events, never `agent.output` or the stall ticker. Those only move agents between phases that map to the same work state.

**TECHNOLOGY §4 (status store), add:**

> The system summary counts (open questions, user-held questions, blocked tasks/projects) come from a pure function in `packages/protocol` (`summarize`) over the domain rows. Server and client compute them from the same state, and no summary message is sent. This is simpler than a server-sent summary, and it cannot drift because its inputs are the rows the conformance test already proves equal.

## Deferred / for the other wave-2 tasks

- **P2-14:** set explicit states **with `by`** (pause/cancel/stop of a task or project) so that they hold. A stopped Steward alone gives no opinion, so the cascade decides what a stop means for the task (failed? approved?). `Commands.setTaskState` / `setProjectState` currently emit without `by`, which looks like a derived change. P2-14 or P2-18 should pass the actor.
- **P2-13:** an explicit `request_project_closure` may set `awaiting_closure` with the Waykeeper as `by`. The derivation already reaches the same state once every task is closed.
- **P2-16:** a failed or ended Waykeeper is not mapped to a project state ("keep"). Decide this together with brain resume. Sub-projects do not propagate to their planet's project.
- Pruned history: an agent whose events were pruned from the log has no phase and is ignored. Rows stay as last written.
- Recomputation scans `agents` and `questions` per affected item. This is fine at current sizes; index it if the tables grow.
