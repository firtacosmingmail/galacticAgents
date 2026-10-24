# Long-term Projects, Area Moons and Recurring Jobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project can be long-term (purpose, goals, never closes by itself) on a big planet whose moons are business areas; each area holds recurring jobs that Mission Control runs on schedule as Stewards in the project's folder, catching up after downtime, pausing on failure, and bringing every finding and every real-money spend to Cosmin as inbox questions.

**Architecture:** New protocol types (`Area`, `Job`, `JobRun`, `Schedule`) and a new question kind `spend` live in `packages/protocol`; migration `0016` adds the project columns and the `areas`, `jobs`, `job_runs` tables and widens two CHECKs (bodies get host kind `areas`, questions get kind `spend`). Each job owns one hidden task (`task.meta.jobId`) on its area's moon, so every run is an ordinary Steward spawn on that task in the project's workspace (no worktree), and "one run at a time" is the existing one-live-Steward-per-task slot. A `JobScheduler` in the runtime (modelled on `Archival`) ticks every minute, collapses missed occurrences into one catch-up run, and records run ends; findings, failure notices and job spends are **job-owned questions** that outlive the run's Steward and never wake a brain. Confirmation cards are proposals carrying `meta.job` / `meta.longTerm` (precedent: `meta.plan`).

**Tech Stack:** TypeScript, zod (`packages/protocol`), Fastify + better-sqlite3 (`apps/server`), React 19 + zustand + R3F (`apps/web`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-long-term-projects-design.md` (approved 2026-10-24).

**Tickets** (new phase file `docs/tasks/PHASE_10_LONG_TERM_PROJECTS.md`, created in Task 1): **P10-01** protocol and storage (Tasks 1–3); **P10-02** long-term projects (Task 4); **P10-03** areas and jobs (Task 5); **P10-04** runs and the scheduler (Tasks 6, 8); **P10-05** findings and spend approvals (Tasks 7, 9); **P10-06** brain tools and cards (Task 10); **P10-07** web: Jobs tab, cards, scene (Tasks 11–13); **P10-08** docs and end-to-end (Task 14). Phase branch `phase-10` from `main`, one batch branch `p10-1-long-term-projects` from it. Cosmin merges; agents never merge into `main`.

## Global Constraints

- Every mutation and its events in one `ctx` transaction (`log.runCommand`); every new type in `packages/protocol`; nothing outside `apps/server/src/adapters` imports a runtime SDK; speculative fields in `meta`.
- Limits (`LONG_TERM_LIMITS` in protocol): purpose 1–2000 chars; goals 0–10, each 1–300 chars; area name 1–60; job name 1–80; instructions 1–8000; ≤12 areas per project; ≤10 jobs per area; ≤10 unattended rules per job; `job_runs` kept per job: the last 200 (older rows deleted when a run is recorded).
- `BIG_PLANET_MIN_MOONS = 4` → the big planets are Jupiter, Uranus and Saturn (counted from catalogued, non-reserved moons, not hard-coded names).
- Schedule kinds exactly: `daily {at}`, `weekdays {at}` (Mon–Fri), `weekly {days, at}` (ISO weekday 1=Mon…7=Sun, 1–7 distinct), `monthly {day: 1–31, at}`; `at` is `HH:MM` 24-hour, in the Mac's local time zone. A monthly day past the month's end runs on its last day.
- Scheduler tick: `JOB_TICK_MS = 60_000`. A run is `catch_up` when its due time is more than `2 * JOB_TICK_MS` before it starts.
- Several missed occurrences → exactly one run, `coversFrom` = the previous run's start (or the job's creation), and the next due time is the first occurrence **after now**.
- One run per job at a time; a due run waits while one runs. Follow-ups (approved send/spend) queue on the job and run when no run is running.
- A failed run pauses its job and opens **one** failure question (`Fixed — retry now` / `Stop the job`); no new runs while paused. Any answer other than `Stop the job` retries at once and passes the written text to the retry run as a note.
- Finding actions exactly: suggestion → `Create a ticket` / `Implement it` / `Drop`; reply → `Send` / `Drop` (the edited reply travels as the answer's `detail.text`). Failure: `Fixed — retry now` / `Stop the job`. Spend: `Approve` / `Refuse`.
- `spend` questions: holder always the user; never answered by an agent, a supervisor, the project policy or an "Allow similar" rule; never part of a set; answered remotely only under the permission rules (decision 90); shown with class `question-spend`, a "$" badge, the amount (Intl currency format) and the purpose.
- Job-owned questions (`isJobOwned(q)`: `context.finding`, `context.jobFailure`, or `kind === 'spend'` with `context.spend.jobId`) survive their Steward's end and never wake a brain. Only "Implement it" messages the Waykeeper.
- Finished runs never wake the Waykeeper: job-run Stewards send no turn-end report, and their `agent.finished`/`agent.failed` never wake.
- Unattended rules: `PermissionRule`-shaped, scoped to one job, applied only to that job's run Stewards on top of the project's policy and rules; never `push`; never override a `deny`; never cover a spend.
- Credentials are never stored in a job: job instructions and rules refuse text matching the deliverables secret patterns (`.env`, keys) — reuse the existing secret check.
- A long-term project never starts the "anything else?" flow: `request_project_closure` refuses it, and `close_task`'s result omits the closure hint. Only Cosmin closes it.
- Jobs only on long-term projects; a sub-project cannot become long-term on its own.
- Phone: every new view works in the one-screen phone layout (decision 140).
- Docs in the same work: SPEC §7 decisions **142** (long-term projects), **143** (area moons, amends 10), **144** (recurring jobs), **145** (real-money approvals); §8 the two open questions from the spec; TECHNOLOGY (jobs storage, scheduler, run lifecycle, job-owned questions, `spend`); IMPLEMENTATION_PLAN Phase 10; task board.

## Review Focus

1. **Calendar edges** — a monthly job on the 31st in February/April, a weekly job across a year end, a 02:30 daily job on the spring-forward night (02:30 does not exist) and the fall-back night (it exists twice): each must produce exactly one occurrence per day, never skip a month, never double-run. → Task 2 tests.
2. **Asleep, then restarted mid-run** — the Mac sleeps through three daily occurrences, Mission Control restarts while a run was half done: the half run is recorded `interrupted` (its Steward not resumed), and exactly one catch-up run follows. → Task 8 tests.
3. **Retry races the tick** — Cosmin answers "Fixed — retry now" while a tick is evaluating the job: never two runs at once. → Task 8 test.
4. **A finding answered late** — after its job was stopped, its area removed or its project closed: "Create a ticket"/"Implement it" on a closed project and "Send" on a stopped job are refused with a clear message, not a crash; "Drop" always works. → Task 7 tests.
5. **Spend through the back doors** — a brain calling `answer_question` on a spend, a matching "Allow similar" rule, a remote answer without auto-approve, a supervisor relay: all refused; only the user's local (or permitted remote) answer resolves it. → Task 7 tests.

---

### Task 1: Protocol — long-term types, schedule shape, `spend`, events

**Files:**
- Create: `packages/protocol/src/long-term.ts` (+ export from `src/index.ts`)
- Modify: `src/enums.ts` (`HostKind` + `'areas'`, `QuestionKind` + `'spend'`), `src/domain.ts` (`Project` fields, `QuestionContext.finding/jobFailure/spend`), `src/events.ts`, `src/commands.ts`, `src/rest.ts`, `src/ws.ts` (`SnapshotMessage.areas?`, `jobs?`), `src/world.ts` (`WorldState.areas`, `jobs`; `applySnapshot`, `applyEvent`), `src/fixtures/events.ts`
- Create: `docs/tasks/PHASE_10_LONG_TERM_PROJECTS.md` (purpose, references = the spec, execution order, tickets P10-01…P10-08 with acceptance criteria from this plan); README row for Phase 10; claim P10-01.
- Test: `packages/protocol/src/long-term.test.ts`, extend `events.test.ts`, `world.test.ts`

**Interfaces — Produces:**
```ts
// long-term.ts
export const LONG_TERM_LIMITS = { maxPurpose: 2000, maxGoals: 10, maxGoal: 300, maxAreaName: 60,
  maxJobName: 80, maxInstructions: 8000, maxAreasPerProject: 12, maxJobsPerArea: 10,
  maxUnattendedRules: 10, runsKept: 200 } as const;
export const BIG_PLANET_MIN_MOONS = 4;
export const Schedule: z.ZodDiscriminatedUnion<'kind', …>; // daily | weekdays | weekly | monthly (Global Constraints)
export const JobState = z.enum(['active', 'paused', 'stopped']);
export const JobRule = PermissionRule.pick({ id: true, scope: true, tool: true, match: true, categories: true, label: true });
export const JobRunOutcome = z.enum(['running', 'quiet', 'findings', 'failed', 'interrupted']);
export const JobRunPurpose = z.enum(['scheduled', 'catch_up', 'retry', 'follow_up']);
export const FollowUp = z.object({ questionId: Id, kind: z.enum(['send', 'spend']), text: z.string().optional(),
  amount: z.number().positive().optional(), currency: z.string().length(3).optional(), purpose: z.string().optional() });
export const JobRunBrief = z.object({ runId: Id, outcome: JobRunOutcome, purpose: JobRunPurpose,
  startedAt: Timestamp, endedAt: Timestamp.optional(), summary: z.string().max(500).optional() });
export const Area = z.object({ id: Id, projectId: Id, name, bodyId: Id, createdAt, updatedAt, meta });
export const Job = z.object({ id: Id, projectId: Id, areaId: Id, taskId: Id, name, instructions, schedule: Schedule,
  provider: z.string().default('claude'), unattendedRules: z.array(JobRule).max(10), state: JobState,
  pausedReason: z.string().optional(), failureQuestionId: Id.optional(), nextRunAt: Timestamp.optional(),
  lastRun: JobRunBrief.optional(), runningRunId: Id.optional(), followUps: z.array(FollowUp).default([]),
  createdAt, updatedAt, meta });
export const JobRun = z.object({ id: Id, jobId: Id, agentId: Id.optional(), purpose: JobRunPurpose, dueAt: Timestamp,
  coversFrom: Timestamp.optional(), startedAt: Timestamp, endedAt: Timestamp.optional(), outcome: JobRunOutcome,
  summary: z.string().optional(), numbers: z.record(z.string(), z.number()).optional(),
  followUp: FollowUp.optional(), note: z.string().optional(), meta });
export const FindingContext = z.object({ jobId: Id, runId: Id, kind: z.enum(['suggestion', 'reply']),
  title: z.string().min(1).max(200), draft: z.string().max(8000).optional() });
export const JobFailureContext = z.object({ jobId: Id, runId: Id, reason: z.string().min(1) });
export const SpendContext = z.object({ amount: z.number().positive(), currency: z.string().length(3).default('USD'),
  purpose: z.string().min(1).max(500), jobId: Id.optional(), runId: Id.optional() });
export const FINDING_ACTIONS = { suggestion: ['Create a ticket', 'Implement it', 'Drop'], reply: ['Send', 'Drop'] } as const;
export const FAILURE_ACTIONS = ['Fixed — retry now', 'Stop the job'] as const;
export const SPEND_ACTIONS = ['Approve', 'Refuse'] as const;
export function isJobOwned(q: Pick<Question, 'kind' | 'context'>): boolean;
export function isJobTask(t: Pick<Task, 'meta'>): boolean;           // meta.jobId is a string
export function jobIdOfTask(t: Pick<Task, 'meta'>): Id | undefined;
export function isLongTerm(p: Pick<Project, 'longTerm'>): boolean;
```
- `Project` gains `longTerm?: boolean`, `purpose?: string`, `goals?: string[]`; `ProjectChanges` may set them.
- `Proposal.meta` precedents: `ProposalJob = { projectId, waykeeperId, action: 'create'|'change'|'stop', jobId?, draft?: JobDraft, area?: {areaId} | {name} }` in `meta.job`; `ProposalLongTerm = { projectId?, purpose, goals }` in `meta.longTerm` (no `projectId` = a new project). `JobDraft = Job.pick({name, instructions, schedule, provider, unattendedRules})` (rules' `id` assigned on approval). Readers `proposalJobOf(p)`, `proposalLongTermOf(p)`.
- Events: `area.created {area}`, `area.updated {areaId, changes}`, `job.created {job}`, `job.updated {jobId, changes}`, `job_run.started {run}`, `job_run.ended {runId, jobId, outcome, endedAt, summary?, numbers?}`. The fold keeps `areas` and `jobs`; `job_run.*` are a no-op in the fold (run history is REST, Task 12) — the job row's `lastRun`/`runningRunId` change through `job.updated` in the same command.
- `commands.ts` inputs + `DomainCommands` methods (implemented in Tasks 4–7):
```ts
createProject(input: CreateProjectInput & { longTerm?: { purpose: string; goals: string[] } }, write?)  // extended
setLongTerm(input: { projectId: Id; purpose: string; goals: string[]; by: Actor }): Promise<CommandResult<Project>>;
createJob(input: { projectId: Id; area: { areaId: Id } | { name: string }; draft: JobDraft; by: Actor }): Promise<CommandResult<{ job: Job; area: Area }>>;
updateJob(input: { jobId: Id; changes: Partial<JobDraft> & { areaId?: Id }; by: Actor }): Promise<CommandResult<Job>>;
setJobState(input: { jobId: Id; state: JobState; by: Actor; reason?: string }): Promise<CommandResult<Job>>;
startJobRun(input: { jobId: Id; purpose: JobRunPurpose; dueAt: string; followUp?: FollowUp; note?: string }): Promise<CommandResult<JobRun>>;
attachJobRunAgent(input: { runId: Id; agentId: Id }): Promise<CommandResult<JobRun>>;
endJobRun(input: { runId: Id; outcome: Exclude<JobRunOutcome, 'running'>; summary?: string; numbers?: Record<string, number>; failureReason?: string }): Promise<CommandResult<JobRun>>;
openFinding(input: { runId: Id; originAgentId: Id; kind: 'suggestion' | 'reply'; title: string; text: string; draft?: string }): Promise<CommandResult<Question>>;
requestSpend(input: { originAgentId: Id; amount: number; currency?: string; purpose: string; runId?: Id }): Promise<CommandResult<Question>>;
```
- `AnswerQuestionInput` gains `detail?: SetAnswer` (stored in `meta.answerDetail`, as sets do).

- [ ] **Step 1: Write the failing tests** — `long-term.test.ts`:
  - `Schedule` accepts `{kind:'weekly', days:[1,4], at:'09:00'}`, refuses `days: []`, `days:[1,1]`, `days:[8]`, `at:'24:00'`, `at:'9:00'`, `{kind:'monthly', day: 32}`.
  - `Job.parse` with no `provider`/`followUps` gives `'claude'` / `[]`; 11 unattended rules refused.
  - `isJobOwned`: true for `context.finding`, `context.jobFailure`, `{kind:'spend', context.spend.jobId}`; false for a spend without `jobId` and a plain clarification.
  - `isJobTask({meta:{jobId:'j-1'}})` true, `{}` false.
  - `events.test.ts`: each new event round-trips through `Event.parse`; `world.test.ts`: `job.created` then `job.updated {state:'paused'}` folds; `job_run.started` leaves the world unchanged; a snapshot with `jobs`/`areas` applies; a snapshot without them gives empty records.
- [ ] **Step 2: Run** `pnpm --filter @galactic/protocol test` — FAIL (module missing).
- [ ] **Step 3: Implement** the types, events, fold and command interfaces above; write the phase file and README row; claim P10-01 (commit `P10-01: start protocol and storage`).
- [ ] **Step 4: Run** `pnpm --filter @galactic/protocol test && pnpm typecheck` — PASS. Where an exhaustive `HostKind`/`QuestionKind` switch breaks, add the minimal case (`'areas'` behaves like a project host for lookups, `'spend'` like `'permission'` for holding and display) and list each one in the report; Tasks 7 and 13 give them their real behaviour.
- [ ] **Step 5: Commit** `P10-01: protocol for long-term projects, areas, jobs and spend`.

### Task 2: Schedules — next occurrence and plain words

**Files:**
- Create: `packages/protocol/src/schedule.ts` (+ export)
- Test: `packages/protocol/src/schedule.test.ts`

**Interfaces — Produces:**
```ts
export function nextOccurrence(schedule: Schedule, after: Date): Date;   // strictly after `after`, local time
export function scheduleText(schedule: Schedule): string;
export function missedSince(schedule: Schedule, from: Date, to: Date): number; // occurrences in (from, to]
```
Approach: walk local calendar days from `after`'s date (at most 400 days), build the candidate with `new Date(y, m, d, hh, mm)`; accept the first candidate `> after` whose day matches. Monthly: clamp `day` to the month's length. A candidate that falls in a spring-forward gap is normalised by `Date` to the next valid minute — accept it once (compare by local date, not by time, so the fall-back repeat never produces two). `scheduleText`: `every day 9:00`, `weekdays 9:00`, `Mon, Thu 9:00`, `monthly, 1st 9:00` (ordinals 1st 2nd 3rd 4th … 21st 22nd 23rd 31st; hours without a leading zero).

- [ ] **Step 1: Write the failing tests** (assert with local constructors, so they hold in any time zone):
```ts
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
expect(nextOccurrence({ kind: 'daily', at: '09:00' }, at(2026, 10, 24, 8, 59))).toEqual(at(2026, 10, 24, 9));
expect(nextOccurrence({ kind: 'daily', at: '09:00' }, at(2026, 10, 24, 9, 0))).toEqual(at(2026, 10, 25, 9)); // strictly after
expect(nextOccurrence({ kind: 'weekdays', at: '09:00' }, at(2026, 10, 23, 10))).toEqual(at(2026, 10, 26, 9)); // Fri → Mon
expect(nextOccurrence({ kind: 'weekly', days: [1, 4], at: '08:00' }, at(2026, 12, 31, 9))).toEqual(at(2027, 1, 4, 8)); // across year end
expect(nextOccurrence({ kind: 'monthly', day: 31, at: '09:00' }, at(2027, 2, 1))).toEqual(at(2027, 2, 28, 9));
expect(nextOccurrence({ kind: 'monthly', day: 31, at: '09:00' }, at(2027, 2, 28, 10))).toEqual(at(2027, 3, 31, 9));
expect(missedSince({ kind: 'daily', at: '09:00' }, at(2026, 10, 20, 10), at(2026, 10, 23, 12))).toBe(3);
expect(scheduleText({ kind: 'monthly', day: 1, at: '09:00' })).toBe('monthly, 1st 9:00');
expect(scheduleText({ kind: 'weekly', days: [4, 1], at: '08:30' })).toBe('Mon, Thu 8:30');
```
  plus `dst: one occurrence per day across a whole year` — for a daily `02:30` job, iterate `nextOccurrence` from Jan 1 for 365 steps: every result is on a distinct, consecutive local date (holds in every zone, including ones with DST).
- [ ] **Step 2: Run** `pnpm --filter @galactic/protocol test -- schedule` — FAIL.
- [ ] **Step 3: Implement** `schedule.ts`.
- [ ] **Step 4: Run** the same — PASS; also run once with `TZ=America/New_York` and `TZ=Europe/Bucharest` prefixed — PASS.
- [ ] **Step 5: Commit** `P10-01: schedules — next occurrence, missed count, plain words`.

### Task 3: Storage — migration 0016, tables, snapshot

**Files:**
- Create: `apps/server/src/db/migrations/0016_long_term_projects.sql`
- Modify: `apps/server/src/db/tables.ts` (project mapper + columns; `areas`, `jobs`, `jobRuns` tables), `apps/server/src/domain/event-log.ts` (`snapshot()` adds `areas`, `jobs`), `apps/server/src/ws/snapshot.ts`, `apps/server/src/db/map-export.ts` / `map-import.ts` (carry the new tables like the others, or exclude them explicitly with a comment if the map format excludes run data)
- Test: `apps/server/src/db/db.test.ts`, new `apps/server/src/db/long-term-tables.test.ts`

Migration (header `-- P10-01: long-term projects, area moons, recurring jobs (SPEC decisions 142–145).`; first line `-- migrate: foreign_keys=off` because two tables are rebuilt):
- `ALTER TABLE projects ADD COLUMN long_term INTEGER NOT NULL DEFAULT 0;` `… purpose TEXT;` `… goals TEXT;` (JSON array).
- Rebuild `bodies` with `host_kind IN ('project','task','areas')` (copy `0005`'s rebuild pattern, keep `bodies_host` index).
- Rebuild `questions` with `kind IN ('clarification','permission','spend')` (keep `questions_status` index and every column added since `0001`).
- `CREATE TABLE areas (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, body_id TEXT NOT NULL REFERENCES bodies(id), created_at, updated_at, meta)`; index on `project_id`, on `body_id`.
- `CREATE TABLE jobs (id, project_id → projects, area_id → areas, task_id → tasks, name, instructions, schedule TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'claude', unattended_rules TEXT, state TEXT NOT NULL CHECK (state IN ('active','paused','stopped')), paused_reason, failure_question_id, next_run_at, last_run TEXT, running_run_id, follow_ups TEXT, created_at, updated_at, meta)`; index `(state, next_run_at)`.
- `CREATE TABLE job_runs (id, job_id → jobs, agent_id, purpose, due_at, covers_from, started_at, ended_at, outcome TEXT NOT NULL CHECK (outcome IN ('running','quiet','findings','failed','interrupted')), summary, numbers TEXT, follow_up TEXT, note, meta)`; index `(job_id, started_at)`.

- [ ] **Step 1: Write the failing tests** — `long-term-tables.test.ts` on `openDatabase(':memory:')`: insert/get round-trips an `Area`, a `Job` (with schedule, rules, followUps, lastRun) and a `JobRun`; a question with `kind:'spend'` inserts; a body with `host {kind:'areas', id}` upserts; a project with `longTerm/purpose/goals` round-trips; an existing database at 0015 with bodies, questions and projects migrates with every row intact (seed through `migrate(db, migrations.slice(0, 15))` then the rest); `log.snapshot()` contains `areas` and `jobs`.
- [ ] **Step 2: Run** `pnpm --filter @galactic/server test -- long-term-tables db.test` — FAIL.
- [ ] **Step 3: Implement** the migration, mappers, tables and snapshot.
- [ ] **Step 4: Run** the same, then `pnpm --filter @galactic/server test -- conformance map-export backup` — PASS.
- [ ] **Step 5: Commit** `P10-01: migration 0016 — areas, jobs, job runs, spend questions`; finish P10-01 (`P10-01: done — protocol and storage for long-term projects`).

### Task 4: Long-term projects — creation, conversion, no self-closing

**Files:**
- Modify: `apps/server/src/domain/catalogue.ts` (`chooseBody` planet request gains `longTerm?: true`; `isBigPlanet`, `freeBigPlanets`), `apps/server/src/domain/projects.ts` (`createProject` long-term; new `setLongTerm`), `apps/server/src/domain/bodies.ts` (`moveHost` refuses a project with areas), `apps/server/src/domain/commands.ts`, `apps/server/src/domain/proposals.ts` (approving a proposal with `meta.longTerm` creates a long-term project or converts one), `apps/server/src/brains/waykeeper/tools.ts` (`request_project_closure` refuses long-term; `close_task` omits `allTasksClosed`/closure `next` for long-term)
- Test: `apps/server/src/domain/long-term.test.ts`, extend `catalogue.test.ts`, `apps/server/src/brains/waykeeper/*.test.ts` (closure)

**Interfaces — Produces:** `isBigPlanet(ctx: Reader, body: Body): boolean`; `freeBigPlanets(ctx: Reader): Body[]`; `setLongTerm(ctx, input): Project`; `BodyRequest` planet variant `{kind:'planet', longTerm?: true}`; `BodyChoice` refusal reason `'no_planet_with_moons'`.

Rules: a long-term request takes the first free big planet, else the first free planet with ≥1 catalogued moon, else refuses `no_planet_with_moons` (the proposal parks as today). `setLongTerm`: refuses a sub-project (`invalid`, "a part of <parent> cannot become long-term on its own") and a finished project; sets the three fields (`project.updated`); if the project is not on a big planet, moves it (`moveHost`) to a free big planet; if none, stays when its planet has moons; a project on a moon or on a moonless planet moves to the first free planet with moons, else refuses `no_planet_with_moons` with the text "No planet with moons is free; <project> stays as it is until one is." Converting an already long-term project only updates purpose/goals.

- [ ] **Step 1: Write the failing tests:**
  - `createProject` with `longTerm` on an empty catalogue lands on Jupiter (first big planet in catalogue order) and stores purpose/goals; with Jupiter, Saturn, Uranus taken it lands on Mars (moons) — never Mercury/Venus; with every moon-bearing planet taken → `no_planet_with_moons`.
  - `setLongTerm` on a project on Mars with Saturn free → moves to Saturn, satellites follow (`agent.updated` bodyId), one transaction; with no big planet free → stays on Mars; on Venus with nothing free → refused, project unchanged; on a sub-project → `invalid`.
  - `moveHost` of a long-term project that has an area → `invalid` ("a long-term project with areas stays on its planet").
  - `request_project_closure` on a long-term project with every task completed → `invalid` "long-term projects are closed by the user only"; `close_task` of its last task returns no `allTasksClosed`.
  - Approving a proposal with `meta.longTerm` (no `projectId`) creates a long-term project; with `projectId` converts it.
- [ ] **Step 2: Run** `pnpm --filter @galactic/server test -- long-term catalogue closure` — FAIL.
- [ ] **Step 3: Implement.** Claim P10-02 first (`P10-02: start long-term projects`).
- [ ] **Step 4: Run** the same plus `proposal-flow placement projects` — PASS.
- [ ] **Step 5: Commit** `P10-02: long-term projects — big planets, conversion, user-only closing`; `P10-02: done — …`.

### Task 5: Areas and jobs — domain

**Files:**
- Create: `apps/server/src/domain/jobs.ts`
- Modify: `apps/server/src/domain/commands.ts`, `apps/server/src/domain/projects.ts` (`archiveProject`/`closeProject`: stop jobs, release area moons), `apps/server/src/domain/work-states.ts` (job tasks never derive `completed`/`failed`; they read `approved` idle, `in_progress` while a run is live), `apps/server/src/domain/agents.ts` (`checkPlacement`: a job task's Steward is supervised by its project's Waykeeper row whatever that row's status)
- Test: `apps/server/src/domain/jobs.test.ts`

**Interfaces — Produces:**
```ts
export function createArea(ctx: CommandContext, projectId: Id, name: string): Area;  // moon choice below
export function createJob(ctx: CommandContext, input: CreateJobInput): { job: Job; area: Area };
export function updateJob(ctx: CommandContext, input: UpdateJobInput): Job;
export function setJobState(ctx: CommandContext, input: SetJobStateInput): Job;
export function jobOf(ctx: Reader, jobId: Id): Job;          // not_found otherwise
export function areaMoonFor(ctx: Reader, planetId: Id): Body; // free moon first, else the 'areas' moon of this project with fewest areas (catalogue order on ties)
```
Rules: jobs only on long-term projects (`invalid` "jobs live on long-term projects"); an area name is unique per project (case-insensitive: `{name}` reuses the existing area); limits from Global Constraints; never takes a moon hosted by other work. The moon's host becomes `{kind:'areas', id: projectId}` (`body.assigned`). `createJob` also creates the job's task (`description: "Recurring job: <name>"`, `state:'approved'`, `bodyId` = the area's moon, `meta.jobId`) and sets `nextRunAt = nextOccurrence(schedule, now)`. `updateJob` with a new schedule recomputes `nextRunAt`; moving a job to another area moves its task's body. `setJobState('stopped')` clears `nextRunAt`, drops queued follow-ups and cancels the job's open failure question; `'active'` from `'paused'` sets `nextRunAt = now`. Rule ids for `unattendedRules` are assigned here (`r-<uuid>`); a rule with `categories` containing `push`, or instructions/rule text matching the secret patterns (reuse the deliverables secret check), is refused `invalid`. Archiving or closing the project stops every job and frees its area moons (`body.freed`).

- [ ] **Step 1: Write the failing tests:**
  - On Saturn (7 moons) creating areas Feedback, Marketing, Sales, Finance, Research takes five distinct free moons; on Mars (2 moons) the third area shares the moon with fewest areas and the body host stays `{kind:'areas', id}`.
  - A moon hosting an independent small project is never chosen.
  - `createJob` on a non-long-term project → `invalid`; 11th job in an area → `invalid`; a rule with `push` → `invalid`; instructions containing `OPENAI_API_KEY=sk-…` → `invalid`.
  - `createJob` emits `area.created` (new area), `task.created` (hidden job task on the moon), `job.created` with `nextRunAt` = next 09:00 — all in one command (same `at`).
  - `setJobState(stopped)` cancels the open failure question and empties `followUps`; `archiveProject` frees every area moon.
  - A job task's state stays `approved` after its Steward finishes (work-states).
- [ ] **Step 2: Run** `pnpm --filter @galactic/server test -- jobs` — FAIL.
- [ ] **Step 3: Implement.** Claim P10-03.
- [ ] **Step 4: Run** `pnpm --filter @galactic/server test -- jobs work-states placement projects` — PASS.
- [ ] **Step 5: Commit** `P10-03: areas on moons and recurring jobs in the domain`; `P10-03: done — …`.

### Task 6: Job runs — start, end, failure, memory

**Files:**
- Create: `apps/server/src/domain/job-runs.ts`
- Modify: `apps/server/src/domain/commands.ts`, `apps/server/src/domain/questions.ts` / `question-service.ts` (failure question; `cancelQuestionsOf` skips job-owned questions)
- Test: `apps/server/src/domain/job-runs.test.ts`

**Interfaces — Produces:**
```ts
export function startJobRun(ctx: CommandContext, input: StartJobRunInput): JobRun;  // conflict if job.runningRunId; invalid unless state is 'active' (follow-ups wait while paused)
export function endJobRun(ctx: CommandContext, input: EndJobRunInput): JobRun;
export function jobRuns(ctx: Reader, jobId: Id, limit?: number): JobRun[];          // newest first, default 20, max 200
export function jobMemory(ctx: Reader, jobId: Id, limit?: number): string[];       // default 10 lines: "<date> <outcome>: <summary> — findings: <title> → <answer>; …"
export function runPurpose(dueAt: Date, startedAt: Date): 'scheduled' | 'catch_up';
```
`startJobRun` records `coversFrom` = `job.lastRun?.startedAt ?? job.createdAt`, sets `job.runningRunId`, emits `job_run.started` + `job.updated`; a `follow_up` run removes its follow-up from `job.followUps`. `endJobRun`: sets outcome/summary (summary in `lastRun` cut to 500 chars), clears `runningRunId`, emits `job_run.ended` + `job.updated {lastRun}`; deletes runs beyond 200 for the job; on `failed` sets `state:'paused'`, `pausedReason`, and opens **one** user-held clarification with `context.jobFailure`, text `"<job name> failed: <reason>. Tell me when it is fixed."`, options `FAILURE_ACTIONS`, `originAgentId` = the run's agent (or the project's Waykeeper row when the run never got an agent), `meta.jobOwned: true`; stores `failureQuestionId`. A second failure while a failure question is open never opens another. `interrupted` changes nothing else but sets `nextRunAt = now` (missed run).

- [ ] **Step 1: Write the failing tests:** start → end `quiet` updates `lastRun` and clears `runningRunId`; a second `startJobRun` while running → `conflict`; `failed` pauses and opens exactly one failure question held by the user; failing again (forced) opens none; the failure question survives `cancelQuestionsOf(steward)`; 201 runs leave 200; `jobMemory` lists newest first with finding answers; `interrupted` sets `nextRunAt` to `ctx.now`; `runPurpose(due, due + 3 min)` is `catch_up`, `due + 1 min` is `scheduled`.
- [ ] **Step 2: Run** `pnpm --filter @galactic/server test -- job-runs` — FAIL.
- [ ] **Step 3: Implement.** Claim P10-04 (`P10-04: start runs and the scheduler`).
- [ ] **Step 4: Run** `pnpm --filter @galactic/server test -- job-runs questions question-service` — PASS.
- [ ] **Step 5: Commit** `P10-04: job runs — start, end, pause on failure, run memory`.

### Task 7: Findings and spend questions — domain

**Files:**
- Create: `apps/server/src/domain/findings.ts`
- Modify: `apps/server/src/domain/questions.ts` (`checkAnswer`, `checkHolder` for `spend`; answering a job-owned question applies its action in the same command), `apps/server/src/domain/question-service.ts` (`holderFor`: spend → user), `apps/server/src/domain/question-sets.ts` (sets refuse spend), `apps/server/src/domain/commands.ts` (`answerQuestion` passes `detail`; remote answers to `spend` follow the permission rule), `apps/server/src/brains/common-tools.ts` (`answer_question` refuses spend: "the user answers spend approvals"), `apps/server/src/brains/wake.ts` (`concerns`: job-owned questions never wake; `spend` wakes no brain), `apps/server/src/http/agent-routes.ts` (remote gate for spend = permission's)
- Test: `apps/server/src/domain/findings.test.ts`, extend `wake.test.ts`, `common-tools.test.ts`, `remote-access.test.ts`

**Interfaces — Produces:**
```ts
export function openFinding(ctx: CommandContext, input: OpenFindingInput): Question;   // user-held, options FINDING_ACTIONS[kind], meta.jobOwned
export function requestSpend(ctx: CommandContext, input: RequestSpendInput): Question;  // kind 'spend', options SPEND_ACTIONS; jobId/runId when the asker is a job-run Steward
export function applyJobAnswer(ctx: CommandContext, q: Question): void;              // called inside answerQuestion for job-owned questions
```
Actions (inside the answering command):
- `Create a ticket` → a task in the project, `state:'proposed'` left unstarted, description = the finding's title, `meta.fromFinding: questionId`. Project finished → `invalid` "the project is closed; the suggestion was not filed".
- `Implement it` → `message.sent` from the system to the project's Waykeeper: `"Cosmin wants this implemented (from <job name>): <title> — <text>. Plan it as a task and propose it."`. Project finished → `invalid` as above.
- `Send` → queue `FollowUp {kind:'send', text: detail.text ?? draft}` on the job. Job stopped → `invalid` "the job is stopped; the reply was not sent".
- `Approve` on a job spend → queue `FollowUp {kind:'spend', amount, currency, purpose}`; job stopped → `invalid` as above. `Approve`/`Refuse` on a task spend → recorded only (Task 9 relays it to the Steward).
- `Drop` / `Refuse` → recorded only.
- Failure question: `Stop the job` → `setJobState(stopped)`; any other answer → `state:'active'`, `nextRunAt = now`, `pausedReason` cleared, the answer text (unless it is exactly `Fixed — retry now`) kept as `job.meta.retryNote`.

- [ ] **Step 1: Write the failing tests:**
  - each action above, including the refusals (closed project, stopped job) and `Drop` working after the job is stopped;
  - an edited reply answer (`answer:'Send', detail:{choices:['Send'], text:'Hi, thanks…'}`) queues that text, not the draft;
  - spend: an agent answering → `invalid`; holder always user even for a Steward whose Waykeeper lives; a spend in `openQuestionSet` → `invalid`; a matching "Allow similar" rule never touches it (spend is not a tool call: assert no `permission.decided` and the question stays open); a remote answer without auto-approve → 403 like permission; with auto-approve → accepted;
  - wake: answering a finding wakes no brain; `Implement it` wakes the Waykeeper exactly once (its `message.sent`); a job spend's `question.opened` wakes no brain.
- [ ] **Step 2: Run** `pnpm --filter @galactic/server test -- findings wake common-tools remote-access` — FAIL.
- [ ] **Step 3: Implement.** Claim P10-05.
- [ ] **Step 4: Run** the same plus `questions question-sets permissions allow-similar` — PASS.
- [ ] **Step 5: Commit** `P10-05: findings and spend approvals as job-owned questions`.

### Task 8: The scheduler and job-run Stewards — runtime

**Files:**
- Create: `apps/server/src/runtime/job-scheduler.ts`, `apps/server/src/brains/job-prompt.ts`
- Modify: `apps/server/src/runtime/compose.ts` (build the scheduler; `start` only `if (opts.jobs?.intervalMs)`; stop in `shutdown()`/`dispose()`), `apps/server/src/index.ts` (start after `promotions`, i.e. after recovery and the Harmonizer; stop in `shutdown`), `apps/server/src/runtime/agent-runtime.ts` (`recover()` does not resume job-run Stewards: stops them as system and leaves them out of `needAttention`; `rulesOf` adds the job's `unattendedRules` for a Steward whose task is a job task), `apps/server/src/runtime/steward-reports.ts` (no turn-end report for job-run Stewards), `apps/server/src/brains/wake.ts` (`agent.finished/failed/stalled` of a job-run Steward wake no one)
- Test: `apps/server/src/runtime/job-scheduler.test.ts`, extend `agent-runtime` recovery tests, `steward-reports` tests, `permission-gate` tests

**Interfaces — Produces:**
```ts
export const JOB_TICK_MS = 60_000;
export interface JobTickReport { started: Id[]; waited: Id[]; interrupted: Id[]; ended: Id[] }
export class JobScheduler {
  constructor(opts: { log: EventLog; commands: DomainCommands; runtime: AgentRuntime; stewardRuntime: () => AgentRuntimeName;
    now?: () => Date; timers?: Timers; onError: (e: unknown) => void });
  start(intervalMs?: number, opts?: { immediate?: boolean }): void;
  stop(): void;
  tick(): Promise<JobTickReport>;          // serialised: a tick never overlaps another
  retryNow(jobId: Id): Promise<void>;      // called after a failure answer; goes through the same serialised path
}
export function jobRunPrompt(brief: { project: Project; job: Job; area: Area; run: JobRun; memory: string[];
  followUp?: FollowUp; note?: string; declares: boolean }): string;
```
`tick()` in order: (1) **reconcile** — every job with `runningRunId` whose run agent is not live: `endJobRun(interrupted)`; (2) **ended turns** — handled by a `runtime.onTurnEnded` subscription (not the tick): a job-run Steward's turn that ended on its own → `endJobRun` with the outcome/summary it reported through `report_run` (Task 9), else `quiet` with the turn's last text (≤500 chars), then stop the Steward as system; `agent.failed` → `endJobRun(failed, reason = error; for a cap stop while a permission question was open: "it needed permission to <action> and nobody answered")`; (3) **due** — for each `active` job without a running run, with a queued follow-up or `nextRunAt <= now`: `startJobRun` (purpose `follow_up` first, else `runPurpose`), set `nextRunAt = nextOccurrence(schedule, now)` for scheduled/catch-up runs, then `commands.spawnAgent({role:'steward', runtime: stewardRuntime(), taskId: job.taskId, projectId, supervisorId: <the project's Waykeeper row>, prompt: jobRunPrompt(…)})` and `attachJobRunAgent`. Before starting a run, skip the job (report it in `waited`) when the runtime has no free slot under the concurrency cap; a spawn still refused by that cap (a race) → `endJobRun(interrupted)`, which sets `nextRunAt = now`, so the next tick tries again — never `failed`, never a question. Refused by budget or no Waykeeper row → `endJobRun(failed, reason)`. `retryNow` and the failure-answer path both enter the same serialised queue, so a retry and a tick never start two runs.

`jobRunPrompt` contains: project name, purpose, goals; area and job name; the job's instructions; "This run covers <coversFrom> to now" for catch-up; the memory lines; the follow-up ("Send exactly this reply: …" / "Cosmin approved spending <amount> for <purpose>: do it now") or the retry note; the rules: read and draft only, never send/post/spend unless this run is the approved follow-up; report each finding with `report_finding`; before anything that costs real money call `request_spend` and stop; end with `report_run`. For `declares: false` runtimes: list findings in the final message instead (out of scope beyond the text: jobs run on Claude until project 2).

- [ ] **Step 1: Write the failing tests** (`fakeTimers()`, `tickingClock()`, the fake adapter, as in `archival.test.ts`):
  - a daily 09:00 job: clock 08:59 → tick starts nothing; 09:00 → one run, purpose `scheduled`, Steward spawned on the job task in `project.workspace` (no worktree), supervisor = the Waykeeper row;
  - asleep: last run Oct 20 09:00, clock Oct 23 12:00 → exactly one run, `catch_up`, `coversFrom` Oct 20 09:00, next due Oct 24 09:00;
  - restart mid-run: a run `running` with a Steward, recompose the runtime (`recover()`): the Steward is not resumed (`agent.stopped` by system, not in `needAttention`), the next tick records `interrupted` and starts one catch-up run;
  - one at a time: a run still going at the next due time → `waited`, no second spawn; it starts on the tick after the first ends;
  - retry race: `retryNow(job)` and `tick()` called together → one spawn;
  - concurrency cap full → `waited` with no run row, spawned on a later tick; a cap race after `startJobRun` → run `interrupted`, no question, retried next tick;
  - a job whose `provider` is `'gemini'` still runs on the Steward runtime (Claude) until project 2; budget refusal → run `failed`, job paused, one failure question;
  - turn end: the Steward's final turn ends → run `quiet` with its last text; no `message.sent` to the Waykeeper; the Waykeeper's mailbox gets nothing for `agent.finished`;
  - unattended rules: a job rule `network` words `curl api.myapp.com` allows that call for the job's run Steward, while a task Steward of the same project is asked;
  - `dispose()` stops the timer.
- [ ] **Step 2: Run** `pnpm --filter @galactic/server test -- job-scheduler steward-reports permission-gate resume` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `pnpm --filter @galactic/server test` (whole server suite) — PASS.
- [ ] **Step 5: Commit** `P10-04: the job scheduler — runs on time, catches up, one at a time`; `P10-04: done — …`.

### Task 9: Steward tools — findings, run report, spend

**Files:**
- Create: `apps/server/src/brains/job-tools.ts`
- Modify: `apps/server/src/runtime/compose.ts` (`setStewardTools` returns deliverable tools + `stewardJobTools`), `apps/server/src/brains/steward-prompt.ts` (every Steward: "Before anything that spends real money, call `request_spend` and end your turn; never spend without an approval."; runtimes that cannot serve tools: "never spend money; report 'Not done: needs approval to spend …'"), a `SpendRelay` subscriber (in `job-tools.ts`, registered in compose) that sends a task Steward its spend answer (`"Spend approval for <amount> (<purpose>): approved"` / `"…: refused"`) via `runtime.send`
- Test: `apps/server/src/brains/job-tools.test.ts`

**Interfaces — Produces:**
```ts
export const JOB_TOOL_NAMES = ['report_finding', 'report_run'] as const;
export function stewardJobTools(commands: DomainCommands, tables: Tables, agent: Pick<Agent, 'id' | 'taskId'>): ToolDefinition[];
// every Steward: request_spend {amount:number>0, currency?:string(3), purpose:string}
//   → { questionId, note: 'Asked Cosmin. End your turn now; …' }
// job-run Stewards only (task is a job task with a running run):
//   report_finding {kind:'suggestion'|'reply', title, text, draft?} → { questionId }
//   report_run {outcome:'quiet'|'findings'|'failed', summary, numbers?: Record<string, number>, failureReason?}
//     → stores the report on the run (meta.report) for the turn-end handler; outcome 'findings' with no finding reported → invalid
```
Limits: at most 20 findings per run (`invalid` beyond); `numbers` keys 1–60 chars, at most 30 keys (kept on the run for project 3).

- [ ] **Step 1: Write the failing tests:** a task Steward gets `request_spend` only; a job-run Steward gets all three; `report_finding` opens a user-held job-owned question with the fixed options and the draft; the 21st finding → `invalid`; `report_run('failed')` makes the turn-end handler record `failed` and pause the job; a task Steward's spend answer reaches it as one message; a job spend's answer sends nothing to any agent.
- [ ] **Step 2: Run** `pnpm --filter @galactic/server test -- job-tools` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `steward-prompt deliverable-tools` — PASS.
- [ ] **Step 5: Commit** `P10-05: Steward tools — report findings and runs, request spend approvals`; `P10-05: done — …`.

### Task 10: Brain tools, prompts and confirmation cards

**Files:**
- Create: `apps/server/src/brains/waykeeper/job-tools.ts`
- Modify: `apps/server/src/brains/waykeeper/index.ts` (register), `apps/server/src/brains/waykeeper/prompt.ts` (long-term section), `apps/server/src/brains/harmonizer/tools.ts` (`propose` gains optional `longTerm {purpose, goals}`; new `propose_long_term {projectId, purpose, goals}`), `apps/server/src/brains/harmonizer/prompt.ts`, `apps/server/src/domain/proposals.ts` (create/decide cards with `meta.job`; approving applies `createJob`/`updateJob`/`setJobState('stopped')` in the deciding transaction; the Waykeeper that proposed owns the card — wake on its decision like plan cards), `apps/server/src/brains/definition.ts` (`BrainQueries.jobs(projectId)`, `areas(projectId)`, `jobRuns(jobId, limit)`)
- Test: `apps/server/src/brains/waykeeper/job-tools.test.ts`, extend `proposal-flow.test.ts`, harmonizer tool tests

**Interfaces — Produces (Waykeeper tools):**
- `propose_job {area: string (existing area id or a new name), name, instructions, schedule, provider?, unattendedRules?: [{label, tool, scope, match, categories}]}` — `endsTurn: true`; refused on a non-long-term project; validates through the same checks as `createJob` before the card exists.
- `propose_job_change {jobId, changes}` and `propose_job_stop {jobId}` — `endsTurn: true`; the card shows before → after.
- `list_jobs {}` → `{ jobs: [{id, area, name, schedule: scheduleText, state, nextRunAt, lastRun, openFindings}] }`.
- `read_job_runs {jobId, limit?}` → `{ runs: [...] }` (≤50).
- Prompt (Waykeeper): when Cosmin asks for a recurring job, ask what is missing (what to look at, where the data lives, how often, what may it do unattended), then one `propose_job`; never put keys or passwords in instructions — tell Cosmin to put them in the project's environment; read runs only when asked or when changing a job; jobs never send, post or spend except through Cosmin's approval.
- Prompt (Harmonizer): a project meant to be looked after over months is proposed with `longTerm`; "make <project> long-term" → `propose_long_term`; "I need a recurring job on <project>" → relay to that project's Waykeeper.

- [ ] **Step 1: Write the failing tests:** `propose_job` on a long-term project opens one card whose `meta.job` carries the draft and area; approving creates the area, task and job in one transaction and wakes the proposing Waykeeper once; rejecting creates nothing; `propose_job` with a `push` rule or a key in the instructions is refused before any card; `propose_job_stop` approved → job `stopped`; `list_jobs` shows `scheduleText`; Harmonizer `propose` with `longTerm` → approved → a long-term project on a big planet; `propose_long_term` approved → converted (Task 4 rules).
- [ ] **Step 2: Run** `pnpm --filter @galactic/server test -- job-tools proposal-flow harmonizer` — FAIL.
- [ ] **Step 3: Implement.** Claim P10-06.
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `P10-06: Waykeeper job tools, Harmonizer long-term proposals, job cards`; `P10-06: done — …`.

### Task 11: Web — job and long-term cards, finding and spend cards

**Files:**
- Create: `apps/web/src/panel/cards/JobCard.tsx`, `apps/web/src/panel/cards/FindingCard.tsx`, `apps/web/src/panel/cards/SpendCard.tsx`
- Modify: `apps/web/src/panel/cards/ProposalCard.tsx` (route `meta.job` → `JobCard`, `meta.longTerm` → long-term card section), `apps/web/src/panel/cards/QuestionCard.tsx` (`spend` → `SpendCard`; `context.finding` → `FindingCard`), `apps/web/src/panel/cards/index.ts`, `apps/web/src/panel/inbox-model.ts` (`waitingRank`: spend 0 with permission), `apps/web/src/api/*` (answer with `detail`), card CSS (`question-spend` distinct colour token, `$` badge)
- Test: `apps/web/src/panel/cards/job-cards.test.tsx`

Content: **JobCard** — "New recurring job" / "Change job" / "Stop job"; name, moon line ("Feedback moon · new area" or "Marketing area on Titan"), `scheduleText`, provider, instructions (collapsible past 6 lines), "May do without asking:" + each rule's `label` (or "Nothing — it asks for anything outside the project's rules"), Approve / Reject (the existing proposal actions). Long-term card: purpose, goals list, "Moves to <planet>" when the approval moves it. **FindingCard** — job name + area, title, text; suggestion: three buttons `Create a ticket` / `Implement it` / `Drop`; reply: a textarea prefilled with the draft and `Send` / `Drop` (Send submits `answer:'Send', detail:{choices:['Send'], text}`). **SpendCard** — `$` badge, `Intl.NumberFormat(undefined, {style:'currency', currency})` amount, purpose, "from <job or task>", `Approve` / `Refuse`; never shows Allow similar; on a remote client without auto-approve the buttons are disabled with the permission text already used for permissions.

- [ ] **Step 1: Write the failing tests:** each card renders its fixed actions; editing a reply then Send posts the edited text in `detail.text`; the spend card shows `$1,250.00` for `{amount:1250, currency:'USD'}` in `en-US`, has class `question-spend` and no Allow similar; the inbox orders a spend before clarifications; the job card lists rule labels; axe passes on each card.
- [ ] **Step 2: Run** `pnpm --filter @galactic/web test -- job-cards inbox` — FAIL.
- [ ] **Step 3: Implement.** Claim P10-07.
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `P10-07: cards for jobs, long-term proposals, findings and spend approvals`.

### Task 12: Web — the Jobs tab and run history

**Files:**
- Create: `apps/server/src/http/job-routes.ts` (`GET /api/jobs/:id/runs?limit=` → `{ runs: JobRun[] }`, bearer guard, `limit` 1–200 default 20; registered in `app.ts`), `apps/web/src/panel/jobs/JobsPane.tsx`, `apps/web/src/panel/jobs/jobs-model.ts`, `apps/web/src/panel/jobs/jobs.css`
- Modify: `apps/web/src/panel/status/dock-view.ts` (`DockView` + `'jobs'`; `brainView` maps `jobs` → `chat` unless the brain is a Waykeeper of a long-term project), `apps/web/src/panel/status/StatusViews.tsx` (`DockViewToggle` option "Jobs" with a dot when something needs Cosmin; `BrainDock` renders `JobsPane`), `apps/server/src/http/job-routes.test.ts`
- Test: `apps/web/src/panel/jobs/jobs-model.test.ts`, `jobs-pane.test.tsx`

**Interfaces — Produces:**
```ts
export interface JobRow { job: Job; area: Area; moonName: string; scheduleText: string; nextRunText?: string;
  lastLine?: string; tone: 'ok' | 'catchup' | 'bad' | 'idle'; waiting: number /* open job-owned questions */ }
