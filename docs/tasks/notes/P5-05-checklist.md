# P5-05 — SPEC §4.2 / §4.3 conformance checklist

Phase 5's exit criterion: "Everything in `SPEC.md` §4.2 and §4.3 is doable from the panel, with and without the scene." Every clause of §4.2 and §4.3 is split below into individual requirements. Each row names the exact UI path, whether it works **with the scene** and **without it (list mode)**, and the automated test that proves it.

## How the rows are proven

- **`apps/web/src/conformance/spec-4-2.test.tsx`** and **`spec-4-3.test.tsx`** (new, P5-05) walk every row through the real panel (`<App/>`, the fake socket feeding it a snapshot and live events, every POST recorded). Each file is one `describe.each(MODES)`: every test runs twice, under `SPEC §4.2 side panel — with scene` / `— list mode` (and `SPEC §4.3 requests … — with scene` / `— list mode`). With the scene, its three.js part is stubbed as in `selection-paths.test.tsx` (bodies are registered anchors, picks go through `activateBody` / `activateSatellite` / `deselectFromScene`, the camera is its store). List mode is the per-browser "scene hidden" preference (decision 62); the suite asserts no scene is mounted. The shared world and page live in `apps/web/src/conformance/harness.ts`. Test names start with the row number (`§4.2.12 …`), so a row is found with `vitest -t "§4.2.12"`.
- Where a scene-only gesture has no list-mode equivalent (clicking a planet, a satellite, Earth, empty space), the list-mode run takes the panel's equivalent path, named in the row; the list-mode ✓ means "doable without the scene by that path".
- **`apps/server/src/brains/harmonizer/control-mapping.test.ts`** (new) proves the Harmonizer's conversational mappings that no brain test exercised through the Harmonizer (last section).
- Existing tests are listed as extra evidence where they cover the same row more deeply (component level, or against the real server).

Result: **77 rows** (§4.2: 51, §4.3: 26). With the scene: **75 ✓, 1 ✗, 1 partial**. List mode: the same, **75 ✓, 1 ✗, 1 partial**. The ✗ is §4.2.42h (controls of the Harmonizer itself), an open product question rather than a missing feature (Follow-up F2). The partial row is §4.3.25, the Harmonizer's conversational controls (Follow-up F1); it is not a panel requirement, so it does not bear on the exit criterion, but it is listed so the gap is not lost. Gaps fixed in place: one (§4.2.21, the Harmonizer's own cost).

## §4.2 Side panel

Paths: "dock bar" is the main area's header (decision 71); "strip" is its controls strip (decision 69: inline Pause/Resume, the rest under **More**); "cards" are the right column's managed-agents cards (decision 56); "row ⋯" is a navigation row's actions (decision 75).

### Bullet 1 — chat with the Harmonizer by default; a Waykeeper's conversation when selected; the Harmonizer one click away

| # | Requirement | How in the panel | Scene | List | Test (`spec-4-2.test.tsx`) | Notes |
|---|---|---|---|---|---|---|
| 4.2.1 | A chat with the Harmonizer by default | Open `/`: the main area is "Conversation with Harmonizer", composer "message to Harmonizer" | ✓ | ✓ | `§4.2.1 shows the chat with the Harmonizer by default` | Also `Panel.test.tsx › navigates between the Harmonizer, a Waykeeper and a Steward`. |
| 4.2.2 | Selecting a Waykeeper by clicking its planet/moon replaces the chat with its conversation | Scene: click the project's body. List: the project's navigation row | ✓ | ✓ (nav row) | `§4.2.2 selecting a Waykeeper by its planet or moon replaces the chat with its conversation` | Also `selection-paths.test.tsx › a body, Earth, and a click on empty space`. |
| 4.2.3 | … or by clicking its satellite | Scene: click the satellite. List: the Waykeeper's managed-agents card link | ✓ | ✓ (card link) | `§4.2.3 selecting a Waykeeper by its satellite replaces the chat with its conversation` | Also `picking-ui.test.tsx` (satellite picks). |
| 4.2.4 | The Harmonizer is one click away: deselect | Scene: click empty space (or Escape). Both: the dock bar's "← Harmonizer" | ✓ | ✓ ("← Harmonizer") | `§4.2.4 the Harmonizer is one click away: deselect` | |
| 4.2.5 | … or click Earth | Scene: click Earth (or its HQ station). List: the navigation's "Harmonizer" row (or the top bar's app name) | ✓ | ✓ (nav row) | `§4.2.5 the Harmonizer is one click away: click Earth` | |

