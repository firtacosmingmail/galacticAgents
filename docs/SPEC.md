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

A Steward handles exactly one task, in its own git worktree of the project's workspace (§3.5). When a Steward needs input it announces its **supervisor**: its Waykeeper for a project task, or the Harmonizer for an asteroid task. When it stops (its turn ends) it reports to its supervisor with a final message ("Done: …" or "Not done: …", decision 39); the supervisor decides whether the task is closed, or gives the Steward what it is waiting for.

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

Earth is reserved: it is the headquarters (the Harmonizer's home) and is never assigned work. The Sun (a body of its own kind, `star`) and Earth's Moon are likewise never assigned work.

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

States are derived by the server from agents, questions and explicit commands (decision 29), with this precedence: `completed`, `archived`, `moved` and `proposed` change only by explicit command. **Blocked on user** applies whenever an open question held by the user exists for the item (for a project, from any of its agents or its tasks' agents); it overrides everything except those states, an explicit failure and an explicit pause (the user paused the work on purpose; resuming it brings "blocked on user" back). A user's or supervisor's explicit state (pause, stop, cancel, reopen — decision 28) holds until one of the item's agents is started or resumed again. Otherwise: an agent running → in progress; all live agents paused → paused; a Steward that ended its turn or finished → awaiting closure (its supervisor closes it or sends it back to work); the most recent Steward failed → failed; interrupted after a restart until resumed. A project is in progress while its Waykeeper works or any task is open, and awaiting closure once every task is closed — the user's "anything else?" moment.

"Blocked on user" (an open question or permission for the user) is the most prominent state everywhere: satellite colour, beacon, inbox and notifications.

### 4.5 Notifications

The user is notified — on the desktop first, by push on the phone later — when a question or permission is opened for them, when a task or project is finished or fails, when work is interrupted by a restart, and when a project-sized request is refused for lack of space.

### 4.6 Setup and settings

On first run the application checks that the Claude Code runtime is installed and logged in (subscription login; decision 17) and guides the user through: the projects root folder, the default permission policy (§3.6), the retention period (decision 4), hard caps on agents (wall-clock, tool calls, concurrent agents; decision 18), and the rendering quality tier. Failures such as "runtime not installed / not logged in" are shown as a fixable message, not as a crash.

## 5. Non-functional requirements

- **Local first.** Agents run on the user's computer; the application runs there too.
- **Remote access (future).** The user wants to check on the system from a mobile device while the computer is running and reachable over the internet. The architecture must not prevent this (see `TECHNOLOGY.md`).
- **Non-blocking supervision.** Status reads must never interrupt a working agent.
- **Resilience (decision 8).** Restarting the application (or the computer) must not lose the map of projects, tasks, bodies and agents, **and running work is resumed automatically**: on shutdown every agent is interrupted gracefully and its session recorded; on startup every interrupted agent is resumed from its saved session, supervisors before their Stewards (decision 44). A Steward gets any message it never received before anything new; a brain (the Harmonizer, a Waykeeper) comes back through its runner, and its first turn folds in what it had not consumed, including those messages. Questions an agent asked from inside its session are cancelled with the interruption and asked again by the resumed agent (decision 21); questions a brain asked through a tool stay open (decision 45). The Harmonizer reports "recovered: N agents resumed, M need attention" (decision 46). A brain whose session cannot be resumed gets a fresh session seeded from the database; a Steward whose session cannot be resumed is shown as `interrupted` with a resume action.
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
| 24 | Where agents run | **The hierarchy places them** (2026-10-01, P2-01): an agent of a project runs in its task's worktree or, without one, in the project's workspace, on the task's or project's body and under the project's permission policy; it cannot be given another directory. Only agents outside any project name their working directory — the Harmonizer, and the Steward of a standalone task (a related project's workspace or a scratch folder, §3.5). The ops console's free-form spawn form stays a development tool until P2-18 replaces it. |
| 25 | Body catalogue | **Seeded, deterministic, room to grow** (2026-10-01, P2-02): the catalogue is the Sun (a `star`), the 8 planets and 22 major moons; the Sun, Earth and the Moon are reserved. A new planet project gets the first free planet (from the Sun outwards) that still has a free moon, so it can later take a sub-project; Mercury and Venus come last. An independent moon project takes the first free moon of a planet without a running Waykeeper, else any free moon; a sub-project takes a free moon of its parent's planet, or stays a task on it (§3.2). Asteroids are generated on demand (`(n) Name`, seeded orbits) and never reused. A body whose work moved away shows "moved to …" and is neither free nor assignable until the retention sweep (or an explicit free) clears it. Project tasks never get a body of their own: they live on the project's body (decision 9). |
| 26 | Question routing | **Nearest living supervisor, everyone told** (2026-10-01, P2-03): a clarification is held by the asking agent's nearest *living* supervisor (Waykeeper for a project Steward, Harmonizer for an asteroid Steward or a Waykeeper), else by the user; a permission question is held by the user from the start. Escalation and orphan re-routing (a holder that finishes, fails, is stopped or interrupted) follow the same rule. When a question is answered or cancelled, every agent that ever held it is told, so no level keeps waiting. |
| 27 | Workspaces and worktrees | **Never surprise the user's repository** (2026-10-01, P2-05): a workspace is an existing folder or a new `<projects root>/<slug>` (default `~/GalacticProjects`); `/`, the home directory, the projects root itself and anything touching the server's data directory are refused. A new or empty folder gets `git init` and an empty first commit; an existing folder that is not a repository (or one without commits) is only initialised when the user agrees on the proposal card — otherwise its Stewards run one at a time without worktrees. Each Steward works in `<workspace>/.galactic/worktrees/<task-id>` on `galactic/<task-id>-<slug>` (`.galactic/` excluded through `info/exclude`, never the user's `.gitignore`). The Waykeeper merges into the base branch (the branch checked out when the workspace was prepared) in the workspace's own checkout — refused while it is dirty or on another branch; a conflict is aborted at once and becomes a clarification question with the files and both branches. |
| 28 | Control action states | **Explicit actions set the state** (2026-10-01, P2-14): pause → `paused` and the agents paused (a project's running tasks too); resume → `in progress` if an agent is live, else `approved`; stop → `paused` with the agents stopped (a stopped Steward does not finish its task — its supervisor or the user restarts it); cancel → `failed` by the user with the agents stopped (a project's unfinished tasks too; a `proposed` item is archived; refused while a sub-project is active; the body is freed by the retention archive); close also stops the item's agents (decision 11). Pause, stop and resume refuse finished work. |
| 29 | Work states | **Derived by the server, explicit wins** (2026-10-01, P2-15): task and project states are a server projection over the event log (§4.4), written as ordinary state changes so every client sees them. Finished states and explicit panel or supervisor states are never overwritten by derivation until one of the item's agents starts again; "blocked on user" keys on a question held by the user, not on any open question. |
| 30 | Merge conflicts | **The Waykeeper merges what it knows; external changes go to the user** (2026-10-01, decided by Cosmin): when a Steward's branch conflicts with the base branch only because of work the project itself merged (other tasks' branches), the Waykeeper resolves it — it has the plan and the tasks' context — by sending the task's own Steward back into its kept worktree to merge the base branch and resolve, then merging again; no dedicated merge Steward. When the conflicting changes on the base branch include commits that did not come from the project's own task branches (the user's or anyone else's commits), the Waykeeper does not guess: it asks the user, with the conflicting files, both branches and the external commits. |
| 31 | Permission routing | **The table decides first, the user only for "ask"** (2026-10-01, P2-04): a permission request is decided before any question exists, by the agent's project's current table (decision 22). `allow` runs the call and `deny` refuses it at once — both answered by the system and logged, no question. Only `ask` opens a question, held by the user from the start; no supervisor's mailbox ever sees it. A change to a project's table applies to the next tool call of agents already working there; an open permission card is **not** re-evaluated (a looser table never silently approves a card the user may be reading). A remote client (Phase 7) cannot set up auto-approvals: unless the server is configured with `autoApproveRemote`, a policy it chooses is held to the global default in every category. A moved workspace applies at once, like a changed table. |
| 32 | Placement | **Everyone where SPEC §2 puts them** (2026-10-01, P2-20): the Harmonizer lives on Earth (placing an agent is not hosting work, so Earth stays reserved), has no supervisor, task or project, and only one runs at a time (an ended one may be replaced; after a restart the resume path brings it back). A Waykeeper answers to the Harmonizer, or for a sub-project to the parent project's Waykeeper; a project Steward to its project's Waykeeper; an asteroid Steward to the Harmonizer (decision 6). Supervisors are matched by role and project, not by a fixed agent or by liveness, so a replacement Waykeeper can take Stewards over. A Steward's project is always its task's project; promotion re-parents the Steward in the same update. Moving work hands its agents over in the same commit (P2-12): a task that joins a project gives its Stewards that project and its Waykeeper; a sub-project detached from its planet gives its Waykeeper to the Harmonizer, one attached to a planet to that planet's Waykeeper; a move that would leave a Steward or Waykeeper without its prescribed supervisor is refused. One Harmonizer at a time holds across concurrent spawns and restarts: of several interrupted Harmonizers only the newest is resumed. |
| 33 | Clearing a field | **Explicit `null`, on a short list** (2026-10-01, P2-20): an update clears an optional field with `null`, allowed only for a project's `parentProjectId` (the sub-project becomes independent on its moon), `permissionPolicy` (back to the global default) and `repoPath`, and a task's `worktreePath` and `branch` (cleared after a merge or removal; `meta.merge` keeps the record). Required fields are never cleared; tasks leave projects and hosts change bodies only by moving. |
| 34 | The Harmonizer's work cards | **One card, enforced by the server** (2026-10-02, P2-08): a work request produces exactly one proposal recording what it asks for (a new project, a standalone task, a task added to a project, a promotion); the server refuses the Harmonizer's create tools until the user approves it, and never twice for one card — the rule does not depend on the model. After approval the Harmonizer carries out the card *as the user left it* (an edited size changes what is created). A standalone task works in its related project's workspace — then under the stricter of that project's table and the global default, category by category — or a new `<projects root>/scratch/<slug>` shown on the card (changeable there, and only there: the Harmonizer cannot run a Steward anywhere else). The Harmonizer starts with the server (on Claude, or the fake adapter in dev mode; `GALACTIC_HARMONIZER=off|fake|claude-sdk`), never as a second one. |
| 35 | Plan cards | **A plan is one card over proposed tasks** (2026-10-02, P2-10): a Waykeeper's plan creates its tasks `proposed` on the project's body together with the card; the user approves it as a whole (every task still proposed becomes approved) or rejects it with a reason — the draft stays until a better plan replaces it, archiving the old draft's tasks. The plan is edited through its tasks before approval; only the user decides a plan; one plan per project — after approval, discovered work is added task by task without a card. |
| 36 | Merging and closing | **Merge before close** (2026-10-02, P2-10): the Waykeeper merges a task's branch before closing it; closing with an unmerged worktree needs an explicit "close unmerged" (branch and worktree kept). Closing stops the task's idle Steward. A conflict with the project's own work sends the task's Steward back at most twice; after that — as for external commits, or when the base branch's commits cannot be told apart (decision 30) — the user is asked directly (no supervisor holds the question), with the files, both branches, the external commits and suggested answers; "send the Steward back" is then carried out whatever the conflict, and closing the task unmerged withdraws the question. A project's closure request is refused while a task is open or a Steward runs; it is recorded on the project and reported to the Harmonizer — also for a sub-project, whose Waykeeper otherwise answers to the parent's. |
| 37 | Policy writes from remote clients | **Every write is floored** (2026-10-02, P2-21): a project's permission table set or changed from a remote client — at creation, by a panel edit, or by a brain acting on a remote user's message — is held to the global default in every category unless the server is configured with `autoApproveRemote`. A write whose origin is unknown (an agent acting on its own, or on another agent's message) counts as remote. Clearing a table (back to the global default) is allowed from anywhere. |
| 38 | Proposal flow | **Approval creates the work; parking is the server's** (2026-10-02, P2-09): approving a work card creates what it asks for in the same step, as the user left the card — a project on the body the card names (another free one if that was taken; parked if none) or a task — so nothing the model does can differ from the card; the Harmonizer then only starts the agents. A card needing a new planet or moon (a new project, a standalone task resized up, a promotion — the Harmonizer's or a Waykeeper's) is parked at creation, edit or approval when none is free, listing the occupied bodies with their occupants and offering to downsize, close a completed project early, or (a sub-project) stay a task on the planet; tasks for a project, asteroids and plan cards never park. A freed body goes in the same step to the oldest waiting card, which returns to `pending` on it — the user still approves it, and a card the user parked by hand never un-parks; a card the catalogue cannot place at all stays parked without holding up the step that freed the body. Two pending cards may name the same free planet: the user chooses, and the second approval parks. The "initialise git" consent (decision 27) is the user's alone, on the card. |
| 39 | Steward reports | **A Steward reports by ending its turn** (2026-10-02, P2-11): its final message — "Done: …" (what changed, how it was checked, what is left) or "Not done: …" (what stops it) — goes to its supervisor (the Waykeeper, or the Harmonizer for an asteroid task), who decides: done (merge, then close) or in fact waiting (it gives the Steward what it needs, or asks the user and relays the answer). A turn cut short by an interrupt, pause or stop, or followed at once by more queued work, is not a report; a finished Steward reports through its result (or its last words). Stewards ask clarifications through their runtime's question tool and never ask permission in prose — the permission gate decides each tool call. |
| 40 | Promotions and moves | **The server carries out the card** (2026-10-02, P2-12): a promotion card — the Harmonizer's (an asteroid task to a moon or planet, a moon project to a planet, a standalone task into an existing project; never to a smaller or same-size body) or a Waykeeper's (its task to a sub-project moon or a planet) — is carried out by the server on the user's approval, never by a brain's tools. While it waits the task's live Stewards are paused (one the user paused stays the user's; paused again after a restart; a paused agent's wall-clock cap does not run); a rejection resumes them, an edited or parked card keeps them waiting. It parks and un-parks like any card (decision 38), and the approval itself takes the body: the new project is created on it (the card's body if still free, else the catalogue's choice; a Waykeeper's moon is a sub-project, a Harmonizer's an independent project), or the project target moves to it. Then its Waykeeper is started if none runs (one started meanwhile is adopted; with no running supervisor or a spawn cap the card waits and is retried), the task moved with its Stewards handed over in the same commit, then resumed; the card records the outcome and its owner reports it. Carried out once (an approved card left unrecorded by a crash is carried out at the next start); a failed step is recorded and reported, the Stewards resume on their old body, and a new project left empty is failed and its body freed. The history link is the new project's `promotedFrom` and the `body.moved` event. A project with sub-project moons does not move. |
| 41 | Retention clock | **From the moment the work finished; a pin suspends it** (2026-10-02, P2-13): the retention period (decision 4, a setting, default 7 days) counts from the moment a closed or cancelled project or a finished standalone task last *entered* a finished state — later edits do not move it. A pinned item is never archived; unpinning starts a full period again. An hourly job archives what is due (freeing the body, which may un-park a card — decision 38) and clears "moved to …" markers with the same period; a planet with an active sub-project is skipped until it finishes. Reopening puts the work back on its old body when free, else on the catalogue's choice for its kind, keeping the old body in its history. |
| 42 | Closure relay | **One question, answered by closing** (2026-10-02, P2-13): the Harmonizer relays a Waykeeper's closure request as one question, "Anything else on <project>?", with the Waykeeper's summary and the choices "Close <project>" / "Something else". "Close" makes the Harmonizer close the project; more work becomes a work request for it; closing from the panel withdraws the question. The user's word is checked by the server, not left to the prompt: the Harmonizer closes, archives, pins, unpins or reopens only on a question the user answered with that choice ("Anything else?" answered "Close", or a confirmation question it asks for a request made in conversation). Closing stops the Waykeeper and its Stewards (transcripts kept) and starts the retention clock. |
| 43 | Spawn caps | **The workers are capped, the brains are bounded by the hierarchy** (2026-10-02, P2-17): the concurrent-agents cap counts Stewards only — one Harmonizer and one live Waykeeper per project bound the brains, so a full house of Stewards never keeps a brain from running, and the Harmonizer is never refused by any spawn cap. A Waykeeper has at most 3 live Stewards; new agents per sliding hour are capped globally (30) and per spawning brain (20); a resumed or renewed session is not a new spawn; the window survives a restart. A refused spawn is a tool error naming the cap, the count, the limit and when it frees, which the brain reports. All configurable (`caps` in the config file, `GALACTIC_MAX_*`). |
| 44 | Brains resume as brains | **Same row, same tools, supervisors first** (2026-10-02, P2-16; refines 8 and 32): after a restart (or the panel's "Resume session") the Harmonizer and every Waykeeper come back on their own agent row through their runner — tools, system prompt and mailbox — resumed from the saved session where the runtime can, else with a fresh session seeded from the database; never as bare sessions; one Harmonizer at a time. Supervisors are resumed before their Stewards and Stewards are interrupted first, so questions find their holders running. A brain's first turn after the resume folds in what it had not consumed (the events after its last turn, minus its own effects, plus messages it never got). Every resumed session, a Steward's too, receives a short "the server restarted, continue" notice — naming each question the restart cancelled, so the agent asks it again (dev-machine run: real Claude otherwise went idle). A brain whose session cannot be resumed (no session, a refused resume, or a resumed session that ends before its first turn did: the runtime reports a lost session only when its process exits) gets a fresh session on the same row, seeded from the database, with what it was owed; a Steward whose session cannot be resumed stays `interrupted` for the user's resume action. An interrupted agent is never reopened beside the one that replaced it (one Steward per task, one Waykeeper per project), and an agent recovery is about to reopen counts as running, so a supervisor resumed first does not replace it. A Harmonizer that ends, other than by the user's stop, is replaced by a new one. |
| 45 | Questions asked through a tool survive a restart | **They belong to the brain, not its session** (2026-10-02, P2-16; refines 21): a question a brain opened through a tool (`ask_user`, `ask_closure`, `ask_confirmation`, a Waykeeper's own question) stays open through a restart or a session reset, and the resumed brain hears the answer in its mailbox; it is cancelled only when the brain ends for good. An interrupted brain also keeps such questions that it holds (a Waykeeper's own question escalated to the Harmonizer): they move on (P2-03) only if recovery cannot bring it back. When a new Harmonizer replaces one that cannot be resumed, the user questions the old one asked (`ask_user`, `ask_confirmation`) are withdrawn and the new Harmonizer is told what was asked, so it asks again if it still matters. Questions an agent asked from inside its session are still cancelled with the interruption and asked again (decision 21). |
| 46 | Recovery report | **The Harmonizer tells the user what came back** (2026-10-02, P2-16; decision 8, §5): after recovery and the Harmonizer's start, the running Harmonizer gets one line — "the server restarted — recovered: N agents resumed, M need attention", naming each one that needs attention with its state and reason — and tells the user in its chat. Interrupted agents keep the panel's resume action; the server's console prints the same counts. |
| 47 | Work carried over a restart | **Nothing the restart interrupted is lost** (2026-10-02, P2-16): a Steward report its supervisor could not receive is sent again ("sent again") when the supervisor is back, and a resumed idle Steward never reports a turn twice; a closure request nobody could relay reaches the next Harmonizer's first turn, and a stale "Anything else?" question of an ended Harmonizer is withdrawn so the new one asks again; a promotion card's waiting time counts from its approval across restarts; at start, the Stewards of every card still waiting for the user are paused (unless someone paused or resumed them by hand after the card was made). |
| 48 | Overriding a supervisor's answer | **Tell the supervisor, never the Steward** (2026-10-02, P2-18): the user overrides a clarification a supervisor answered from context (decision 12) through the inbox's Override, which messages the answering Harmonizer or Waykeeper; it passes it on to its Steward (`tell_steward`), so the user still never chats with a Steward (decision 13). The answered question stays answered — an answer is final, and the log keeps both. The Steward view offers an answer box for any open clarification of that Steward (held by the user or a supervisor — answering anywhere resolves everywhere) and its open permission card with allow / refuse only. |

## 8. Open questions

| Date | Question | Owner |
|---|---|---|
| 2026-09-30 | Which authentication does the TypeScript Agent SDK support for the Harmonizer/Waykeeper brains under a subscription login (decision 17)? If only an API key, the brains bill the key while Stewards use the subscription. | **Answered 2026-09-30 (P1-08):** the SDK spawns its bundled Claude Code and uses the same login as the `claude` binary; in-process brains with custom tools run under the subscription, no API key. `--bare` is the exception: it needs an API key, so the opt-in is refused when none is configured. See `docs/tasks/notes/P1-08-sdk-spike.md`. |
| 2026-09-30 | Does the Claude SDK path report cost per session reliably enough for the cost meter, or do caps count only time and tool calls in v1? | **Answered 2026-09-30 (P1-08):** every turn's result carries a cumulative `total_cost_usd` (an estimate, notional under a subscription) plus token usage; the cost meter shows it, caps stay wall-clock + tool calls (decision 18), Phase 8 budgets use the estimate. |
| 2026-09-30 | When a Waykeeper cannot merge a Steward's branch, does the user resolve the conflict by hand in the repo, or does the Waykeeper spawn a "merge" Steward? | **Answered 2026-10-01:** decision 30. |
| 2026-10-01 | Should the global permission default be a floor a project cannot loosen (merge = strictest of the two), rather than a per-category override (decision 22)? | Decide before Phase 7 (remote clients); conservative meanwhile: only the panel's presets loosen. |
| 2026-10-01 | A long silent tool (a build, a test run) looks `stalled` after the runtime's silence threshold. Per-tool thresholds, or a heartbeat while a tool runs? | Decide before Phase 4 makes "stalled" visible in the scene. |
| 2026-10-01 | Where may an agent be spawned? Today the ops console accepts any directory (dev tool). From Phase 2, require a resolved path inside a project workspace, anything else only with `GALACTIC_DEV`? | **Answered 2026-10-01 (P2-01):** decision 24 — the command surface derives the directory from the task and project; the console's free form stays a dev tool until P2-18. |
| 2026-10-02 | Should Steward sessions load the user's own global Claude Code settings (`~/.claude`: deny/allow rules, hooks such as a command-rewriting hook, plugins)? Today they do (decision 17: a normal Claude Code session). Then a user's stricter global rule refuses a call before GalacticAgents' permission table sees it — safe, but the user gets no card for it, only the Steward's refusal. Alternative: only the repository's `project`/`local` settings, so the table decides everything. | Cosmin — conservative meanwhile: keep loading them (the user's own rules only tighten); the real-Claude checks load `project`/`local` only (`stewardSettingSources`). |
