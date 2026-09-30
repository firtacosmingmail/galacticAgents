# GalacticAgents — Technology Recommendations

**Status:** Proposal v0.3 · **Date:** 2026-09-30 · **Client decisions:** React + React Three Fiber confirmed (Flutter set aside for the 3D client; a Flutter companion app for the side panel remains a possible later phase). Review decisions of 2026-09-30 incorporated: WebGL-only renderer for v1 (SPEC decision 20), Agent SDK adapter as the day-one Claude transport, brains run through that adapter, subscription login without `--bare` (decision 17), hard caps from Phase 1 (decision 18), simplified monorepo.

This document recommends a technology stack for the system described in `SPEC.md`, explains the reasoning, and lists the alternatives that were considered. The two constraints that shaped every choice:

1. **The agents are mixed CLIs** (Claude Code today; Codex, Gemini CLI, custom scripts later) running on the user's computer.
2. **The UI must eventually be reachable from a phone** while the computer runs the agents.

Constraint 2 rules out a "desktop app with everything inside it" design. The right shape is a **local server that owns the agents, plus a web UI that can be opened locally today and remotely later**.

The domain and event vocabulary used below is defined once, in `packages/protocol` (§7). Where this document and `IMPLEMENTATION_PLAN.md` name fields or events, they reference that package rather than restate it.

---

## 1. Architecture at a glance

```
┌──────────────────────── user's computer ────────────────────────┐
│                                                                  │
│   ┌───────────────┐  Agent SDK (TS)    ┌──────────────────┐     │
│   │  Claude Code  │◄──────────────────►│                  │     │
│   │  (Stewards)   │  claude-sdk adapter│   Mission        │     │
│   ├───────────────┤                    │   Control        │     │
│   │  Harmonizer / │  Agent SDK (TS)    │   server         │     │
│   │  Waykeepers   │◄──────────────────►│   (Node/TS)      │     │
│   │  (brains)     │  same adapter +    │                  │     │
│   ├───────────────┤  domain tools      │  • agent runtime │     │
│   │  Codex CLI    │  JSON-RPC / stdio  │  • adapters      │     │
│   │  Gemini CLI   │◄ - - - - - - - - ─►│  • brain mailbox │     │
│   │  (later, ACP) │                    │  • status store  │     │
│   ├───────────────┤  PTY / stream      │  • SQLite        │     │
│   │  other CLIs   │◄ - - - - - - - - ─►│  • WebSocket API │     │
│   │  (later)      │                    │                  │     │
│   └───────────────┘                    └────────┬─────────┘     │
│                                                 │ ws:// + https  │
│              ┌──────────────────────────────────┼─────────────┐  │
│              │  Web UI (React + React Three Fiber, WebGL)     │  │
│              │  opened in a browser / Tauri shell / PWA       │  │
│              └────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ Tailscale Serve (private HTTPS)
                        ┌──────┴──────┐
                        │  phone PWA  │
                        └─────────────┘
```

Solid arrows are v1; dashed arrows are deferred adapters behind the same `AgentAdapter` interface.

---

## 2. Recommended stack

### 2.1 Frontend: React 19 + React Three Fiber v9 + Three.js (WebGL)

