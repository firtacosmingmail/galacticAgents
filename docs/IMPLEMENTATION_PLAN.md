# GalacticAgents — Implementation Plan

**Status:** Proposal v0.3 (aligned with SPEC.md decisions 1–20 and TECHNOLOGY.md v0.3; Phase 9 — deliverables, decisions 118–134 — added 2026-10-07) · **Date:** 2026-09-30

Companion to `SPEC.md` (what) and `TECHNOLOGY.md` (with what). The plan is ordered so that **the agent runtime is proven before the 3D scene is built**: the space interface is the product's soul, but if agents cannot be spawned, observed and answered reliably, the scene has nothing true to show. Following decision 19, a **minimal usable side panel (Phase 2.5)** now comes before the scene, so the product is usable daily long before it is beautiful.

Each phase ends with something you can run. Estimates assume one developer working part-time; treat them as relative sizes, not promises. Schema and event names below are those of `packages/protocol` (see `TECHNOLOGY.md` §7).

---

## Phase 0 — Foundations (≈ 1 week)

**Goal:** a small monorepo where server and web share types and talk over a WebSocket with a resumable protocol.

- pnpm workspace with **three** packages: `apps/server`, `apps/web`, `packages/protocol` (adapters and brains live inside the server for now; `TECHNOLOGY.md` §7).
- `packages/protocol`: zod schemas for the domain model and the event model, plus the `AgentAdapter` and `DomainCommands` interfaces.
  - Domain: `Body{id, kind: planet|moon|asteroid, parentId?, name, host?: {kind: project|task, id}}`, `Project{id, name, workspace, repoPath?, parentProjectId?, bodyId, state}`, `Task{id, projectId?, bodyId, description, priority, worktreePath?, branch?, blockedBy[], state}`, `Agent{id, role: harmonizer|waykeeper|steward, runtime, sessionRef, supervisorId, bodyId, caps}`, `Proposal{id, requestText, kind, proposedBody, workspace, rationale, state: pending|approved|edited|rejected|parked}`, `Question{id, kind: clarification|permission, originAgentId, holder: {type: agent|user, id?}, status, context, answeredBy?, answer?}`, `StatusRecord`, `PermissionPolicy`.
  - Events: the normalised `agent.*` events (including `stalled`, `paused`, `resumed`), `question.*`, `proposal.*`, `body.assigned / body.moved / body.freed`, `project.*`, `task.*`, `control.*` (panel actions).
- Server: Fastify + `ws`, SQLite via `better-sqlite3` in WAL mode with a migrations folder, and the **one write rule** (domain mutation + event insert in one transaction, event ID = rowid, publish after commit; `TECHNOLOGY.md` §6.1). Two streams from the start: `events` and `transcript_chunks`.
- **WebSocket protocol as it will stay:** `hello{token, lastEventId?}` as the first frame → `snapshot` or `events since` → ordered `{seq, event}` stream (`TECHNOLOGY.md` §6.3). Bearer token, `Host` allow-list and `Origin` check on upgrade.
- Web: Vite + React 19 + TypeScript, a bare page that connects, authenticates, receives the snapshot and prints events; client state derived from the stream.
- Tooling: ESLint, Prettier, Vitest, a `dev` script that starts both.

**Exit criteria:** `pnpm dev` starts server + web; a fake event emitted on the server appears in the browser; killing and restarting the web page resumes from `lastEventId` with no gaps or duplicates (tested).

---

## Phase 1 — Agent runtime and adapters (≈ 2–3 weeks)

**Goal:** spawn, observe, pause, answer and stop real agents from a plain web page. No 3D yet.

