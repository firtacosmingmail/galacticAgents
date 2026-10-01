# Phase 2 — The hierarchy: Harmonizer, Waykeepers, Stewards

**Current task:** P2-02, P2-03, P2-05, P2-06, P2-14, P2-15 (wave 2, branch `p2-wave2-services`) · **Task status:** in progress
**Phase status:** in progress (1/20 done) — on branch `phase-2`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

The full Steward → Waykeeper → Harmonizer → user loop, working through the ops console: requests become proposals, approved proposals become bodies, Waykeepers plan and spawn Stewards in worktrees, questions travel and resolve everywhere, tasks are merged and closed, projects are closed by the user, and all of it survives a `kill -9`.

## Entry criteria

- Phase 1 exit criteria met (real Claude adapter passing conformance; restart recovery v1 working).
- P1-08 findings applied: SDK auth for in-process brains known (SPEC §8 q1).

## References

- `IMPLEMENTATION_PLAN.md` → Phase 2; corner cases 6, 9–19c, 31–34.
- `TECHNOLOGY.md` §5 (brains: adapter-run, mailbox, tools, question ownership, caps), §6 (persistence), §7 (vocabulary).
- `SPEC.md` §2 (hierarchy, who talks to whom, questions, completion), §3 (sizing, moons, proposals, moves, workspaces/worktrees, permissions), §4.3–4.4 (requests, states), §7 decisions 1–18.

## Design notes for implementation

- **Brains are agents:** spawned through the `claude-sdk` adapter with `tools` + `systemPrompt`; rows in `agents` with `role`, `sessionRef`, `supervisorId`, `bodyId`. Brain code (`src/brains`) contains prompts, tool schemas and handlers against `DomainCommands` — no SDK imports.
- **Mailbox runtime:** one mailbox per brain; whitelist of wake events; one turn at a time; the turn prompt is the drained mailbox; `ask_user` / `escalate` / `propose` / `request_project_closure` are non-blocking; each turn is seeded from the DB; periodic session reset with carried summary.
- **Questions:** `kind` decides the path. Permission → policy or user only, never a brain mailbox. Clarification → holding supervisor may answer (logged `answeredBy`) or escalate. Holder = `Agent.supervisorId`, generically. Orphaned → next living supervisor or user. Answer anywhere resolves everywhere (version check → "already answered by …").
- **Confirmation scope (decision 3):** conversational requests never produce proposals; work requests produce one `Proposal`; a Waykeeper's `plan_tasks` is one approvable card.
- **Bodies:** catalogue seeded; Sun, Earth, Moon reserved; procedural asteroids; project tasks hosted on the project body; moons as sub-project (same planet, `parentProjectId`) or independent project; `freePlanets()` / `freeMoons()` deterministic.
- **Worktrees:** `spawn_steward` creates `<workspace>/.galactic/worktrees/<task-id>` (or a sibling dir) on branch `galactic/<task-id>-<slug>`; `merge_task` merges into the project's base branch; conflict → clarification question.
- **Closure:** Waykeeper closes tasks; `request_project_closure` → Harmonizer asks the user; user closes → Waykeeper stopped, `completed`, retention timer.
- **Control actions** are server commands emitting `control.*` events that land in the affected brains' mailboxes.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P2-01 | Domain commands underpin everything. |
| 2 (parallel) | P2-02, P2-03, P2-05, P2-06, P2-14, P2-15 | Catalogue, questions, worktrees, brain runner, control actions and state derivation are independent given P2-01. |
| 3 (parallel) | P2-04, P2-07, P2-17 | Permission routing, fake-LLM harness, extra caps. |
| 4 (parallel) | P2-08, P2-10 | Harmonizer and Waykeeper brains (share the runner; can be built side by side). |
| 5 (parallel) | P2-09, P2-11, P2-12, P2-13 | Proposal flow, Steward lifecycle, promotion/moves, closure/retention. |
| 6 (parallel) | P2-16, P2-18 | Hierarchy resume; ops console extensions. |
| 7 | P2-19 | End-to-end exit run + kill -9 drill. |

P2-20 (added 2026-10-01) runs with wave 4: it needs the Earth/HQ body from P2-02 and is used by P2-08 and P2-11.

## Tasks

