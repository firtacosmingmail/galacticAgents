# Project Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each long-term project gets a dashboard of fixed panel types (tiles, line and bar charts, tables, lists, calendars, status boards, text) that Cosmin defines by talking to the Waykeeper. Recurring jobs fill the panels and each job shows its details as a pipeline map. Cosmin arranges the panels on the Mac, and the phone shows them in one column.

**Architecture:**
- **Data.** Runs report more than numbers: tables, lists, calendar entries, status items and texts, plus the problems they had with their sources. The runtime records which sources each run actually used.
- **Storage.** Panels are a new domain table, folded into the world like jobs. A job gains a declared **data map** (sources → values collected → processing steps).
- **Values.** The server computes each panel's data over REST, using a pure evaluator in the protocol package. The evaluator handles comparisons, limits, staleness and the task status board.
- **Combined card.** A panel card can carry a job part (use an existing job, change one, or create one). One approval runs the job part through the existing job-card path, then creates the panel.
- **Refresh.** Refresh is a new `refresh` run purpose that never moves the schedule.
- **Web.** The dashboard is a fifth Waykeeper view, using plain SVG charts and a hand-written arrange mode (no new dependencies).

**Tech Stack:** TypeScript, zod (`packages/protocol`), Fastify + SQLite event log (`apps/server`), React 19 + zustand (`apps/web`), Vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-project-dashboard-design.md`

## Global Constraints

- **Scope:** one dashboard per long-term project, owned by its Waykeeper. There is no dashboard for short projects, asteroids, or across projects.
- **Panel types (exact enum):** `tile`, `line`, `bar`, `table`, `list`, `calendar`, `status`, `text`.
- **Panel cap:** `MAX_PANELS_PER_DASHBOARD = 24`.
- **Removal suggestion:** after `PANEL_UNCHANGED_DAYS = 28` days unchanged. The Waykeeper suggests; it never removes a panel without Cosmin's OK.
- **Panel sources:** data reaches a panel only from one job's runs (`{kind:'job', jobId, values}`) or from the project's own tasks (`{kind:'tasks'}`).
- **A panel never grants permissions.** Only the job part of a card can widen what a job may do. When it does, the whole card can be confirmed only locally or with `autoApproveRemote` (the existing `checkRemoteGrant`, decisions 138 and 144). The card is never half-applied.
- **Snapshots vs history:**
  - Tables, lists, calendars, status boards and text show the **latest good run's** snapshot (a good run's outcome is `quiet` or `findings`).
  - Numbers keep per-run history for charts and comparisons. A chart covers at most the jobs' last 200 runs (`LONG_TERM_LIMITS.runsKept`).
- **Very bad / very good:**
  - They apply only to tiles and to the latest value of a chart series.
  - Each limit stores `better: 'higher' | 'lower'`.
  - The UI always shows a word (`very bad` / `very good`) and an arrow, never colour alone.
  - Fireworks play once per new run result. They play only when the system's reduce-motion setting is off; under reduce motion the panel gets a steady green glow instead.
- **Never coloured:** a stale value (the job's last run failed, or the job is paused), a "job stopped" panel and a "no longer reported" panel.
- **Refresh:**
  - Refresh runs the panel's job now, as purpose `refresh`.
  - If the job already has a run going, refresh waits for that run instead of starting another.
  - Refresh is refused while the job or its project is paused, or the job is stopped. A paused job's panel offers "Job paused — Fix & retry", which opens the existing failure question.
  - A refresh run never changes `nextRunAt` or the catch-up window.
  - Hard caps apply.
  - Refresh is allowed from the phone.
- **Clear history:**
  - A panel's clear sets `historyFrom`, and the panel ignores runs before that time.
  - A job's "Clear stored values" deletes the `numbers` and `data` of its runs up to now, and lists the affected panels first.
  - Both are events, and neither can be undone.
- **Arranging:** only Cosmin arranges panels. A panel the Waykeeper adds goes at the end. A panel hidden on the Mac is hidden on the phone too.
- **Phone:** follows the Mac's order. Tiles become a swipeable strip; every other panel is a full-width card. The first `PHONE_OPEN_CARDS = 3` cards are open and the rest are folded to a title line.
- **Run data limits (`DASHBOARD_LIMITS` in protocol):**

  | Data kind | Limit |
  | --- | --- |
  | Data name | `^[a-z][a-z0-9_]{0,59}$`. The name rule does not apply to numbers, whose keys stay as they are. |
  | Tables per run | ≤ 10, each ≤ 12 columns and ≤ 200 rows; a cell is a string ≤ 300 characters, a number or null |
  | Lists | ≤ 10, each ≤ 100 items `{title ≤ 200, detail? ≤ 1000, tag? ≤ 40, at?}` |
  | Calendars | ≤ 5, each ≤ 200 entries `{date: YYYY-MM-DD, title ≤ 200, detail? ≤ 1000}` |
  | Status boards | ≤ 5, each ≤ 200 items `{column ≤ 40, title ≤ 200, detail? ≤ 300}` |
  | Texts | ≤ 5, each ≤ 4000 characters |
  | Source problems | ≤ 20 `{sourceId, problem ≤ 300}` |
  | A run's `data` JSON | ≤ 262 144 bytes |

  A run that breaks a limit is refused in the `report_run` tool's result. It never crashes.
- **Data map limits:** ≤ 20 sources, ≤ 60 collected values, ≤ 30 steps.
- **One-write rule:** every state change is an event in the same transaction as its row change. The schema changes in migration **`0020_project_dashboard.sql`**.
- **Types and SDKs:** types live in `packages/protocol`; nothing outside `apps/server/src/adapters` imports an SDK.
- **Phase:** Phase 15, task IDs `P15-nn`, branch `agent-project-dashboard` from `main`. The SPEC decision is **156**.
- **Gates:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.

## Review Focus

1. **A job reports a value under a slightly different name** than the panel reads (`churn` instead of `churn_30d`). Expected: the panel shows "no longer reported" with its last value, uncoloured, never `0` or blank. Test in Task 4.
2. **Refresh pressed twice, or while a scheduled run is going.** Expected: one run only, and the second press returns the running run's id (`started: false`). After the refresh run ends, `nextRunAt` is unchanged. Test in Task 4.
3. **A combined card whose job part adds unattended rules, approved from the phone** without `autoApproveRemote`. Expected: the whole card is refused (`remote_control`), with no panel and no job change. Test in Task 3.
4. **A tile whose newest run failed** while an older value is past the very-bad limit. Expected: `stale` is true, there is no verdict and no fireworks, and the last good time is shown. Test in Task 4.
5. **History cleared and only 0 or 1 runs since.** Expected: a chart says "No data since history was cleared" or shows one point, and the tile's comparison is absent (not `+0%` or `NaN`). Test in Task 4 (evaluator) and Task 6 (render).

---

### Task 1: Protocol, storage and world fold

**Files:**
- Create: `packages/protocol/src/dashboard.ts` (export from `index.ts`)
- Modify:
  - `packages/protocol/src/long-term.ts` (`JobRunPurpose` + `'refresh'`; `Job`/`JobDraft` + `dataMap`; `JobRun` + `data`, `sources`)
  - `packages/protocol/src/events.ts` (panel events; `JobChanges` + `dataMap`, `valuesClearedAt`)
  - `packages/protocol/src/world.ts` (`panels` state, snapshot and fold)
- Create: `apps/server/src/db/migrations/0020_project_dashboard.sql`
- Modify: `apps/server/src/db/tables.ts` (`dashboard_panels` mapper, job and job-run columns), `apps/server/src/domain/event-log.ts` (snapshot `panels`), `apps/server/src/domain/map-export.ts` and `map-import.ts` (panels exported like jobs)
- Test: `packages/protocol/src/dashboard.test.ts`, `packages/protocol/src/world.test.ts`, `apps/server/src/db/tables.test.ts` (or the existing tables test)

**Interfaces — Produces (protocol `dashboard.ts`):**
- **Constants:** `MAX_PANELS_PER_DASHBOARD = 24`, `PANEL_UNCHANGED_DAYS = 28`, `PHONE_OPEN_CARDS = 3`, and `DASHBOARD_LIMITS` (every number in Global Constraints).
- **Names and types:**
  - `DataName` is the regex from Global Constraints.
  - `PanelType` is the enum.
- **Data map:**
  - `JobSource = {id: DataName, label ≤80, kind: 'mcp'|'site'|'files'|'database'|'command'|'other', target ≤200}`
  - `JobCollect = {name: string 1–60, kind: 'number'|'table'|'list'|'calendar'|'status'|'text', sourceIds: DataName[] ≥1, description ≤300}`
  - `JobStep = {text ≤500, uses: string[], produces: string[]}`
  - `JobDataMap = {sources, collects, steps}`, with the limits above. Every `sourceIds` entry and every `uses`/`produces` name must exist (zod refine).
- **Run data:**
  - `RunData = {tables?: Record<DataName,{columns: string[], rows: (string|number|null)[][]}>, lists?: Record<DataName, ListItem[]>, calendars?: Record<DataName, CalendarEntry[]>, statuses?: Record<DataName, StatusItem[]>, texts?: Record<DataName,string>, sourceProblems?: {sourceId: string, problem: string}[]}`
  - `UsedSource = {kind: JobSource['kind'], target: string}`
- **Panel definition:**
  - `PanelSource = {kind:'job', jobId: Id, values: string[] (1–8)} | {kind:'tasks'}`
  - `PanelDisplay = {compare?: 'week'|'month', format?: 'number'|'percent'|'money', unit?: string ≤8, currency?: string(3), rangeDays?: 7|30|90|365, columns?: string[]}`
  - `Threshold = {op:'above'|'below', value: number} | {op:'rise'|'fall', percent: number>0, vs: 'week'|'month'}`
  - `PanelLimit = {value: string, better: 'higher'|'lower', veryBad?: Threshold, veryGood?: Threshold}`
  - `PanelLayout = {order: number int ≥0, w: 1|2|3|4, h: 1|2|3, hidden?: true}`
- **Panel:** `Panel = {id, projectId, type: PanelType, title 1–80, source: PanelSource, display: PanelDisplay, limits: PanelLimit[] ≤8, layout: PanelLayout, historyFrom?: Timestamp, removalSuggestedAt?: Timestamp, createdBy: Actor, createdAt, updatedAt, meta?}`. A `status` panel may use `{kind:'tasks'}`; every other type needs a job source (refine). `PanelDraft = Panel.pick({type,title,source,display,limits})`.
- **Events:**
  - `panel.created {panel}`
  - `panel.updated {panelId, changes: Partial<Pick<Panel,'title'|'source'|'display'|'limits'|'layout'|'historyFrom'|'removalSuggestedAt'>>, by: Actor}`
  - `panel.removed {panelId, projectId, by: Actor, reason}`
  - `panels.arranged {projectId, layouts: {panelId, layout}[], by: Actor}`
  - `job.values_cleared {jobId, upTo: Timestamp, by: Actor}`. In the world it folds to nothing; on the server the command deletes the run data.
- **Changes to existing schemas:**
  - `Job.dataMap?: JobDataMap` and `JobDraft.dataMap?` (optional, because older jobs have none)
  - `JobRun.data?: RunData`, `JobRun.sources?: UsedSource[]`
  - `JobRunPurpose` gains `'refresh'`
  - `World.panels: Record<Id, Panel>`
  - `panelsOf(world, projectId): Panel[]`, sorted by `layout.order`

**Steps:**
- [ ] **Step 0: Claim.** Create `docs/tasks/PHASE_15_DASHBOARD.md` in the format of `PHASE_13_WAYKEEPER_APPROVALS.md`. Its tasks P15-01…P15-10 are Tasks 1–10 here, one wave each, in order. Tasks 6–9 all touch the dashboard pane, so none run in parallel. Add the phase row to `docs/tasks/README.md`, set P15-01 to `in progress`, and commit `P15-01: start the project dashboard`.
- [ ] **Step 1: Failing tests.**
  - `DataName` rejects `Churn`, `1x` and a 61-character name.
  - `JobDataMap` rejects a collect that names a missing source.
  - `RunData` rejects 11 tables and a 201-row table.
  - `Panel` rejects a `tile` with `{kind:'tasks'}` and accepts a `status` with it.
  - `Threshold` rejects `percent: 0`.
  - The world folds `panel.created`, then `panel.updated` (layout), then `panels.arranged`, then `panel.removed`, and `panelsOf` returns them by order.
  - The server tables round-trip a panel, a job with `dataMap`, and a run with `data` and `sources`.
- [ ] **Step 2: Run** `pnpm --filter @galactic/protocol test` and the server tables test. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Migration**, in 0016's header style:
    - `CREATE TABLE dashboard_panels (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), type TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, display TEXT NOT NULL, limits TEXT NOT NULL, layout TEXT NOT NULL, history_from TEXT, removal_suggested_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, meta TEXT)`
    - the index `dashboard_panels_project`
    - `ALTER TABLE jobs ADD COLUMN data_map TEXT`
    - `ALTER TABLE job_runs ADD COLUMN data TEXT`
    - `ALTER TABLE job_runs ADD COLUMN sources TEXT`
  - **Code:** the mappers, the snapshot and the export/import.
- [ ] **Step 4: Run** the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `P15-01: protocol, storage and world fold for dashboard panels`

### Task 2: Runs report data and record their sources

**Files:**
- Modify:
  - `apps/server/src/brains/job-tools.ts` (the `report_run` schema and description)
  - `packages/protocol/src/commands.ts` (`JobRunReport` + `data?: RunData`; `EndJobRunInput` + `data?`, `sources?`)
  - `apps/server/src/domain/findings.ts` (`reportJobRun` validation)
  - `apps/server/src/runtime/job-scheduler.ts` (`endWithReport` passes `data`, `sources`)
  - `apps/server/src/domain/job-runs.ts` (`endJobRun` stores them)
  - `apps/server/src/brains/job-prompt.ts` (tells the run its job's data map and the exact names to report)
- Create: `apps/server/src/runtime/run-sources.ts`
- Test: `apps/server/src/brains/job-tools.test.ts`, `apps/server/src/runtime/run-sources.test.ts`, `apps/server/src/runtime/job-scheduler.test.ts`

**Interfaces:**
- Produces: `usedSourceOf(toolName: string, input: unknown, cwd: string): UsedSource | undefined`
  - `mcp__<server>__<tool>` gives `{kind:'mcp', target: server}`.
  - `WebFetch`/`WebSearch`, and Bash `curl`/`wget` URLs, give `{kind:'site', target: host}`. Use the host parsing in `domain/hosts.ts`.
  - `Read`/`Grep`/`Glob`, and Bash read commands on paths outside `cwd`, give `{kind:'files', target: folder}`.
  - Anything else gives `undefined`.
- Produces: the class `RunSourceRecorder` with `note(agentId, toolName, input, cwd)` and `take(agentId): UsedSource[]`. It is deduplicated by `kind:target` and capped at 50.
- `AgentRuntime` calls `note` for every tool call of a job-run Steward, on the same path where the gate sees the call. `JobScheduler.endWithReport` calls `take`.

**Steps:**
- [ ] **Step 1: Failing tests.**
  - `report_run` with `tables: {experiments: {columns:['Test','Result'], rows:[['Short video','+18%']]}}` stores `run.data.tables.experiments`.
  - A run that breaks a limit (13 columns, or a `data` JSON over 262 144 bytes) is refused. The result is `{error:'invalid', message}` naming the limit, and the run stays running.
  - `sourceProblems` naming an id the job's data map lacks is accepted and kept as given.
  - The table-driven test for `usedSourceOf` covers each rule above, including `curl -s https://api.posthog.com/x` giving `site api.posthog.com`.
  - When a job run ends, `sources` holds the deduplicated sources used.
  - `jobRunPrompt` lists every `collects[].name` and its kind under "Report exactly these names".
