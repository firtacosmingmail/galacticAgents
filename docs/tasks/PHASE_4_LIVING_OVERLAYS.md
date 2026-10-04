# Phase 4 — Living overlays: satellites, scans and workers

**Current task:** P4-12, P4-13 (added to wave 2, branch `p4-wave2-state-activity-beacons`) · **Task status:** in progress
**Phase status:** in progress (8/13 done) — on branch `phase-4`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

The map shows *what agents are doing*, continuously, from the status store: a satellite per active agent, scanning beams, Steward activity archetypes, satellites flying between bodies on moves and promotions, landing on completion, and beacons for open questions.

## Entry criteria

- Phase 3 exit criteria met.

## References

- `IMPLEMENTATION_PLAN.md` → Phase 4; corner cases 21, 26, 32.
- `TECHNOLOGY.md` §2.1 (satellite actor state machine), §4 (status record fields, summariser driving the animation choice).
- `SPEC.md` §3.4 (moves and promotions fly), §4.1 (satellites, Steward activities, beacon, colonised), §4.4 (states), decisions 4, 9, 15.

## Design notes for implementation

- **Satellite = actor with a small state machine:** `orbiting | scanning | gathering | transporting | building | flying | landing | landed`, driven by `StatusRecord.state`, `current_activity` and `body.moved` / completion events. Transitions are tweened; flights complete even when the camera is elsewhere.
- Colour/pulse mapping for agent states: working / waiting_for_input / paused / stalled / idle / failed.
- Building animation only on bodies with a surface (rocky planets, moons, asteroids); gas giants get orbital platforms.
- Hard cap on simultaneous animations; instanced satellites when many.
- The Harmonizer has an HQ station orbiting Earth (full detail in Phase 6).

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P4-01 | Satellite actor first. |
| 2 (parallel) | P4-02, P4-03, P4-05 | State mapping, archetypes and beacons are independent uses of the actor. |
| 3 | P4-04 | Body transitions build on the actor's flying/landing states. |
| 4 (parallel) | P4-06, P4-07 | Test harness/toasts and the optional scrubber. |

## Tasks

### P4-01 — Satellite actor and state machine
- **Status:** done (2026-10-03) · **Depends on:** P3-07 · **Parallel with:** —
- `<Satellite agent>` component with the state machine above, orbit parameters per body, periodic scanning cone/beam (bloom), tweened transitions, instanced rendering path when count is high, animation cap.
- **Acceptance:** a satellite per active Waykeeper/Steward orbits the right body; state switches animate smoothly.

### P4-02 — State → visual mapping and HQ station
- **Status:** done (2026-10-04) · **Depends on:** P4-01 · **Parallel with:** P4-03, P4-05
- Colour and pulse per agent state (working, waiting_for_input, paused, stalled, idle, failed); Harmonizer HQ station orbiting Earth with its own idle/thinking indication; legend in the panel.
- **Acceptance:** a designer or friend can tell which bodies are busy, blocked, or failed without reading text.

### P4-03 — Steward activity archetypes
- **Status:** done (2026-10-04) · **Depends on:** P4-01 · **Parallel with:** P4-02, P4-05
- Derive `gathering | transporting | building` from `current_activity` / summariser output (reading & searching → gathering; producing output / commits → transporting between Steward and Waykeeper satellite; running builds/tests/editing many files → building); surface robots on rocky bodies, orbital platforms on gas giants; raw activity text stays available in the panel (corner case 32).
- **Acceptance:** switching activity in the harness changes the archetype within a second.

### P4-04 — Body transitions: fly, land, colonise, moved marker
- **Status:** todo · **Depends on:** P4-01, P2-12, P2-13 · **Parallel with:** —
- On `body.moved` the satellite **flies** from the old body to the new one (task joins a project, promotion); on completion the satellite **lands** and the body is marked colonised; "moved to …" marker on the old body during retention; archival clears markers.
- **Acceptance:** moving a task to a project in the panel flies its satellite there; completing a task lands it.

### P4-05 — Question beacon
- **Status:** done (2026-10-04) · **Depends on:** P4-01, P2-03 · **Parallel with:** P4-02, P4-03
- A body with an open user-held question shows a visible beacon (distinct for permission vs clarification); clicking opens the question in the inbox.
- **Acceptance:** beacon appears/disappears with the question lifecycle.

### P4-06 — Test harness and event toasts
- **Status:** todo · **Depends on:** P4-02, P4-03, P4-04, P4-05 · **Parallel with:** P4-07
- Dev-only harness (`/debug`) to set an agent's state/activity and fire move/complete/question events; optional subtle 3D toasts (flare on task finish).
- **Acceptance:** exit criterion "switching an agent's state changes its satellite within a second" verifiable from the harness.

### P4-07 — Timeline scrubber (nice-to-have)
- **Status:** todo · **Depends on:** P4-04 · **Parallel with:** P4-06
- Replay the `events` stream for a project over a time range to see how it unfolded; read-only; can be deferred to Phase 8.
- **Acceptance:** scrubbing replays body assignments, moves and completions.