### P2-01 — Domain commands
- **Status:** done (2026-10-01) · **Depends on:** P0-07, P0-04 · **Parallel with:** —
- Implement `DomainCommands` as transactional commands: projects (create, set workspace, set state, close, archive, pin, reopen), tasks (create, edit, set state, move, close, archive, reopen), agents (register, set supervisor/body, set state), proposals (create, approve, edit, reject, park), questions (open, escalate, answer, reassign), control actions; every command emits its event(s) and they fully describe the mutation (a new body → `body.created`); snapshot builder completed for all tables. Migration 0004 (0003 went to P1-01's `agent_processes`) adds `projects.permission_policy` (JSON, validated by `PermissionPolicy`) and the protocol gains `Project.permissionPolicy?` (TECHNOLOGY §6.2, decided with P0-18).
- **Acceptance:** each command has a test asserting the row change and the emitted event; invalid transitions are rejected; a **conformance test** replays a recorded event log through the web client's reducer and asserts equality with the server's snapshot at every `seq` (statuses excluded — server-owned).

### P2-02 — Body catalogue and assignment
- **Status:** in progress · **Depends on:** P2-01 · **Parallel with:** P2-03, P2-05, P2-06, P2-14, P2-15
- Seed migration: Sun, 8 planets, major moons with `parentId`; `reserved` flag on Sun, Earth, Earth's Moon; procedural asteroid generator (seeded names/orbits, on demand); `freePlanets()`, `freeMoons(planetId?)`, `assignBody(kind, {relatedProjectId?})` implementing decision 10 preferences (sub-project → own planet's moon; independent → moons of Waykeeper-less planets, else any free moon); host assignment for project tasks (`Body.host = task`, `parentId = project body`); `body.moved` / `body.freed`; `moved` marker state with retention.
- **Acceptance:** tests for every preference rule and for the no-free-planet case; reserved bodies never assigned.

### P2-03 — Question service
- **Status:** in progress · **Depends on:** P2-01 · **Parallel with:** P2-02, P2-05, P2-06, P2-14, P2-15
- Open from `agent.needs_input` (kind, context: origin agent, task, body, last N events); holder routing by `supervisorId`; escalate; `answer(questionId, answer, version, answeredBy)` with first-answer-wins and "already answered by …" reply; notify every holder and deliver the answer to the origin agent via the adapter; orphan re-routing when a holder agent dies; `answeredBy` recorded for supervisor answers.
- **Acceptance:** tests for double answer, orphaned holder, escalation chain for a project Steward and for an asteroid Steward (Harmonizer as supervisor).

### P2-04 — Permission routing
- **Status:** todo · **Depends on:** P2-03, P1-10 · **Parallel with:** P2-07, P2-17
- `needs_input(kind: permission)` → evaluate the project's policy; allow → answer immediately; ask → `Question(kind: permission, holder: user)` straight to the inbox, never to a brain mailbox; remote-client flag respected (never auto-approve for remote unless configured).
- **Acceptance:** tests: allowed action never creates a question; asked action creates a user-held question; brain mailboxes never receive permission questions.

### P2-05 — Workspace and worktree service
- **Status:** in progress · **Depends on:** P2-01 · **Parallel with:** P2-02, P2-03, P2-06, P2-14, P2-15
- `Project.workspace`: validate an existing path or create `<projectsRoot>/<slug>`; git detection, `git init` for new folders; `createWorktree(task)` → path + branch; `mergeTask(task)` (fast-forward or merge into base branch, delete worktree on success); conflict detection → returns structured conflict info for a clarification question; non-git fallback flag (serialise Stewards).
- **Acceptance:** tests on a temp repo: two worktrees, one clean merge, one conflicting merge reported; non-git workspace initialised.

### P2-06 — Brain runner (mailbox, turns, seeding)
- **Status:** in progress · **Depends on:** P1-09, P2-01 · **Parallel with:** P2-02, P2-03, P2-05, P2-14, P2-15
- Per-brain mailbox fed by a whitelist of events (user message, `question.opened/answered`, `proposal.*` decisions, `agent.finished/failed/stalled`, `control.*`, subordinate reports); one turn at a time; turn prompt = drained mailbox + DB-seeded context (`list_supervised_agents`, project tasks, open questions); tools executed against `DomainCommands`; non-blocking user-facing tools end the turn; session reset policy with summary carry-over; brain spawned via the `claude-sdk` adapter with `tools` + `systemPrompt`, so it has a `StatusRecord`, cost and `sessionRef`.
- **Acceptance:** unit tests (with P2-07 harness) for coalescing two simultaneous events into one turn, re-entrancy prevention, and that a brain's own tool side effects don't wake it mid-turn.