- [ ] **Step 2: Run** `pnpm --filter ./apps/server exec vitest run src/brains/job-tools.test.ts src/runtime/run-sources.test.ts src/runtime/job-scheduler.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `P15-02: runs report tables, lists, calendars, statuses, texts and the sources they used`

### Task 3: Panel commands and the combined panel card

**Files:**
- Create: `apps/server/src/domain/panels.ts`
- Modify:
  - `packages/protocol/src/commands.ts` (inputs and `DomainCommands` members below; `DecideProposalInput` + `removePanels?: true`)
  - `apps/server/src/domain/commands.ts` (wiring)
  - `apps/server/src/domain/proposals.ts` (`proposePanel`; `carryOutPanelCard`; job stop/change cards with `removePanels`)
  - `apps/server/src/domain/jobs.ts` (`createJob`/`updateJob` accept `dataMap`)
- Modify (protocol `dashboard.ts`): `ProposalPanel` and `proposalPanelOf(proposal)`
- Test: `apps/server/src/domain/panels.test.ts`, `apps/server/src/domain/proposal-flow.test.ts`

**Interfaces — Produces:**
- **The card:** `ProposalPanel = {projectId, waykeeperId, action: 'create'|'change'|'remove', panelId?, draft?: PanelDraft, before?: PanelDraft, job?: {use: Id} | {propose: ProposalJob}}`.
  - With `use`, the card says the panel is filled by an existing job, and no job changes.
  - With `propose`, the card carries a job `create` or `change` part.
  - When the job part creates a job, the panel's `source.jobId` is the placeholder `'$new'`, resolved on approval.
- **Card helpers:** `affectedPanels(world, jobId, after?: JobDataMap): Panel[]`. With no `after`, it returns every panel reading the job (a stop). With `after`, it returns the panels that read a value missing from `after.collects` (a change).
- **Domain functions** (all `(ctx: CommandContext, …)`):
  - `createPanel(ctx, projectId, draft: PanelDraft, by: Actor): Panel`
    - refused with `DomainError 'invalid'` unless the project is long-term and open;
    - refused with `'limit'` at 24 panels;
    - the panel's `layout.order` is the current max + 1, with default sizes `tile` 1×1, `line`/`bar`/`table`/`status`/`text` 2×1 (`w:2,h:1`), `list`/`calendar` 1×2.
  - `updatePanel(ctx, panelId, changes, by): Panel`
  - `removePanel(ctx, panelId, by, reason): void`
  - `arrangePanels(ctx, projectId, layouts: {panelId, layout}[], by): void`
    - user only;
    - the `order` values must be distinct;
    - every panel of the project must be present.
  - `clearPanelHistory(ctx, panelId, by): Panel`, which sets `historyFrom = now`
  - `clearJobValues(ctx, jobId, by): {upTo, panels: Id[]}`, which nulls `numbers`/`data` of runs with `startedAt ≤ now` and emits `job.values_cleared`
  - `suggestPanelRemoval(ctx, panelId): void`, which sets `removalSuggestedAt`
- **The proposal command:** `proposePanel(ctx, input: ProposePanelInput): Proposal`. `ProposePanelInput = Omit<ProposalPanel, 'waykeeperId'> & {waykeeperId}`. A new card from the same Waykeeper for the same `panelId`, or for the same draft title while a card is open, cancels the earlier open card as `superseded`.
- **Carrying out the card:** `carryOutPanelCard(ctx, card, by, origin)` is called from `decideProposal` next to `carryOutJobCard`.
  1. If the card has `job.propose`, it calls `checkRemoteGrant(ctx, jobPart, write)` **first**, then `carryOutJobCard`.
  2. It resolves `'$new'` and creates, updates or removes the panel.
  3. All of this happens in the same transaction.
- **Job cards with affected panels:** a job `stop`/`change` card approved with `removePanels: true` also removes `affectedPanels` with the reason `job stopped` / `no longer reported`.

**Steps:**
- [ ] **Step 1: Failing tests** in `panels.test.ts`:
  - the cap: the 25th `createPanel` gives `'limit'`;
  - the order and the default sizes;
  - `arrangePanels` refused from `{kind:'agent'}` and for a missing panel;
  - `clearPanelHistory` sets `historyFrom`;
  - `clearJobValues` empties two runs' `numbers` and `data` and returns the panels reading the job.
- [ ] **Step 2: Failing tests** in `proposal-flow.test.ts`:
  - a `use` card creates only the panel, and the job's `updatedAt` is unchanged;
  - a `propose create` card creates job and panel, and the panel's `source.jobId` is the new job;
  - **Review Focus 3**: a remote approval (phone) of a card whose job part adds an unattended rule, without `autoApproveRemote`, throws `remote_control`, and neither panel nor job changed;
  - re-proposing supersedes the earlier card;
  - a stop card approved with `removePanels: true` removes the job's two panels, and without it keeps them.
- [ ] **Step 3: Run** `pnpm --filter ./apps/server exec vitest run src/domain/panels.test.ts src/domain/proposal-flow.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the same command plus `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `P15-03: panel commands and the combined panel-and-job card`

### Task 4: Dashboard data, evaluation and refresh

**Files:**
- Create: `packages/protocol/src/dashboard-eval.ts` (pure, used by server and web)
- Create: `apps/server/src/http/dashboard-routes.ts` (registered next to `job-routes.ts`)
- Modify:
  - `apps/server/src/runtime/job-scheduler.ts` (`runNow`)
  - `apps/server/src/domain/job-runs.ts` (a `refresh` run's end leaves `nextRunAt` alone)
  - `apps/web/src/console/api.ts` (`dashboard`, `refreshJob`, `clearPanelHistory`, `clearJobValues`, `arrangePanels` clients)
- Test: `packages/protocol/src/dashboard-eval.test.ts`, `apps/server/src/http/dashboard-routes.test.ts`, `apps/server/src/runtime/job-scheduler.test.ts`

**Interfaces — Produces:**
- `evaluatePanel(panel: Panel, job: Job | undefined, runs: JobRun[] /* newest first */, now: Timestamp, tasks?: Task[]): PanelData`. Here `PanelData` is:

  ```
  {
    panelId,
    status: 'ok' | 'empty' | 'stale' | 'job_paused' | 'job_stopped' | 'not_reported',
    lastGoodAt?: Timestamp,
    sourceLine: string,
    tile?: {value: number, previous?: number, changePct?: number, changeAbs?: number},
    series?: {name, points: {at, value}[]}[],
    table?, list?, calendar?, statusBoard?: {columns: {name, items}[]}, text?,
    verdict?: {kind: 'very_bad'|'very_good', value: string, arrow: 'up'|'down', resultId: Id},
  }
  ```

  - **Runs it reads:** only runs with `startedAt ≥ historyFrom` and outcome `quiet`/`findings`.
  - **Stale:**
    - `stale` when the job's `lastRun.outcome` is `failed` or `limited`;
    - `job_paused` when the job's state is `paused`;
    - `job_stopped` when it is `stopped`.
  - **Not reported:** `not_reported` when the newest good run lacks a value that an older good run had.
  - **Empty:** `empty` when there are no runs, or none since `historyFrom`.
  - **Verdict:** only when `status === 'ok'` and the panel type is `tile`, `line` or `bar`. `resultId` is the run id, so the web plays fireworks once per id.
  - **Tile comparison:** `compare` picks the newest good run at least 7 or 30 days older than the newest. Without one, there are no `previous` or `change` fields.
  - **Task status board:** columns `In progress` (state `in_progress`), `Next` (`todo`/`ready`, at most 5), and `Done this week` (`done` with `updatedAt` in the last 7 days). Job tasks are excluded.
- **REST** (each body validated with zod):
  - `GET /api/projects/:id/dashboard` returns `DashboardResponse = {panels: PanelData[]}`.
  - `POST /api/jobs/:id/refresh` returns `{runId, started: boolean}`.
  - `POST /api/panels/:id/clear-history`
  - `POST /api/jobs/:id/clear-values` returns `{panels: Id[]}`.
  - `PUT /api/projects/:id/dashboard/layout` takes `{layouts}`.
- **Refresh:** `JobScheduler.runNow(jobId: Id, by: Actor): Promise<{runId: Id, started: boolean}>`.
  - If the job has `runningRunId`, it returns `{runId, started: false}`.
  - It is refused with `DomainError 'invalid'` when the job is paused or stopped, or its project is paused.
  - It is refused with `'limit'` when `runtime.caps.canSpawn` fails.
  - Otherwise it calls `startJobRun({purpose:'refresh', dueAt: now})` and spawns the run like a due run.
  - When a `refresh` run ends, `nextRunAt` and `coversFrom` stay as they were.

**Steps:**
- [ ] **Step 1: Failing evaluator tests.**
  - **Review Focus 1:** runs `{churn_30d: 4.1}` then `{churn: 4.0}` give `not_reported` with tile value 4.1 and no verdict.
  - **Review Focus 4:** `lastRun.outcome: 'failed'` plus an older value past `veryBad` gives `stale` and no verdict.
  - **Review Focus 5:**
    - 0 runs since `historyFrom` gives `empty`;
    - 1 run gives a tile without `changePct` and a series with one point.
  - **Directions:**
    - `better:'lower'`, `veryGood {op:'fall', percent:10, vs:'week'}`, churn 5.0 a week ago and 4.1 now gives `very_good` with arrow `down`;
    - `veryBad {op:'above', value:6}` and 6.5 gives `very_bad`.
  - **Snapshot panels:** a table takes only the newest good run's rows.
  - **Task status board:** the three columns from a task fixture.
- [ ] **Step 2: Failing server tests.**
  - **Review Focus 2:** `runNow` twice gives `started: true`, then `started: false` with the same `runId`. After the refresh run ends, `nextRunAt` equals its value before the refresh.
  - A paused job gives `invalid`.
  - The routes return the zod shapes. A remote client may call refresh. Layout and clear-history from a remote client are allowed too (decision 90: these are the user's own dashboard actions, not permissions).
- [ ] **Step 3: Run** the protocol tests plus `vitest run src/http/dashboard-routes.test.ts src/runtime/job-scheduler.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `P15-04: dashboard evaluation, REST and refresh runs`