### Bullet 2 — the Steward view

| # | Requirement | How in the panel | Scene | List | Test (`spec-4-2.test.tsx`) | Notes |
|---|---|---|---|---|---|---|
| 4.2.6 | Selecting a Steward shows a read-only view with its status | Scene: its satellite or (asteroid) its body. List: its task's navigation row, or its card | ✓ | ✓ | `§4.2.6 selecting a Steward shows its status` | Agent state and task state in the view's header. |
| 4.2.7 | … its current activity | The view's header ("Current activity: …") | ✓ | ✓ | `§4.2.7 … its current activity` | |
| 4.2.8 | … its work | Header facts: task, project, body, worktree, branch | ✓ | ✓ | `§4.2.8 … its work (task, project, body, worktree, branch)` | Plus the task facts of P5-02 (`status-views.test.tsx › adds the task facts to the Steward view`). |
| 4.2.9 | … its thought process (transcript) | "Transcript": thinking (collapsed), tool calls, text | ✓ | ✓ | `§4.2.9 … its thought process (the transcript: thinking, tool calls, text)` | Backfill + live: `StewardPanelView.test.tsx › backfills over REST, then goes live …`. |
| 4.2.10 | … its open question, if any | "Open question" section | ✓ | ✓ | `§4.2.10 … its open question` | |
| 4.2.11a | A message box appears only while it has an open clarification | "answer the clarification" form; gone once answered, replaced by the read-only note | ✓ | ✓ | `§4.2.11 a message box appears only while the Steward has an open clarification` | Also `StewardPanelView.test.tsx › has no composer without an open question …`. |
| 4.2.11b | No message box for a permission request (allow / refuse only) | The permission card in the view | ✓ | ✓ | `§4.2.11 … and none for a Steward with only a permission request (allow / refuse only)` | Decision 57. |
| 4.2.12 | Stop / pause remain available | The view's "controls": Pause / Resume, Stop → "Confirm stop" | ✓ | ✓ | `§4.2.12 stop and pause remain available on the Steward` | |

### Bullet 3 — the managed-agents section

| # | Requirement | How in the panel | Scene | List | Test (`spec-4-2.test.tsx`) | Notes |
|---|---|---|---|---|---|---|
| 4.2.13 | For the Harmonizer: the agents it manages (Waykeepers, asteroid Stewards), with statuses | Right column "Managed agents" with the Harmonizer selected | ✓ | ✓ | `§4.2.13 the Harmonizer’s: its Waykeepers and the asteroid Stewards, with their statuses` | Also `AgentCards.test.tsx › managed-agents cards: what they show`. |
| 4.2.14 | For a Waykeeper: the agents it manages, with statuses | Same section with the Waykeeper selected | ✓ | ✓ | `§4.2.14 a Waykeeper’s: the Stewards it manages, with their statuses` | Sub-projects' Waykeepers: `AgentCards.test.tsx › a Waykeeper’s cards: its Stewards and its sub-projects’ Waykeepers`. |

### Bullet 4 — the question inbox

| # | Requirement | How in the panel | Scene | List | Test (`spec-4-2.test.tsx`) | Notes |
|---|---|---|---|---|---|---|
| 4.2.15 | Every open question in the system | Right column "Inbox": "Waiting for you", "Held by supervisors" | ✓ | ✓ | `§4.2.15 lists every open question in the system` | Order: `Inbox.test.tsx › lists blocked-on-user items first …`. |
| 4.2.16 | … with its kind | The card's kind pill | ✓ | ✓ | `§4.2.16 … with its kind` | |
| 4.2.17 | … who is currently holding it | "held by you" / "held by Waykeeper · …" | ✓ | ✓ | `§4.2.17 … who is currently holding it` | |
| 4.2.18 | … the context needed to answer it: origin agent, task, body, last events | The card's origin line ("open Steward · …" link, task, project, body) and "last N events" | ✓ | ✓ | `§4.2.18 … and the context to answer it: origin agent, task, body, last events` | |
| 4.2.19 | Answer inline | Option buttons / "answer" + Answer; Allow / Refuse; a supervisor-held one too | ✓ | ✓ | `§4.2.19 answers inline: a clarification, a permission, a question a supervisor holds` | Stale answers: `Inbox.test.tsx › says "already answered by …" …`. |