### P2-07 — Scripted fake-LLM harness for brains
- **Status:** todo · **Depends on:** P2-06 · **Parallel with:** P2-04, P2-17
- A fake "LLM" that, given a turn prompt, replays scripted tool calls; lets brain tool contracts, question routing, proposal flows and wake coalescing be tested deterministically without Claude.
- **Acceptance:** used by P2-06, P2-08, P2-10 tests; runs in CI.

### P2-08 — Harmonizer brain
- **Status:** todo · **Depends on:** P2-06, P2-02, P2-03 · **Parallel with:** P2-10
- System prompt (role, sizing rules, moon rules, escalation etiquette, conversational vs work requests, closure relay); tools: `find_related_work`, `size_request`, `propose`, `create_project`, `create_task`, `assign_body`, `spawn_waykeeper`, `spawn_steward` (asteroid; supervisor = Harmonizer), `propose_promotion`, `close_task` (asteroid), `stop/pause/resume_agent`, `get_agent_status`, `list_supervised_agents`, `ask_user`, `answer_question` (clarification only), `report_status`, `freePlanets`, `freeMoons`; Harmonizer auto-started with the server and idle otherwise.
- **Acceptance:** scripted tests: status question produces no proposal; new project produces a proposal; asteroid Steward's question is held by the Harmonizer; permission questions never reach it.

### P2-09 — Proposal flow
- **Status:** todo · **Depends on:** P2-08, P2-02 · **Parallel with:** P2-11, P2-12, P2-13
- `Proposal` lifecycle: created → approved / edited (size, body, workspace) / rejected (draft stays) / parked (no free planet: payload lists occupied planets + occupants, offers downsizing and early closure; un-parks when a planet frees or the user edits); task-plan card from `plan_tasks` approved once; approval triggers body assignment + spawns.
- **Acceptance:** tests for each transition; a parked proposal resumes automatically after a planet is freed.

### P2-10 — Waykeeper brain
- **Status:** todo · **Depends on:** P2-06, P2-05, P2-03 · **Parallel with:** P2-08
- System prompt (project coordination, plan once, worktrees, closure judgement, answering from context); tools: `plan_tasks`, `create_task`, `spawn_steward` (creates worktree; sets policy), `merge_task`, `close_task`, `stop/pause/resume_agent`, `get_agent_status`, `list_supervised_agents`, `answer_question` (clarification only, logged), `escalate`, `request_promotion`, `request_project_closure`, `report_status`.
- **Acceptance:** scripted tests: plan → single card; Steward "done" → close + merge; conflict → clarification question; all tasks closed → `request_project_closure`.

### P2-11 — Steward lifecycle
- **Status:** todo · **Depends on:** P2-10, P2-08, P2-04 · **Parallel with:** P2-09, P2-12, P2-13
- Steward spawn in its worktree with the project's policy and caps; prompt template carrying task, project context and the "report done / ask when unsure" etiquette; done report → supervisor decides (close vs waiting for input); asteroid Stewards supervised by the Harmonizer; Steward `finished` without a done report handled as a report.
- **Acceptance:** end-to-end with the fake adapter: task spawned, reports done, Waykeeper closes and merges; same for an asteroid task with the Harmonizer.

### P2-12 — Promotion and moves
- **Status:** todo · **Depends on:** P2-09, P2-02 · **Parallel with:** P2-11, P2-13
- `propose_promotion` / `request_promotion` → proposal; approval: pause the Steward if mid-task, create/assign the new body, `body.moved` (drives the satellite flight in Phase 4), spawn a Waykeeper if promoted to moon/planet, hand over or resume the Steward, old body in `moved` state for the retention period then freed, permanent link in history; "task added to an existing project" moves an asteroid task onto the project body the same way.
- **Acceptance:** tests: asteroid → moon promotion with a mid-task Steward; task moved into project; old body freed after retention.

### P2-13 — Closure, retention and archival
- **Status:** todo · **Depends on:** P2-10, P2-02, P2-14 · **Parallel with:** P2-11, P2-12
- `request_project_closure` → Harmonizer `ask_user("anything else on <project>?")` → user closes (control action) → Waykeeper stopped, transcripts kept, `completed`, retention timer (default 7 days, setting); scheduled archival job frees the body; archive-now, pin (suspends the timer), reopen (same body if free, else new body linked); sub-project moons block their planet's closure.
- **Acceptance:** tests with a fake clock for retention, pin, reopen and the blocked-closure rule.