### Task 5: Waykeeper tools and prompt

**Files:**
- Create: `apps/server/src/brains/waykeeper/panel-tools.ts`
- Modify:
  - `apps/server/src/brains/waykeeper/job-tools.ts` (`DRAFT_PROPERTIES` + `dataMap`)
  - the Waykeeper prompt file of a long-term project (find it with `rg "list_jobs" apps/server/src/brains/waykeeper`)
  - `apps/server/src/runtime/job-scheduler.ts` (the 28-day nudge after a run ends)
- Test: `apps/server/src/brains/waykeeper/panel-tools.test.ts`

**Interfaces — Produces** (the tools are given only to the Waykeeper of a long-term project):
- `propose_panel`, with input `{panelId?, draft: PanelDraft, job: {use: jobId} | {create: <propose_job input>} | {change: <propose_job_change input>}}`. It calls `commands.proposePanel`.
- `propose_panel_remove`, with input `{panelId, reason}`.
- `list_panels`, which returns each panel with its current `PanelData`, `unchangedSince`, and the jobs' `collects` names.
- **Prompt text:**
  - First look for an existing job whose `dataMap.collects` already has the value, and use it.
  - Propose a job change only when a value is missing.
  - Always give a new job a `dataMap`.
  - Without limits from Cosmin, propose limits from the panel's history.
  - Never rearrange or remove a panel without a card.