### P4-08 — Satellite hover card (added 2026-10-03)
- **Status:** done (2026-10-03) · **Depends on:** P4-01, P3-05 · **Parallel with:** P4-09
- Cosmin, after seeing the satellites: "I would want to be able to see information about them when I hover them with the mouse. Information like what agents they are and small info on what they are doing, like a title." Satellites become hover targets in the scene's picking (they win over the body under them); the hover card shows the agent's role and name (Waykeeper of <project> / Steward of <task>), its state, and a one-line title of its current activity. Clicking a satellite selects its agent (SPEC §4.1: "clicking a satellite selects that agent").
- **Acceptance:** hovering any visible satellite shows the right agent and activity within a frame; clicking selects that agent in the panel; tests.

### P4-09 — Hidable managed agents, compact project rows (added 2026-10-03)
- **Status:** done (2026-10-03) · **Depends on:** P25-04, P25-02 · **Parallel with:** P4-08
- Cosmin: "I don't need the Managed agents side panel. I want it hidable." and "in the projects side panel, when I select a Waykeeper, I want to see less information, but I want to know how many Stewards it uses." The managed-agents column gets a hide/show toggle remembered per browser (the panel layout reflows); a selected project's navigation row stays compact (its tasks collapsed unless opened) and shows how many Stewards it uses (running / total).
- **Acceptance:** the managed-agents column hides and stays hidden after a reload, with nothing lost (its controls remain reachable elsewhere: the agent's own view, the history); a selected project row shows its Steward count; tests.

### P4-10 — Chat docked at the bottom, minimisable (added 2026-10-03)
- **Status:** done (2026-10-03) · **Depends on:** P4-09, P3-12 · **Parallel with:** —
- Cosmin, after hiding the managed agents: "The inbox panel is now below and on top of the chat window. Now I cannot reach the chat. Move the chat to the bottom part of the screen, between the side panels. I want to be able to minimise the chat as well, and pull it back up." Also reported: "a big scroll on the page; the bottom of the page is empty and I can scroll to it." New layout: the scene fills the centre; the conversation (or the Steward view) is a panel docked at the bottom between the navigation (left) and the side column (inbox and, when shown, the managed agents — right); it can be minimised to a bar (keeping its title, the unread/typing hint and the controls strip's essentials) and pulled back up (button and drag handle for its height), remembered per browser; nothing ever overlaps another panel, and the page never scrolls. List mode (scene hidden) gives the conversation the centre. Phone widths keep a stacked layout with the same minimise bar.
- **Acceptance:** at every width from 320 px to 2560 px, with the scene and the managed agents shown or hidden and the chat open or minimised, no panel covers another and `document.scrollingElement.scrollHeight == innerHeight`; the chat minimises and comes back, its state remembered after a reload; tests.

### P4-11 — Parallel permission requests (added 2026-10-04)
- **Status:** done (2026-10-04) · **Depends on:** P1-09 · **Parallel with:** P4-12, P4-13
- Cosmin: the Harmonizer asked "May WebSearch run?"; pressing Allow showed "Internal" and nothing happened. Root cause (his database, read-only): the Harmonizer made two WebSearch calls in one turn; the Claude adapter kept one pending question per session, so the second `canUseTool` overwrote the first; answering the first threw "no pending question" after the answer was written, the command rolled back (500 `internal`), and the first tool call waited forever. Fix: pending questions by id (`Session.pending` is a map; interrupt, stop and the session's end settle all of them). Test: two concurrent `canUseTool` calls, both answered.
- **Acceptance:** met — the regression test fails before the fix and passes after; adapter suite green.

### P4-12 — Hidable inbox; closed projects out of the navigation (added 2026-10-04)
- **Status:** in progress · **Depends on:** P4-09, P4-10 · **Parallel with:** P4-13
- Cosmin: "I want to be able to hide the inbox as well" and "I want to be able to remove closed projects from the projects bar. There are a few demo projects that seem to be working on invented planets." The inbox gets a hide/show toggle like the managed agents (decision 69), with "N waiting" still visible and a way back; when the inbox and the managed agents are both hidden the side column goes and the centre takes the space. The navigation hides closed work (completed and archived projects and tasks) behind a "Show closed" toggle; a project can be closed and archived from the navigation (the controls strip's actions), so leftover demo projects can be cleared.
- **Acceptance:** the inbox hides and comes back, remembered per browser, with no overlap at any width; completed or archived projects are not listed unless "Show closed" is on; tests.

### P4-13 — A beacon per question, clicking it goes to the asker; no made-up planets (added 2026-10-04)
- **Status:** in progress · **Depends on:** P4-05 · **Parallel with:** P4-12
- Cosmin's answers on the beacon choices: the Harmonizer's own questions put a beacon on Earth (kept); one beacon per **question**, not per body; clicking a beacon also selects the asking agent and flies the camera to it (as well as opening the question in the inbox). Also: bodies that are not in the catalogue (demo planets made by the early dev buttons) are not drawn once nothing is on them.
- **Acceptance:** two questions on one body show two beacons; clicking one selects its asker, flies there and opens the question; a free non-catalogue body is not drawn; tests.

## Exit criteria (from the plan)

Switching an agent's state in a test harness changes its satellite behaviour within a second; moving a task to a project flies its satellite there; a designer or friend can tell which planets are busy without reading text.