**Recommendation:** React 19, [React Three Fiber v9](https://r3f.docs.pmnd.rs/tutorials/v9-migration-guide), `@react-three/drei`, `@react-three/postprocessing`, Three.js r17x with the classic **`WebGLRenderer`**, Zustand for state, Vite for tooling, TypeScript throughout.

Why this over Angular + Three.js (your daily stack): the "spectacular solar system" is the heart of this product, and the React 3D ecosystem is an order of magnitude larger. R3F gives declarative scene graphs that map naturally onto your domain (`<Planet>`, `<Satellite agent={…}>`, `<AsteroidBelt tasks={…}>`), drei provides camera controls, orbit helpers, HTML labels-in-3D, instancing helpers and loaders out of the box, and there are many open-source solar-system scenes to borrow from. Angular can host Three.js, but you would write all of that plumbing yourself, and Angular's change detection fights against a 60 fps render loop.

Rendering notes:

- **WebGL only in v1 (decision 20).** Three.js also ships a `WebGPURenderer` (with WebGL2 fallback), but it uses a different material/shader system (TSL node materials), and `@react-three/postprocessing` plus several drei helpers target the classic renderer. v1 needs nothing WebGPU offers (no compute shaders, no scene dense enough to need it), so one renderer, one quality matrix and the full helper ecosystem win. Keep hand-written GLSL to a minimum so a later move to WebGPU (GPU-driven belt simulation, say) stays feasible.
- The asteroid belt must be **instanced** (one draw call for thousands of rocks). Only the asteroids that host tasks get individual meshes/labels.
- Use `three-mesh-bvh` for fast raycasting/picking once the scene is dense.
- Level of detail (LOD) is mandatory: low-poly spheres at solar-system scale, textured spheres with normal/specular maps when zoomed, and a separate "planet detail" sub-scene for surface/cutaway views. Do not try to render surface robots at solar-system zoom.
- Scale is fake: real orbital distances are unusable on a screen. Use logarithmic or hand-tuned spacing and keep a "true scale" toggle as a fun extra.
- Postprocessing: bloom for the sun and scanning beams, selective outline for the selected body. Keep a "reduced effects" quality tier for mobile.
- Satellites are animated actors with a small state machine (orbiting / scanning / gathering / transporting / building / flying-to-new-body / landing), driven by the status store, so "work moved to Europa" and "task completed" are animations, not just label changes.

UI chrome (side panel, chat, status lists) is ordinary React (Tailwind or CSS modules), rendered outside the canvas. Only the scene is in R3F.

### 2.2 Backend: Node.js 22+ / TypeScript "Mission Control" server

**Recommendation:** Node.js (LTS) with TypeScript, Fastify for HTTP, `ws` for WebSockets, `better-sqlite3` for persistence (WAL mode), `zod` for shared schemas.

Why Node and not Rust/Python: the agent CLIs are all Node-friendly, the Claude Agent SDK is first-class in TypeScript, `node-pty` exists for wrapping arbitrary CLIs, and one language across server and UI lets you share the protocol types (`packages/protocol`). Bun is a reasonable substitute if you prefer it (`bun:sqlite`, fast startup), but `node-pty` and the SDK are better tested on Node.

Responsibilities:

- **Agent runtime**: spawn, supervise, pause, resume, restart and kill agent processes; own their stdio; enforce hard caps (§5.4).
- **Adapters** (see §3): translate each runtime's protocol into one internal event model. **The brains are agents too** and run through the same adapter (§5.1).
- **Status store**: the always-current, read-without-asking status of every agent (see §4) — a rebuildable projection of the event log, never the source of truth.
- **Domain model & persistence**: projects, tasks, bodies, workspaces/worktrees, proposals, questions, agent sessions, event log — in SQLite (§6).
- **Brain mailboxes**: the event-driven wake-up mechanism for the Harmonizer and Waykeepers (§5.2).
- **API**: WebSocket for live events with snapshot + resume (§6.3), plus a small REST surface for history. Authenticated with a single-user token (§8).

### 2.3 Desktop shell: none required at first; Tauri 2 later if desired

Because the server runs as a normal local process and the UI is a web app, the simplest v1 is `galactic start` → opens `http://localhost:4321`. If you want a "real app" with a dock icon, tray status and auto-start, wrap the *same* web UI in **Tauri 2** (small binaries, Rust core, mobile targets exist). Electron is the fallback if you ever need Node inside the shell itself, but you don't: the server is already a separate process, and Electron's size/memory cost buys nothing here.

### 2.4 Mobile / remote access: PWA over Tailscale Serve

**Recommendation:** make the web UI a PWA (installable, offline shell, push notifications) and expose the local server privately with **Tailscale Serve** (`https://<machine>.<tailnet>.ts.net`).

- Tailscale gives you a private network between your computer and phone, valid HTTPS certificates (needed for PWA, service workers, and WebSockets on iOS), and identity-based access — with **no public port**. It is the option the tunnelling comparison recommends for private dashboards ([source](https://guides.happier.dev/cloudflare-tunnel-vs-tailscale-funnel-vs-ngrok-for-claude-code-codex-opencode)).
- If you ever need access from a device that cannot run Tailscale, switch to **Cloudflare Tunnel + Cloudflare Access** (SSO in front of the tunnel). Never expose the raw server on a public port: it can start processes on your machine.
- A native mobile app is *not* needed. If it ever is, Tauri 2 can build iOS/Android from the same web UI. The phone must degrade gracefully: lower quality tier, touch controls (one-finger orbit, pinch zoom, tap select), and a "list mode" for when 3D is too heavy.
- **Push notifications on iOS** work only for a PWA installed to the Home Screen, need a user gesture to request permission, and require the server to speak Web Push (VAPID keys, `web-push` library) to Apple's/Google's push service over the public internet. That is server-side work listed in Phase 7; treat push as best-effort. The service worker must use a versioned, network-first app-shell strategy and never cache API/WebSocket responses.

---

## 3. The agent adapter layer (mixed CLIs)

This is the most important design decision for a mixed-CLI setup. **Decision (SPEC.md §7, #5):** only Claude Code is implemented on day one, but the communication layer is a runtime-agnostic `AgentAdapter` interface with a fake adapter and a conformance suite, so adding Codex, Gemini CLI or PTY-wrapped CLIs later is one new adapter folder.

A session is owned by exactly **one** transport: an adapter cannot "complement" another adapter's session with a second protocol handle. Each runtime therefore has one adapter, chosen as follows.

### 3.1 Day one: the `claude-sdk` adapter (Claude Agent SDK, TypeScript)

**Stewards, Waykeepers and the Harmonizer all run through the [Claude Agent SDK](https://code.claude.com/docs/en/headless) adapter in v1.** The Harmonizer and Waykeepers already need the SDK for their custom tools, so this is one integration rather than two, and it gives the richest control: hooks, subagent trees (`parent_tool_use_id`), structured output, cost in the final `result`, and resume by session ID (`resume: <session_id>`).

Spawn options (per SPEC §3.5–3.6 and decision 17):

- **Subscription login, not `--bare`.** Bare mode skips CLAUDE.md, hooks, skills, MCP servers and plugins — precisely the repository context a Steward needs — and does not use the subscription login. `bare` is an opt-in per spawn for reproducibility experiments only.
- `cwd` = the Steward's **git worktree** (created by the server under the project's workspace; branch named after the task).
- Permission handling via the SDK's permission callback/hook mapped to the project's **policy table**: allowed actions return immediately; everything else becomes `agent.needs_input(kind: "permission")` and blocks the tool call until the user answers.
- Clarification questions: the `AskUserQuestion` tool becomes `agent.needs_input(kind: "clarification")`.
- Graceful stop: `interrupt()` and wait for the turn to end before terminating (SIGTERM alone leaves an in-progress turn and any pending permission unanswered).

*Verify in Phase 1:* which authentication the TypeScript SDK supports under a subscription login for in-process brains, and whether cost is reported per session reliably (SPEC §8).

### 3.2 Later: the ACP adapter for other runtimes

[ACP](https://blog.marcnuri.com/agent-client-protocol-acp-introduction) is "LSP for coding agents": JSON-RPC 2.0 over stdio, introduced by Zed in August 2025, adopted by JetBrains and others, with a registry launched in January 2026. Claude Code (`claude-agent-acp`), Codex (`codex-acp`) and Gemini CLI (`--acp`) all speak it, and by early 2026 25+ agents were compatible ([source](https://codex.danielvaughan.com/2026/06/10/agent-client-protocol-microsoft-intelligent-terminal-codex-cli-multi-agent-ide-ecosystem/)). When the second runtime arrives, GalacticAgents becomes an ACP *client*, like an editor, using the official TypeScript ACP SDK:

- `session/new`, `session/prompt`, `session/update` (streamed), `session/cancel` give spawn / talk / observe / stop with one code path; `session/load` (capability `loadSession`) is the resume path.
- **`session/request_permission` is tool authorization**, not a free-form question: map it to `agent.needs_input(kind: "permission")`.
- **Clarification questions arrive via form elicitation** (`elicitation/create`) and only if the client advertises `clientCapabilities.elicitation.form` in `initialize`; without it the agent's question tool is disabled. The adapter must advertise it and handle it → `agent.needs_input(kind: "clarification")`.
- A headless server should not advertise `fs/*` or `terminal/*` client methods unless it implements them faithfully. Document the exact capability set in the adapter README and have the fake ACP agent of the conformance suite assert on it.

*Verify before building:* what `claude-agent-acp` exposes for cost, `loadSession` and spawn options.

### 3.3 Fallback: PTY adapter for anything else

For CLIs with no machine protocol, spawn them under `node-pty`, stream the terminal to the UI (xterm.js in the side panel), and derive status heuristically (output activity, exit code, prompt detection). Treat this as "observable but dumb": no structured permission requests, so questions must be detected by regex/LLM and surfaced as best-effort. A PTY agent cannot be resumed after a restart; it is shown as `interrupted` with a "restart task" action.

### 3.4 One internal event model

Every adapter emits the same normalised events (schemas in `packages/protocol`) into the server's event bus:

`agent.spawned · agent.output(text/tool/thinking) · agent.tool_call · agent.needs_input(question: {kind, text, options}) · agent.progress(summary) · agent.idle · agent.stalled · agent.paused · agent.resumed · agent.finished(result, cost) · agent.failed(error) · agent.stopped`

The `AgentAdapter` interface: `spawn(opts)`, `send(sessionId, message)` (enqueued; delivered when the agent is idle, or immediately with `interrupt: true`), `answer(questionId, answer)`, `interrupt`, `pause`, `resume`, `stop`, `resumeSession?(sessionRef)`, plus the `events` stream. `spawn(opts)` accepts `tools` and `systemPrompt` so the same adapter runs the brains.

The UI, the status store and the supervisor brains only ever see these events. Adding a new runtime means adding one adapter, nothing else — including for the brains, which never import a runtime module directly.

---

## 4. Supervision without interruption (status store)

The spec's requirement — supervisors know statuses without interrupting — is solved by **never asking the agent**. Instead:

1. Each adapter's event stream is folded into a per-agent **status record**: `state ∈ {starting, working, waiting_for_input, idle, stalled, paused, interrupted, finished, failed, stopped}`, `current_activity` (last tool call or a rolling LLM-written one-liner), `last_event_at`, `pending_question`, `progress` (task-level checklist if the agent reports one), `cost_so_far`, `caps` (used vs. limit). `stalled` is set by a per-runtime silence threshold, never by killing.
2. The status store is an in-memory **projection** of the event log, rebuildable from it on startup and pushed to the UI over WebSocket as batched diffs (≈10 Hz, never per token).
3. The Harmonizer and Waykeepers get a `get_agent_status(agent_id)` / `list_supervised_agents()` **tool** that reads the store. Reading it costs nothing to the supervised agent.
4. Task and project states (SPEC §4.4) are derived in the server from agent states and open questions — no LLM call needed for the basic status views.
5. Optional cheap summariser: every N events (or on idle), a small model turns the recent event window into a human sentence ("Refactoring auth module, 3 files edited, running tests"). This drives both the panel text and the satellite animation choice (gathering / transporting / building). The raw last event is always shown next to the summary so a lying summary is visible.

---

## 5. The Harmonizer and Waykeepers as "tool-armed" agents

Do not make the hierarchy purely prompt-based. Build the Harmonizer and Waykeepers on the Claude Agent SDK with custom tools that mutate the domain model, so the important decisions are auditable and the UI reflects them immediately.

### 5.1 Brains are agents, run through the adapter

The Harmonizer and each Waykeeper are rows in the `Agent` table (`role`, `runtime: claude-sdk`, `sessionRef`, `supervisorId`, `bodyId`) and are spawned through the **same `claude-sdk` adapter** as Stewards, with `tools` and `systemPrompt` supplied. Consequently they emit `agent.*` events, appear in the status store with real statuses and cost, have a satellite/HQ presence on their body, and are resumed after a restart like any other agent. `packages/brains` (or `apps/server/src/brains`) contains only prompts, tool schemas and tool handlers written against a `DomainCommands` interface — never SDK or runtime imports.

### 5.2 Mailbox, one turn at a time

Brains are long-lived but **event-driven, never polling**:

- Each brain has a **mailbox**. Wake-worthy events are appended to it: a user message, `question.opened / answered`, `proposal.decided`, `agent.finished / failed / stalled`, task/project control actions from the panel, a subordinate's report. Never `agent.output` or `agent.tool_call`.
- **One turn at a time per brain.** A turn drains the whole mailbox into a single prompt ("since your last turn: Steward S3 finished task T7; the user answered Q12; the user paused T9"). Events arriving during a turn wait for the next one. Two Stewards finishing together produce one turn, not two, and a brain's own tool side effects never re-enter it mid-turn.
- **Tools that need the user are non-blocking.** `ask_user`, `escalate`, `propose`, `request_project_closure` create the corresponding object and end the turn; the answer arrives later as a mailbox event. A brain's turn is therefore always short, and a restart never loses an hours-long in-flight turn.
- **The database is the brain's memory.** Each turn is seeded with the current state it needs (`list_supervised_agents()`, its project's tasks and open questions) rather than relying on an ever-growing transcript; sessions are reset periodically (e.g. on each project milestone) with a summary carried over, so context never silently compacts away "knows the status of every task".

### 5.3 Tools

| Agent | Key tools |
|---|---|
| Harmonizer | `find_related_work(request)`, `size_request → {kind, rationale, suggestedName, proposedBody, workspace}`, `propose(proposal)`, `create_project`, `create_task`, `assign_body`, `spawn_waykeeper`, `spawn_steward` (asteroid tasks; the Harmonizer is their supervisor), `propose_promotion(task\|project, toKind)`, `close_task` (asteroid tasks), `stop_agent`, `pause_agent`, `resume_agent`, `get_agent_status`, `list_supervised_agents`, `ask_user`, `answer_question` (clarification kind only), `report_status`, `freePlanets()` / `freeMoons(planetId?)` (deterministic body catalogue checks) |
| Waykeeper | `plan_tasks(plan)` (presented once for approval), `create_task`, `spawn_steward` (creates the worktree), `merge_task(taskId)`, `close_task`, `pause_agent`, `resume_agent`, `stop_agent`, `get_agent_status`, `list_supervised_agents`, `answer_question` (clarification kind only), `escalate(question)`, `request_promotion`, `request_project_closure`, `report_status` |
| Steward | Whatever the underlying runtime provides (files, shell, tests) inside its worktree; plus clarification questions and permission requests, which the adapter maps to `agent.needs_input` |

Escalation is an **event with an owner**: `needs_input` creates a `Question{id, kind: clarification|permission, originAgentId, holder: {type: agent|user, id?}, status, context, answeredBy?, answer?}`. Holder routing follows `Agent.supervisorId` generically (Harmonizer for asteroid Stewards). A **permission** question is resolved only by the policy table or the user and is routed to the user's inbox without entering any brain's mailbox; a **clarification** question may be answered by its holding supervisor from context (logged with `answeredBy`) or escalated. When the user answers it anywhere in the UI, the server marks it answered and notifies every holder, so upper levels stop waiting. An orphaned question (holder died) moves to the next living supervisor or to the user — the server, not the agents, owns questions.

### 5.4 Hard caps (decision 18)

Enforced by the process supervisor, not by prompts, from Phase 1: per-agent wall-clock and tool-call caps; global maximum of concurrent agents; per-Waykeeper maximum of Stewards; maximum spawns per hour. Hitting a cap stops the agent with a `failed(reason: cap)` event the supervisor sees and reports. Dollar budgets per project (warn / refuse) come in Phase 8.

---

## 6. Persistence, event log and API protocol

### 6.1 One write rule

Every command (a brain tool, a panel action, an adapter event fold) performs its **domain mutation and its event insert in one `better-sqlite3` transaction**; the event ID is the `events` rowid (monotonic, server-assigned); in-memory subscribers are notified **after commit**, strictly in `seq` order even when a subscriber runs a command of its own while being notified (its events are committed at once and published after the current batch). A crash can therefore never leave the domain tables and the event log disagreeing. Clients never trust their own timestamps for ordering.

### 6.2 Two streams

- `events` — domain, status, question, proposal and lifecycle events: small, ID-ordered, resumable, retained for a long time. This is the log that corner case 33 ("reconstruct any state") and the timeline scrubber replay.
- `transcript_chunks(agentId, seq, chunk)` — agent output (text, tool calls, thinking), written in batches (≈10 Hz), pruned by retention policy, redacted for known secret patterns **before** persisting and before sending to the UI.

The status store (§4) and the task/project states are projections over `events`; they are rebuilt on startup and never written back as truth.

### 6.3 WebSocket protocol (defined in Phase 0, used by every client from Phase 1)

1. Client opens the socket and sends `hello{token, lastEventId?, logId?}` as the **first frame** (browsers cannot set headers on a WebSocket upgrade). `logId` is the identity of the log its state came from.
2. Server replies with `snapshot{logId, seq, agents, bodies, projects, tasks, questions, proposals, statuses}` when `lastEventId` is absent, `logId` is not this log's (database deleted or replaced), or `lastEventId` is too old to replay; otherwise with the `events` since `lastEventId` followed by `caught_up{seq}`.
3. Thereafter a single ordered stream of `{seq, event}`; the client derives all state from it and remembers `seq` + `logId` for the next reconnect. `seq` is never reused (`AUTOINCREMENT`). Transcript chunks are a separate, subscribable stream per agent.
4. The derived state lives in memory only. A client that has no state (a fresh page load) sends no `lastEventId` and takes a snapshot; resuming from a persisted `seq` onto an empty world would replay only the tail (P0-12). Persisting the world together with its `seq` + `logId` is possible later (a phone PWA), never `seq` alone.

A phone that slept reconnects with its last `seq` and catches up instead of reloading everything; answers given offline are sent with the question's version so an "already answered by …" reply is possible.

---

## 7. Repository layout (pnpm monorepo, kept small)

```
galactic-agents/
  apps/
    server/        Fastify + ws + SQLite + agent runtime
      src/adapters/   claude-sdk/, fake/, (later) acp/, pty/
      src/brains/     Harmonizer & Waykeeper prompts, tool schemas, handlers
      src/domain/     commands, projections, status store
    web/           Vite + React + R3F (WebGL), PWA
  packages/
    protocol/      zod schemas shared by server and web: domain model, events,
                   the AgentAdapter interface, the DomainCommands interface
  docs/            SPEC.md, TECHNOLOGY.md, IMPLEMENTATION_PLAN.md
```

Three workspaces instead of five: adapters and brains live inside the server until a second consumer exists (extraction is cheap; a `server ↔ brains` dependency cycle is not). `packages/protocol` is the **single vocabulary**: `Body{id, kind, parentId?, host?: {kind: project|task, id}}`, `Project{…, workspace, repoPath?, parentProjectId?}`, `Task{…, projectId?, bodyId, worktreePath?, branch?, blockedBy[]}`, `Agent{…, role, runtime, sessionRef, supervisorId, bodyId}`, `Proposal`, `Question` (§5.3, with a `version` bumped on every holder change or answer), `StatusRecord` (§4), the `agent.*` / `question.*` / `proposal.*` / `project.*` / `task.*` / `body.*` events.

---

## 8. Security

- The server can start processes on your machine. It must require a bearer token even on localhost, sent in the first WebSocket frame (§6.3) or an `Authorization` header for REST, and it must bind to `127.0.0.1` by default; Tailscale Serve terminates TLS and forwards to it.
- **`Host` allow-list** (`localhost`, `127.0.0.1`, the `*.ts.net` name) and an **`Origin` check** on every WebSocket upgrade, so a web page in the same browser cannot reach the server via DNS rebinding or cross-origin sockets.
- The token is printed once by `galactic start` and pasted (or scanned as a QR code) into the phone PWA; Tailscale identity headers may replace it for remote clients in Phase 7.
- Permission requests from agents follow the per-project policy table (SPEC §3.6); anything not auto-allowed is surfaced to the user and never auto-approved for a remote client unless explicitly configured.
- Known secret patterns (API keys, tokens) are redacted from transcripts before persisting and before sending to any client.
- Store API keys in the OS keychain or a `.env` outside the repo; never send them to the browser.

---

## 9. Alternatives considered

| Area | Alternative | Why not (for v1) |
|---|---|---|
| Frontend | Angular + Three.js | Much smaller 3D ecosystem; manual scene plumbing; change detection vs render loop. Fine for the side panel, poor for the scene. |
| Frontend | Svelte + Threlte | Excellent, lighter than R3F, but smaller community and fewer ready-made helpers/examples. Good second choice. |
| 3D engine | Babylon.js | Batteries-included engine with good tooling, but weaker React integration and fewer solar-system references. |
| Renderer | WebGPU (+ WebGL2 fallback) | Different material system, fewer ready-made effects/helpers, two render paths to test; nothing in v1 needs it. Revisit for GPU-driven simulation. |
| Desktop | Electron | Heavy; unnecessary because the server is already a separate process. Tauri 2 wraps the same UI if a shell is wanted. |
| Backend | Python (FastAPI) | Fine for the brains, but you would lose shared types and the TypeScript Agent SDK / ACP SDK ergonomics. |
| Claude transport | ACP (`claude-agent-acp`) on day one | Second Claude integration next to the SDK the brains need; cost/resume/spawn options depend on what the ACP adapter exposes. Becomes the path for Codex/Gemini later. |
| Agent integration | Prompt-only orchestration (agents talk to each other via files or messages) | Untraceable, fragile, expensive. Tool-armed brains + a real event model are simpler to debug. |
| Remote access | Cloudflare Tunnel + Access | Great if you need public-internet access with SSO; more setup than Tailscale for a single user. Keep as option. |
| Remote access | ngrok / raw port forward | Public URL with weak or no auth in front of a process-spawning server. No. |

---

## 10. Sources

- [ACP introduction (Marc Nuri)](https://blog.marcnuri.com/agent-client-protocol-acp-introduction)
- [ACP protocol overview](https://agentclientprotocol.com/protocol/overview)
- [ACP ecosystem overview, June 2026](https://codex.danielvaughan.com/2026/06/10/agent-client-protocol-microsoft-intelligent-terminal-codex-cli-multi-agent-ide-ecosystem/)
- [React Three Fiber v9 migration guide](https://r3f.docs.pmnd.rs/tutorials/v9-migration-guide)
- [Claude Code programmatic usage / Agent SDK](https://code.claude.com/docs/en/headless)
- [Cloudflare Tunnel vs Tailscale vs ngrok for agent dashboards](https://guides.happier.dev/cloudflare-tunnel-vs-tailscale-funnel-vs-ngrok-for-claude-code-codex-opencode)