- **The nudge:** after any job run ends, the scheduler checks the project's panels. For a panel whose value has been unchanged for ≥ 28 days (`removalSuggestedAt` unset), it sends the Waykeeper one system mailbox message, "Panel '<title>' has not changed since <date>; propose removing it if it is no longer useful", and calls `suggestPanelRemoval`.

**Steps:**
- [ ] **Step 1: Failing tests.**
  - `propose_panel` with `use` makes a card whose `proposalPanelOf(...).job` is `{use}`.
  - `propose_panel` with an invalid draft (`tile` with a tasks source) returns `{error:'invalid'}`.
  - The tools are absent for a short project's Waykeeper.
  - The nudge fires once for a panel unchanged for 29 days, and not again on the next run.
- [ ] **Step 2: Run** `vitest run src/brains/waykeeper/panel-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `P15-05: Waykeeper panel tools and the unchanged-panel nudge`

### Task 6: Dashboard view on the Mac

**Files:**
- Modify: `apps/web/src/panel/status/dock-view.ts` (`DockView` + `'dashboard'`; `brainView` allows it only for a long-term Waykeeper; opening a long-term Waykeeper selects `dashboard`; an area moon still opens `jobs`), `apps/web/src/panel/status/StatusViews.tsx` (the "Dashboard" tab first)
- Create:
  - `apps/web/src/panel/dashboard/DashboardPane.tsx`
  - `use-dashboard.ts` (fetches `GET …/dashboard`; refetches on `job_run.ended`, `job.updated` and `panel.*` events of the project)
  - `PanelFrame.tsx` (title, body, source line "from job '<name>' · <age>", state badge, Refresh / "Job paused — Fix & retry", ⋯ menu with "Clear history")
  - `panels/TilePanel.tsx`, `LineChart.tsx`, `BarChart.tsx` (plain SVG), `TablePanel.tsx`, `ListPanel.tsx`, `CalendarPanel.tsx` (month grid), `StatusBoardPanel.tsx`, `TextPanel.tsx`
  - `NeedsALook.tsx`
  - `Fireworks.tsx`
  - `dashboard.css`
- Test: `apps/web/src/panel/dashboard/dashboard.test.tsx`

**Interfaces:**
- `celebrated(resultId): boolean` and `markCelebrated(resultId)`, kept in `localStorage['galactic.dashboard.celebrated']` and wrapped in try/catch. They hold the last 200 ids.
- "Fix & retry" opens the job's `failureQuestionId` question (the existing inbox navigation).
- Clearing history asks for confirmation with the text "Clear this panel's history? Its charts and comparisons start again from the next run. This can't be undone."

**Steps:**
- [ ] **Step 1: Failing tests** (Testing Library):
  - the Dashboard tab is first and is the default for a long-term Waykeeper, and absent for a short project;
  - each panel type renders from a `PanelData` fixture;
  - a `very_bad` tile shows the text "very bad" and an arrow;
  - `stale` shows "last good value <time>" and no verdict class;
  - **Review Focus 5:** `empty` shows "No data since history was cleared" when `historyFrom` is set, and "No data yet" otherwise;
  - fireworks render once for a `resultId` and not after a remount;
  - under `matchMedia('(prefers-reduced-motion: reduce)')` the panel gets the glow class instead of fireworks;
  - Refresh calls `api.refreshJob` and is disabled with `job_paused`;
  - "Needs a look" lists only the panels with a verdict.
- [ ] **Step 2: Run** `pnpm --filter ./apps/web exec vitest run src/panel/dashboard`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use a 4-column CSS grid with `grid-auto-flow: dense`. A panel spans `layout.w` columns and `layout.h` rows, ordered by `layout.order`; hidden panels are skipped.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `P15-06: the dashboard view on the Mac`

### Task 7: Arrange mode

**Files:**
- Create: `apps/web/src/panel/dashboard/ArrangeMode.tsx`, `arrange-model.ts` (pure: `move(layouts, panelId, toIndex)`, `resize(layouts, panelId, w, h)`, `hide(layouts, panelId)`, `show(...)`)
- Test: `apps/web/src/panel/dashboard/arrange.test.tsx`, `arrange-model.test.ts`

**Interfaces:**
- **Arrange mode** opens with an "Arrange" button and closes with "Done arranging", which sends `api.arrangePanels` once with every layout.
- **Mouse:** drag ⠿ to move (pointer events), drag ◢ to resize, ✕ to hide.
- **Hidden panels** are listed under "Hidden panels" with "Show".
- **Keyboard:** with the handle focused, the arrow keys move a panel, Shift+arrows resize it, and Delete hides it.
- **Phone:** arrange mode is not offered on the phone layout.

**Steps:**
- [ ] **Step 1: Failing tests.**
  - `move` renumbers `order` from 0 with no gaps.
  - `resize` clamps to w 1–4 and h 1–3.
  - Keyboard ArrowRight on the second panel swaps it with the third.
  - "Done arranging" sends one request.
  - A panel added (via `panel.created`) while arranging appears at the end, and the pending order of the others is kept.
- [ ] **Step 2: Run** `vitest run src/panel/dashboard/arrange`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `P15-07: arrange the dashboard's panels`

