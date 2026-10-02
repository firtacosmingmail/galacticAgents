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
- Permission handling via the SDK's permission callback/hook, which asks the spawn's **permission gate** (below): allowed actions return immediately, denied ones are refused with the reason, everything else becomes `agent.needs_input(kind: "permission")` and blocks the tool call until the user answers.
- Clarification questions: the `AskUserQuestion` tool becomes `agent.needs_input(kind: "clarification")`.
- Graceful stop: `interrupt()` and wait for the turn to end before terminating (SIGTERM alone leaves an in-progress turn and any pending permission unanswered).

*Verified in Phase 1 (P1-08, `docs/tasks/notes/P1-08-sdk-spike.md`):* the SDK bundles its own Claude Code binary and reads the same login as the `claude` CLI, so in-process brains with custom tools run under the subscription; cost is reported per turn as a cumulative estimate (SPEC §8, both answered). What the spike fixed about the adapter's shape:

- **One long-lived `query()` per agent with streaming input.** The inbox (P1-07) is the `AsyncIterable` prompt; each delivered message ends in a `result` (→ `agent.idle`). `query.interrupt()` cancels the current turn only: that turn ends with an error result the adapter maps to `agent.idle`, and the next message runs in the same session. `sessionRef` is the SDK session id, assigned by the adapter (`sessionId`) and re-opened with `resume`.
- **Every tool call goes through the permission gate via a `PreToolUse` hook** (the `canUseTool` callback alone fires only for what Claude Code would prompt for itself). The hook calls `opts.gate.check(toolCall)` and answers `allow`/`deny` from its verdict and `ask` for the rest; `ask` lands in `canUseTool`, which opens `agent.needs_input(kind: permission)` and blocks until the answer. `AskUserQuestion` arrives in the same callback and is answered through `updatedInput.answers` → `agent.needs_input(kind: clarification)`.
- **The gate is the server's, not the adapter's (P1-18).** `SpawnOptions.gate: PermissionGate` — `check(toolCall) → {allow} | {deny, reason} | {ask, action?, reasons}` — is built per spawn by `runtime/permission-gate.ts` from the project's policy table (`domain/permissions.ts`, P1-10) and the agent's caps: the tool-call cap is checked first, and a call refused for the cap also trips it, so the agent is stopped rather than left retrying. Adapters never see the policy or the caps; the ACP adapter's `request_permission` and a PTY adapter's prompt detection call the same `check()`, so every runtime gets the same decisions from one implementation and the policy engine has one caller. The fake adapter runs every tool call through it too.
- **The supervisor spawns the CLI** through `spawnClaudeCodeProcess`, so the SDK session is a child in its own process group with a row in the PID table like any other runtime.
- **`bare` needs an API key** (no subscription login in bare mode); the option is refused without one.

Decided while implementing the adapter (P1-09, `apps/server/src/adapters/claude-sdk/`):

- **A job ends in `agent.idle`, not `agent.finished`.** An SDK session is long-lived: every turn's `result` becomes `agent.idle(cost)` and the session waits for the next message; the Waykeeper (Phase 2) closes the task and stops the agent. `agent.finished` is reserved for the CLI ending on its own (a clean exit, reported by the supervisor as `exited`), `agent.failed(crash)` for an unexpected exit and `agent.stopped` for a completed stop — one terminal event per session, mapped from the supervisor's `ProcessOutcome`. The conformance suite's `jobEnd: 'idle'` describes this.
- **`agent.tool_call` is emitted when the gate lets the call run** (from the `PreToolUse` hook, or from `canUseTool` after the user allowed it), never from the assistant's `tool_use` block, so a refused call is not counted against the tool-call cap and the transcript explains the refusal. Tool results come back as `agent.output(kind: tool)` excerpts; subagent output is prefixed `[subagent]`.
- **Pause is `SIGSTOP` on the process group, resume `SIGCONT`.** The turn in flight — model call, tool, shell children — freezes in place and continues afterwards, which is what the panel's pause means; cancelling the turn would lose work. `stop()` sends `SIGCONT` first, so a paused agent still stops gracefully (interrupt → turn end → SIGTERM → SIGKILL).
- **An error result that is not ours** (`error_max_turns`, an API failure) is a transcript line plus `agent.idle`, not a failure: the session is intact and the next message runs. The error result of our own `interrupt()` is just `agent.idle`.
- **Environment:** the CLI inherits the supervisor's allow-list plus `CLAUDE_PASS_ENV` (API routing and login variables: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex settings, …) plus the adapter's own `env`; `ANTHROPIC_API_KEY` reaches a child only through that `env`, for `bare`. The session id is assigned by the adapter (`sessionId`), so a server that itself runs under Claude Code never leaks its own session id to its agents.
Decided in the phase review (P1-30, P1-32, P1-36, `docs/tasks/notes/P1-review.md`):

