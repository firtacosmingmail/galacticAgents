# P5-03 — History view

The history view was built in P25-10 (SPEC decision 61: `/history`, finished and archived work with reopen / pin / archive, past questions, one search, filters) and its "Replay" in P4-07 (decision 78). This task closes what the P5-03 text asks for beyond that.

## Gap audit (against the P5-03 text, before any change)

Task text: *"Archived projects/tasks with their bodies, moved-to links, closure dates; past questions with kind, holder chain and who answered; search/filter; reopen from history. Acceptance: an archived project can be found, inspected and reopened."*

| Item | Before P5-03 | Now |
| --- | --- | --- |
| Archived projects and tasks listed | **exists** — `history-routes.test.ts` "lists finished and archived projects and tasks newest first, never open work"; `history.test.tsx` "finds an archived task by text and reopens it" | unchanged |
| …with their **bodies** | **partial** — the row showed the body's name only when the stream's world still held the body (`world.bodies[bodyId]`); `history.test.tsx` checks `Ceres-1` | **fixed here**: the server sends `bodyName` on every row and in the detail (the client falls back to it); the inspector says "lived on" for archived work. Tests: `history-detail.test.ts` "gives each work row its body name…", `history.test.tsx` acceptance test ("lived on" → Kepler) |
| …**moved-to links** | **gap** — nothing listed where work moved; the P25-10 notes deferred it ("moved markers are not listed"). Decision 15 and §3.4 promise "the history view keeps the permanent link between the two bodies" | **fixed here**: each row and the inspector list the item's moves ("moved from Ceres-1 to Kepler, into project CSV tool · date"), the project joined is a link that opens it in the inspector; promotion links both ways ("promoted from" a task, "promoted to" a project). Tests: `history-detail.test.ts` "records a standalone task joining a project once…" (real `moveTask` command), "links a promoted task to the project it became"; `history.test.tsx` "follows a moved-to link to the project the task joined, and back" |
| …**closure dates** | **gap** — only "created" and "last change" (`updatedAt`, which a pin also moves) | **fixed here**: "closed", "archived" and "last reopened" from the log's `*.state_changed`. Tests: `history-detail.test.ts` "gives each work row … closure / archive / reopen dates" (closed, reopened, closed again, archived → the second closure, the reopen, the archive), `history.test.tsx` acceptance test (`<time dateTime>` values on the row and in the inspector) |
| Inspect an archived project | **gap** — a row was all there was; no tasks, no state history, no questions of the work | **fixed here**: "Inspect" opens the **inspector** (`GET /api/history/work/:kind/:id`): facts and dates, moves, controls, every state change with who made it, tasks and sub-projects (each opens in place, with "← Back to …"), agents (Steward view / Waykeeper chat links) and their questions with holder chains. Tests: `history-detail.test.ts` "inspects an archived project…", "caps the questions…", 404/400/401, redaction parity; `history.test.tsx` acceptance and navigation tests |
| Past questions with **kind** | **exists** — `history.test.tsx` "finds a past question with its answer, who answered…" | unchanged |
| …**holder chain** | **gap** — only the current holder was in the row, and the list did not show it | **fixed here**: each past question carries `holders` (asked → escalated / reassigned → …), shown as "Waykeeper · CSV tool → Harmonizer (reassigned: …) → you". Tests: `history-detail.test.ts` "gives each past question its holder chain…" (two escalations to the user; a reassignment with its reason; a question never escalated), `history.test.tsx` "shows each past question's holder chain…" and in the inspector (acceptance test) |
| …**who answered** | **exists** — "answered by" (P25-10 test above) | unchanged; also asserted in the new tests |
| Search / filter | **exists** — `history-routes.test.ts` "searches names and descriptions, filters by kind and state", "searches the question and its answer…"; `history.test.tsx` search and filter tests | unchanged |
| Reopen from history | **exists for a task** (`history.test.tsx` "finds an archived task by text and reopens it"); a project's reopen used the same code but was not tested | **tested here** for an archived project, from the inspector |
| Replay | **exists** (P4-07, `replay-ui.test.tsx`) | kept: on project rows and in the inspector's controls |
| **Acceptance**: an archived project can be found, inspected and reopened | found and reopened: yes (untested for a project); inspected: no | **met**: `history.test.tsx` "finds an archived project, inspects it and reopens it (acceptance)" through `<App/>`: search → row (closure dates, move) → Inspect (body, state changes, task link, Waykeeper link, question with holder chain and who answered) → Reopen sends `{project, reopen}` → the stream's `project.state_changed` updates the inspector and the row |

