# Phase 10 — Long-term projects, area moons and recurring jobs

**Current task:** — · **Task status:** P10-01 – P10-08 done
**Phase status:** done (2026-10-27) (8/8 done) — on batch branch `p10-1-long-term-projects`, cut from `phase-10` (cut from `main`); waiting for Cosmin's merge into `phase-10`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

A project can be **long-term**: it has a purpose and goals, never closes by itself and sits on a big planet whose moons are business **areas**. Each area holds **recurring jobs** that Mission Control runs on schedule as Stewards in the project's folder, catching up after downtime, pausing on failure, and bringing every finding and every real-money spend to Cosmin as inbox questions. The design leaves room for more providers per job (project 2) and a dashboard fed by the numbers runs report (project 3), and builds neither.

## Entry criteria

- Phases 0–9 done; Phase 8 tasks P8-19 (question sets) and P9-17 ("Allow similar" rules) done — jobs reuse both.
- The design approved by Cosmin (2026-10-24).

## References

- Spec (authority for this phase): `docs/superpowers/specs/2026-10-24-long-term-projects-design.md`.
- Plan: `docs/superpowers/plans/2026-10-24-long-term-projects.md` (Global Constraints, Review Focus, Tasks 1–14).
- `SPEC.md` decisions 3, 4, 7, 9, 10, 12, 18, 49, 90, 135, 138, 140, 141; new decisions 142–145 and two §8 questions (written in P10-08).
- `TECHNOLOGY.md` §5.3 (brain tools, question sets), §6.2–§6.4 (write rule, protocol rule 5, export/import), §8 (remote clients); the deliverables secret check (§9).
- Code precedents: `packages/protocol/src/question-set.ts` (a feature module), `Proposal.meta.plan` / `proposalPlan` (proposal-meta readers), deliverables in `WorldState` / `SnapshotMessage` (an optional snapshot entity), `apps/server/src/runtime/archival.ts` (a ticking runtime service).

## Design notes for implementation

- **One vocabulary.** `packages/protocol/src/long-term.ts` holds `Area`, `Job`, `JobRun`, `Schedule`, `LONG_TERM_LIMITS` and the job-owned question helpers; the world fold keeps `areas` and `jobs`. `job_run.*` fold to nothing (run history is REST).
- **One hidden task per job** (`task.meta.jobId`) on its area's moon: every run is an ordinary Steward spawn on that task in the project's workspace (no worktree); "one run at a time" is the one-live-Steward-per-task slot.
- **Area moons** have host `{kind: 'areas', id: projectId}`; several areas may share a moon.
- **Job-owned questions** (findings, failure notices, job spends) outlive their run's Steward and never wake a brain; only "Implement it" messages the Waykeeper.
- **`spend` questions** are always held by the user and answered only by the user, under the permission rules for remote answers.
- **Confirmation cards** are proposals carrying `meta.job` / `meta.longTerm`, like `meta.plan`.
- Every limit and fixed text in the plan's Global Constraints binds every task.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P10-01 | Protocol, schedules and storage (plan Tasks 1–3). |
| 2 | P10-02 | Long-term projects on big planets (Task 4). |
| 3 | P10-03 | Areas and jobs in the domain (Task 5). |
| 4 | P10-04 | Job runs and the scheduler (Tasks 6, 8). |
| 5 | P10-05 | Findings and spend approvals (Tasks 7, 9). |
| 6 | P10-06 | Brain tools and confirmation cards (Task 10). |
| 7 | P10-07 | Web: cards, Jobs tab, area moons (Tasks 11–13). |
| 8 | P10-08 | Docs and end-to-end (Task 14). |

All eight run in one batch branch, `p10-1-long-term-projects`, in this order.

## Tasks