- **One gate check per tool use.** The `PreToolUse` hook's verdict is remembered by `tool_use_id`; `canUseTool` reuses it (asks the user for an `ask`, allows a hook `allow` without a second check), so a call is gated once and has one `agent.tool_call`. Both callbacks deny when the gate throws. `PermissionGate.check(call, {reserve?})` exists for adapters that must re-check without the cap pre-flight.
- **The query loop ending is a failure while the CLI lives.** If the iterator throws (also during an interrupt) or ends and the process is still running with no terminal event after 2 s, the adapter emits `agent.failed(runtime)` and stops the child.
- **Pause needs a process.** Pausing before the CLI exists is refused (the runtime reverts its own paused flag). `interrupt()` while paused sends `SIGCONT` and emits `agent.resumed` first (the runtime resumes first itself). Trade-off of `SIGSTOP`: the CLI's own tool and API timers keep counting while frozen, so a long pause can end the frozen call in a timeout.
- **Mapping:** a `result` with `is_error: true` (also with subtype `success`) is an errored turn — transcript line + `agent.idle`, like the other error results. `AskUserQuestion` with several questions asks them one by one (one `needs_input` each); a multi-select question says "separate the labels with commas" and passes the answer as typed. Cache read/creation tokens are added to `inputTokens` (the protocol `Cost` has one input count). `rate_limit_event` warnings/rejections during a turn become `agent.progress`. An init `session_id` that differs from the resumed ref is reported. Ended sessions are freed; events of a session replaced by a same-agent resume are dropped. An idle stop closes the input, so the CLI exits on stdin EOF before any signal.
- **Brains:** `role !== 'steward'` gets `settingSources: []` (no repository CLAUDE.md, hooks or skills), its `systemPrompt` as the whole prompt, and its `ToolDefinition`s as an in-process MCP server (`mcp__galactic__*`, JSON Schema converted to the zod shape the SDK wants). A Steward keeps the Claude Code preset and the repository's settings; a Steward `systemPrompt` is appended to the preset.

A brain's own tools (`SpawnOptions.tools`) are server code checked by `DomainCommands`: the permission gate allows them by name (bare or `mcp__galactic__<name>`) after the tool-call cap and never consults the policy table for them (P2-06).

**Permission routing (P2-04).** The gate is the one place a permission is decided. Adapters call `check()` from their hooks; the runtime calls `decide()` (no cap reservation) on every `agent.needs_input(kind: permission)` that carries a tool call, before a question is opened: `allow` / `deny` answer the adapter and log `permission.decided{agentId, questionId?, toolCall (redacted), decision, action?, reason?, decidedBy: system}` with no question row; `ask` opens the user-held question. The gate reads the policy and the workspace on every check (the agent's project's `permissionPolicy` and `workspace`, else the global default and the spawn's; the spawn-time values only for agents outside any project) and logs its own hook refusals as `permission.decided{deny}` without `questionId` (cap refusals are the agent's failure). SPEC decision 31. `decide()` reserves no tool call, because the SDK and fake adapters' hooks already did: a future PTY or ACP adapter that asks the runtime directly, without a hook, must reserve in its permission path, or its allowed calls escape the tool-call cap.

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

`agent.spawned · agent.output(text/tool/thinking) · agent.tool_call · agent.needs_input(questionId, kind, question: QuestionContext{text, options?, toolCall?, permissionAction?}) · agent.progress(summary) · agent.idle · agent.stalled · agent.paused · agent.resumed · agent.finished(result, cost) · agent.failed(error) · agent.stopped`