### Bullet 5 — each agent's status, cost so far, and its queries

| # | Requirement | How in the panel | Scene | List | Test (`spec-4-2.test.tsx`) | Notes |
|---|---|---|---|---|---|---|
| 4.2.20 | Each agent's status | Navigation (Harmonizer row), dock bar state pill of the selected agent, card pills | ✓ | ✓ | `§4.2.20 each agent’s status: in the navigation, in the dock bar, on its card` | |
| 4.2.21 | Each agent's cost so far | Cards ("cost so far") for Waykeepers and Stewards; Steward view "cost"; project status "Waykeeper"; **Harmonizer: Status → Cost → "the Harmonizer itself"** | ✓ | ✓ | `§4.2.21 each agent’s cost so far: the Harmonizer, a Waykeeper, the Stewards` | **Gap fixed (P5-05):** the Harmonizer's own cost was only summed into "Harmonizer and Waykeepers". |
| 4.2.22 | Respond to its queries directly from the panel | The Steward view's box, the inbox, the supervisor's thread (§4.3.8) | ✓ | ✓ | `§4.2.22 responds to an agent’s query directly from the panel (its view, the inbox)` | |

### Bullet 6 — control actions on any task, project or agent (direct, instant, no LLM; supervisors informed)

Every row below runs one control through the strip and asserts the only POST is `/api/control` with that body (no message to any brain: "no LLM in the loop"); destructive ones assert nothing is sent before the inline confirmation (decision 56). The same actions are on the cards (`AgentCards.test.tsx › managed-agents cards: every control action of SPEC §4.3`, every action × target, plus `agent-cards-roundtrip.test.tsx` against the real server) and on a row's ⋯ (without Edit; `inbox-closed.test.tsx › work actions on a navigation row`).

