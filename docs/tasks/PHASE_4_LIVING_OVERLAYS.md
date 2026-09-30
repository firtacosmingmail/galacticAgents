# Phase 4 — Living overlays: satellites, scans and workers

**Current task:** — (phase not started; first task will be P4-01) · **Task status:** —
**Phase status:** not started (0/7 done)

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
- **Status:** todo · **Depends on:** P3-07 · **Parallel with:** —
- `<Satellite agent>` component with the state machine above, orbit parameters per body, periodic scanning cone/beam (bloom), tweened transitions, instanced rendering path when count is high, animation cap.
- **Acceptance:** a satellite per active Waykeeper/Steward orbits the right body; state switches animate smoothly.

### P4-02 — State → visual mapping and HQ station
- **Status:** todo · **Depends on:** P4-01 · **Parallel with:** P4-03, P4-05
- Colour and pulse per agent state (working, waiting_for_input, paused, stalled, idle, failed); Harmonizer HQ station orbiting Earth with its own idle/thinking indication; legend in the panel.
- **Acceptance:** a designer or friend can tell which bodies are busy, blocked, or failed without reading text.

### P4-03 — Steward activity archetypes
- **Status:** todo · **Depends on:** P4-01 · **Parallel with:** P4-02, P4-05
- Derive `gathering | transporting | building` from `current_activity` / summariser output (reading & searching → gathering; producing output / commits → transporting between Steward and Waykeeper satellite; running builds/tests/editing many files → building); surface robots on rocky bodies, orbital platforms on gas giants; raw activity text stays available in the panel (corner case 32).
- **Acceptance:** switching activity in the harness changes the archetype within a second.

### P4-04 — Body transitions: fly, land, colonise, moved marker
- **Status:** todo · **Depends on:** P4-01, P2-12, P2-13 · **Parallel with:** —
- On `body.moved` the satellite **flies** from the old body to the new one (task joins a project, promotion); on completion the satellite **lands** and the body is marked colonised; "moved to …" marker on the old body during retention; archival clears markers.
- **Acceptance:** moving a task to a project in the panel flies its satellite there; completing a task lands it.

### P4-05 — Question beacon
- **Status:** todo · **Depends on:** P4-01, P2-03 · **Parallel with:** P4-02, P4-03
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

## Exit criteria (from the plan)

Switching an agent's state in a test harness changes its satellite behaviour within a second; moving a task to a project flies its satellite there; a designer or friend can tell which planets are busy without reading text.
