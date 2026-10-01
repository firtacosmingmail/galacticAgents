# GalacticAgents — Initial Specification

**Status:** Draft v0.3 (review decisions 6–20 incorporated) · **Date:** 2026-09-30 · **Author:** Cosmin Firta

This document captures the initial product specification for GalacticAgents. It is the source of truth for *what* the application does; `TECHNOLOGY.md` covers *with what* and `IMPLEMENTATION_PLAN.md` covers *in which order*.

---

## 1. Vision

GalacticAgents is a local application that manages the AI agents running on the user's computer. It presents them through a spectacular space interface built around our solar system: Earth is the headquarters, and the other planets, moons and asteroids represent projects and tasks, chosen by their size.

The purpose is to make managing local agents easier: one place to see what every agent is doing, to give them work, to answer their questions and to follow progress — without having to babysit terminals.

## 2. The agent hierarchy

The user interfaces with a single top-level agent. Below it sit two further tiers.

### 2.1 The Harmonizer (one, global)

The Harmonizer is the user's single point of contact and the commander of the whole system. It:

- decides when to start new agents and when to stop them;
- knows what each agent is doing and what it *should* be doing;
- knows the status of every task and project and what is to be done next for each;
- receives the user's requests for statuses, new tasks and new projects;
- decides how big a new request is and assigns it a celestial body accordingly (see §3);
- **directly supervises the Stewards that work on asteroids** (standalone tasks have no project and therefore no Waykeeper; decision 6);
- relays questions from the lower tiers to the user when they cannot be answered internally (§2.6);
- relays a Waykeeper's "project seems finished" report to the user and asks whether anything else is needed (§2.7).

The Harmonizer is started together with the application and stays idle (event-driven) until something happens; Earth is never "empty".

### 2.2 Waykeepers (one per project)

Each project is coordinated by a Waykeeper. A Waykeeper:

- knows the tasks required for its project and their status;
- knows the agents (Stewards) working on the project's tasks;
- plans the project's tasks and presents the plan to the user once (§3.3);
- starts and supervises Stewards for the project's tasks, and merges their work (§3.5);
- decides when a Steward has finished its task and closes the task; decides when a Steward is merely waiting for input (§2.7);
- answers a Steward's question itself when the project context allows it, otherwise escalates it to the Harmonizer (§2.6);
- reports to the Harmonizer when it believes the whole project is done (§2.7).

### 2.3 Stewards (one per task)

A Steward handles exactly one task, in its own git worktree of the project's workspace (§3.5). When a Steward needs input it announces its **supervisor**: its Waykeeper for a project task, or the Harmonizer for an asteroid task. When it believes its task is done it reports to its supervisor; the supervisor decides whether the task is closed.

### 2.4 Who the user talks to

The default escalation path is **Steward → Waykeeper → Harmonizer → user** (or Steward → Harmonizer → user for asteroid tasks).