| # | Requirement | How in the panel | Scene | List | Test (`spec-4-2.test.tsx`) | Notes |
|---|---|---|---|---|---|---|
| 4.2.23 | Pause a task | Steward view strip: "Pause the task" | ✓ | ✓ | `§4.2.23 pause a task` | |
| 4.2.24 | Resume a task | Strip: "Resume the task" | ✓ | ✓ | `§4.2.24 resume a task` | |
| 4.2.25 | Stop a task | Strip → More → task → Stop → "Yes, stop" | ✓ | ✓ | `§4.2.25 stop a task` | |
| 4.2.26 | Cancel a task | More → task → Cancel → "Yes, cancel" | ✓ | ✓ | `§4.2.26 cancel a task` | |
| 4.2.27 | Edit a task's description | More → task → Edit → "description" → Save | ✓ | ✓ | `§4.2.27 edit a task’s description` | |
| 4.2.28 | Edit a task's priority | More → task → Edit → "priority" → Save | ✓ | ✓ | `§4.2.28 edit a task’s priority` | |
| 4.2.29 | Close a task now | More → task → Close → "Yes, close" | ✓ | ✓ | `§4.2.29 close a task now` | |
| 4.2.30 | Archive a task now | More → task → Archive now → confirm | ✓ | ✓ | `§4.2.30 archive a task now` | Also from history (`history.test.tsx`). |
| 4.2.31 | Pin a task (keep visible) / unpin | More → task → Pin / Unpin | ✓ | ✓ | `§4.2.31 pin a task (keep it visible)`, `§4.2.31 unpin a task` | |
| 4.2.32 | Reopen a task | More → task → Reopen | ✓ | ✓ | `§4.2.32 reopen a task` | Archived: §4.3.24. |
| 4.2.33 | Pause a project | Waykeeper dock bar strip: "Pause the project" | ✓ | ✓ | `§4.2.33 pause a project` | |
| 4.2.34 | Resume a project | "Resume the project" | ✓ | ✓ | `§4.2.34 resume a project` | |
| 4.2.35 | Stop a project | More → project → Stop → confirm | ✓ | ✓ | `§4.2.35 stop a project` | |
| 4.2.36 | Cancel a project | More → project → Cancel → confirm | ✓ | ✓ | `§4.2.36 cancel a project` | |
| 4.2.37 | Edit a project | More → project → Edit → "name" (and "trust level") → Save | ✓ | ✓ | `§4.2.37 edit a project (its name; its trust level)` | A project has no description or priority; decision 56 makes "edit" its name or trust level (trust: `AgentCards.test.tsx › edits a project’s trust level`). See S1. |
| 4.2.38 | Close a project now | More → project → Close → confirm | ✓ | ✓ | `§4.2.38 close a project now` | |
| 4.2.39 | Archive a project now | More → project → Archive now → confirm | ✓ | ✓ | `§4.2.39 archive a project now` | |
| 4.2.40 | Pin a project | More → project → Pin | ✓ | ✓ | `§4.2.40 pin a project` | |
| 4.2.41 | Reopen a project | More → project → Reopen | ✓ | ✓ | `§4.2.41 reopen a project` | |
| 4.2.42 | Pause an agent | Waykeeper strip "Pause the agent"; Steward view Pause (4.2.12); cards | ✓ | ✓ | `§4.2.42 pause an agent` | |
| 4.2.43 | Resume an agent | "Resume the agent"; "Resume session" for an interrupted one | ✓ | ✓ | `§4.2.43 resume an agent` | Resume session: `controls-strip.test.tsx › offers Resume and Resume session …`. |
| 4.2.44 | Stop (= cancel) an agent | More → agent → Stop → confirm | ✓ | ✓ | `§4.2.44 stop an agent` | An agent-level cancel is a stop (decision 56); cancel is offered on the work. |
| 4.2.42h | Pause / resume the Harmonizer itself; restart it (decision 82: no plain Stop) | Harmonizer dock bar: "Pause the Harmonizer" / "Resume the Harmonizer"; "Resume session" when interrupted; "Restart Harmonizer" → confirm (starts on Keep) → `POST /api/harmonizer/restart` | ✓ | ✓ | `§4.2.42h pause and resume the Harmonizer itself`, `§4.2.42h resume the session of an interrupted Harmonizer`, `§4.2.42h restart the Harmonizer (confirmed); the dock follows the new one` | P5-06 (was ✗, F2). Also `controls-strip.test.tsx › the Harmonizer’s controls in its dock bar …`; server: `brains/harmonizer/restart.test.ts`, `http/harmonizer-restart-route.test.ts`. |
| 4.2.45 | The same actions from a row's ⋯ and from a card | Navigation row ⋯ "Actions for …"; a card's task controls | ✓ | ✓ | `§4.2.45 the same actions from a navigation row’s “⋯” and from the managed-agents card` | |
| 4.2.45s | The affected supervisors are informed so they adjust | Server: `control.*` events wake the agent's supervisor, a task's Stewards' supervisor and project Waykeeper (or the Harmonizer), a project's Waykeeper(s), parent and the Harmonizer | ✓ | ✓ | `apps/server/src/brains/wake.test.ts › wakes on control actions on the brain, its agents, its tasks and its projects`, `› control wake-ups through concernedSupervisors` | Same server path in both modes. |

### Bullets 7–8 — history view; list mode

| # | Requirement | How in the panel | Scene | List | Test (`spec-4-2.test.tsx`) | Notes |
|---|---|---|---|---|---|---|
| 4.2.46a | A history view of archived work (`/history`) | Top bar → History: "Finished and archived work" | ✓ | ✓ | `§4.2.46 a history view of archived work and past questions (/history)` | Inspect / reopen: `history.test.tsx › history inspector`. |
| 4.2.46b | … and of past questions | Same page: "Past questions" | ✓ | ✓ | (same test) | Holder chain: `history.test.tsx › shows each past question’s holder chain …`. |
| 4.2.47 | The panel works with the 3D scene hidden (list mode) | Top bar → Hide scene / Show scene | ✓ (hides it) | ✓ | `§4.2.47 the panel works with the 3D scene hidden (list mode)` | And the whole list-mode run of both suites; `a11y/list-mode.test.tsx`. |

## §4.3 Requests the user must be able to make

