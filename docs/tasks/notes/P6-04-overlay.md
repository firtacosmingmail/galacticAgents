# P6-04 — Project overlay: tasks, Stewards, sub-project moons

Branch `p6-04-overlay` (from `p6-wave3-overlay-hq-view`), 2026-10-05. Code in `apps/web/src/scene/detail/overlay/`. The technical summary is in `TECHNOLOGY.md` §2.1 ("Project overlay in the detail view").

## What was built

| File | What it does | three.js? |
|---|---|---|
| `detail/overlay/overlay-model.ts` | Which tasks (`projectTasksOn`), footing (`overlayFooting`), deterministic slots (`assignSlots`, `surfaceSlot`, `orbitSlot`), positions (`surfacePoint`, `orbitPoint`, `spinAngle`), looks (`markerLook`, `markerBrightness`), selection (`taskSelection`, `selectedTaskOf`), moons (`moonLinks`, `parentPlanetOf`), the marker list (`overlayMarkers`), the cut rule (`cutAway`), sizes and caps. | no |
| `detail/overlay/task-registry.ts` | The markers as picking sees them (like the beacons' registry): `publishTaskMarkers`, `taskMarkerHit` / `taskMarkerUnder`, `taskMarkersDrawn`. | no |
| `detail/overlay/activate.ts` | `activateTask`: a marker click. | no |
| `detail/overlay/overlay-mesh.ts` | Procedural pin, buoy, robot, drone and glow geometries (`simple` on mobile). | yes |
| `detail/overlay/ProjectOverlay.tsx` | The part: instanced markers, stand-ins, highlight rings, tethers; frame functions `placeMarkers` / `drawStandIns`. | yes |
| `satellites/placement.ts` | Placement overrides: a view shows an agent elsewhere than its orbit. | no |
| `detail/cutaway/cut-planes.ts` | The cutaway's planes, shared. | type only |

### Tasks

- **Which.** Every project task on the shown body (`task.bodyId`, decision 9), except archived and moved work. Proposed and approved tasks show (grey, smaller); completed tasks show dim and small; they are the first left out past the cap.
- **Where.**
  - A rocky planet or a moon: **pins** on the surface. Slots are a 48-point Fibonacci lattice over ±55° latitude (the poles stay clear). Pins ride the planet's tilt and spin like its terrain, so a task goes round to the far side and back every 40 s (`SPIN_PERIOD`); under reduced motion the planet stands still and so do the pins.
  - A gas or ice giant (Jupiter, Saturn, Uranus, Neptune — `footingOf`'s rule): **buoys** on three low orbit rings (1.22, 1.38, 1.54 anchor radii, inclined a few degrees, 12 slots each), under the satellites' innermost shell (1.8). They go round slowly (70–98 s), still under reduced motion.
- **Deterministic.** Slot = `hash(task id) mod slots`, the next free slot when taken; tasks are taken oldest first (`createdAt`, then id). A task's slot therefore depends only on it and older tasks: the same in every session and on every machine, and a new task never moves an older one (tested). Caps per tier: 48 / 36 / 24; past the cap open work wins and the newest completed tasks are dropped.
- **Look.** A pin (hexagonal pad and mast) with a glowing head, or a small buoy in a ring with a glow, coloured by the task's state with the satellites' palette: amber, larger and blinking in step with the waiting satellites when blocked on you; light blue and breathing in progress; green awaiting closure; violet paused; orange interrupted; red flickering failed; warm, small and dim completed; grey planned. Colour is never the only cue (size and pulse differ). Reduced motion: no pulse, the still levels. Markers stay between 7 and 44 CSS px on screen (a buoy passing right in front of the camera would otherwise fill the view) and grow in with the cross-fade.
- **Cost.** Two instanced solids (pins, buoys), a third for the uncut moon pins, two instanced glows (cut and uncut), one for robots, one for drones, two rings, one tether line: each hidden when empty, so a typical view adds 3–5 draw calls whatever the number of tasks.

### Clicking and the panel

- **Hover:** the task's name and state ("Harness task 1.2 · in progress") at the pointer, in the body's hover label style (`TaskHover`; no body is hovered, the body's label is not lit).
- **Click:** selects what the task's row in the panel's navigation selects — its Steward, the newest live one else the newest (`primaryAgent`) — so the panel shows the Steward's view, its row lights up and the URL becomes `/steward/<id>`. The camera flies to the marker's body (in the body's own view that keeps the detail framing). A task no Steward has started selects nothing and shows an info card ("Task on Mars · … · no Steward yet"), as a body does.
- **Panel → scene:** when the panel selects a Steward, its task's marker gets the selection's blue ring; the hovered marker gets the faint white ring. Rings are drawn over everything but hidden while the marker is behind its body.
- **Picking rule:** beacons first (unchanged); then a marker under the pointer (its drawn radius or 9 px), not behind a body, wins over labels and the body — and over a satellite unless the satellite is nearer the pointer on screen (a Steward's robot stands beside its pin, and either click selects the same Steward). The planet's own sphere is tested at the planet's radius, not the anchor's (a ringed planet's pick sphere is its rings' reach). Markers are re-picked every frame while drawn (they move with the spin).

### Stewards: robots and drones

- A Steward orbiting the shown body whose task has a marker is **put down by it**: beside the pin (0.07 rad, a seeded direction) as a tracked robot on a rocky planet or moon; just outside the buoy as a drone round a giant. At most 16 / 12 / 6 per view (tier); the rest keep their satellites.
- **How** (`satellites/placement.ts`): the overlay registers a placement override per Steward (world position, `k`, a span `scale` of 0.5). The director applies it after placing the satellite on its orbit, only while it orbits (never a flight, a landing or a landed satellite): the frame moves toward the position by `k` — the cross-fade, eased — and is `claimed` from `k` ≥ 0.5, when `Satellites.tsx` draws neither the satellite nor its beam and the overlay draws the robot or drone at the frame. So the Steward glides down from its orbit while the view fades in, turns into a robot half way, and goes back up on the way out.
- **Everything follows the frame:** picking and the hover card ("Steward · Harness task 1.2 · gathering · Mars"), the hover and selection rings, the beacons' asker, and the **Phase 4 activities** (decision 73: gathering drones rise to the robot, the transport shuttle runs from it to the Waykeeper's satellite, building robots work round it, a platform is assembled under a drone). Their pieces scale with the frame's span (halved while claimed, so they match the robot).
- The robot's light (and the drone's) is the satellite's state colour with its pulse; the robot bobs while its Steward has an activity (still under reduced motion).
- The Waykeeper keeps its satellite (it coordinates from orbit).

### Moons

- **Sub-project moon, in the planet's view:** a faint warm tether (the Waykeeper's colour) from the planet's surface toward the moon, and the moon's own tasks as pins on it (uncut by the planet's cutaway). Its Waykeeper's satellite already orbits it (P4-01). Clicking one of its pins selects that Steward and flies to the moon (as clicking the moon does: it leaves the planet's view).
- **Sub-project moon, in its own view:** a tether from the moon toward its planet.
- **Independent-project moon:** no tether and no pins in the planet's view; it keeps the scene's teal ring (`MoonMarkers`, decision 66), which already shows in the detail view (checked in the browser: Europa tethered in Jupiter's view; Ganymede's teal ring seen around Jupiter).

## Decisions taken

- **Surface markers ride the spin.** A surface slot is a place on the terrain, so pins turn with the planet and pass behind it; a task on the far side comes back within 20 s (or the user turns the camera). Alternative rejected: pins fixed in the planet's tilted frame, which would make them slide over the terrain.
- **Cutaway: surface markers are clipped with the surface.** The cutaway publishes its two world-space planes; the overlay's pins, their heads and the robots on the shown body use the same planes (`clipIntersection`, assigned once while mounted, so no recompile when the cut opens or closes). What stands on the removed wedge goes with the crust, and a pin in the wedge is not a pick target. Orbit buoys, drones and the pins on moons are never cut (the planes extend beyond the body). Known gap: a robot whose frame stands in the wedge is clipped but its satellite frame can still be picked.
- **Stewards are relocated, not duplicated.** One Steward = one thing on screen: the orbiting satellite becomes the robot or drone; nothing new to pick.
- **Keyboard (decision 81).** Markers are not keyboard targets in the scene; the panel's navigation lists every task (keyboard and screen reader), and selecting one there rings its marker. The hover label is `role="tooltip"` as for bodies. A scene shortcut to step through tasks is left for later.
- **Labels (decision 66).** No permanent label per task (the planet's label stays the project's); the hover names the task.

### Proposed decision 8x (88 unless P6-06/P6-07 take it; for SPEC §7, numbered at merge)

> | 8x | Project overlay | **A project's tasks and Stewards up close** (2026-10-05, P6-04; §3.2, §4.1, decisions 9, 66, 68, 72, 73, 81, 84, 86): in the detail view of a planet or moon that hosts a project, each of the project's tasks is a small marker — a pin on the surface of a rocky planet or a moon, a beacon buoy in a low orbit round a gas or ice giant — always at the same place for the same task (a new task never moves an older one; pins turn with the planet). Its light shows the task's state with the satellites' colours: amber, larger and blinking when it is blocked on you, light blue in progress, violet paused, red failed, dim when completed, grey while only planned; with reduced motion nothing blinks. Hovering a marker names the task and its state; clicking it selects the task's Steward, as its row in the panel does (a task no Steward has started shows what it is). When the panel selects a Steward its task's marker is ringed. The Stewards working there come down from their orbits as the view opens: robots beside their task's pin on a planet or moon with a surface, drones by their task's buoy round a giant, still doing what they do (gathering, carrying to the Waykeeper, building); the Waykeeper stays in orbit. A moon hosting a sub-project is tied to its planet by a faint line and shows its own tasks in the planet's view; a moon hosting an independent project keeps its teal ring and nothing ties it to the planet. With the cutaway open, markers on the removed wedge go with it. Completed and archived work beyond the space available is left out, oldest open work first kept. |

And in §4.1, after the Stewards bullet: "(up close, decision 8x)".

## Tests (Vitest, no WebGL)

- `detail/overlay/overlay.test.ts` (22): part registration (planets and moons, not asteroids); footing; which tasks and the cap rule; slots — same in every session, distinct, a newer task never moves an older one, probing, the lattice band; `surfacePoint` equals three's nested tilt/spin; orbit rings under the satellites' shell, distinct, still at t = 0; looks (blocked louder, closed dimmer), reduced motion constant; texts; `descent`; selection (newest live Steward, else newest, else none; highlight only for Stewards); moons (sub-project vs independent, parent planet), sub-project moons' markers in the planet's view; the cut rule with three `Plane`s (parked planes cut nothing); picking a marker (near side hit, far side and behind another body never, own body at the surface radius, nearest of several, hidden ones skipped).
- `detail/overlay/overlay-ui.test.tsx` (5, jsdom): the part publishes a frame per task (StrictMode), none after unmount, disposes its geometry; a new task adds a frame; mobile mounts; an asteroid draws nothing; `activateTask` selects the Steward, flies, updates the URL; a task without Steward shows the info card; task hovers name the task, hover no body, are not re-set.
- `satellites/placement.test.ts` (5): the director moves an orbiting frame by `k`, claims from 0.5, scales the span; `k` = 0 changes nothing, clearing restores; flights and landed satellites are never taken over; the instanced renderer leaves claimed frames out.

- Gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` all green — protocol 70, server 976 (+1 skipped), web 1465 (111 files; 1433 → 1465). three.js is still absent from the panel's first chunk (`index-*.js`). The replay guard (`replay/store.test.ts`: no `s.world` in scene sources) caught a scratch field named `world`; renamed.

## Browser check

**Setup** (all from this worktree, all stopped afterwards; Cosmin's 5173/4321 and the other agent's 7713/7793/9483 untouched): the built server (`GALACTIC_DEV=1 GALACTIC_HARMONIZER=fake`, `GALACTIC_HOME` in scratch) on 127.0.0.1:7804, Vite on 7724, headless Chrome (`--use-angle=metal`, background throttling off) on CDP 9494, 1440×900 at DPR 2, tier high. Scenarios from the dev harness: a project on Mars (4 Stewards: building, gathering, waiting on a question, paused), one on Jupiter (3: building, transporting, idle), projects on Europa (made a sub-project of Jupiter's in the client store, the harness has no sub-project scenario) and Ganymede (independent). Screenshots in the session scratchpad (`shots-p604/`).

- **60 fps** in the system view and in Mars's detail view with the overlay, robots and activities (rAF over 2 s).
- **Mars:** pins on the surface turning with the planet, each Steward a robot beside its pin with its activity (gathering drones, transport pieces); (the amber/blink look is covered by the unit tests, not by a crop). Hovering a pin shows "Harness task 1.2 · in progress"; clicking it selected the task's Steward (`/steward/…`), its row lit in the panel, the marker ringed blue, the view stayed. Hovering the robot shows the Steward's card.
- **Jupiter:** buoys on the low rings with drones beside them; the tether toward Europa; Europa's pins placed in Jupiter's view (registry: 5 markers = 3 + 2).
- **Europa's own view:** pins and robots on the moon; the label reads "part of Harness project 2".
- **Cutaway on Mars:** the wedge opens with no pin floating over it.
- **Reduced motion** (emulated): marker screen positions identical across 2 s.
- **Fixed during the check:** heads were as big as the pin (the light-blue squares) → 0.8 of the head size; the buoy's core hid its glow → smaller core; a buoy or drone passing in front of the camera filled the view → 44 px cap; the robot's activity pieces were sized for a satellite → claimed span halved; hovering a pin always gave the Steward beside it → a marker nearer the pointer than any satellite wins.
- **Seen, not mine:** belt rocks and the system rings show in Mars's and Earth's views (P6-07); the faint hover ring of a body seen up close is a wide band (`HighlightRing`, P3-05).

## Shared files touched (small)

- `scene/detail/parts.ts`: one `DETAIL_PARTS` entry and two imports.
- `scene/frame-order.ts`: `PLACE_OVERLAY` (−0.6) and its doc line.
- `scene/satellites/director.ts`: `SatelliteFrame.claimed?`, the override after orbit placement, the span scale; `claimed` reset while hidden.
- `scene/satellites/Satellites.tsx`: claimed frames draw no satellite or beam (both paths).
- `scene/picking/store.ts`: `TaskHover`, `hoveredTask`, `sameHover` for tasks.
- `scene/picking/Picking.tsx`: markers in hover and click, re-pick while drawn.
- `scene/detail/cutaway/Cutaway.tsx`: publishes its planes (two lines).
- Not touched: framing, camera, the HQ station, the eclipse shadow, SPEC, the phase file, `docs/tasks/README.md`.

## Deferred

- **A keyboard path through the tasks in the scene** (e.g. `]`/`[` over markers in a detail view) and a screen-reader announcement.
- **Harness:** a sub-project scenario (`kind: 'moon', parentProjectId`) would make the Europa check reproducible without editing the store.
- **Landed Stewards** stay where the director lands them (their orbit's foot), not by their task's pin.
- **A robot cut by the cutaway** is still pickable through its satellite frame.
- **Saturn:** buoys at 1.22 × the anchor radius sit just outside the rings; not checked in the browser.

## What Cosmin should try

1. Start a project on Mars with a few Stewards (`/debug` harness), open Mars's detail view: pins on the surface, robots beside them coming down from orbit as the view fades in.
2. Hover a pin, click it: the panel shows that task's Steward. Select another task in the panel: its pin is ringed.
3. Jupiter: buoys and drones in low orbit. With a sub-project moon, the tether and its pins.
4. Open the cutaway on Mars: pins on the wedge disappear with it.