### Task 8: Phone layout and the cards

**Files:**
- Create: `apps/web/src/panel/dashboard/PhoneDashboard.tsx`, `apps/web/src/panel/cards/PanelCard.tsx`
- Modify:
  - `DashboardPane.tsx` (on the phone layout, `sheeted` from `Panel.tsx`, render `PhoneDashboard`)
  - `apps/web/src/panel/cards/ProposalCard.tsx` (`if (panel) return <PanelCard …/>`)
  - `apps/web/src/panel/cards/JobCard.tsx` (shows the `dataMap` and the "Panels affected" list, with a "Also remove these panels" tick sent as `removePanels`)
- Test: `apps/web/src/panel/dashboard/phone.test.tsx`, `apps/web/src/panel/cards/panel-card.test.tsx`

**Interfaces:**
- **PhoneDashboard:**
  - the "Needs a look" row;
  - then the visible tiles in order, as a horizontal scroll-snap strip;
  - then the other panels as full-width cards in order: the first 3 are open, and the rest are folded to the title with a ›, which a tap opens.
- **PanelCard:**
  - shows the panel draft (type, title, values, display, limits with "better: higher/lower") and below it the job part:
    - `use`: "Filled by job '<name>', which already reports <values>. No job changes.";
    - `propose`: the existing `JobCard` body for that job proposal;
  - Approve / Refuse as on other cards;
  - when the job part grants new rules on a remote client without `autoApproveRemote`, the existing "approve on the Mac" note shows and Approve is disabled, as `JobCard` does today.

