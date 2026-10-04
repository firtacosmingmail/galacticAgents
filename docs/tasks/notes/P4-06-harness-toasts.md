# P4-06 — Test harness and event toasts

Branch `p4-06-harness` (from `p4-wave4-harness-scrubber`, P4-07 merged in). Done 2026-10-04.

## What was built

**Server — the scene harness** (`apps/server/src/runtime/scene-harness.ts`, routes in `apps/server/src/http/dev-routes.ts`, bodies in `packages/protocol/src/dev.ts`):

| Route (all `POST` unless noted) | What it does, and through what |
|---|---|
| `GET /dev/harness` | ids of the harness's projects, tasks and fake agents still around |
| `/dev/harness/scenario` `{stewards 0–8, kind planet\|moon, bodyId?, asteroid}` | `Commands.createProject` (free body of `kind`, or `bodyId`), a fake Waykeeper, `stewards` project tasks (`Commands.createTask`) each with a fake Steward, and a standalone task on a fresh asteroid with its Steward; all set working (Waykeeper "Planning…", Stewards cycling gathering / building / transporting) |
| `/dev/harness/agents` `{role, projectId?, taskId?}` | a fake agent on existing work (a Steward on a new project task or a new asteroid task when no task is given); one running agent per task / project |
| `/dev/harness/agents/:id/state` `{state, activity?}` | the runtime's agent event for the state, through `Commands.recordAgentEvent`: `agent.progress` (working), `agent.idle`, `agent.paused` / `agent.resumed`, `agent.stalled`, `agent.finished`, `agent.failed`, `agent.stopped`, `agent.spawned` (starting, and first whenever the agent is ended); `waiting_for_input` asks a permission question |
| `/dev/harness/agents/:id/activity` `{preset \| text}` | an `agent.tool_call` per archetype (Grep → gathering, `git commit` → transporting, `pnpm test` → building, TodoWrite → none) or an `agent.progress` line |
| `/dev/harness/agents/:id/question` `{kind, text?}` | permission: `agent.needs_input` (the runtime's path; always the user's). Clarification: `Commands.openQuestion({toUser})` plus `agent.needs_input` so the agent waits |
| `/dev/harness/questions/:id/answer` `{answer?}` | `Commands.answerQuestion` as the user |
| `/dev/harness/tasks/:id/move` `{projectId}` | `Commands.moveTask` (its Stewards are handed over and fly) |
| `/dev/harness/tasks/:id/complete` | its live fake Stewards `agent.finished`, then `Commands.control(task, close)` — the Steward lands (decision 77) |
| `/dev/harness/projects/:id/close` | its fake Waykeeper finishes, then `Commands.control(project, close)` |
| `/dev/harness/clear` | stops the harness's live fake agents, closes + archives its tasks and projects (bodies freed); best effort, refusals listed in `skipped`; never touches real rows |

- Registered only with `GALACTIC_DEV=1` (as before), bearer-guarded, and **refused to remote clients** (403 `remote_dev`) — this guard now covers every `/dev/*` route, the older `/dev/events` and `/dev/seed` too.
- Fake agents: `meta.harness: true`, runtime `fake`, no session, no process; made in one command as the runtime makes rows (`checkPlacement`, `createAgent`, `recordSpawned`).
- A harness project's Waykeeper and harness asteroid Stewards answer to a **dormant harness Harmonizer** row: never spawned (no status record, so never "living": question routing skips it), `createdAt` at the epoch (never picked as "the newest Harmonizer" by a hand-over's fallback or the panel). Reason: with the real Harmonizer as supervisor, every fake failure / finish / control on an asteroid task would wake the real brain (an LLM turn each).
- `StatusStore`'s `stallThresholdMs(runtime, agentId)` now takes the agent; the composition returns ∞ for fake agents (5 s for the `fake` runtime would turn every harness satellite orange). Recovery (`AgentRuntime.recover`) ends a fake agent `stopped` instead of `interrupted`, so a restart never reopens one (a Waykeeper fake would otherwise be resumed as a brain).
- A fake agent that moves on from waiting (to working, idle, stalled, starting) has its open questions withdrawn (`question.cancelled`), so beacons do not outlive the waiting; paused keeps them; endings settle them through the runtime's ending path.
- A real agent with a live session can be given states and activities but not an ending or a restart (409: stop it from the panel).