| # | Requirement | How in the panel | Scene | List | Test | Notes |
|---|---|---|---|---|---|---|
| 4.3.1 | Status of the whole system | Harmonizer dock bar → Status | ✓ | ✓ | `spec-4-3.test.tsx › §4.3.1 the whole system` | No POST at all (no LLM). Narrative button: `status-views.test.tsx › asks the Harmonizer for a narrative only on the button …`. |
| 4.3.2 | … of a project | Select the Waykeeper (body click / nav row) → Status | ✓ | ✓ | `§4.3.2 a project` | |
| 4.3.3 | … of a task | Select its Steward (asteroid click / nav row): "task status" facts | ✓ | ✓ | `§4.3.3 a task` | |
| 4.3.4 | … of an agent | Its view (state, activity, caps) or its card | ✓ | ✓ | `§4.3.4 an agent` | |
| 4.3.5 | Ask for a new standalone task | Harmonizer chat → message → the card in the thread → Approve | ✓ | ✓ | `§4.3.5 a new standalone task` | Real server: `harmonizer.test.ts › holds and answers an asteroid Steward’s clarification, then closes the task`. |
| 4.3.6 | Ask for a new task added to an existing project | Same, "project task" card | ✓ | ✓ | `§4.3.6 a new task added to an existing project` | `harmonizer.test.ts › adds work that belongs to an existing project there …`. |
| 4.3.7 | Start a new project | Same, "new project" card | ✓ | ✓ | `§4.3.7 start a new project` | Real server end to end: `chat-run.test.tsx › a request typed in the chat gets its card in the thread …`. |
| 4.3.8 | Answer a question through its supervisor | Select the supervisor (body click / nav row): the question's card in its conversation (decision 55) | ✓ | ✓ | `§4.3.8 through its supervisor (the card in the supervisor’s conversation)` | Also `thread-inbox.test.tsx`. See S6 (a free-text chat reply does not answer it). |
| 4.3.9 | … from the inbox | Inbox card: options / answer / Allow / Refuse | ✓ | ✓ | `§4.3.9 from the inbox (a clarification, a permission)` | |
| 4.3.10 | … directly to the Steward (clarification only) | Steward view box; a permission has no box | ✓ | ✓ | `§4.3.10 directly to the Steward — a clarification only` | |
| 4.3.11 | Approve a proposal | Inbox card (or thread) → Approve | ✓ | ✓ | `§4.3.11 approve a proposal` | |
| 4.3.12 | Edit a proposal | Card → Edit → size, body, workspace (git init, trust) → Save | ✓ | ✓ | `§4.3.12 edit a proposal (size, body, workspace)` | All fields: `Inbox.test.tsx › approves, edits inline …`. |
| 4.3.13 | Reject a proposal | Card → reason → Reject | ✓ | ✓ | `§4.3.13 reject a proposal (with a reason)` | |
| 4.3.14 | Approve a task plan | Waykeeper's conversation (or inbox): plan card → Approve plan | ✓ | ✓ | `§4.3.14 approve a task plan (in the Waykeeper’s conversation)` | |
| 4.3.15 | Edit a task plan | Plan card → a task's Edit → description / priority → Save (decision 35: edited through its tasks) | ✓ | ✓ | `§4.3.15 edit a task plan, through its tasks` | |
| 4.3.16 | Reject a task plan | Plan card → reason → Reject | ✓ | ✓ | `§4.3.16 reject a task plan` | |
| 4.3.17 | Confirm a promotion | Promotion card ("moves task …") → Approve | ✓ | ✓ | `§4.3.17 confirm a promotion` | Carried out: `promotion.test.ts`. |
| 4.3.18 | Decline a promotion | Promotion card → Reject | ✓ | ✓ | `§4.3.18 decline a promotion` | |
| 4.3.19 | Stop, cancel, pause or resume a task, project or agent | As §4.2.23–26, 33–36, 42–44 | ✓ | ✓ | `spec-4-2.test.tsx › §4.2.23 … §4.2.26, §4.2.33 … §4.2.36, §4.2.42 … §4.2.44` | |
| 4.3.20 | Edit a task's description or priority | As §4.2.27–28 | ✓ | ✓ | `spec-4-2.test.tsx › §4.2.27`, `§4.2.28` | |
| 4.3.21a | Close a project (§2.7) from the panel | As §4.2.38 (closing withdraws an open "Anything else?") | ✓ | ✓ | `spec-4-2.test.tsx › §4.2.38 close a project now` | Withdrawal: `closure.test.ts › … the user closes from the panel`. |
| 4.3.21b | … by answering the Harmonizer's "Anything else?" | The question's card in the Harmonizer's thread (or inbox) → "Close <project>" | ✓ | ✓ | `spec-4-3.test.tsx › §4.3.21 close a project by answering the Harmonizer’s “Anything else?”` | Carried out: `closure.test.ts › … or by answering the question …`. |
| 4.3.22 | Archive early | As §4.2.30 / §4.2.39; history row "Archive now" | ✓ | ✓ | `spec-4-2.test.tsx › §4.2.30`, `§4.2.39` | |
| 4.3.23 | Pin (and unpin) | As §4.2.31 / §4.2.40; history row Pin / Unpin | ✓ | ✓ | `spec-4-2.test.tsx › §4.2.31`, `§4.2.40`; `history.test.tsx › pages back through the work, and unpins finished work` | |
| 4.3.24 | Reopen finished work (also archived) | §4.2.32 / §4.2.41; History → row → Reopen | ✓ | ✓ | `spec-4-3.test.tsx › §4.3.24 reopen finished work from the history view` | Archived project: `history.test.tsx › finds an archived project, inspects it and reopens it`. |
| 4.3.25 | The same control actions conversationally through the Harmonizer, with the same tools | Harmonizer chat | partial | partial | See the map below | Not a panel requirement. Gap: work-level controls and edits (F1, S3). |