export interface JobsModel { needsYou: JobRow[]; areas: { area: Area; moonName: string; shared: boolean; rows: JobRow[] }[] }
export function jobsModel(world: WorldState, projectId: Id, filter?: { bodyId?: Id }, now?: Date): JobsModel;
export const useJobsFilter: UseBoundStore<…>; // { bodyId?: Id; set(bodyId?: Id): void } — not persisted
```
Layout per the mockup (B with A's per-job detail): "Needs you" first (paused jobs: "paused since <day> — <reason> (asked in the inbox)" with a "Fix & retry" button that reveals the failure question in the inbox; jobs with waiting findings: "<n> in inbox →"); then one section per area ("Feedback · Titan", "shares Titan with Sales" when shared), each job: name, schedule pill, last line (`✓ today 9:02 — <summary>`, `↻ … (caught up after sleep)`, `✕ … — <reason>`), "<provider> · next: <relative day + time>"; clicking a job expands its last 20 runs fetched from the route. With a moon filter: a header "<Area names> · <moon>" and "Show all jobs". Stopped jobs are listed last, dimmed. Phone: the pane fills the chat area like the other dock views.

- [ ] **Step 1: Write the failing tests:** `jobsModel` puts a paused job in `needsYou` and counts open findings per job; filter by a shared moon returns both areas; `nextRunText` reads "tomorrow 9:00"; the route returns newest-first runs and refuses `limit=500` with 400; the pane shows "Jobs" only for a long-term project's Waykeeper; expanding a job lists its runs; axe passes; phone width renders without horizontal scroll.
- [ ] **Step 2: Run** `pnpm --filter @galactic/web test -- jobs` and `pnpm --filter @galactic/server test -- job-routes` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `status-views` — PASS.
- [ ] **Step 5: Commit** `P10-07: the Jobs tab with run history`.

### Task 13: Scene — area moons

**Files:**
- Modify: `apps/web/src/scene/labels/label-model.ts` (`MoonRole` + `'area'`; label title = the area names joined with ", ", `partOf` = the project; `fullTitle` adds "· <n> jobs"), `apps/web/src/scene/labels/MoonMarkers.tsx` (area moons get their own ring colour token; a shared moon shows a small count "2 areas"), `apps/web/src/scene/picking/body-action.ts` (a body with host `areas` → select the project's Waykeeper, set dock view `jobs`, `useJobsFilter.set(bodyId)`), every other exhaustive `HostKind` switch the typecheck reports (server and web)
- Test: extend `label-model.test.ts`, `body-action.test.ts`, satellites placement test

- [ ] **Step 1: Write the failing tests:** an `areas` moon with Feedback and Sales gets label "Feedback, Sales" with role `area` and `partOf` the project; clicking it selects the Waykeeper with the Jobs view filtered to that moon; a running job's Steward satellite is placed on its area moon (the job task's body), and none is shown when no run is live.
- [ ] **Step 2: Run** `pnpm --filter @galactic/web test -- label-model body-action placement` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && pnpm --filter @galactic/web test` — PASS.
- [ ] **Step 5: Commit** `P10-07: area moons in the scene`; `P10-07: done — Jobs tab, cards and area moons`.