## What was built

### Protocol (`packages/protocol/src/panel.ts`, history section)

- `HistoryMove` `{at, fromBodyId?, fromBodyName?, toBodyId?, toBodyName?, intoProjectId?, intoProjectName?}`, `HistoryWorkRef` `{kind, id, name}`, `HistoryWorkTrail` `{closedAt?, archivedAt?, reopenedAt?, moves, promotedTo?, promotedFrom?}`.
- `HistoryWorkItem` gains optional `bodyName` and `trail`; `HistoryQuestion` gains optional `holders: HolderStep[]` (`{holder, at, via: 'asked' | 'escalated' | 'reassigned', reason?}`). Optional, so a client reading an older server still parses; this server always sends them.
- `HistoryStateStep` `{at, from, to, by?}`, `HistoryWorkParams` `{kind: project | task, id}`, `HistoryWorkDetail` `{work, bodyName?, trail, states, project?, tasks, subProjects, agents, questions, moreQuestions}`.

### Server

- `apps/server/src/runtime/history-view.ts`: `work()` adds `bodyName` and the trail to each row, from one read of the page's lifecycle events (`lifecycles`) and one read of promotions (`promotedInto`); `questions()` adds the holder chain (`holderChains`, one read per page); new `detail(kind, id)`.
  - **Dates**: `closedAt` = the last `*.state_changed` into `completed` / `failed` / `moved` while the work is still finished; `archivedAt` = the last into `archived` while archived; `reopenedAt` = the last move out of a finished state.
  - **Moves**: each `body.moved` whose host is the item; for a task also a `task.updated` with a new `projectId` (a Waykeeper's promotion hands the task to another project without a `body.moved`). A standalone task joining a project emits both in one command (`moveTask`: `task.updated` then `body.moved`); they fold into one move (same `at`, same project). Names resolved by the server, so the link reads after the client sheds rows.
  - **Holder chain**: the first `question.escalated` / `question.reassigned`'s `from` (else the row's holder) is the first holder, at the question's `createdAt`; then one step per event.
  - The cancel-reason read now binds the page's ids as one JSON array like the new reads (`IN (SELECT value FROM json_each(?))`), so one statement serves every page size.