- Process supervisor: spawn/kill with process-group handling, stdio capture, crash detection, restart policy, per-agent working directory, **graceful stop** (interrupt, wait for the turn to end, then terminate), and a persisted PID/session table reconciled on startup.
- **Hard caps from day one (decision 18):** per-agent wall-clock and tool-call caps (the wall clock for Stewards and free-form agents only, decision 103, P8-10), global max concurrent agents; a cap hit produces `agent.failed(reason: cap)`.
- **Adapter interface first** (decision 5): `AgentAdapter` from `packages/protocol` — `spawn(opts{cwd, prompt, tools?, systemPrompt?, gate, caps})`, `send(sessionId, message, {interrupt?})` (starts a turn now; the server's inbox is what waits for idle), `answer(questionId, answer)`, `interrupt`, `pause`, `resume`, `stop`, `resumeSession?(sessionRef)`, plus the `events` stream. The `gate` is the server's decision function for tool calls (policy table + caps); adapters never see the policy. Nothing outside `src/adapters` may import a runtime-specific module. A **fake adapter** implementing the interface is written before any real one and used by the UI, the brains and the tests.
- **`claude-sdk` adapter — the only real one on day one** (`TECHNOLOGY.md` §3.1): Claude Agent SDK (TypeScript), **subscription login, no `--bare` by default** (decision 17); `PreToolUse` hook → the spawn's `gate` → allowed actions pass, denied ones are refused with the reason, the rest become `agent.needs_input(kind: permission)`; `AskUserQuestion` → `agent.needs_input(kind: clarification)`; final `result` → `agent.finished(cost)`; `resume: sessionRef` for `resumeSession`. *Verified in P1-08* (`docs/tasks/notes/P1-08-sdk-spike.md`): SDK auth under subscription login works for in-process brains, and per-session cost is reported as a cumulative estimate (SPEC §8).
- **Deferred adapters** (not built now, but the interface must accommodate them): **ACP** for Codex / Gemini CLI / `claude-agent-acp` (must advertise `elicitation.form`; `request_permission` ≠ clarification — `TECHNOLOGY.md` §3.2), and a **PTY adapter** (`node-pty` + xterm.js) for CLIs with no machine protocol. Keep a short "how to add a runtime" doc in `src/adapters/README.md` from the start.
- **Status store** as a projection: fold events into `StatusRecord`s (states incl. `stalled` via a per-runtime silence threshold, `paused`, `interrupted`); rebuild from `events` on startup; broadcast batched diffs (≈10 Hz).
- **Secret redaction** of transcript chunks before persisting and before sending to clients.
- Plain "ops console" page: list agents, spawn one by picking a runtime + cwd + prompt, send it a message, see its status and cost-so-far, answer a `needs_input` of either kind, pause/resume, stop it.
- Adapter conformance test suite: runs against the fake adapter in CI and against the real `claude-sdk` adapter locally, exercising every event path including both question kinds, pause/resume, caps and resume-by-session. Any future adapter must pass the same suite.

**Exit criteria:** Claude Code can be spawned, asked to do a small job, interrupted with a clarification question and a permission request that you answer from the page, paused and resumed, and stopped — the status store shows the right state throughout without sending the agent any extra message; killing the server mid-task and restarting resumes the agent from its session ref; the fake adapter passes the identical test suite.

---

## Phase 2 — The hierarchy: Harmonizer, Waykeepers, Stewards (≈ 3 weeks)

**Goal:** the full Steward → Waykeeper → Harmonizer → user loop working through the ops console, with worktrees, proposals and closure.

- `src/brains`: Harmonizer and Waykeeper prompts, tool schemas and handlers against `DomainCommands` (`TECHNOLOGY.md` §5.3). **Brains are spawned through the `claude-sdk` adapter** with `tools` + `systemPrompt`, so they are ordinary `Agent` rows with statuses, cost and a `sessionRef` (§5.1).
- **Brain mailbox runtime** (§5.2): one mailbox per brain, whitelist of wake events, one turn at a time draining the mailbox into a single prompt, non-blocking `ask_user` / `escalate` / `propose` / `request_project_closure`, per-turn state seeding from the DB, periodic session reset with carried-over summary. Tested against a **scripted fake LLM** so tool contracts, question routing and wake coalescing are deterministic unit tests.
- **Requests and proposals** (decisions 3, 7, 16): conversational vs. work requests; `find_related_work` before `size_request`; `size_request` returns `{kind, rationale, suggestedName, proposedBody, workspace}`; the Harmonizer **always** presents a `Proposal` the user approves, edits inline (size, body, workspace) or rejects. Rejected/edited proposals stay as drafts; a refusal for lack of a free planet parks the proposal, lists occupied planets, and offers downsizing or early closure. A Waykeeper's `plan_tasks` is one approvable card; approved tasks spawn without further cards.
- **Body assignment** (decisions 1, 9, 10): a body catalogue seeded with the Sun, 8 planets and their major moons (Sun, Earth and the Moon reserved); asteroids generated procedurally on demand (deterministic names and orbits from a seed). Project tasks live **on the project's body** (`Task.bodyId = Project.bodyId`; they never get a body of their own, SPEC decision 25), never on asteroids. Moons: sub-project of the same planet (`parentProjectId` set, planet not closable while active) or independent project (prefer moons of Waykeeper-less planets, any free moon otherwise). `freePlanets()` / `freeMoons(planetId?)` are deterministic catalogue functions, not model judgement.
- **Workspaces and worktrees** (decisions 8, 14): `Project.workspace` (existing path or new folder under the projects-root setting); `spawn_steward` creates a git worktree + branch per task under the workspace; `merge_task` merges on closure, an unresolvable conflict becomes a clarification question. Non-git workspaces are initialised or fall back to one Steward at a time.
- **Permission policy** (decision 7): per-project `PermissionPolicy` with a global default; permission questions route to the user's inbox without entering any brain mailbox; clarification questions go to the holding supervisor first (`answer_question` allowed, logged with `answeredBy`), then up.
- **Supervision of asteroid Stewards** by the Harmonizer (decision 6); holder routing by `Agent.supervisorId` everywhere. Orphaned questions move to the next living supervisor or the user.
- **Promotion** (decisions 2, 15): `propose_promotion` / `request_promotion`; approval moves the work (`body.moved`), spawns a Waykeeper if needed, pauses a mid-task Steward until decided, and leaves the old body in `moved` state for the retention period.
- **Completion and closure** (decision 11): Steward reports done → Waykeeper `close_task` (or decides it is waiting for input) → `merge_task`; when all tasks are closed the Waykeeper calls `request_project_closure` → Harmonizer asks the user "anything else on this project?" → the user closes the project (Waykeeper stopped, transcripts kept, `completed`, retention starts). Retention (decision 4): default 7 days, then archived automatically, body freed; archive-now, pin and reopen (same body if free, otherwise a new one linked to the old) as `control.*` actions.
- **Control actions** (decision 11b): stop/cancel, pause/resume, edit description/priority, close, archive-now, pin, reopen — server commands emitting `control.*` events that wake the affected supervisors; the Harmonizer has the same tools for conversational use.
- **Conversation model** (decision 13): the user converses with the Harmonizer and Waykeepers (mailbox messages); Stewards get a read-only transcript view and accept a user message **only** as the answer to their open clarification question.
- **Persistence and resume** (decision 8): on graceful shutdown interrupt every agent and persist session refs; on startup reconcile the PID table, respawn every interrupted agent via `resumeSession`, deliver the messages it never received as its first messages (its open questions are cancelled and re-asked, decision 21), and have the Harmonizer report "recovered: N resumed, M need attention". Agents whose runtime cannot resume are `interrupted` with a resume/restart action.
- **More caps:** max Stewards per Waykeeper, max spawns per hour.

**Exit criteria:** "Start a new project: build a CLI that converts CSV to Parquet" typed to the Harmonizer results in a related-work check, a sizing proposal with a workspace you confirm, a planet or moon assignment, a Waykeeper whose task plan you approve once, several Stewards each in its own worktree, at least one clarification answered by the Waykeeper from context (visible to you) and one escalated to you, one permission request answered by you, merged branches, a closure request you accept — all visible in the ops console, and survivable across a `kill -9` of the server with automatic resume.

---

## Phase 2.5 — Minimal side panel (≈ 1–2 weeks) — *new, decision 19*

**Goal:** a daily-usable product before any 3D: the spec's panel in plain React, no scene.

- Chat with the Harmonizer by default; selecting a Waykeeper (from a list of projects) swaps the conversation; per-agent conversation history from the server.
- "Managed agents" cards for the Harmonizer (Waykeepers + asteroid Stewards) and Waykeepers (their Stewards) with live status, cost-so-far and control actions.
- Steward read-only view: status, current activity, transcript and thought process; message box only while it has an open clarification question.
- Question inbox with kind, holder, context (origin agent, task, body, last events) and inline answer; proposal cards (approve / edit / reject) and task-plan cards.
- Desktop notifications (SPEC §4.5) for question/permission opened, task/project finished or failed, work interrupted by a restart, refusal for lack of space.
- Settings page (SPEC §4.6): runtime preflight, projects root, default permission policy, retention, caps, quality tier.
- This *is* "list mode"; Phase 5 polishes it and Phase 7 makes it mobile-friendly. The ops console survives as a hidden debug view.

**Exit criteria:** everything in `SPEC.md` §4.2–4.3 that does not require the scene is doable from the panel; you can run a real project for a day without opening the ops console.

---

## Phase 3 — Solar system scene (≈ 3 weeks)

**Goal:** the spectacular map, driven by real data, with navigation and picking.

- R3F canvas on the classic **WebGL renderer** (decision 20); star field skybox; Sun with bloom.
- Planets with textures, axial tilt, rings for Saturn/Uranus, major moons on orbits; hand-tuned (non-real) spacing with a "true scale" toggle.
- Asteroid belt: instanced mesh (thousands of rocks); task-hosting asteroids get an individual mesh, label and pick target.
- Camera: orbit/pan/zoom controls, click-to-focus with smooth flight to a body, breadcrumb "back to system".
- Picking by ray vs the bodies' bounding spheres (SPEC decision 65; no mesh raycast or `three-mesh-bvh`); hover highlight; selection outline. Clicking a planet/moon selects its project and Waykeeper; an asteroid its task; a satellite its agent (SPEC §4.1).
- LOD tiers and a quality setting (high / balanced / mobile).
- Bodies bind to the domain model: hosted project/task name and state appear as an HTML label anchored to the body; independent-project moons are visually distinct from sub-project moons.

**Exit criteria:** 60 fps on your Mac at "high", ≥30 fps at "mobile" tier in Safari on the phone over the LAN; every assigned body can be clicked and shows the right project/task.

---

## Phase 4 — Living overlays: satellites, scans and workers (≈ 2 weeks)

**Goal:** the map shows *what agents are doing*, continuously, from the status store.

- One **satellite** per active Waykeeper/Steward orbiting its body; periodic scanning cone/beam animation; colour and pulse mapped to state (working / waiting_for_input / paused / stalled / idle / failed). The Harmonizer's HQ station orbits Earth.
- Steward **activity archetypes** derived from status: gathering (orbital mining animation), transporting (shuttle between Steward and Waykeeper satellite), building (surface robots — only for bodies with a surface: rocky planets, moons, asteroids; gas giants get orbital platforms instead).
- **Body transitions** (SPEC §3.4, decision 4): satellite **flies** to the new body on `body.moved` (task joins a project, promotion); satellite **lands** and the body is marked colonised on completion; "moved to …" marker on the old body during retention.
- Question indicator: a body with an open `Question` for the user gets a visible beacon; clicking it opens the question.
- Event toasts in 3D (a small flare when a task finishes) — optional, keep subtle.
- Timeline scrubber (nice-to-have): replay the `events` log to see how a project unfolded.

**Exit criteria:** switching an agent's state in a test harness changes its satellite behaviour within a second; moving a task to a project flies its satellite there; a designer or friend can tell which planets are busy without reading text.

---

## Phase 5 — Side panel polish and scene integration (≈ 1–2 weeks)

**Goal:** the Phase 2.5 panel becomes the spec's panel, wired to the scene.

- Selection in the scene drives the panel and vice versa; the Harmonizer is one click away (deselect / click Earth).
- Status views: system / project / task / agent summaries from the status store and the derived task/project states (SPEC §4.4); "blocked on user" is the loudest state everywhere.
- History view of archived work and past questions (including supervisor-answered ones).
- Keyboard and accessibility basics; the panel keeps working with the scene hidden (list mode).

**Exit criteria:** everything in `SPEC.md` §4.2 and §4.3 is doable from the panel, with and without the scene.

---

## Phase 6 — Planet zoom and structure (≈ 2 weeks)

**Goal:** zooming into a planet shows it "as it is in our solar system".

- Planet detail sub-scene: high-res textures, atmosphere shader, clouds for Earth, rings, moons in orbit around the planet, optional cutaway showing internal layers (crust/mantle/core; gas giant envelopes).
- Project view overlay: the project's tasks placed on the surface or in orbit; Stewards as surface robots or orbital drones depending on the body; sub-project moons shown as part of the project.
- Earth as headquarters: a distinct HQ station in orbit, Harmonizer "home".

**Exit criteria:** smooth transition from system scale to planet scale and back; project tasks are placed and clickable in the detail view.

---

## Phase 7 — Remote and mobile access (≈ 1–2 weeks)

**Goal:** check on the system from your phone while your computer runs the agents.

- PWA: manifest, versioned network-first service worker for the app shell (never caching API/WS responses), installable on iOS/Android.
- Tailscale Serve in front of the server; document the setup; server keeps binding to localhost; token pasted or scanned into the PWA, optionally Tailscale identity headers as the remote credential.
- Touch controls and mobile quality tier; list mode for slow connections.
- **Web Push:** VAPID key generation, push-subscription storage, server-side `web-push` sending for question/permission opened and project finished; iOS requires Home-Screen install and a user gesture to request permission — best-effort.
- Reconnect: the Phase 0 `lastEventId` resume already covers a phone that slept; answers given offline carry the question's version so a stale answer gets "already answered by …".
- Housekeeping (P7-07): the ops console's demo planets are never reused for real work and retire (`body.retired`) when their project is archived; a dev-only "Clear demo projects" archives the seeded demo work.

**Exit criteria:** from mobile data, you can open the app, see the map or the list, read every status, and answer a Steward's question or permission request.

---

## Phase 8 — Hardening, cost and polish (ongoing)

- Dollar budgets per project/task, measured against the cost the runtimes report: a warning in the Harmonizer's chat at a threshold, new Waykeepers and Stewards refused at the budget, running agents never stopped (P8-01; hard caps already exist since Phase 1).
- Log retention and `transcript_chunks` compaction (the `events` stream is kept long for resume and replay).
- Backups of the SQLite file; export/import of the map (P8-03: daily online backups with rotation and `galactic restore`; a JSON export of the event log that `galactic import` replays into a new database — `docs/BACKUP_RESTORE.md`, TECHNOLOGY §6.4).
- Crash recovery drills: kill -9 the server mid-project, reboot the machine, unplug the network.
- Tests: adapter conformance, brain tool contracts (scripted LLM), WebSocket protocol, scene smoke tests via Playwright.
- Tauri 2 desktop shell (tray icon, auto-start) if you want the "real app" feel — P8-06, `docs/DESKTOP.md`.
- ACP adapter for the second runtime (Codex / Gemini CLI), PTY adapter for arbitrary CLIs.

---

## Phase 9 — Deliverables (≈ 2–3 weeks)

**Goal:** when a project or a task has deliverables, reach them from the app: see and open files, open a folder of code in the IDE or the Finder, see and run the important commands, open an application, look at an image — on the Mac; list, view and download from the phone, and stop a run there (SPEC §4.7, decisions 118–134; TECHNOLOGY §9).

- **Domain model:** `deliverables`, `deliverable_runs` and `run_output` (migration 0014); `deliverable.*` and `run.*` events in `packages/protocol`, folded into the world (`WorldState.deliverables`, `Snapshot.deliverables?`) and covered by the conformance test; moves and promotions carry a task's deliverables; export rows and import check.
- **Where they come from:** a Steward's `declare_deliverable` tool (Claude Code Stewards; others list them in their "Done:" report), the brains' declare / remove / list tools, the project folder and detected run scripts (`package.json`, Makefile, justfile, pyproject, Cargo, Compose, deno — parsed, never executed), and the user by hand on the Mac.
- **Paths and copies:** every path checked on its real path inside the project (workspace, repository, the task's worktree), secret names refused to agents, re-checked on every read; strays from temporary folders and worktree files a merge does not carry are copied into a `deliverables/` folder inside the project's own folder (`<workspace>/deliverables/<task-slug>/`; a scratch task's in its scratch folder), kept out of git through the repository's local `.git/info/exclude`, never written by agents, never cleaned up by the app, no size limit but a free-space guard; a merge re-points the rest into the project's folder, inside the repository lock, before the worktree is removed.
- **Viewing and serving:** a viewer for text and code (highlighted), Markdown (no raw HTML, no images loaded) and images (SVG only as a picture); bytes served by deliverable id with `nosniff`, a sandboxing CSP and `attachment` outside the preview types; one-time download tickets.
- **Opening on the Mac:** `open`, `open -R`, `open -b <IDE bundle id>`; an IDE setting with auto-detection (WebStorm, IntelliJ IDEA, Cursor, VS Code, Zed); applications open after a confirmation tied to a fingerprint.
- **Managed runs:** a confirmed run of a command in the project's folder as a tracked process (process group, launch intent, `GALACTIC_RUN_ID` marker), live redacted output with retention, detected ports, Stop/Restart, the user's confirmation as the only gate (no permission table), concurrency and output retention as settings, stopped with the project and on shutdown, shown as stopped after a restart and never restarted by itself.
- **Panel:** the Waykeeper dock's "Chat | Status | Deliverables", the Steward view's Deliverables section, the history inspector's list, the run view; a small mark on the scene's labels (optional).
- **Remote rules:** the phone lists, views, downloads and may stop a run; opening, launching and starting runs are the Mac's alone, even with `autoApproveRemote`; adding and removing by hand and the deliverables settings are local unless `autoApproveRemote`.

**Exit criteria:** on the Mac, a Steward on real Claude finishes a task that builds a small web app and a screenshot: the screenshot shows in the Steward view and, after the Waykeeper's merge, still shows from the project's Deliverables (re-pointed into the project's folder, or copied into the project's own `deliverables/` folder — `~/GalacticProjects/<project>/deliverables/<task>/`, excluded from git locally — which Reveal in Finder opens); the project folder opens in WebStorm and in the Finder; `pnpm dev` from `package.json` runs from the panel after a confirmation, its output streams, its port opens in the browser, and Stop ends it and everything it started; closing the project stops a run left running; after a server restart the run shows stopped and nothing is left of it. From the phone the same deliverables are listed, the screenshot and a text file are viewed and a file downloaded, and the running command is stopped (after a confirmation), while every open, launch and start of a run is refused. An agent's attempt to declare a path outside the project (a private key, a symlink out of the worktree) is refused.

---

## High-level corner cases and risks

Grouped by area. Each has a suggested handling so it can become a ticket later. Items marked *Decided* reference SPEC.md §7.

### Agent lifecycle

1. **Agent crashes mid-task.** Detect exit code, mark `failed`, keep the partial transcript, let the supervisor decide: retry (resume via `sessionRef` where the runtime supports it), reassign, or escalate.
2. **Agent hangs (no output for a long time).** Per-runtime "silence threshold"; surface as `stalled` (a real state and event) rather than killing automatically; offer interrupt from the UI. Beware of long legitimate operations (test suites, builds).
3. **Server restarts while agents run.** *Decided (8): stop, then auto-resume.* `--resume` / `resumeSession` starts a **new** process from a saved session — nothing can re-attach to a live one — so the design is: graceful shutdown interrupts every agent and persists its `sessionRef`; startup reconciles the PID table, respawns interrupted agents, delivers the messages they never received (open questions are re-asked), and the Harmonizer reports what was recovered. PTY agents cannot resume and are shown as `interrupted` with a restart action.
4. **Zombie processes / orphaned subprocesses** (agents spawn their own shells, dev servers, watchers). Kill by process group; on startup, reconcile the persisted PID table against the live process list.
5. **Runaway agent** (infinite loop, tool-call storm, spiralling cost). *Decided (18):* hard caps per agent on wall-clock and tool calls, global concurrency, Stewards per Waykeeper and spawns per hour, enforced by the supervisor from Phase 1; the supervising brain gets a `failed(reason: cap)` event and reports it. Dollar budgets in Phase 8.
6. **Two agents editing the same repository.** *Decided (14): git worktree per Steward*, branch per task, the Waykeeper merges on closure; an unresolvable conflict becomes a clarification question (open: user resolves by hand vs. a merge Steward — SPEC §8). Non-git workspaces: initialise a repo or serialise Stewards.
7. **Runtime not installed / not logged in / API key missing.** Preflight at startup (SPEC §4.6) and detect at spawn; produce a human-readable `failed` reason and let the user fix it without restarting the app.
8. **Runtime protocol version drift** (an SDK or CLI update changes an event). Pin versions, feature-detect from the init message, and keep the conformance suite running against the installed CLI.
8b. **Graceful vs. hard stop.** SIGTERM alone leaves an in-progress turn and any pending permission unanswered; always `interrupt()` and wait for the turn to end, then terminate, with a timeout before a hard kill.

### Escalation and conversation

9. **Question answered in two places** (user answers the Steward's clarification directly while the Harmonizer is also asking). The `Question` object has one status and a version; the first answer wins, the second UI is told "already answered by …"; every holder is notified and stops waiting.
10. **User answers a question after the agent gave up / timed out / was stopped.** Store the answer on the `Question`; when the agent is resumed, feed the answer as the first message.
11. **Question the user cannot understand out of context.** Every question carries `context` (origin agent, task, body, last few events); the inbox card can open the agent's read-only view.
12. **Chain of escalation is broken** (Waykeeper died before relaying). The server, not the agents, owns questions: an orphaned question automatically moves to the next living supervisor or to the user.
13. **Supervisor-answered questions drift from what the user wanted.** *Decided (12):* supervisors may answer clarification questions from context, but every such answer is logged with `answeredBy` and shown read-only in the inbox/history so the user can override. (The former risk of the user changing a task's scope by chatting with a Steward no longer exists: decision 13 removes direct Steward chat.)
14. **Permission requests vs. clarification questions.** *Decided (7):* both are `Question`s with a `kind`; permission questions are resolved by the per-project policy table or the user only, never by a brain, and never enter a brain's mailbox; clarification questions may be answered by supervisors. Different UI for each.
15. **The Harmonizer itself needs input to size a request.** It may ask clarifying questions before proposing; the UI treats this like any other question. `ask_user` is non-blocking: the turn ends and the answer arrives as a later wake-up.
15b. **Concurrent wake-ups and re-entrancy in the brains.** One mailbox per brain, one turn at a time, drained into a single prompt; a brain's own tool side effects are never delivered to it mid-turn; only whitelisted events wake a brain (never `agent.output`).
15d. **Questions that went stale** (the user talked to the agent directly meanwhile). *Decided (135, P9-14):* every question card can be dismissed (a clarification withdrawn and its agent told, a permission refused); the user's direct message to an agent withdraws that agent's own open clarifications as superseded — never a permission, a question opened for the user alone, or the Harmonizer's.
15c. **Brain context growth.** Each turn is seeded from the DB; sessions are reset periodically with a carried-over summary so compaction never silently erases the project state.

### Domain and sizing

16. **Misjudged size** (an "asteroid" task turns out to be a project). *Decided (2, 6, 9, 15):* promotion exists; the Harmonizer (which supervises asteroid Stewards) proposes, the user confirms; create a moon/planet, move the task (its satellite flies there), spawn a Waykeeper; the old body shows "moved to Europa" for the retention period, then frees; the history view keeps the link. A promotion proposed while the Steward is mid-task pauses the Steward until the decision, then resumes or hands over.
17. **Bodies run out.** *Decided (1, 16):* asteroids are procedural and unlimited; planets/moons are reused after archival; planets are a hard cap. When every planet is occupied and a new planet-sized project is requested, the Harmonizer states that there is no more space and does not create it. The refusal must be useful: show which planets are occupied and by what, offer to downsize (moon of a related planet, or asteroids), offer to close a completed project early; the proposal stays **parked** until a planet frees or the user changes it. `freePlanets()` / `freeMoons()` are deterministic catalogue functions.
17b. **Moon capacity and semantics.** *Decided (10):* a moon hosts either a sub-project of its planet's project (shown as part of it; the planet cannot close while it is active; no free moon → the sub-project stays a task on the planet) or an independent small project (prefer Waykeeper-less planets, any free moon otherwise; visibly its own project; unaffected by its planet). The Sun, Earth and Earth's Moon are never assigned.
18. **Duplicate or overlapping requests** ("fix login bug" twice). `find_related_work` runs before sizing; the Harmonizer proposes adding to the existing project/task or asks "is this the same as …?".
19. **Finished work.** *Decided (4, 11):* the Waykeeper closes tasks; the user closes projects after the Harmonizer relays "anything else?"; completed bodies stay visible for the retention period, then archive automatically. A task "finished" but later reopened (bug found) un-archives to the same body if it is still free, otherwise gets a new one linked to the old.
19b. **Confirmation fatigue.** *Decided (3):* conversational requests need no confirmation; work requests get one card; a Waykeeper's task plan is one card, not one per Steward. Approval is one click; size/body/workspace are editable inline; several proposals can be batched into one card.
19c. **Rejected proposals.** *Decided (16):* rejected or edited proposals stay as drafts in the chat; nothing is spawned until approval.
20. **Cross-project dependencies** (Task on Mars depends on a task on Europa). Keep it out of v1; `Task.blockedBy` exists for intra-project ordering and can carry cross-project links later (a nullable column is a one-line migration — do not pre-add speculative fields; put them in a `meta` JSON column until real).

### Interface and rendering

21. **Performance with many active agents.** Instancing for asteroids and satellites, LOD, throttled label updates, and a hard cap on simultaneous animations; status updates are batched (≈10 Hz) rather than pushed per token.
22. **Renderer availability.** *Decided (20):* WebGL only in v1, so there is no fallback matrix to test; the "mobile" quality tier runs on WebGL. Revisit WebGPU only when a feature needs it.
23. **Very small screens.** 3D is optional on phones: list mode (the Phase 2.5 panel) is a first-class view, not an error page.
24. **Selection ambiguity** (moon behind a planet, cluster of asteroids). Raycast picks nearest; offer a "what's here" popover listing all bodies under the pointer; keyboard/next-body cycling.
25. **Real-scale expectations.** Users may expect true distances; provide the toggle, but default to a readable layout and say so in the UI.
26. **Time and orbits.** Orbital motion is decorative; do not tie it to real time in ways that hide a busy planet behind the Sun. Camera focus must always be able to reach any body. Satellite flights between bodies (moves, promotions) must complete even if the camera is elsewhere.

### Remote access and security

27. **Exposing a process-spawning server.** Localhost binding + token even locally (first WS frame), `Host` allow-list and `Origin` check, Tailscale (or Cloudflare Access) for remote; never a public port; permission prompts from agents are never auto-approved for remote clients unless the user opts in.
28. **Phone sleeps / connection drops.** WebSocket resume from `lastEventId` (Phase 0 protocol); questions answered offline are queued with the question's version and reconciled (answer may already be given elsewhere — see 9).
29. **Clock skew and ordering.** Event IDs are server-assigned and monotonic (the `events` rowid); clients never trust their own timestamps for ordering.
30. **Secrets in transcripts.** Agents may print API keys or tokens; redact known patterns before persisting and before sending to the UI — from Phase 1, since transcripts are persisted from Phase 1.

### Cost and observability

31. **Supervisor agents that never sleep.** Mailbox-driven turns only; an explicit idle state in the Harmonizer and Waykeeper loops and a visible "thinking" cost meter per brain (they are ordinary agents in the status store).
32. **Status summaries that lie.** LLM-written one-liners can drift from reality; always keep the raw last event next to the summary and let the user open the full transcript.
33. **Debuggability.** Every decision (sizing, assignment, spawn, stop, escalation, supervisor answer, control action) is an event with a rationale in the `events` stream; that stream — separate from transcript chunks and retained long — is enough to reconstruct any state.
34. **Billing surprises.** *Decided (17):* subscription login for Stewards; whether the in-process brains can use it is an open question (SPEC §8) — if they need an API key, show brain cost separately.

### Deliverables (Phase 9)

35. **An agent points a deliverable at a secret or outside the project** (a key file, the home folder, a symlink out of the worktree). *Decided (121):* real-path checks against the project's roots on declaration and on every read; secret names refused to agents; a descriptor checked against the real path, so a link swapped after the check is caught.
36. **The worktree goes away under a deliverable.** *Decided (123):* the merge hook runs inside the repository lock before `git worktree remove`: re-point what the merge carried, copy what it did not (ignored build output), mark the rest missing with the reason; the merge is never held up.
37. **A file served to the browser runs as code** (an HTML report, an SVG with a script, a Markdown file with raw HTML). *Decided (126):* text is always `text/plain`, SVG only in `<img>`, Markdown without raw HTML; `nosniff` and a sandboxing CSP on every file response; blobs only with allow-listed image types.
38. **The command the user confirmed is not the one that runs** (an agent edits a declared command, or `package.json` changes, between the dialog and the click). *Decided (129):* the run carries the deliverable's `version`; a changed row is refused as stale and the dialog shows the new command.
39. **Runs outlive their work or the server** (a dev server keeps a port after the project closed, or after a crash). *Decided (130):* runs are stopped with their project or task and on shutdown; after a crash their PID rows and launch intents are reconciled by the `GALACTIC_RUN_ID` marker and the launch id; never restarted by themselves.
40. **A run's processes mistaken for a Steward's, or the reverse.** *Decided (130, 76):* runs carry `GALACTIC_RUN_ID` and never `GALACTIC_AGENT_ID`; Steward attribution needs the agent marker; runs stop only their own group and marker carriers.
41. **Opening something runs code** (an app bundle, a `.command` file, a `.pkg`). *Decided (128):* those are applications, opened only after a confirmation tied to a fingerprint, asked again when it changes; Open refuses them.
42. **The phone as a remote control for the Mac's programs.** *Decided (131):* open, launch, start and restart routes refuse remote clients even with `autoApproveRemote`; viewing, downloads (one-time tickets, never the token in an address) and stopping a run stay open.
43. **Copies fill the disk.** *Decided (122):* no size limit on files (Cosmin): a copy that would leave less than the backups' free-space reserve is refused with how much it needs and how much is free; the settings page shows each project's `deliverables/` size; the folder is the user's and is never cleaned up by the app.
44. **Detected scripts are noise** (a project with forty npm scripts, a Makefile of internal targets). *Decided (119):* the common scripts first, at most 50 listed, removal by hand remembered across scans.

---

## Suggested first sprint

1. Phase 0 in full, including the resumable WebSocket protocol and the one-transaction write rule.
2. Phase 1: the `AgentAdapter` interface and fake adapter first, then the `claude-sdk` adapter with subscription login, both question kinds, pause/resume, caps and session resume; conformance suite passing on both.
3. The ops console spawning one Steward in a worktree, asking it a question, answering it, pausing it, stopping it, and recovering it after a server restart.

Once that loop feels solid, the rest of the plan is about hierarchy, a usable panel, then scale and beauty — in that order.