### P10-01 — Protocol and storage
- **Status:** done (2026-10-27) · **Depends on:** — · **Parallel with:** —
- Plan Tasks 1–3: `long-term.ts` (types, limits, `Schedule`, job-owned question helpers, proposal-meta readers), `HostKind` `areas`, `QuestionKind` `spend`, `Project.longTerm/purpose/goals`, the `area.*` / `job.*` / `job_run.*` events, the world fold and snapshot fields, the command interfaces; `schedule.ts` (`nextOccurrence`, `missedSince`, `scheduleText`); migration 0016 (project columns, `areas`, `jobs`, `job_runs`, widened `bodies` / `questions` CHECKs), tables and snapshot.
- **Acceptance:** `Schedule` refuses empty, repeated and out-of-range days, `24:00` and `9:00`; `Job` defaults `provider` `claude` and `followUps` `[]` and refuses 11 rules; `isJobOwned` / `isJobTask` as specified; every new event round-trips; `job.created` → `job.updated` folds and `job_run.*` changes nothing; a snapshot with and without `areas`/`jobs` applies. Schedules: one occurrence per local day across a whole year in any zone (DST), monthly 31st clamps to the month's end, weekly across a year end, tests pass under `TZ=America/New_York` and `TZ=Europe/Bucharest`. Storage: round-trips of an area, a job, a run, a spend question, an `areas` body host and a long-term project; a database at 0015 migrates with every row intact; `snapshot()` carries `areas` and `jobs`.

### P10-02 — Long-term projects
- **Status:** done (2026-10-27) · **Depends on:** P10-01 · **Parallel with:** —
- Plan Task 4: a long-term request takes the first free big planet (≥ `BIG_PLANET_MIN_MOONS` catalogued moons), else a free planet with moons, else refuses `no_planet_with_moons`; `setLongTerm` converts a project (moving it when needed); `moveHost` refuses a project with areas; `request_project_closure` refuses a long-term project and `close_task` omits the closure hint; approving a `meta.longTerm` proposal creates or converts.
- **Acceptance:** a long-term project lands on Jupiter on an empty catalogue, on Mars when the big planets are taken, never on Mercury/Venus, refused when no moon-bearing planet is free; conversion moves to Saturn with its satellites in one transaction, stays when nothing is free, refuses a sub-project; closure refused "long-term projects are closed by the user only".