The `AgentAdapter` interface: `spawn(opts)`, `send(sessionId, message, {interrupt?})` (starts a turn now — the server's per-agent inbox is what waits for idle, so adapters keep no queue and may reject a mid-turn message; P1-19), `answer(questionId, answer)`, `interrupt`, `pause`, `resume`, `stop`, `resumeSession?(sessionRef)`, plus the `events` stream. `spawn(opts)` accepts `tools` and `systemPrompt` so the same adapter runs the brains, and `gate` (§3.1) for its tool calls. An adapter is a translator, not a scheduler: the runtime owns the inbox, the caps, the permission policy and the event log.

The UI, the status store and the supervisor brains only ever see these events. Adding a new runtime means adding one adapter, nothing else — including for the brains, which never import a runtime module directly.

Two refinements decided while building the fake adapter and the supervisor (P1-01, P1-03):

- **`agent.spawned` is emitted by the server's runtime layer**, not by adapters, when `spawn()` / `resumeSession()` resolves: it carries the body, supervisor, task and project ids the adapter never sees, plus the `sessionRef` from the handle — written to the agent row in the same transaction (P1-21). **Every other `agent.*` event comes from the adapter, the one emitter for its session** (P1-20). The process supervisor tells the adapter what only it can know as a `ProcessOutcome` through the spec's `onOutcome` hook — `start_failed`, `crashed`, `exited` (clean, or announced with `expectExit()`), `stopped{by}`, `restarting` — and the adapter decides the verdict (`agent.failed(reason: runtime)`, `agent.failed(reason: crash)`, `agent.stopped`, or `agent.finished` from the runtime's own final message), so a process exit and a final result can never race each other into the log.
- **One terminal event per agent (P1-17).** The runtime logs exactly one of `agent.finished` / `agent.failed` / `agent.stopped`: a cap stop is flagged on the live entry and the adapter's `agent.stopped` is folded into `agent.failed(reason: cap)` whichever arrives first; a straggler from an ended agent is dropped; an event for an agent the runtime never spawned is reported and never logged. The status store treats an ended record as a sink.
- **`agent.needs_input` opens the question (P1-23).** The runtime inserts the `Question` row and emits `question.opened` in the same command as the event; `answer()` closes the row and emits `question.answered` with the bumped `version`. The server owns questions (§5.3); holder routing arrives with Phase 2.
- **`agent.created{agent}` describes the row** (emitted by whichever command inserts it: the Phase 1 runtime, the Phase 2 `spawnAgent` command), so a replaying client builds the same `agents` table as a snapshotting one (§6.2); `agent.spawned` then reports the session. `agent.idle` may carry the running `cost` for runtimes that meter per turn.
- **Adapters emit `agent.output` per content block, never per token**: one transcript row per token is not a transcript. The pipeline's redaction (§6.2, §8) is boundary-aware since P1-27, so a key split across two deltas no longer leaks — but the per-block rule stands for the sake of the rows. The runtime redacts every string in the other agent events too (tool inputs, question text, results, errors, progress summaries) before they reach the log.
- **`agent.paused` / `agent.resumed` / `agent.stopped` emitted by an adapter carry `by: {type: system}`**: the adapter interface has no actor. Who asked is recorded by the matching `control.*` event the runtime appends first (decision 11b), so the log always has both.

**Restart recovery (P1-14, P1-15, P1-29, P1-32, P1-33; SPEC decisions 8, 21, 23).** `agent.interrupted{agentId, reason, pending?}` is the runtime's event for a session the server lost without the agent ending. A graceful shutdown first logs every live agent's fate — `agent.interrupted{pending}`, or the `agent.stopped{by}` / `agent.failed(cap)` a stop already under way was heading for — then flushes the transcripts, then stops all processes in parallel (the server's hard deadline is grace + term + 10 s). A start after a crash of the server logs `agent.interrupted` for every agent whose last state is still live, or `agent.stopped` when a `control.stop` after its last spawn was never answered. The status store folds `interrupted` to an ended state that only a new `agent.spawned` leaves. `AgentRuntime.recover()` reads the log once and reopens every interrupted agent through `recoverAgent(id)` — the same path the panel's "Resume session" (`POST /api/agents/:id/recover`) takes: refused unless the agent is `interrupted` and not live; the permission policy, workspace, prompt and `bare` come from `Agent.meta` (until tasks carry them in Phase 2); every `message.sent` without a `message.delivered` is queued again with its original id, so a second restart before delivery still knows it is pending and a crash mid-turn does not deliver the turn's message twice. A failed resume logs `agent.interrupted{reason: "resume failed: …"}`.

**Message and question lifecycle (P1-33, P1-34).** `message.delivered{messageId, agentId}` is logged when the adapter's `send()` resolved; a refused delivery waits at the head of the inbox and is retried at the next idle (three attempts). A delivery marks the agent busy at once, so a pause/resume or a second message right after cannot reach a mid-turn session. An agent's open questions are cancelled (`question.cancelled{questionId, agentId, reason, version}`, row status `cancelled`) in the same command as its terminal or interrupted event, and when it goes idle with a question still open (an interrupt withdrew it); a late answer is refused. A stop whose adapter call throws ends the agent with `agent.failed(runtime)`; a stop that resolved without an adapter event ends with the runtime's `agent.stopped{by}` — an agent can always be stopped. A message sent while a stop is under way is refused before it is logged. A cap hit before the session handle exists is acted on when it arrives.

The **process supervisor** (`apps/server/src/runtime/supervisor.ts`) is the one place that spawns and kills child processes: each in its own process group (killed by group, corner case 4), stdio captured, an allow-listed environment (§8), restart policy off by default, and one graceful stop sequence — the runtime's interrupt hook (SIGINT to the group by default) → wait for the turn to end with a timeout → SIGTERM → SIGKILL (corner case 8b). Its PID table is the `agent_processes` table (migration 0003): runtime bookkeeping that never appears in a snapshot and has no events. On startup `reconcile()` treats every `running` row as a previous server life: a still-running orphan is killed by group (nothing can re-attach to a live process, corner case 3), and both dead and orphaned rows become `interrupted` for the resume path (P1-14) to respawn from `agents.sessionRef`. Since the phase review (P1-32, P1-37): the interrupt hook runs inside the grace window (a CLI that never answers the interrupt still reaches SIGTERM/SIGKILL); **whenever a group leader exits, for any reason, the rest of its group gets SIGTERM (and SIGCONT) then SIGKILL**, so dev servers and background shells do not outlive their agent, and `reconcile()` also kills the leftover group of a dead leader recorded in this boot; process identity is the basename of the whole `ps -o comm=` (macOS paths with spaces) plus a start-time check (`ps -o lstart=`, 5 s tolerance) against the row's `startedAt`, so a recycled pid — say the user's own `claude` — is never killed; `adopt()` refuses a restart policy (the SDK could not reconnect to a relaunched CLI).

---

## 4. Supervision without interruption (status store)

The spec's requirement — supervisors know statuses without interrupting — is solved by **never asking the agent**. Instead:

1. Each adapter's event stream is folded into a per-agent **status record**: `state ∈ {starting, working, waiting_for_input, idle, stalled, paused, interrupted, finished, failed, stopped}`, `current_activity` (last tool call or a rolling LLM-written one-liner), `last_event_at`, `pending_question`, `progress` (task-level checklist if the agent reports one), `cost_so_far`, `caps` (used vs. limit). `stalled` is set by a per-runtime silence threshold, never by killing.
2. The status store is an in-memory **projection** of the event log, rebuildable from it on startup and pushed to the UI over WebSocket as batched diffs (≈10 Hz, never per token, and only for records that changed: the record carries `startedAt` and the client extrapolates the running wall clock from it rather than being sent a fresh `caps.wallClockMs.used` every second — P1-25). **The projection has one implementation, in the server** (P1-05): clients receive status records in the `snapshot` and as status messages afterwards and never fold `agent.*` events into records themselves — a second implementation in the web client would drift from the server's and make a resuming client disagree with a snapshotting one (decided with P0-18).
   Ended records are retained for a bounded time and count (default 24 h, 500) and then dropped; the drop is announced in the next `status` message (`removed`) so clients forget them too, and the log keeps the history (P1-16). After a replay the full set is sent with `replace: true` and the client swaps its map, so a record pruned while it was away disappears too (P1-38). `pendingQuestionId` is cleared by `question.cancelled`, `agent.idle` and `agent.interrupted` (P1-34).
3. The Harmonizer and Waykeepers get a `get_agent_status(agent_id)` / `list_supervised_agents()` **tool** that reads the store. Reading it costs nothing to the supervised agent.
4. Task and project states (SPEC §4.4) are derived in the server from agent states and open questions — no LLM call needed for the basic status views.
5. Optional cheap summariser: every N events (or on idle), a small model turns the recent event window into a human sentence ("Refactoring auth module, 3 files edited, running tests"). This drives both the panel text and the satellite animation choice (gathering / transporting / building). The raw last event is always shown next to the summary so a lying summary is visible.

---

The system summary counts (open questions, user-held questions, blocked tasks and projects) come from a pure function in `packages/protocol` (`summarize`, P2-15) over the domain rows: server and client compute them from the same state, so no summary message is sent and it cannot drift.

## 5. The Harmonizer and Waykeepers as "tool-armed" agents

Do not make the hierarchy purely prompt-based. Build the Harmonizer and Waykeepers on the Claude Agent SDK with custom tools that mutate the domain model, so the important decisions are auditable and the UI reflects them immediately.

### 5.1 Brains are agents, run through the adapter

The Harmonizer and each Waykeeper are rows in the `Agent` table (`role`, `runtime: claude-sdk`, `sessionRef`, `supervisorId`, `bodyId`) and are spawned through the **same `claude-sdk` adapter** as Stewards, with `tools` and `systemPrompt` supplied. Consequently they emit `agent.*` events, appear in the status store with real statuses and cost, have a satellite/HQ presence on their body, and are resumed after a restart like any other agent. `packages/brains` (or `apps/server/src/brains`) contains only prompts, tool schemas and tool handlers written against a `DomainCommands` interface — never SDK or runtime imports. The implementation is `Commands` (`apps/server/src/domain/commands.ts`, P2-01), built by `composeRuntime`: domain commands run synchronously under the one write rule and refuse with a `DomainError{code: not_found | invalid_transition | conflict | stale | invalid}` that rolls everything back; agent commands (spawn, stop, pause, resume, answering a question a live session asked) go through the runtime. Task and project state transitions follow one table (`domain/states.ts`, SPEC §4.4).

### 5.2 Mailbox, one turn at a time

Brains are long-lived but **event-driven, never polling**:

- Each brain has a **mailbox**. Wake-worthy events are appended to it: a user message, `question.opened / answered`, `proposal.decided`, `agent.finished / failed / stalled`, task/project control actions from the panel, a subordinate's report. Never `agent.output` or `agent.tool_call`.
- **One turn at a time per brain.** A turn drains the whole mailbox into a single prompt ("since your last turn: Steward S3 finished task T7; the user answered Q12; the user paused T9"). Events arriving during a turn wait for the next one. Two Stewards finishing together produce one turn, not two, and a brain's own tool side effects never re-enter it mid-turn.
- **Tools that need the user are non-blocking.** `ask_user`, `escalate`, `propose`, `request_project_closure` create the corresponding object and end the turn; the answer arrives later as a mailbox event. A brain's turn is therefore always short, and a restart never loses an hours-long in-flight turn.
- **The database is the brain's memory.** Each turn is seeded with the current state it needs (`list_supervised_agents()`, its project's tasks and open questions) rather than relying on an ever-growing transcript; sessions are reset periodically (e.g. on each project milestone) with a summary carried over, so context never silently compacts away "knows the status of every task".

**Brain runner (P2-06).** `apps/server/src/brains/runner.ts` drives one brain: it spawns it through `DomainCommands.spawnAgent` with `tools` and `systemPrompt` and calls `AgentRuntime.attachMailbox`; from then on messages to the brain (the user's chat, a subordinate's report) are only logged as `message.sent`, folded into the next turn by the mailbox and marked `message.delivered` once that turn is delivered. A turn starts only when the brain is idle and ends at its `agent.idle`; its prompt is "Since your last turn: 1. … 2. …" plus the seed block (supervised agents with status, the project's tasks, the open clarifications it holds or its agents asked). Events committed together become one turn. The whitelist is one table, `WAKE_RULES` (`brains/wake.ts`): `message.sent` from the user or a supervised agent; `question.opened/escalated/reassigned` to the brain as new holder and `question.answered/cancelled` naming it in `holders` (clarifications only); `proposal.*` decisions on proposals it owns; `agent.finished/failed/stalled` of supervised agents; `control.*` aimed at the brain, a supervised agent, a task or project it runs, or concerning it as a supervisor (`concernedSupervisors`, P2-14: an agent target concerns its supervisor; a task its Stewards' supervisors and its project's Waykeeper, or the Harmonizer for a standalone task; a project its Waykeeper(s) and their supervisors, the parent project's Waykeeper and the Harmonizer; never the actor). Tool handlers receive a `DomainCommands` proxy: every event a tool call appended is taken out of the mailbox, so a brain's own actions never wake it. `ask_user`, `escalate`, `propose`, `request_project_closure` (or any tool marked `endsTurn`) end the turn: later tool calls in it are refused with `turn_ended`; a refused command reaches the model as `{error: <DomainError code>, message}`. Session reset (after N turns, or on demand) has the brain call `carry_summary`, then `AgentRuntime.renewSession` replaces the adapter session on the **same agent row** (`agent.interrupted{reason: "session reset"}` then `agent.spawned`), and the new session's first prompt carries the summary. A reset keeps the questions the brain holds (the agent lives on; only its own open questions are cancelled with the old session). A tool call's events, as the command surface returns them, are only what that call caused — its own transaction and its agent effects carrying its actor — so another actor's event logged meanwhile still wakes the brain. The mailbox is in memory; P2-16 restores it after a restart.

**Placement (P2-20).** `checkPlacement` (`domain/agents.ts`) holds the hierarchy rules for `spawnAgent` and `updateAgent` (SPEC decision 32): the Harmonizer on Earth, one at a time, unsupervised; every other agent under its prescribed supervisor, matched by role and project. The Phase 1 ops console (`/api/agents` → `AgentRuntime.spawn`) is outside these rules. A brain is also woken when a clarification it asked through a tool (the Harmonizer's `ask_user`, a Waykeeper's own question — marked `meta.source: "command"` by the command surface) is answered or cancelled; a question its own session raised, and any permission question, is answered through the adapter and never enters its mailbox.

**Brain tests (P2-07).** Brains are tested without Claude through `apps/server/src/brains/testing/`: a `BrainScript` stands in for the model — turn rules match the turn prompt and their async bodies call the brain's real tools (through the runner, the gate and `DomainCommands`), chaining results; a `BrainTranscript` records every prompt, call, result and refusal, and `verify()` fails on an expected turn that never came, an unexpected turn or a refused call. The fake adapter's `script` step is the only seam.

### 5.3 Tools

| Agent | Key tools |
|---|---|
| Harmonizer | `find_related_work(request)`, `size_request → {kind, rationale, suggestedName, proposedBody, workspace}`, `propose(proposal)`, `create_project`, `create_task`, `assign_body`, `spawn_waykeeper`, `spawn_steward` (asteroid tasks; the Harmonizer is their supervisor), `propose_promotion(task\|project, toKind)`, `close_task` (asteroid tasks), `stop_agent`, `pause_agent`, `resume_agent`, `get_agent_status`, `list_supervised_agents`, `ask_user`, `answer_question` (clarification kind only), `report_status`, `freePlanets()` / `freeMoons(planetId?)` (deterministic body catalogue checks) |
| Waykeeper | `plan_tasks(plan)` (presented once for approval), `create_task`, `spawn_steward` (creates the worktree), `merge_task(taskId)`, `close_task`, `pause_agent`, `resume_agent`, `stop_agent`, `get_agent_status`, `list_supervised_agents`, `answer_question` (clarification kind only), `escalate(question)`, `request_promotion`, `request_project_closure`, `report_status` |
| Steward | Whatever the underlying runtime provides (files, shell, tests) inside its worktree; plus clarification questions and permission requests, which the adapter maps to `agent.needs_input` |

Escalation is an **event with an owner**: `needs_input` creates a `Question{id, kind: clarification|permission, originAgentId, holder: {type: agent|user, id?}, status, context, answeredBy?, answer?}`. Holder routing follows `Agent.supervisorId` generically (Harmonizer for asteroid Stewards). A **permission** question is resolved only by the policy table or the user and is routed to the user's inbox without entering any brain's mailbox; a **clarification** question may be answered by its holding supervisor from context (logged with `answeredBy`) or escalated. When the user answers it anywhere in the UI, the server marks it answered and notifies every holder, so upper levels stop waiting. An orphaned question (holder died) moves to the next living supervisor or to the user — the server, not the agents, owns questions.

**Question service (P2-03, `domain/question-service.ts`).** `agent.needs_input` opens the question with holder = the origin's first living ancestor by `supervisorId` (permission → user; P2-04 puts the policy evaluation in front) and `context.origin = {role, taskId?, projectId?, bodyId?, recent: the agent's last 10 events}`. An agent's end (the runtime's terminal path, startup recovery, `Commands.recordAgentEvent`) cancels its own open questions and re-assigns the ones it held, in the same command (`question.reassigned{reason: "holder <id> <how>"}`). `question.answered` and `question.cancelled` carry `holders[]`, every agent that held the question. Liveness comes from the status store in the composed runtime, from the log's lifecycle events otherwise.

**Harmonizer (P2-08, `brains/harmonizer/`).** `harmonizerBrain(deps)` is the prompt plus its tools; deps are `projectsRoot`, `checkPath` (`Workspaces.checkPath`), `startWaykeeper` (wired in `index.ts` to start the Waykeeper brain) and `stewardPrompt` (P2-11). `find_related_work` is a deterministic word-overlap search; `size_request` informs and changes nothing (the body `chooseBody` would give, a suggested name and workspace, related work, free planets and moons). `propose` stores what the card asks for in `Proposal.meta.request` (and the `BodyChoice` in `meta.bodyChoice` when no planet or moon is free, for P2-09). `create_project` / `create_task` need an approved card and record `meta.proposalId`. `index.ts` starts the Harmonizer after `listen`, cwd = the projects root, unless one already runs; tests build the app through `buildApp`, never `index.ts`.

**Waykeeper (P2-10, `brains/waykeeper/`).** The prompt and its tools; the supervision tools both brains share live in `brains/common-tools.ts` (`stop/pause/resume_agent`, `get_agent_status`, `list_supervised_agents`, `answer_question`, `report_status`; the Harmonizer uses them all but `report_status`, for which it has its own read-only system overview). Their reach is the caller's subtree (the `supervisorId` chain); a refusal is a `DomainError` returned to the model. Tools get `ctx.send(agentId, text)` (a `message.sent` from the brain that wakes only its addressee) and `ctx.workspaces` (built by `composeRuntime` from `ComposeOptions.workspaces`, which `index.ts` fills from `projectsRoot`/`dataDir`). A plan card is a `Proposal` with `meta.plan = {projectId, waykeeperId, taskIds}`, made with its proposed tasks in one transaction by `DomainCommands.proposePlan`; approving it approves its tasks in the same transaction; its decision wakes the project's Waykeeper (`WakeScope.ownsProposal`), never the Harmonizer. A spawn's result carries only the spawn's own events (row, body, session), so a Steward that finishes before the call returns still wakes its supervisor.

### 5.4 Hard caps (decision 18)

Enforced by the process supervisor, not by prompts, from Phase 1: per-agent wall-clock and tool-call caps; global maximum of concurrent agents; per-Waykeeper maximum of Stewards; maximum spawns per hour. Hitting a cap stops the agent with a `failed(reason: cap)` event the supervisor sees and reports. Dollar budgets per project (warn / refuse) come in Phase 8.

### 5.5 Control cascades (P2-14)

`domain/cascade.ts`: a panel or Harmonizer control on a task or project records `control.*` and sets the state with `by` (SPEC decision 28) in one command, then the `Commands` surface pauses, resumes or stops the item's live agents through the runtime, each logging its own `control.*{agent}`; a refusal by some agents rejects with `conflict` and the rest stands. Exposed as `POST /api/control {target, action}` (bearer-guarded, zod-validated: 400 / 404 / 409) and as `DomainCommands.control`. `retentionDue(tables)` lists finished, unpinned projects for P2-13's archival job.

---

## 6. Persistence, event log and API protocol

### 6.1 One write rule

Every command (a brain tool, a panel action, an adapter event fold) performs its **domain mutation and its event insert in one `better-sqlite3` transaction**; the event ID is the `events` rowid (monotonic, server-assigned); in-memory subscribers are notified **after commit**, strictly in `seq` order even when a subscriber runs a command of its own while being notified (its events are committed at once and published after the current batch). Events are buffered per outermost command and published only when it commits: a nested command that succeeded inside an outer one that then threw is rolled back with it and never published (P1-35). A crash can therefore never leave the domain tables and the event log disagreeing. **A command reads the clock once** (P2-01): every event it appends carries that reading as `at`, and every row it writes uses it for `createdAt` / `updatedAt`, so a client that folds `updatedAt = at` holds exactly the server's rows. Clients never trust their own timestamps for ordering. A migration that rebuilds a table (SQLite's only way to change a constraint) declares `-- migrate: foreign_keys=off`; the runner disables foreign keys around its transaction and refuses to commit if `foreign_key_check` reports anything (P2-02, migration 0005).

### 6.2 Two streams

- `events` — domain, status, question, proposal and lifecycle events, `message.sent` (what the user, a supervisor or the system sent to an agent — logged before it is queued, so a restart re-delivers what was pending and a brain's mailbox is fed from the log; P1-22) and `message.delivered` (the adapter accepted it; P1-33): small, ID-ordered, resumable, retained for a long time. This is the log that corner case 33 ("reconstruct any state") and the timeline scrubber replay.
- `transcript_chunks(agentId, seq, chunk)` — agent output (text, tool calls, thinking), written in batches (≈10 Hz), pruned by retention policy, redacted for known secret patterns **before** persisting and before sending to the UI. Redaction is boundary-aware (P1-27): the previous chunk's tail is matched together with the new text, a secret's head moves into the new chunk, and the newest chunk of an agent is held for 250 ms so a key split over streamed deltas is caught whole. Since the phase review (P1-31): the pipeline receives the **raw** output and redacts it itself (a chunk redacted on its own loses the context a split key needs); only consecutive chunks of the same kind are joined; after a gap longer than the hold, a key's head is kept only if it was safe on its own and the rest is masked; a private-key block is masked from its `BEGIN … PRIVATE KEY` line to its `END` line whatever the chunking (per-agent state, 16 KB cap); a subscribe backlog holds persisted rows only and subscribers are notified after the write succeeded; `prune()` never deletes an agent's newest row, so `seq` keeps increasing across restarts without a stored high-water mark (a Phase 8 "delete an agent's transcript" needs one).

The status store (§4) and the task/project states are projections over `events`; they are rebuilt on startup and never written back as truth.

**Work states (P2-15).** `WorkStateDeriver` (`runtime/work-state-deriver.ts`) is a log subscriber placed after the status store. Once every event of a commit is folded, it recomputes the tasks and projects the commit concerns with an ordered rule table (`domain/work-states.ts`, SPEC §4.4) and writes any difference through `setTaskState` / `setProjectState` as `*.state_changed` **without `by`**, so clients receive derived states as ordinary row changes and the conformance test still holds. It derives per commit, not per event: a command that sets a task and its project explicitly (a cancel) has both holds recorded before either is re-derived. A task's change re-triggers only its project, a project's change nothing. On restart it rebuilds its tables from the log without writing, then corrects only rows a crash left stale.

**Bodies (P2-02).** The catalogue is seeded by migration 0005 (`domain/catalogue.ts`: `freePlanets`, `freeMoons`, `chooseBody` with decision 25's preferences, returning the occupied planets when none is free; seeded asteroid generator `b-asteroid-n`). The "moved to …" marker is a first-class `Body.movedTo{bodyId, host, at}` column: `body.moved` writes it with the event's `at` (with `intoProjectId` when a standalone task joins a project's body, whose host is unchanged), `body.freed` clears it, and both sides fold it alike. `sweepMarkers(retentionMs)` frees markers by the log's clock (default 7 days until P2-13 reads the setting).

**Patch rule (P2-20).** `project.updated` / `task.updated` carry `changes` validated by `ProjectChanges` / `TaskChanges` (`packages/protocol`): absent or `undefined` is unchanged, an explicit `null` removes the field — allowed only on `CLEARABLE_PROJECT_FIELDS` (`repoPath`, `parentProjectId`, `permissionPolicy`) and `CLEARABLE_TASK_FIELDS` (`worktreePath`, `branch`), refused elsewhere. The commands and the web reducer apply changes with the same `applyChanges`, so a cleared key is absent on both sides, never stored as `null`; clearing an absent field emits nothing. `agent.updated` has no clearable fields.

Two consequences for the client, decided with P0-18:

- **Domain state is derived twice by design** — the server's commands mutate the tables, the web client's reducer folds the same events — so the two must agree or a resuming client and a snapshotting one would show different worlds. Every command therefore emits events that fully describe its mutation (`body.created` for a new body, `project.created` with the whole project, …), and a **conformance test** (`apps/web/src/state/conformance.test.ts`, P2-01) drives the real commands and runtime through every domain event type and checks that replaying the recorded log through the client reducer equals the server's snapshot after every commit. Status records are exempt: they are server-owned (§4). A row's placement in the hierarchy changes with `agent.updated{changes: supervisorId | bodyId | taskId | projectId}`.
- **The per-project `PermissionPolicy`** (SPEC §3.6, decision 7) is stored in a `permission_policy` JSON column on `projects` (validated by the protocol schema; absent = default policy), added by migration with P2-01 and exposed as `Project.permissionPolicy?`. It is never parked in `meta`. The same migration (0004) adds `pinned` to projects and tasks (decision 11b).

### 6.3 WebSocket protocol (defined in Phase 0, used by every client from Phase 1)

1. Client opens the socket and sends `hello{token, lastEventId?, logId?}` as the **first frame** (browsers cannot set headers on a WebSocket upgrade). `logId` is the identity of the log its state came from.
2. Server replies with `snapshot{logId, seq, agents, bodies, projects, tasks, questions, proposals, statuses}` when `lastEventId` is absent, `logId` is not this log's (database deleted or replaced), or `lastEventId` is too old to replay; otherwise with the `events` since `lastEventId` followed by `caught_up{seq}`.
3. Thereafter a single ordered stream of `{seq, event}`; the client derives all state from it and remembers `seq` + `logId` for the next reconnect. `seq` is never reused (`AUTOINCREMENT`). Transcript chunks are a separate, subscribable stream per agent.
4. The derived state lives in memory only. A client that has no state (a fresh page load) sends no `lastEventId` and takes a snapshot; resuming from a persisted `seq` onto an empty world would replay only the tail (P0-12). Persisting the world together with its `seq` + `logId` is possible later (a phone PWA), never `seq` alone.

Two more message kinds ride on the same socket (P1-05, P1-06): `status{statuses}` carries the status store's batched diffs (≈10 Hz; each record replaces the client's copy for that agent) and follows a replay's `caught_up` with the full current set, since records cannot be derived from the replayed events; `transcript.subscribe{agentId, since?}` / `transcript.unsubscribe{agentId}` open and close the per-agent transcript stream, whose `transcript{agentId, chunks}` batches arrive in per-agent `seq` order (history after `since` first, then live). A client that reconnects re-subscribes with the last `seq` it has. A socket too slow for any of the three streams is cut and resumes on reconnect.

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

Three workspaces instead of five: adapters and brains live inside the server until a second consumer exists (extraction is cheap; a `server ↔ brains` dependency cycle is not). `packages/protocol` is the **single vocabulary**: `Body{id, kind: star|planet|moon|asteroid, parentId?, host?: {kind: project|task, id}, movedTo?: {bodyId, host, at}, meta}` (catalogue data in `meta`: `reserved`, `orbit`, an asteroid's `number` / `seed`), `Project{…, workspace, repoPath?, parentProjectId?}`, `Task{…, projectId?, bodyId, worktreePath?, branch?, blockedBy[]}`, `Agent{…, role, runtime, sessionRef?, supervisorId?, bodyId, taskId?, projectId?, caps}`, `Proposal`, `Question` (§5.3, with a `version` bumped on every holder change or answer), `StatusRecord` (§4), the `agent.*` / `question.*` / `permission.decided` (the policy decided without the user; no question row) / `message.sent.origin?` (`RequestOrigin`: local or remote, P2-21) / `proposal.*` / `project.*` / `task.*` / `body.*` (`created` for a body that was not in the seeded catalogue — a procedural asteroid — then `assigned` / `moved` (with `intoProjectId` when a standalone task joins a project's body; the old body gets the "moved to …" marker) / `freed` (clears host and marker)) / `control.*` events.

---

## 8. Security

- The server can start processes on your machine. It must require a bearer token even on localhost, sent in the first WebSocket frame (§6.3) or an `Authorization` header for REST, and it must bind to `127.0.0.1` by default; Tailscale Serve terminates TLS and forwards to it.
- **`Host` allow-list** (`localhost`, `127.0.0.1`, the `*.ts.net` name) and an **`Origin` check** on every WebSocket upgrade, so a web page in the same browser cannot reach the server via DNS rebinding or cross-origin sockets.
- The token is printed once by `galactic start` and pasted (or scanned as a QR code) into the phone PWA; Tailscale identity headers may replace it for remote clients in Phase 7. `GET /health` hands it out only to a loopback caller whose `Origin` is absent or a loopback name: a reverse proxy connects from loopback too, but carries the remote page's `Origin`.
- Development-only routes (`/dev/*`) exist only with `GALACTIC_DEV=1`; they never write domain rows without the matching events, so a replaying client and a snapshotting one always agree.
- **Agent processes get an allow-listed environment** (`INHERITED_ENV` in the supervisor: PATH, HOME, locale, proxies, `CLAUDE_CONFIG_DIR`, …) plus what the spawn passes explicitly; the server's own variables — its token, any API key — never reach an agent unless a spec hands them over (bare mode does, for its key).
- **REST authentication runs on the decoded route** (P1-28): the `/api` and `/dev` routes live in encapsulated Fastify scopes whose `onRequest` hook checks the bearer token, so no spelling of the path (`/%61pi/…`) reaches a handler without it.
- Permission requests from agents follow the per-project policy table (SPEC §3.6); anything not auto-allowed is surfaced to the user and never auto-approved for a remote client unless explicitly configured. **The policy engine is lexical, a guard rail rather than a sandbox** (P1-30): `domain/permissions.ts` lexes a subset of bash (quotes removed as the shell does, `&`/`;`/`|`/newlines, glued and fd-prefixed redirections, command substitutions classified as commands, heredoc bodies as data, brace expansion capped at 64 alternatives); a command name or git subcommand built at run time, `$'…'` quoting, an interpreter reading from stdin or a heredoc, and `git -c` keys git executes are opaque and ask. By design it does not follow symlinks and does not see what a script written in one call does when run in the next (`Write x.sh` → `bash x.sh`, `npm test` after editing `package.json`); an OS-level sandbox (Claude Code's sandbox, seatbelt) is the real boundary if one is needed. The gate never throws (an exception is a `deny`), an invalid policy makes every action `ask`, and a cwd outside the workspace (or a workspace of `/`) makes every call `ask`.
- **Credentials reach the CLI's tools.** The `claude-sdk` adapter passes `CLAUDE_PASS_ENV` (login and API routing: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, Bedrock/Vertex keys, …) to the CLI because it needs them; every shell child of the agent can therefore read them. Accepted for a local single-user tool; revisit with a sandbox.
- Known secret patterns (API keys, tokens, private-key blocks, case-insensitive `password`/`secret`/`api_key`/`token`-style assignments, Basic auth, Slack, GitLab and Hugging Face tokens) are redacted from transcripts before persisting and before sending to any client, from every string of the other agent events, and from the error messages of `/api` 409 responses (P1-31, P1-38). **Text the user (or a supervisor) writes is not redacted**: `message.sent.text`, `question.answered.answer` and the spawn prompt in `Agent.meta` are stored and broadcast as written — a key pasted into a message stays in the log.
- Store API keys in the OS keychain or a `.env` outside the repo; never send them to the browser.

---

**Server-run git (P2-05).** The server runs git only through `workspace/git.ts`: `execFile` with argument arrays (never a shell string), `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, an allow-listed environment, no prompts (`GIT_TERMINAL_PROMPT=0`) and a 60 s timeout. Hooks are off because the server's own `worktree add`, merge and initial commit would otherwise run repository hooks on the server's behalf, outside any agent and permission gate; Stewards' own commits run in their shell, with hooks, under the project's policy. Git work on one repository is serialised in-process. `mergeTask` tells a conflict with the project's own work from one with external changes (SPEC decision 30): the base side is `rev-list --full-history --no-merges <merge-base>..HEAD -- <conflicting files>`, and a commit is the project's own when an earlier merge of one of its tasks brought it in (`Task.meta.merge.before..commit`, recorded on every successful merge); the rest are `externalCommits` (short id, subject, author; at most 20, `externalCount` in all). Workspace paths are canonicalised (symlinks resolved) and refused when they are `/`, the home directory, the projects root, or touch the data directory. Values a brain can write (`Task.branch`, `Task.meta`) never reach git unchecked: the worktree root is always derived from the workspace and the task id, and a stored branch must be a valid `galactic/…` ref name. Known gap: filter drivers configured in the repository's shared `.git/config` (which a Steward's shell can edit) still run for the server's `git status` / `add`; the permission table counts anything under `.git/` as outside the workspace (decision 22), which is the guard for now.

**Remote clients (P2-04).** `isRemoteRequest(req)` counts a request as local only over a loopback connection with a loopback `Host`, no non-loopback `Origin`, no forwarding header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`) and no Tailscale identity header; everything else is remote — headers can only make a request look more remote. `autoApproveRemote` (`config.json` or `GALACTIC_AUTO_APPROVE_REMOTE`) is off by default; while off, a policy a remote client chooses is floored at the global default with `noLooserThan` (the stricter of the two per category) — on every `permissionPolicy` write: `policyForWrite(policy, {origin, autoApproveRemote})` (`domain/permissions.ts`) guards `createProject`, `updateProject`, a project `control` edit and the `POST /api/agents` presets (P2-21). The command surface takes an optional `WriteOptions {origin: 'local' | 'remote'}` last argument and a missing origin counts as remote; the REST routes pass `originOf(req)`, and `POST /api/agents/:id/send` records it on `message.sent.origin`, so a brain acting on a user's message writes with that origin (`originOfMessages` over the turn: local only if every message is). A remote answer to a permission question is an explicit user decision and is accepted.

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