**Steps:**
- [ ] **Step 1: Failing tests.**
  - The phone renders 2 tiles in the strip, 3 open cards and 2 folded cards, and a hidden panel appears nowhere.
  - The PanelCard `use` variant shows "No job changes".
  - The `propose` variant shows the job's sources, collects and steps.
  - The remote-with-new-rules case disables Approve.
  - A JobCard stop with 2 affected panels lists them, and ticking sends `removePanels: true`.
- [ ] **Step 2: Run** `vitest run src/panel/dashboard/phone.test.tsx src/panel/cards/panel-card.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `P15-08: the phone dashboard and the panel card`

### Task 9: Job map (pipeline view)

**Files:**
- Create: `apps/web/src/panel/jobs/JobMap.tsx`, `job-map-model.ts` (pure), `job-map.css`
- Modify:
  - `apps/web/src/panel/jobs/JobsPane.tsx` ("Details" on each job opens the map)
  - `PanelFrame.tsx` (the source line opens the map)
- Test: `apps/web/src/panel/jobs/job-map.test.tsx`, `job-map-model.test.ts`

**Interfaces — Produces:**
- `jobMapModel(job: Job, lastRun: JobRun | undefined, panels: Panel[]): {sources: MapSource[], collects: MapCollect[], steps: MapStep[], shownIn: {panelId, title, values}[], edges: {from: string, to: string}[], header: {lastRun?, nextRunAt?, schedule}}`
  - `MapSource = JobSource & {state: 'ok'|'problem'|'unused'|'undeclared', problem?}`:
    - `problem` comes from `lastRun.data.sourceProblems`;
    - `unused` means declared but not in `lastRun.sources`;
    - `undeclared` means in `lastRun.sources` but matching no declared source by `kind` and `target`, added as an extra flagged node.
  - The edges are source → collect (`sourceIds`), collect → step (`uses`), step → collect (`produces`), and collect → panel (`source.values`).
  - `highlight(model, nodeId): Set<string>` returns every node reachable both ways.
- **Rendering:**
  - four columns titled "Gathers from", "Collects", "Processes" and "Shown in", with SVG connectors;
  - hover or focus/tap highlights a node and its links;
  - a panel chip switches to the Dashboard view and scrolls to that panel;
  - a job without a `dataMap` shows "This job has no data map yet — ask the Waykeeper to add one", plus only what its last run used;
  - under the phone layout the columns stack.

**Steps:**
- [ ] **Step 1: Failing tests.**
  - The model marks the App Store source `problem` from `sourceProblems`.
  - It adds an `undeclared` source for an unknown MCP server.
  - `highlight` from a source reaches its panel.
  - The component renders the four column titles.
  - Clicking a panel chip calls the navigation with that `panelId`.
  - The empty-map message shows.
- [ ] **Step 2: Run** `vitest run src/panel/jobs/job-map`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `P15-09: the job map`

### Task 10: Docs, task board and the real run

**Files:**
- Modify: `docs/SPEC.md` (decision **156** "Project dashboard", summarising Global Constraints; update decision 144's "numbers for the dashboard" sentence to point to 156, and its views list to five), `docs/TECHNOLOGY.md` (panels table, run data and sources, refresh purpose, the evaluator in protocol), `docs/IMPLEMENTATION_PLAN.md` (Phase 15 line), `docs/tasks/PHASE_15_DASHBOARD.md`, `docs/tasks/README.md`
- Create: `docs/tasks/notes/P15-10-real-run.md`

**Steps:**
- [ ] **Step 1:** Write the docs. Then run every gate: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. All must be green.
- [ ] **Step 2:** Write the real-run checklist for Cosmin.
  1. On a long-term project, ask the Waykeeper for a tile from an existing job (expect a `use` card) and a chart needing a new value (expect a job-change card).
  2. Refresh.
  3. Arrange.
  4. Open the job map.
  5. Clear a panel's history.
  6. Open the dashboard on the phone.
  7. Stop a job and remove its panels on the card.

  Its Result section is left for Cosmin.
- [ ] **Step 3: Commit** `P15-10: decision 156, docs and the real-run checklist`. Then stop and ask Cosmin to run the checklist and merge.