### P2-14 — Control actions
- **Status:** in progress · **Depends on:** P2-01, P1-09 · **Parallel with:** P2-02, P2-03, P2-05, P2-06, P2-15
- Server commands for stop/cancel, pause/resume, edit description/priority, close project, archive-now, pin, reopen on tasks, projects and agents; each emits `control.*`, applies the agent-level effect via the adapter, and lands in the affected supervisors' mailboxes; exposed over WS/REST for the panel and as Harmonizer tools.
- **Acceptance:** tests: pausing a task pauses its Steward and wakes its Waykeeper; cancelling a project stops its agents and frees the body after retention.

### P2-15 — Task and project state derivation
- **Status:** in progress · **Depends on:** P2-01, P1-05 · **Parallel with:** P2-02, P2-03, P2-05, P2-06, P2-14
- Projection computing `SPEC.md` §4.4 states from agent states, open questions and commands (`proposed → approved → in progress → blocked on user → awaiting closure → completed → archived`, plus `failed`, `paused`, `moved`, `interrupted`); included in snapshot and diffs; system summary counts (open questions, blocked items).
- **Acceptance:** table-driven tests mapping agent/question combinations to states; "blocked on user" whenever a user-held question exists.

### P2-16 — Hierarchy restart and resume
- **Status:** todo · **Depends on:** P1-14, P2-06, P2-03 · **Parallel with:** P2-18
- Extend recovery to brains (resume Harmonizer/Waykeepers from `sessionRef` or re-seed from DB if the session is unusable); re-deliver pending answers; requeue mailbox events that were in flight; Harmonizer's "recovered: N resumed, M need attention" message; `interrupted` state on non-resumable agents with a resume action.
- **Acceptance:** kill -9 during a running project; after restart every agent is `working` or `interrupted` with a reason, no duplicate questions or spawns.

### P2-17 — Additional caps
- **Status:** todo · **Depends on:** P1-02, P2-10 · **Parallel with:** P2-04, P2-07
- Max Stewards per Waykeeper; max spawns per hour (global and per brain); a refused spawn is a tool error the brain sees and reports.
- **Acceptance:** tests; the Waykeeper's report of a refused spawn is visible in its transcript.

### P2-18 — Ops console extensions for the hierarchy
- **Status:** todo · **Depends on:** P1-11, P2-09, P2-15 · **Parallel with:** P2-16
- Project/task tree with derived states; proposal and task-plan cards (approve / edit / reject); question inbox with kind, holder, context and inline answer (permission cards show the action); control actions; Harmonizer and Waykeeper chat boxes; Steward transcript view read-only with a message box only when it holds an open clarification question.
- **Acceptance:** the Phase 2 exit run can be driven entirely from this page.

### P2-19 — End-to-end exit run and crash drill
- **Status:** todo · **Depends on:** all Phase 2 tasks · **Parallel with:** —
- Run the exit criteria script ("build a CLI that converts CSV to Parquet") for real: related-work check, proposal with workspace, body, Waykeeper plan approved once, Stewards in worktrees, one supervisor-answered and one escalated clarification, one permission request, merged branches, closure request accepted; `kill -9` the server mid-way and confirm automatic resume. Record the run and any spec deviations in `docs/tasks/notes/P2-19-exit-run.md`; update SPEC/TECH if decisions changed.
- **Acceptance:** exit criteria met; notes committed.

### P2-20 — Hierarchy placement invariants and clearable fields (added 2026-10-01)
- **Status:** todo · **Depends on:** P2-02 · **Parallel with:** P2-08, P2-10
- From the P2-01 review (`docs/tasks/notes/P2-wave1-review.md`, findings 7 and 9). `spawnAgent` puts the Harmonizer on Earth (HQ), not a fresh asteroid; a Steward or Waykeeper always has a supervisor; a Waykeeper's supervisor is the Harmonizer (or, for a sub-project, the planet's Waykeeper); `updateAgent` never gives the Harmonizer a supervisor and keeps `taskId` and `projectId` in agreement. Decide how an optional field is cleared (detaching a sub-project, dropping a project's policy, a task's worktree after merge): an explicit `null` in `project.updated` / `task.updated` folded by both the commands and the web reducer, or a dedicated event; record it in TECHNOLOGY §6.2.
- **Acceptance:** tests for each invariant; the conformance test covers clearing a field.

## Exit criteria (from the plan)

"Start a new project: build a CLI that converts CSV to Parquet" typed to the Harmonizer results in a related-work check, a sizing proposal with a workspace you confirm, a planet or moon assignment, a Waykeeper whose task plan you approve once, several Stewards each in its own worktree, at least one clarification answered by the Waykeeper from context (visible to you) and one escalated to you, one permission request answered by you, merged branches, a closure request you accept — all visible in the ops console, and survivable across a `kill -9` of the server with automatic resume.