- `apps/server/src/db/migrations/0009_history_detail_indexes.sql`: `events_work_subject` (partial expression index, only the four lifecycle event types), `projects_parent`, `projects_promoted_from`, `agents_project`, `agents_task`, `questions_origin`. The lifecycle read names its index (`INDEXED BY`): without it SQLite chose `events_type_question` for the `type IN` term (the plan test caught it).
- `apps/server/src/http/panel-routes.ts`: `GET /api/history/work/:kind/:id` — bearer-guarded (the panel scope's hook), zod-validated params (400 `invalid_query`), 404 `not_found`.

### Web (`apps/web/src/panel/history/`)

- `parts.tsx` (new): the pieces the lists and the inspector share, moved out of `HistoryPage.tsx` — `Fact`, `When`, `AgentLink`, `WorkControls` (Replay, Reopen, Pin / Unpin, Archive now with its confirm), `QuestionRow` (now with "held by" and an `open` tag for the inspector's open questions), plus `TrailFacts`, `Moves`, `HolderChain`, `WorkLink` and `InspectContext`.
- `WorkInspector.tsx` (new): the inspector section, labelled "details of <name>", above the lists. Reads the detail; reads again when the stream changes the item (`updatedAt`), so a reopen's new state change appears; focuses its heading on each new item. Shows the item's live copy from the stream when there is one.
- `HistoryPage.tsx`: rows show closure dates, moves and promotion links, the project as an inspect link, and an "Inspect <name>" button; the page keeps the inspector's trail (`← Back to <previous>`, `Close`).
- `history.css`: the inspector, in-page links, moves, steps and the holder chain (arrows between holders), on the panel's tokens.
- `apps/web/src/console/api.ts`: `historyDetail(kind, id)`.

## Proposed SPEC text (amend decision 61)

Append to decision 61:

> **Inspecting history (2026-10-04, P5-03; §3.4, decisions 15, 78).** Each finished or archived item also shows when it was closed and archived (and last reopened), where it moved — "moved from Ceres-1 to Kepler, into project CSV tool" — and its promotion link both ways ("promoted from" a task, "promoted to" a project); this is the permanent link decision 15 promises, kept after the "moved to …" marker is freed. **Inspect** opens the item in place: its body, its dates, its moves, every state change with who made it, its project, tasks and sub-projects (each opens in the same place, with Back), the agents that ran it with links to their views, and the questions they asked (the newest 50). It offers the row's controls (Replay, Reopen, Pin, Archive now). A moved-to link may lead to work that is still running; the inspector shows it in its current state. Each past question shows its **holder chain** — who held it, in order: the agent it was routed to when asked (the asker's supervisor, or the user for a permission), then each escalation and each reassignment (with why) — and who answered.

Optionally amend the sentence "A moved item's marker is not listed (its work continues under its new body, decision 15)" to "A moved item's marker is not listed; the item's moves are (P5-03)."

## Tests

- **Protocol** (`panel.test.ts`, +3): the detail params (project / task only), a question's holder chain round-trips and an unknown step is refused, the detail is typed by its kind.
- **Server** (`http/history-detail.test.ts`, new, 9 tests):
  - work rows: body name; closed / archived / reopened dates over close → reopen → close → archive; another project's events never leak in; promotion link from a project to its task;
  - holder chains: two escalations up to the user with who answered; a reassignment with its reason; a question never escalated;
  - a standalone task joining a project through the real `moveTask` command: one move, both body names, the project; no closure date while running;
  - a promoted task links to the project it became;
  - the detail route: state changes with `by`, tasks, sub-projects, agents, questions with holders; at most 50 questions with `moreQuestions`; 404 / 400 / 401; rows equal the snapshot's (redaction parity);
  - query plans: each new statement searches its index (`events_work_subject`, `events_type_question` for escalations and cancel reasons, `projects_promoted_from`, `tasks_project`, `projects_parent`, `agents_project`, `agents_task`, `questions_origin`) and scans no table.
  - `history-routes.test.ts` (P25-10's plan test) now selects its statements by `INDEXED BY <table>_history` / `question.cancelled`, since the view has more statements.
- **Web** (`panel/history/history.test.tsx`, +4, through `<App/>`):
  - acceptance: find an archived project by search; its row shows closure dates and its move; Inspect shows "lived on", the state changes (with "by you"), a task link, the Waykeeper chat link and its question with holder chain "Harmonizer → you" and who answered; Reopen sends `{project, reopen}`; the stream's state change updates the inspector and the row;
  - moved-to link navigation: a task's "into project CSV tool" opens the project in the inspector; its task link opens the task; "← Back to CSV tool" returns; Close closes;
  - holder chain in the past-questions list, with a reassignment and its reason;
  - an unreadable item shows an error with "Try again".
- **Gates** (repo root, all green): `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` — protocol 70, server 948 (+1 skipped), web 1038.

## Shared files touched

- `packages/protocol/src/panel.ts` (imports `Agent`, `WorkState`; the history section: new schemas, two optional fields), `packages/protocol/src/panel.test.ts` (one `describe` appended, imports).
- `apps/server/src/http/panel-routes.ts` (imports, the header comment, one route after `/api/history/work`).
- `apps/web/src/console/api.ts` (`historyDetail`, imports `HistoryWorkDetail`, `HostKind`).
- `docs/TECHNOLOGY.md` §6.3 (the history bullet extended; a new bullet for the detail route).
- New migration `0009_history_detail_indexes.sql` — if a parallel batch also adds a `0009`, one of them must be renumbered at merge (the migration loader refuses gaps and duplicates by number).

Not touched: the phase file, `docs/tasks/README.md`, `SPEC.md`, `apps/web/src/state/selection.ts`, `apps/web/src/panel/status/`.

## Deferred

- **The inspector is not in the URL.** Opening an item is page state (like the P25-10 filters); a reload closes it. A `/history/<kind>/<id>` deep link would touch `selection.ts`, which P5-01 owns in this wave.
- **Body links.** A move names its bodies; a body is not a page of its own, so only the project a task joined is a link. When P5-01's selection covers bodies, "to Kepler" could select it in the scene.
- **Questions beyond 50** in the inspector are reachable through the past-questions list's search, not paged in the inspector.
- **Membership is current.** As in the replay (decision 78), the agents and questions of a project are those that belong to it now: a Steward handed to another project shows under that project.