## The Harmonizer's conversational map (§4.3, last line)

Every tool below calls the same command the panel's `POST /api/control` calls (`DomainCommands.control` / `stopAgent` / `pauseAgent` / `resumeAgent`), so the log records the Harmonizer as `by`.

| Control action / request | Harmonizer tool | Test |
|---|---|---|
| Status: system / project / task / agent | `report_status {}` / `{projectId}` / `{taskId}` / `{agentId}` | `control-mapping.test.ts › reads the status of the whole system, a project, a task and an agent`; `harmonizer.test.ts › answers a status question without any proposal` |
| New standalone task / task in a project / new project | `propose` (one card), then `create_task` / `create_project`, `spawn_steward` / `spawn_waykeeper` after approval | `harmonizer.test.ts` (`turns a new-project request …`, `carries out an approved project card …`, `adds work that belongs to an existing project …`, `holds and answers an asteroid Steward’s clarification …`) |
| Answer a question it holds (clarification) | `answer_question` (permission refused) | `harmonizer.test.ts › holds and answers …`, `› never sees a permission question, and refuses to answer one` |
| Approve / edit / reject a proposal or plan; confirm / decline a promotion | — by design: the user's alone (decisions 34, 35, 40); it proposes (`propose`, `propose_promotion`) | `harmonizer.test.ts › proposes a promotion without moving anything` |
| Pause / resume / stop (= cancel) an agent | `pause_agent` / `resume_agent` / `stop_agent` | `control-mapping.test.ts › pauses, resumes and stops an agent below it` (new) |
| Close a project | `close_project`, after "Anything else?" answered "Close …" or an `ask_confirmation` | `closure.test.ts › … or by answering the question …`; `control-mapping.test.ts › pins, unpins and reopens finished work, and closes a project, each on the user’s confirmation` (new) |
| Archive now | `finished_work {action: archive}` after `ask_confirmation` | `closure.test.ts › refuses close_project and finished_work without a user answer, and acts on a confirmation` |
| Pin / unpin / reopen | `finished_work {pin / unpin / reopen}` after `ask_confirmation` | `control-mapping.test.ts › pins, unpins and reopens …` (new) |
| Close an asteroid task | `close_task` | `harmonizer.test.ts › holds and answers … then closes the task` |
| **Pause / resume / stop / cancel a task or project** (decision 28's work-level states) | **none** (`pause_agent` on a Waykeeper pauses the agent, not its project; nothing cancels work) | — gap: F1 |
| **Edit a task's description or priority; a project's name or trust level** | **none** | — gap: F1 |
| **Close a project task now** | **none** (the Waykeeper's `close_task`) | — gap: F1 |

## SPEC §7 decisions 53–81 read against §4.2 / §4.3

No decision contradicts a §4.2/§4.3 requirement the panel implements. Found:

1. **§4.2 bullet 6 / §4.3 "edit description or priority" vs decision 56.** A project has neither; decision 56 makes a project's edit its name or trust level. → S1.
2. **Decision 69 vs decision 75.** 69 still says "The inbox is never hidden"; 75 (which says it refines 69) makes it hidable. → S2.
3. **§4.3 last line and decision 11b ("the Harmonizer can do the same conversationally") vs decision 42 and the tools.** Decision 42 limits the Harmonizer to close, archive, pin, unpin, reopen (on the user's word) — nothing for work-level pause, resume, stop, cancel or edit. → S3, F1.
4. **§4.2 "control actions on any … agent" vs the panel and decision 44.** Decision 44 speaks of "the user's stop" of a Harmonizer, but the panel has no control for the Harmonizer (since P4-09). → S4, F2.
5. **Decision 80** lists the system status's costs (total, today, brains, Stewards); P5-05 adds the Harmonizer's own. → S5.

## Gaps fixed in place

- **The Harmonizer's own cost (§4.2.21).** The system status's Cost section now has "the Harmonizer itself" (`apps/web/src/panel/status/StatusViews.tsx`); every other agent already showed its own cost (card, Steward view, project status). Test: `spec-4-2.test.tsx › §4.2.21 …` (fails without the fix). TECHNOLOGY §4 (status views) updated.

## Follow-ups (for the coordinator to file)

- **F1 — The Harmonizer's work-level controls (§4.3 last line, decision 11b).** Proposed task: *"P5-06 (or Phase 6) — Conversational work controls. Give the Harmonizer a `control_work {kind: task|project, id, action: pause|resume|stop|cancel|edit, changes?}` tool calling `DomainCommands.control` with the Harmonizer as `by`, reaching any task or project (a project task's close stays the Waykeeper's `close_task`, or is relayed to it). Decide in SPEC §7 whether the destructive ones (stop, cancel) need `ask_confirmation` like close/archive (decision 42) or act on the user's message (conversational requests need no card, decision 3). Prompt: map "pause the CSV project" to the project, not to `pause_agent` on its Waykeeper. Acceptance: a brain-harness test per action; TECHNOLOGY §5.3's map has no gap left."*
- **F2 — Controls for the Harmonizer itself (§4.2 "any … agent").** Proposed task: *"Decide (SPEC §8 → §7) whether the panel offers pause / resume / stop and "Resume session" for the Harmonizer. If yes: the Harmonizer's dock bar gets the agent's strip (agent actions only, stop confirmed, warning that the Harmonizer is not replaced after a user stop — decision 44 — and how to start one again); update `controls-strip.test.tsx › … not for the Harmonizer`. Acceptance: §4.2.42h ticked in both modes."* Conservative meanwhile: no controls (as today).

## Proposed SPEC changes (not applied; SPEC is the coordinator's)

- **S1 (§4.2 bullet 6, §4.3 line 6):** "edit description or priority" → "edit a task's description or priority, or a project's name or trust level (decision 56)".
- **S2 (decision 69):** "The inbox is never hidden." → "The inbox stays (until decision 75 made it hidable too)." — or drop the sentence.
- **S3 (§4.3 last line, decision 11b):** either a new decision for F1 (the Harmonizer's work-level controls and whether stop/cancel need a confirmation), or narrow the line to what exists: "The Harmonizer can pause, resume and stop the agents below it, close projects and archive, pin, unpin or reopen finished work conversationally, through the same commands (decision 42)."
- **S4 (§8 open question):** "Should the panel offer pause / resume / stop (and Resume session) for the Harmonizer itself? A user stop leaves no Harmonizer until the next start (decision 44). Conservative meanwhile: no Harmonizer controls in the panel."
- **S5 (decision 80):** add "and the Harmonizer's own cost" to the system status's cost list (P5-05).
- **S6 (§4.3 line 4, clarification):** "through its supervisor" means the question's card in the supervisor's conversation (decision 55); a chat message to the supervisor does not answer a question the user holds (a supervisor answers only the clarifications it holds, decision 12).