**Web — the `/debug` "Scene harness (dev)" tab** (`apps/web/src/console/SceneHarness.tsx`, `harness-model.ts`, `harness-api.ts`): seed / clear a scenario (Stewards count, planet or moon, asteroid task); the agent list (live first, fake before real, label "Waykeeper · project" / "Steward · task", body, activity); for the selected agent: state buttons, activity presets plus a free progress line, Ask permission / Ask clarification, Answer for its open questions, Complete task, Close project, Move task to <project>, Fail, Stop, add a Steward / an asteroid Steward / a new Waykeeper. Each state switch is timed from the click to the status reaching the page ("paused reached this page in 112 ms") — the scene reads the same stream. The Phase 4 exit-criteria checklist with steps sits at the bottom.

**Scene — event toasts** (`apps/web/src/scene/toasts/`): a ring expands from a body and fades (1.6 s) when a task or project completes there (warm white, while its satellite lands), and an amber ring when a question starts waiting for the user (under its beacon). Only live events (`at` ≤ 5 s old; snapshots and catch-up replays never toast); one per body and kind (a burst restarts it); at most 4 at once; a pool of 4 rings, nothing drawn when idle. Reduced motion: a still, dimmer ring for 1.2 s. Over a timeline replay (P4-07, `replayWorld` set) live events do not flare — the scene shows the past and a ring over a body the replay may not draw would mislead; replayed completions do not flare either (a possible follow-up: flare from the replayed world's changes). The feed reads its bodies through `sceneWorld`.

## Proposed SPEC decision (for `SPEC.md` §7, next number — 79 if P4-07's 78 is taken)

> | 79 | Scene harness and event toasts | **A development harness drives the scene with real events; finishes and questions flare briefly** (2026-10-04, P4-06; §4.1, decisions 68, 72–74, 77): in development mode only (`galactic start --dev`, `pnpm dev`), and only on the server's own machine, the ops console (`/debug`) has a "Scene harness" tab. It seeds a demo scenario (a project with a Waykeeper and Stewards, plus a standalone task on an asteroid) whose agents are stand-ins with no process, and drives any Waykeeper or Steward: its state (working, waiting, idle, paused, stalled, starting, finished, failed, stopped), its activity (gathering, transporting, building, nothing clear, or a free line), a permission or clarification question for the user and its answer, moving a standalone task into a project, completing a task, closing a project. Everything it does is an ordinary event, so the scene, the panel, the inbox and the history show it as they would show agents doing it; stand-ins never stall on their own and are never resumed after a restart. "Clear" stops the stand-ins and archives what the harness made, nothing else. The tab times each state switch from the click to the page and lists Phase 4's exit criteria with how to check them. In the scene, a body flares briefly — a soft ring that expands and fades in under two seconds — when a task or project completes there (warm white, as its satellite lands) and when a question starts waiting for the user (amber, under its beacon). Only live events flare (not a page load, a reconnect's catch-up, or a timeline replay); one ring per body at a time, at most four at once; with reduced motion the ring is still and short. |

## How to verify Phase 4's exit criteria with the harness

Setup: `pnpm dev` (or `galactic start --dev`) on this machine. Open the panel `/` (scene shown) in one window and `/debug` → **Scene harness (dev)** in a second window beside it.

1. **"Switching an agent's state in a test harness changes its satellite behaviour within a second."**
   1. Press **Seed demo scenario** (3 Stewards, planet, asteroid task). In the panel, click the new "Harness project 1" planet: a warm Waykeeper satellite and three blue Stewards orbit it, scanning; their activities show (drones, robots, a shuttle).
   2. In the harness select "Steward · Harness task 1.1". Click **Paused** (violet, holds still), **Waiting for you** (amber, larger, blinking; an amber beacon and a brief amber ring on the planet), **Idle** (grey, steady — the beacon goes out), **Stalled** (orange hiccup), **Working** (blue, breathing, scans), **Fail** (red, smaller, flickers, drifts).
   3. After each click read "… reached this page in N ms" under the state buttons: N must stay under 1000 (typically ~100–150 ms: the status store's 100 ms batch). The satellite changes in the same frame the page gets the status.
   4. Activity: with the Steward working press **Gathering**, **Transporting**, **Building**: the animation switches within about a second (decision 73's hold).
2. **"Moving a task to a project flies its satellite there."**
   1. Select "Steward · Harness asteroid task 1"; in the panel click its asteroid in the belt.
   2. Under **Move task to** keep "Harness project 1" and press **Move**: the satellite takes off and flies (~3 s) to the project's planet; the asteroid folds back into the belt (decision 63). The camera may be anywhere: the flight completes.
   3. Also: **Complete task** on any Steward → its satellite lands on the planet with a brief warm ring; select the Waykeeper and **Close project** → the Waykeeper lands and the planet is colonised (warm lights).
3. **"A designer or friend can tell which planets are busy without reading text."**
   1. Seed two scenarios. Leave scenario 1 working. In scenario 2 put one Steward Idle, one **Waiting for you**, one **Fail**, and the Waykeeper Idle.
   2. Zoom out to the whole system view. Ask someone who has not seen the app: which planets are busy, which need you, which have a problem? Record the answers here (below).
   3. **Clear harness scenario** when done.

Results (to fill in by Cosmin): …

## Tests

- `apps/server/src/http/dev-harness.test.ts` (18): not registered without `GALACTIC_DEV` (404), needs the token, refused for a remote client (forwarded header, tailnet origin) on harness and older dev routes, body validation; scenario rows (project, bodies, Waykeeper / Stewards placement and supervisors, dormant Harmonizer, asteroid task, activities, derived task state, reuse of the dormant Harmonizer, body/moon choice); every state injected as agent events and pushed on the status stream; a state change reaches the status listener in < 1 s; a fake agent never stalls on its own (50 ms threshold ticked every 20 ms); activities by preset and text; fake agent creation and the one-running-per-task refusal; move (task.updated, body.moved, agent.updated, hand-over to the Waykeeper); complete (agent.finished before control.close); close project; permission and clarification questions held by the user, answer, withdrawal when moving on, cancellation on failure; clear archives only harness rows; recovery ends fakes stopped.
- `apps/web/src/console/scene-harness.test.tsx` (3): end to end against the real composed runtime and Fastify routes (dev on), page fed like the session: clicking each state button changes the satellite spec (`satelliteList(SCENE_SATELLITES)`) within 1000 ms from the click and the latency line appears; the look changes (tint, orbit rate 0 when paused); Building sets the archetype; Ask permission raises a beacon on the Steward's body and Answer removes it; Move flies the asteroid Steward to the project body; Complete lands the Steward; Fail keeps a failed satellite; Clear removes every harness satellite. Plus the dev-routes-off message and the checklist.
- `apps/web/src/console/harness-model.test.ts` (4): rows, work actions and move targets, latency settling, checklist.
- `apps/web/src/scene/toasts/toast-model.test.ts` (6): which events toast (completion of task / project, questions waiting for the user incl. the Harmonizer's on Earth and an escalation; others quiet), freshness, log reading, dedupe + cap, motion vs reduced-motion look and lifetime.
- `apps/web/src/scene/toasts/Toasts.test.tsx` (3): a fresh completion asks for a frame, quiet / stale events do not, a frame without anchors draws nothing; no flare over a timeline replay; a snapshot never toasts.

Gates on the branch: `pnpm build`, `typecheck`, `lint`, `format:check`, `test` all green (protocol 67, server 933 + 1 skipped, web 1027). three.js stays out of the panel's first chunk (`index-*.js` holds no three; toasts live in `SolarScene-*.js`). No browser run was made for this task: the satellites' response is covered end to end at the store / satellite-spec level; the visual ring itself was not looked at in a real WebGL context — worth a glance during the exit check.

## Shared files touched

`packages/protocol/src/index.ts` (export `dev.js`; merged with P4-07's `replay.js`), `apps/server/src/app.ts` (dev routes get commands / statuses / runtime), `apps/server/src/runtime/status-store.ts` (`stallThresholdMs` takes the agent id), `apps/server/src/runtime/compose.ts` (fakes never stall), `apps/server/src/runtime/agent-runtime.ts` (recovery ends fakes stopped), `apps/web/src/App.tsx` (the tab), `apps/web/src/app.css`, `apps/web/src/scene/SolarScene.tsx` (`<Toasts />`), `docs/TECHNOLOGY.md` (§2.1 bullet, §8 dev routes).

## Deferred

- Toasts from a timeline replay's own changes (a replayed completion flaring) — suppressed for now.
- A "landed" toast distinct from "completed" (they coincide today: a task completes as its Steward lands).
- The designer/friend test itself (exit criterion 3) is a human check: results to be written above.