### Task 14: Docs and end-to-end

**Files:**
- Create: `e2e/tests/13-recurring-jobs.spec.ts`
- Modify: `docs/SPEC.md` (§7 decisions 142–145 quoting Cosmin's words from the spec and listing Claude's calls; §8 the two open questions; §3 sizing text for long-term projects and area moons; decision 10 amended by 143), `docs/TECHNOLOGY.md` (jobs tables and why one task per job; the scheduler and catch-up rule; job-owned questions; the `spend` kind; unattended rules in the gate), `docs/IMPLEMENTATION_PLAN.md` (Phase 10), `docs/tasks/PHASE_10_LONG_TERM_PROJECTS.md` + `README.md` (statuses, exit criteria), `docs/tasks/notes/P10-review.md` (review findings)

- [ ] **Step 1: Write the e2e test** (dev harness, fake adapter, fake clock route if the harness has one — else drive `tick()` through a dev-only route like the question-set harness): Harmonizer proposes a long-term project → approve → it sits on Jupiter; the Waykeeper proposes a daily job on a new "Feedback" area → approve → the moon shows the label; trigger a run → the run's Steward reports one reply finding and ends → the inbox shows the finding card; edit the reply and Send → a follow-up run starts; a spend request shows the `$` card; the Jobs tab lists the job with its last line and the run history.
- [ ] **Step 2: Run** `pnpm e2e -- 13-recurring-jobs` — FAIL until harness hooks exist; add only dev-only harness routes (as `runtime/harness-brains.ts` did).
- [ ] **Step 3: Write the docs** listed above; claim and finish P10-08.
- [ ] **Step 4: Run** the full gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm e2e` — all green.
- [ ] **Step 5: Commit** `P10-08: docs and end-to-end for long-term projects and recurring jobs`; `P10-08: done — …`; Phase 10 exit criteria recorded.