### P10-03 — Areas and jobs
- **Status:** done (2026-10-27) · **Depends on:** P10-02 · **Parallel with:** —
- Plan Task 5: `createArea` (free moon first, else the project's `areas` moon with fewest areas), `createJob` (with its hidden task and `nextRunAt`), `updateJob`, `setJobState`; jobs only on long-term projects; limits; `push` rules and secrets refused; archiving or closing stops jobs and frees area moons; job tasks never derive `completed`/`failed`.
- **Acceptance:** five areas on Saturn take five moons, a third area on Mars shares the moon with fewest; a moon hosting other work is never chosen; refusals for a non-long-term project, the 11th job, a `push` rule and a key in the instructions; `area.created` + `task.created` + `job.created` in one command; stopping cancels the failure question and empties follow-ups; `archiveProject` frees every area moon.

### P10-04 — Runs and the scheduler
- **Status:** done (2026-10-27) · **Depends on:** P10-03 · **Parallel with:** —
- Plan Tasks 6 and 8: `startJobRun` / `endJobRun` (pause on failure with one failure question, keep the last 200 runs, run memory), `runPurpose`; `JobScheduler` (tick every `JOB_TICK_MS`, reconcile, due runs, catch-up, one run per job, serialised `retryNow`), `jobRunPrompt`, recovery that never resumes a job-run Steward, unattended rules in the permission gate, no turn-end reports or wakes for job-run Stewards.
- **Acceptance:** the plan's Task 6 and Task 8 tests: on-time and catch-up runs, restart mid-run → `interrupted` then one catch-up, a run still going → `waited`, retry racing the tick → one spawn, a full concurrency cap → `waited` / `interrupted` (never `failed`), budget refusal → failed + paused + one question, unattended rules apply only to the job's Stewards, `dispose()` stops the timer.

### P10-05 — Findings and spend approvals
- **Status:** done (2026-10-27) · **Depends on:** P10-04 · **Parallel with:** —
- Plan Tasks 7 and 9: `openFinding`, `requestSpend`, `applyJobAnswer` (Create a ticket / Implement it / Drop; Send / Drop; Approve / Refuse; Fixed — retry now / Stop the job); spend held and answered by the user only; job-owned questions wake no brain; Steward tools `request_spend`, `report_finding`, `report_run`; the task-spend relay.
- **Acceptance:** every action and refusal (closed project, stopped job; Drop always works); an edited reply queues its text; spend refused to agents, sets, "Allow similar" rules and remote answers without auto-approve; only "Implement it" wakes the Waykeeper, once; tool scopes per Steward kind, 20 findings per run, `report_run('failed')` pauses the job.

### P10-06 — Brain tools and cards
- **Status:** done (2026-10-27) · **Depends on:** P10-05 · **Parallel with:** —
- Plan Task 10: Waykeeper `propose_job`, `propose_job_change`, `propose_job_stop`, `list_jobs`, `read_job_runs` and its long-term prompt; Harmonizer `propose` with `longTerm` and `propose_long_term`; job cards decided in one transaction.
- **Acceptance:** one card per `propose_job`; approval creates area, task and job in one transaction and wakes the Waykeeper once; rejection creates nothing; refusals before any card; `list_jobs` shows `scheduleText`; long-term proposals create or convert.

### P10-07 — Web: Jobs tab, cards, scene
- **Status:** done (2026-10-27) · **Depends on:** P10-06 · **Parallel with:** —
- Plan Tasks 11–13: JobCard, FindingCard, SpendCard (`question-spend`, `$` badge, Intl currency); the Jobs tab with run history (`GET /api/jobs/:id/runs`); area moons in the scene (labels, ring colour, click → Jobs filtered to the moon).
- **Acceptance:** each card's fixed actions, edited reply sent in `detail.text`, `$1,250.00` in `en-US`, no Allow similar on spend, spend ranked before clarifications; `jobsModel` puts paused jobs first and counts findings, route newest first and refuses `limit=500`; area moon labels and picking; axe clean; phone width without horizontal scroll.

### P10-08 — Docs and end-to-end
- **Status:** done (2026-10-27) · **Depends on:** P10-07 · **Parallel with:** —
- Plan Task 14: SPEC decisions 142–145 and two §8 questions, TECHNOLOGY sections, IMPLEMENTATION_PLAN Phase 10, `e2e/tests/13-recurring-jobs.spec.ts`, review notes, exit criteria.
- **Acceptance:** the e2e flow (long-term project on Jupiter → job on a new Feedback area → run → finding → edited Send → follow-up run → spend card → Jobs tab history) passes; the full gates are green.

## Exit criteria

- Every task done; the full gates (`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm e2e`) green on the batch branch.
- The plan's Review Focus items (calendar edges, asleep then restarted mid-run, retry racing the tick, a finding answered late, spend through the back doors) each covered by a test.
- SPEC, TECHNOLOGY and IMPLEMENTATION_PLAN consistent with what was built.

## Exit criteria — verified 2026-10-27

- **Every task done:** P10-01 – P10-08, 8/8. The full gates on `p10-1-long-term-projects`: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` green; `pnpm test` green (protocol 183, desktop 79, server 2086 + 8 skipped, web 1996); `pnpm e2e` 28/28 (three full runs), including `e2e/tests/13-recurring-jobs.spec.ts` (the whole flow on the Mac's width, and the phone checks at 390 px).
- **The review focus, each covered by a test:**
  - calendar edges — `packages/protocol/src/schedule.test.ts` (one occurrence per day across a whole year with DST, monthly clamped to the month's end, weekly across a year end; passing under `TZ=America/New_York` and `TZ=Europe/Bucharest`, re-run 2026-10-27);
  - asleep, then restarted mid-run — `apps/server/src/runtime/job-scheduler.test.ts` ("a Mac asleep through three occurrences runs once…", "a restart mid-run: the Steward is stopped, not resumed; the run is interrupted and caught up once", "a catch-up cut short by a restart…");
  - retry racing the tick — `job-scheduler.test.ts` ("a retry and a tick together start one run…");
  - a finding answered late — `apps/server/src/domain/findings.test.ts` (closed project: "Create a ticket" / "Implement it" refused, "Drop" works; stopped job: "Send" and "Approve" refused, "Drop" / "Refuse" work);
  - spend through the back doors — `findings.test.ts` (never answered or held by an agent or the system, never in a set, an "Allow similar" rule never touches it, free text refused), `apps/server/src/brains/common-tools.test.ts` (`answer_question` refuses it), `apps/server/src/http/remote-access.test.ts` (remote answers as for permissions, an agent's process refused).
- **Docs consistent with what was built:** SPEC decisions 142–145 (decision 10 amended by 143), §2.6, §2.7, §3.1, §3.2, §3.7, the glossary and three §8 questions; TECHNOLOGY §10 and the §5 tool table; IMPLEMENTATION_PLAN Phase 10 and corner cases 45–52; review notes in `docs/tasks/notes/P10-review.md`.

**Phase 10: done (2026-10-27).** The batch branch waits for Cosmin's merge into `phase-10` (CLAUDE.md, phase branch flow).