The user converses with the **Harmonizer and the Waykeepers only** (decision 13). Stewards are not conversation partners: clicking a Steward opens a read-only view of its status, its work and its thought process, but no message box. The single exception is a **clarification question**: while a Steward has an open question addressed to the user, the user may write the answer to the Steward directly from that view (or from the question inbox, or from the supervisor's chat). Answering in one place resolves the question everywhere, and every supervisor above it is told and stops waiting.

### 2.5 Supervision without interruption

Supervisors (the Harmonizer and the Waykeepers) need a way to know the status of the agents they supervise **without interrupting them**. Status must be observable, not requested by sending the agent a message.

### 2.6 Questions: who may answer what

Every question an agent raises is a tracked object with a **kind**:

- **Clarification** ("which database should I use?"). A supervisor (Waykeeper or Harmonizer) **may answer it itself** when the approved plan or project context already contains the answer (decision 12). Every internally answered question is still recorded, marked with who answered it, and shown read-only in the question inbox and history, so the user can see it and override it. Questions the supervisor cannot answer are escalated up until they reach the user.
- **Permission** ("may I run `rm -rf build`?", "may I push?"). Never answered by any agent. Resolved either by the project's permission policy (§3.6) or by the user, and routed straight to the user's inbox without passing through the supervisor LLMs.

### 2.7 Completion and closure (decision 11)

- A Steward reports that its task is done. Its **Waykeeper decides** whether the work is really finished (and closes the task) or whether the Steward is in fact waiting for input. For asteroid tasks the Harmonizer plays this role.
- When a Waykeeper believes **all of its project's work is finished**, it asks the Harmonizer to ask the user whether anything else needs to be done on that project.
- **Closing a project and its Waykeeper is the user's decision.** Until the user closes it, the Waykeeper stays available (idle) for follow-up work. On closure the Waykeeper is stopped, transcripts are kept, the body enters the `completed` state and the retention period of decision 4 starts.

## 3. Sizing rule: planets, moons and asteroids

### 3.1 Sizes and bodies

When new work arrives, the Harmonizer judges its size and assigns a body:

| Size | Body | Examples |
|---|---|---|
| Big project | **Planet** | A new application, a multi-week initiative |
| Smaller project, or a sub-project of a planet project | **Moon** (see §3.2) | A feature, a sub-system of a bigger project |
| Standalone task, question needing investigation, small job | **Asteroid** (in the belt) | A bug fix, a one-off script, an investigation |
| Task that belongs to a project | **On the project's body** (surface or orbit; no asteroid) | "Add pagination to the CSV project" |

Earth is reserved: it is the headquarters (the Harmonizer's home) and is never assigned work. The Sun and Earth's Moon are likewise never assigned work.

Before sizing, the Harmonizer asks itself whether the new work **belongs to an existing project**; if it plausibly does (or duplicates an existing task) it proposes adding it there instead of creating a new body (this also covers duplicate detection).

The Harmonizer always presents its sizing and body proposal to the user and waits for confirmation before starting any agent (decision 3). If work outgrows its body, the Harmonizer proposes a promotion to a bigger body, again subject to the user's confirmation (decision 2). Asteroids are unlimited and generated as needed; planets and moons are reused after archival, but planets are finite: when all are occupied, the Harmonizer refuses a new planet-sized project and says there is no more space (decision 1).

### 3.2 Moons (decision 10)

A moon has two possible occupants, displayed differently:

- **A sub-project.** When a planet project contains a big task — sub-project sized — the Waykeeper (via the Harmonizer, with the user's confirmation) moves it to one of the moons of its own planet. Sub-projects are displayed as **part of the project**, and the planet's Waykeeper coordinates the sub-project's Waykeeper. A planet cannot be closed while one of its sub-project moons is active.
- **An independent small project.** A project that is not big enough for a planet simply occupies a moon. The Harmonizer prefers the moons of planets that have **no Waykeeper**; if every planet is occupied it takes any free moon. Such a moon is displayed so that the user can see it is a **project of its own and not a sub-project** of the planet it orbits. It is unaffected by what happens to that planet.

When a planet has no free moon left for a sub-project, the sub-project stays a task on the planet.

### 3.3 Requests, proposals and confirmation (decision 3, refined by decision 7)

Requests are of two classes:

- **Conversational requests** — asking for a status, answering an agent, discussing something with the Harmonizer or a Waykeeper. These never get a body and never need confirmation.
- **Work requests** — a new project, a new standalone task, a task added to a project, a promotion. These produce **one proposal card** (size, body, name, workspace) that the user approves, edits inline (size, body, workspace) or rejects. No agent is spawned before approval.

A Waykeeper's **task breakdown** for an approved project is presented **once, as a single approvable plan**; after approval the Waykeeper spawns Stewards for those tasks without further cards. A rejected or edited proposal stays as a **draft** in the chat, which the user can revise or discard; nothing is spawned. When no planet is free, the refusal shows which planets are occupied and by what, offers to downsize (moon or asteroids) or to close a completed project early, and the request stays **parked** until a planet frees or the user changes it (decision 16).

### 3.4 Moving and promoting work

When a standalone task is moved into a project, or promoted to a moon or planet, its **satellite visibly flies** from the old body to the orbit of the new one (decision 9). The old body shows a "moved to …" marker for the retention period of decision 4 and is then freed like any other body; the history view keeps the permanent link between the two bodies (decision 15). If a promotion is proposed while the Steward is mid-task, the Steward is paused, the decision is awaited, then the Steward resumes or hands over.

### 3.5 Workspaces and repositories (decisions 8 and 14)

Every **project has a workspace**: an existing folder or repository the user points at, or a new folder created under the configured *projects root*. The proposal card shows the workspace and lets the user change it before approval. A standalone (asteroid) task inherits the workspace of the project it relates to, or a scratch folder under the projects root.

**Each Steward works in its own git worktree and branch** of the project's workspace, so several Stewards can work on one project in parallel. When a task is closed, the **Waykeeper merges** the Steward's branch; a merge conflict the Waykeeper cannot resolve becomes a clarification question. Workspaces that are not git repositories get one initialised, or fall back to one Steward at a time.

### 3.6 Autonomy and permissions (decision 7)

How much a Steward may do without asking is a **per-project permission policy** with a global default:

| Action | Default |
|---|---|
| Read files, run tests/builds, edit files **inside** the workspace | Allowed automatically |
| Destructive actions (delete files or branches, `rm -rf`, force operations) | Ask the user |
| Anything **outside** the workspace | Ask the user |
| Network access (installs, pushes, external calls) | Ask the user |
| `git push` / anything that leaves the machine | Ask the user |

Permission questions go straight to the user (§2.6); they are never answered by a Waykeeper or the Harmonizer. Remote clients follow the security rules in `TECHNOLOGY.md`.

How the table is applied (decision 22): a project's policy overrides the global default **per category** — it can loosen as well as tighten; a policy value that is not `allow`/`ask`/`deny` counts as `ask`; writing the agent's own configuration (`.claude/`, `.mcp.json`, anything under `.git/`, `.husky/`) counts as "outside the workspace", because a Steward could plant hooks or tools that run outside the table on its next start. The table is a guard rail, not a sandbox (`TECHNOLOGY.md` §8).

## 4. Interface requirements

### 4.1 Solar system view (centre of the screen)

- The solar system is the main view. The user can **drag** to pan/orbit, **scroll** to zoom, and **click** on events, agents, projects and bodies. Clicking a planet or moon selects its project (and Waykeeper); clicking an asteroid selects its task (and Steward); clicking a satellite selects that agent.
- The user can **zoom in on a planet** and see its structure as it is in our real solar system (appearance, rings, major moons, and internal layers where relevant).
- The **asteroid belt** is displayed and navigable, as the home of standalone tasks.
- When a body (planet, moon or asteroid) has work on it — i.e. a Waykeeper or a Steward is working there — it is shown with a **satellite orbiting it and scanning it** from time to time.
- On a planet where a Waykeeper has Stewards working, the Stewards are shown as **smaller satellites doing work**: some gathering minerals, some transporting them to the Waykeeper, some as robots on the surface building things (if the planet has a surface), and so on. The visual activity should reflect what the agent is actually doing.
- Moons hosting a **sub-project** read as part of their planet's project; moons hosting an **independent project** are visibly their own project (§3.2).
- Work that moves body (§3.4) is shown as its satellite **flying** to the new body. Completed work shows the satellite landing and the body marked colonised (decision 4).
- A body with an open question for the user carries a visible **beacon**.

### 4.2 Side panel

- A **chat** with the Harmonizer by default; when the user selects a Waykeeper (by clicking its planet/moon or its satellite) the chat is replaced by a conversation with that Waykeeper. The Harmonizer is always one click away (deselect, or click Earth).
- Selecting a **Steward** shows a read-only view: status, current activity, its work and thought process (transcript), and its open question if any. A message box appears **only** while the Steward has an open clarification question for the user (§2.4). Stop/pause actions remain available.
- For the Harmonizer and for Waykeepers, a **"managed agents" section** listing the agents they directly manage, with their statuses (asteroid Stewards appear under the Harmonizer).
- A **question inbox**: every open question in the system, with its kind, who is currently holding it, and the context needed to answer it (origin agent, task, body, last events); answer inline.
- The user can see each agent's **status**, its **cost so far**, and **respond to its queries** directly from the panel.
- **Control actions** on any task, project or agent: stop/cancel, pause/resume, edit description or priority, close/archive now, pin (keep visible), reopen (decision 11b). These are direct panel actions — instant, no LLM in the loop — and the affected supervisors are informed so they adjust.
- A **history view** of archived work and past questions.
- The panel must work with the 3D scene hidden ("list mode").

### 4.3 Requests the user must be able to make

- Ask for the status of anything: the whole system, a project, a task or an agent.
- Ask for a new task to be done (standalone, or added to an existing project).
- Start a new project.
- Answer a question raised by any agent, either through its supervisor, from the inbox, or (for a clarification question only) directly to the Steward.
- Approve, edit or reject a proposal or a task plan; confirm or decline a promotion.
- Stop, cancel, pause or resume a task, project or agent; edit a task's description or priority.
- Close a project (§2.7); archive early, pin, or reopen finished work.

The same control actions are available conversationally through the Harmonizer, which uses the same underlying tools.

### 4.4 Task and project states

Agent process states are defined in `TECHNOLOGY.md`. Tasks and projects have their own states, derived from their agents and open questions:

`proposed → approved → in progress → blocked on user → (in progress …) → awaiting closure → completed → archived`, plus `failed`, `paused`, `moved` and `interrupted` (after a restart, until resumed).

"Blocked on user" (an open question or permission for the user) is the most prominent state everywhere: satellite colour, beacon, inbox and notifications.

### 4.5 Notifications

The user is notified — on the desktop first, by push on the phone later — when a question or permission is opened for them, when a task or project is finished or fails, when work is interrupted by a restart, and when a project-sized request is refused for lack of space.

### 4.6 Setup and settings

On first run the application checks that the Claude Code runtime is installed and logged in (subscription login; decision 17) and guides the user through: the projects root folder, the default permission policy (§3.6), the retention period (decision 4), hard caps on agents (wall-clock, tool calls, concurrent agents; decision 18), and the rendering quality tier. Failures such as "runtime not installed / not logged in" are shown as a fixable message, not as a crash.

## 5. Non-functional requirements

- **Local first.** Agents run on the user's computer; the application runs there too.
- **Remote access (future).** The user wants to check on the system from a mobile device while the computer is running and reachable over the internet. The architecture must not prevent this (see `TECHNOLOGY.md`).
- **Non-blocking supervision.** Status reads must never interrupt a working agent.
- **Resilience (decision 8).** Restarting the application (or the computer) must not lose the map of projects, tasks, bodies and agents, **and running work is resumed automatically**: on shutdown every agent is interrupted gracefully and its session recorded; on startup every interrupted agent is respawned from its saved session, any message sent to it that it never received is delivered as its first message (its open questions are cancelled with the interruption and asked again by the resumed agent, decision 21), and the Harmonizer reports "recovered: N agents resumed, M need attention". Agents whose runtime cannot resume are shown as `interrupted` with a resume action.
- **Cost safety.** Hard caps (per-agent wall-clock and tool calls, global concurrent agents, Stewards per Waykeeper, spawns per hour) exist from the first runnable version; dollar budgets per project come later (decision 18).

## 6. Glossary

| Term | Meaning |
|---|---|
| Harmonizer | The single top-level agent the user talks to; commander of everything; direct supervisor of asteroid Stewards. |
| Waykeeper | Project coordinator agent; one per project (planet, moon or sub-project moon). |
| Steward | Task worker agent; one per task; works in its own worktree; not a conversation partner. |
| Body | A planet, moon or asteroid that hosts a project or task. |
| Headquarters | Earth; home of the Harmonizer. |
| Workspace | The folder/repository a project's Stewards work in. |
| Satellite | Visual representation of an agent working on a body. |
| Question | A tracked request for input from an agent; kind = clarification or permission. |
| Escalation | A question travelling up the hierarchy until someone can answer it. |
| Proposal | The Harmonizer's sizing/body/workspace suggestion awaiting the user's approval. |

## 7. Decisions

### 7.1 Resolved 2026-09-30 (from the v0.1 open questions)

| # | Question | Decision |
|---|---|---|
| 1 | Body capacity | **Unlimited asteroids, finite planets.** Asteroids are generated procedurally as needed; planets and moons are reused once their project is archived. Planets are a hard cap: when every planet is occupied and the user starts a new planet-sized project, the Harmonizer states that there is no more space for a new project and does not start it. The user may then finish or archive an existing project, or downsize the request (a moon of a related planet, or asteroids). The request stays parked meanwhile (decision 16). |
| 2 | Promotion of grown work (asteroid → moon → planet) | **Allowed. The Harmonizer proposes, the user confirms.** A Waykeeper may trigger the proposal by escalation. History is kept so the old body shows where the work moved (for the retention period; decision 15). |
| 3 | Harmonizer autonomy | **Always confirm work requests.** Every *work* request shows the proposed size, body and workspace and waits for the user's approval before any agent is spawned. Conversational requests are exempt, and a Waykeeper's task plan is confirmed once as a whole (§3.3). |
| 4 | Retention of finished work | **Stay visible, then archive.** A finished body shows a "completed" state (satellite lands, body marked colonised) for a configurable period, then moves to a history view and the body is freed. |
| 5 | Day-one runtimes | **Claude Code only** (also the runtime for the Harmonizer and Waykeepers). The agent communication layer must stay separated and generic enough that adding other runtimes (Codex, Gemini CLI, arbitrary CLIs) later is easy. |

### 7.2 Resolved 2026-09-30 (from the product/architecture review)

| # | Question | Decision |
|---|---|---|
| 6 | Supervisor of asteroid Stewards | **The Harmonizer directly.** Asteroid Stewards appear in its managed-agents list; their questions go Steward → Harmonizer → user; the Harmonizer proposes promotion when a task outgrows its asteroid. Routing uses each agent's supervisor, never "the Waykeeper" by name. |
| 7 | Steward autonomy / permissions | **Per-project policy table** (§3.6): auto-approve reads and edits inside the workspace; ask for destructive, out-of-workspace, network and push actions. Permission questions are a distinct kind, resolved by policy or the user only. |
| 8 | Restart | **Stop, then auto-resume** (§5). |
| 9 | Location of project tasks | **On the project's body**, not in the belt. Only standalone tasks are asteroids. A task moved into a project has its satellite fly to the planet's orbit. |
| 10 | Moons | **Two occupants**: sub-projects of the planet's project (shown as part of it) and independent small projects (prefer Waykeeper-less planets, any free moon otherwise; shown as their own project). |
| 11 | Completion | **Waykeeper closes tasks; the user closes projects.** The Waykeeper decides when a Steward is done (or just waiting for input); when the project seems finished it asks the Harmonizer to ask the user whether anything else is needed; only the user closes the project and its Waykeeper. |
| 11b | Control | **Panel actions, Harmonizer aware.** Stop/cancel, pause/resume, edit, archive now, pin and reopen are direct panel actions recorded as events so supervisors adjust; the Harmonizer can do the same conversationally. Pause is a real agent state. |
| 12 | Supervisors answering questions | **Allowed when answerable from context, always logged** and visible read-only to the user; never for permission-kind questions. |
| 13 | Direct chat | **Harmonizer and Waykeepers only.** Stewards have a read-only view; the user writes to a Steward only to answer its open clarification question. |
| 14 | Parallel Stewards in one repository | **Git worktree per Steward**; the Waykeeper merges on task closure; unresolvable conflicts become questions. |
| 15 | Promotion markers | **Marked for the retention period, then freed**; the history view keeps the link. |
| 16 | Rejected / refused proposals | **Draft stays; parked if no space.** |
| 17 | Billing | **Subscription login, no `--bare` by default.** Stewards run as normal Claude Code sessions with the repository's context; `--bare` is opt-in per spawn. |
| 18 | Cost safety | **Hard caps from the first runnable version**, dollar budgets later. |
| 19 | Phase order | **A minimal side panel is delivered right after the hierarchy**, before the 3D scene. |
| 20 | Renderer | **WebGL only for v1** (see `TECHNOLOGY.md` §2.1). |
| 21 | Resilience | **A resumed agent starts its caps afresh** (2026-10-01): the wall clock counts from the resume and the tool-call count from zero, so an agent recovered after a restart is not stopped for time it did not get to use; its cost meter keeps the session's running total. Messages the agent never received (no `message.delivered`) are delivered as its first messages after the resume, with their original ids; its open questions are cancelled with the interruption (`question.cancelled`) and the resumed agent asks them again (P1-33, P1-34, refined 2026-10-01). |
| 22 | Permission policy | **Per-category override, fail closed** (2026-10-01, P1-30): a project's policy replaces the global default category by category (presets like `trusting` rely on loosening); unknown or invalid values and an unreadable policy are `ask`; agent configuration paths count as outside the workspace (§3.6). Whether the global default should instead be a floor is an open question (§8). |
| 23 | Stops | **A stop always wins** (2026-10-01, P1-32): a stop the user (or a cap) asked for ends the agent as `stopped` (or `failed(cap)`) even when a server shutdown or crash overtakes it; such an agent is never resumed automatically. |

## 8. Open questions

| Date | Question | Owner |
|---|---|---|
| 2026-09-30 | Which authentication does the TypeScript Agent SDK support for the Harmonizer/Waykeeper brains under a subscription login (decision 17)? If only an API key, the brains bill the key while Stewards use the subscription. | **Answered 2026-09-30 (P1-08):** the SDK spawns its bundled Claude Code and uses the same login as the `claude` binary; in-process brains with custom tools run under the subscription, no API key. `--bare` is the exception: it needs an API key, so the opt-in is refused when none is configured. See `docs/tasks/notes/P1-08-sdk-spike.md`. |
| 2026-09-30 | Does the Claude SDK path report cost per session reliably enough for the cost meter, or do caps count only time and tool calls in v1? | **Answered 2026-09-30 (P1-08):** every turn's result carries a cumulative `total_cost_usd` (an estimate, notional under a subscription) plus token usage; the cost meter shows it, caps stay wall-clock + tool calls (decision 18), Phase 8 budgets use the estimate. |
| 2026-09-30 | When a Waykeeper cannot merge a Steward's branch, does the user resolve the conflict by hand in the repo, or does the Waykeeper spawn a "merge" Steward? | Decide in Phase 2 |
| 2026-10-01 | Should the global permission default be a floor a project cannot loosen (merge = strictest of the two), rather than a per-category override (decision 22)? | Decide before Phase 7 (remote clients); conservative meanwhile: only the panel's presets loosen. |
| 2026-10-01 | A long silent tool (a build, a test run) looks `stalled` after the runtime's silence threshold. Per-tool thresholds, or a heartbeat while a tool runs? | Decide before Phase 4 makes "stalled" visible in the scene. |
| 2026-10-01 | Where may an agent be spawned? Today the ops console accepts any directory (dev tool). From Phase 2, require a resolved path inside a project workspace, anything else only with `GALACTIC_DEV`? | Decide with P2-01 (projects and worktrees). |
