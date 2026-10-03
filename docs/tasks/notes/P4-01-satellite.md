# P4-01 — Satellite actor and state machine

Branch `p4-01-satellite` (from `p4-wave1-satellite`), 2026-10-03.

## What was built

Everything lives in `apps/web/src/scene/satellites/`. `SolarScene.tsx` has a one-line mount (`<Satellites quality={quality} />` after the belt).

| File | What it does | three.js? |
|---|---|---|
| `satellite-model.ts` | World → satellite list. One entry per **live** Waykeeper or Steward, meaning a status record whose state is not in `ENDED_STATES` — the rule is one exported predicate, `showsSatellite(world, id, { keepFailed, keepLanded })`, both options off for now. Each entry sits on its work's body: the project's body for a Waykeeper, the task's body for a Steward, falling back to `agent.bodyId` while the work row is missing. `sameSatellites` filters out status churn that changes nothing on screen. `harmonizer: true` adds the HQ station on `b-earth` (the hook for P4-02). | no |
| `machine.ts` | The actor: a pure state machine. Modes `orbiting \| scanning \| gathering \| transporting \| building \| flying \| landing \| landed`, a transition table (`TRANSITIONS`), `advance(actor, input, now, {reducedMotion})` and `sampleActor(actor, now)`. | no |
| `orbits.ts` | Orbit slots per body and deterministic orbits. | no |
| `director.ts` | Turns actors, the anchors' live positions, the clock and the camera's pixel size into one mutable `SatelliteFrame` per satellite. Also holds the animation cap and the instancing switch. | no |
| `registry.ts` | The published frames, keyed by agent id, like `anchors.ts` for bodies. | no |
| `look.ts` | Colour, brightness, size and beam constants. This is where P4-02 plugs in. | no |
| `satellite-mesh.ts` | The geometries: a merged satellite with a bus, two panels and a dish, shaded by vertex colours, and an open cone for the beam. Writes frames into matrices and colours without allocating. | yes |
| `Satellites.tsx` | The component. Feeds store → list → director, and writes the frames each frame into either the per-satellite meshes or the instanced meshes. | yes |

### Behaviour

- **Orbits.**
  - Each satellite orbits its body's anchor. It follows the anchor as the body moves, so it works at both scales.
  - Radius is 1.8 + 0.15 × slot body radii. Slots are **sticky**: a satellite keeps its slot while it lives on that body. An arrival (a new agent, or a flight to the body) takes the lowest free slot there; a Waykeeper takes slot 0 when it is free, otherwise the lowest free one. So a new Steward, a replaced Waykeeper or a flight landing on a crowded body never moves the others. On a fresh scene this gives Waykeeper 0, then Stewards by agent id.
  - An orbit change that still happens in place (a role change) blends radius, inclination and node over 0.6 s from where the satellite is, with its angle carried on.
  - Inclinations are spread by the golden ratio over ≈ 8°–60° and nodes by the golden angle. The phase comes from a hash of the agent id.
  - So no two satellites of one body share an orbit, and they are never closer than 0.15 R.
  - A Waykeeper turns in 28 s, a Steward in 16 s; outer shells are slower (× √(r / 1.8)).
- **Scanning.**
  - A `working` agent scans its body every 5–10 s (seeded per agent and per scan) for 2.4 s.
  - The beam fades in and out over 0.35 s and swings ±0.2 rad across the surface.
  - Agents that are not working (`idle`, `waiting_for_input`, `paused`, `stalled`, `starting`) only orbit.
- **The beam.**
  - It is an additive open cone (front faces only, 12 rings along its length) from the satellite to the surface, 0.22 R wide at the base. Its vertex colours fall off steeply from the apex: `beamProfile(along) = 0.02 + 0.98 (1 − along)³`.
  - With a composer, its colour is HDR at the apex (luminance ≈ 1.07, above the bloom threshold of 1.0), so it glows only near the satellite. From halfway down to the footprint it adds ≤ 0.155 luminance (`MAX_BODY_LUMINANCE`, tested), and ≈ 0.02 at the footprint.
  - A beam cut short (the agent stopped working mid-scan, or the animation budget went to another satellite) fades out over 0.3 s instead of popping.
  - On mobile (no composer) the gain is 0.35: a soft translucent cone.
  - It is on `DECOR_LAYER`, as are the satellites themselves, so the selection outline's depth pass skips them (P3-08).
- **Flights.**
  - A new body for a satellite starts a 3 s flight. It is eased, arcs upward by 0.18 × the distance flown, and ends on the destination orbit, which moves with the body.
  - The flight starts from wherever the satellite was drawn. If it was not drawn, it starts from its old orbit.
  - A flight runs to completion. Only a new destination retargets it, starting from where the satellite is. Landing or an archetype that arrives mid-flight waits for the arrival.
  - All timing is absolute on the motion clock, and the director applies a world change at `setSpecs` time, not at the next drawn frame. So a flight that started while the scene was hidden, on demand or capped has finished on the first frame after its end (corner case 26). Tests cover this.
- **Appearing and ending.** A satellite grows in over 0.4 s (scale) when its agent starts. When the agent ends it shrinks out over 0.4 s and is then dropped; it stays in the registry until then. An agent that comes back meanwhile grows back from where it was. Under reduced motion both are instant.
- **Landing (hook for P4-04).** `landed: true` descends to 1.03 R over 1.6 s, at the orbit angle the descent started from, then stays `landed`. `landed: false` takes off again (`orbiting`).
- **Archetypes (hook for P4-03).** A `working` agent with an `archetype` blends into that mode (0.6 s). Without one, or when not working, it goes back to orbiting. For now the renderer draws an archetype as plain orbiting with no beam; P4-03 draws the actual effects.
- **Instancing.**
  - Up to `quality.satellites.instanceAbove` satellites (12 high, 12 balanced, 8 mobile), each gets a mesh pair (satellite + beam), and the beam is hidden between scans.
  - Above that, one `InstancedMesh` holds every satellite and one every beam. Capacity grows in steps of 16, so buffers are not rebuilt for each new agent.
- **Animation cap.**
  - `quality.satellites.maxAnimated` is 16 / 12 / 6.
  - Flights and landings always animate (they must complete) and count toward the cap. A satellite whose body has no anchor takes no budget.
  - The rest of the budget goes to scans and archetypes in this order: the camera-focused body's satellites, then those that already had it (a running scan is not pre-empted), then Waykeepers, then Stewards, by agent id.
  - A satellite over the budget orbits with no beam.
- **Reduced motion.** Orbits are frozen at their seeded phase, there are no scans, and flights, landings, blends and fades are instant (a flight or landing running when it is turned on ends at once). The `demand` loop is `invalidate()`d on list, anchor and option changes. The mobile frame cap needs nothing extra, because motion uses the clock, not frames.

## SPEC decision 68 (recorded by the coordinator)

The text proposed here was added to SPEC §7 as decision 68:

> | 68 | Satellites | **One satellite per working agent, on its work** (2026-10-03, P4-01; §3.4, §4.1, decisions 4, 9, 63): every running Waykeeper and Steward has a satellite orbiting the body of its work: a Waykeeper its project's planet or moon, a Steward its task's body (a project task's Steward orbits the project's body, decision 9; a standalone task's Steward its asteroid). An agent that has not started yet, or has finished, failed, stopped or been interrupted, has none. The Waykeeper's satellite is larger and warmer; Stewards' are smaller and cooler; several satellites of one body take distinct orbits, always in the same places for the same agents. A working agent's satellite scans its body every few seconds with a short glowing beam; an idle, waiting, paused or stalled one only orbits (P4-02 gives each state its colour). When work moves to another body, its satellites fly there in about three seconds and the flight always completes, even if the camera is elsewhere. Only so many satellites animate at once (16 on high, 12 balanced, 6 on the phone tier); moves and landings always do, the camera's body comes first. With reduced motion the satellites stand still on their orbits and never scan, and moves are instant. |

## The actor's API, for P4-02, P4-03, P4-04, P4-05

- **Inputs.** Everything the machine reads comes from `SatelliteSpec` (`satellite-model.ts`), which the director turns into `SatelliteInput` (`machine.ts`):
  - `bodyId`: a change flies the satellite;
  - `state`: `AgentState`;
  - `archetype?: 'gathering' | 'transporting' | 'building'`: P4-03 sets it. Derive it in `satelliteList`, or in a new pure function there, from `activity` (the raw `currentActivity`, which stays available for the panel, corner case 32);
  - `landed?: boolean`: P4-04 sets it by turning on `keepLanded` (`satelliteList(world, { keepLanded: true })`): a finished Steward whose task is `completed` (`hasLanded`) stays in the list with `landed: true` while the server retains its record.
- **The list rule.** `showsSatellite(world, agentId, { keepFailed, keepLanded })` in `satellite-model.ts`, both off by default (live agents only, today's behaviour). **P4-02 turns on `keepFailed`**: a failed agent keeps its satellite, shown in its failure colour (`look.ts`). **P4-04 turns on `keepLanded`**, as above. Both go through `satelliteList`'s options.
- **HQ station (P4-02).** Call `satelliteList(world, { harmonizer: true })` in `Satellites.tsx`; it orbits `b-earth`, with its look in `SATELLITE_LOOK.harmonizer`.
- **Colour and pulse (P4-02).**
  - Replace `satelliteTint(spec)` (a CSS colour) and `satelliteBrightness(spec, view, now)` (a multiplier; above ≈ 1.4 a bright tint blooms) in `look.ts`. Both renderers read them every frame.
  - Satellites are unlit (`MeshBasicMaterial` with vertex colours), so a colour reads the same on a night side.
- **Reading satellites (P4-03 shuttles, P4-05 beacons, P4-04 markers, later picking).**
  - `getSatellite(agentId)` / `allSatellites()` / `satelliteIds()` / `onSatellitesChanged(cb)` in `registry.ts`. The renderer draws one satellite per `satelliteIds()` entry.
  - A `SatelliteFrame` has `position`, `target` (its body centre), `bodyRadius`, `size`, `mode`, `view` (`SatelliteView`: `from`, `blend`, `flight`, `beam`, `landing`), `animated`, `visible`, `presence` (0 → 1 growing in, back to 0 shrinking out), `role`, `bodyId` and `agentId`.
  - Frames are mutated in place each frame; copy what you keep.
  - A shuttle can fly between `getSatellite(steward).position` and `getSatellite(spec.supervisorId).position`.
- **The machine.**
  - `TRANSITIONS` and `canTransition` define the legal edges. A new trigger must add its edge there; a test walks every change against the table.
  - `TIMING` holds every duration.
  - `advance` is pure and returns the same object when nothing changed. `createActor(agentId, input, now)`.
- **Director.**
  - `new SatelliteDirector({ satellites, reducedMotion })`, `setSpecs(specs, now)`, `update(now, anchorLookup, pixelSize?, focusBodyId?)`, `reset()` (forget everything and publish none: unmount and StrictMode's rehearsed unmount).
  - `actor(agentId)` is for tests and the P4-06 harness.
  - `applyAnimationCap(frames, cap, focus)` and `instancedPath(count, quality)` are pure.
- **Picking.** Not changed. A satellite pick would test `frame.position` with a radius of `max(frame.size, min px)`, the same way `picking/pick.ts` tests anchors, and select `agentId` (SPEC §4.1: "clicking a satellite selects that agent").

## Shared files touched

- `apps/web/src/scene/SolarScene.tsx`: import + one `<Satellites quality={quality} />` line (with a comment).
- `apps/web/src/scene/quality.ts`: a `satellites: { instanceAbove, maxAnimated }` field on `SceneQuality` (the `SatelliteQuality` type), the values in the tier table, and its doc paragraph.
- `docs/TECHNOLOGY.md` §2.1: one new "Satellites (P4-01)" bullet after the existing one-line satellites bullet (which now lists `landed` too).
- Review fixes: `apps/web/src/scene/frame-order.ts` (new), `bodies/Bodies.tsx` (`useOrbit` at `PLACE_BODIES`, exported for its test) and `belt/Belt.tsx` (the spin at `PLACE_BODIES`).
- `SPEC.md` decision 68 was recorded by the coordinator. Not touched: the phase file's status lines, `docs/tasks/README.md`, picking, anchors, labels.

## Deferred

- The archetype visuals (P4-03): archetypes are modes now, drawn as orbiting.
- State colours and pulse, the HQ station and the legend (P4-02): the hooks are in `look.ts` and the list option.
- Landing on completion and the colonised marker (P4-04). The machine, renderer and list handle `landed`; P4-04 turns on `keepLanded`.
- Failed agents keeping their satellite (P4-02 turns on `keepFailed`).
- Satellite picking (a later task, or P5): frames are published for it.
- When a body's anchor disappears (its work moved and the asteroid rejoined the belt), a satellite still assigned to it is hidden. If a flight's origin anchor is gone and the satellite was never drawn, the flight starts at the destination.

## Review fixes (2026-10-03, branch `p4-01-fixes`)

1. **StrictMode left the registry empty in dev.** The rehearsed unmount published an empty map and the re-run layout effect skipped `setSpecs` (`applied` still equal). The cleanup now resets `applied` and calls `director.reset()`, so the remount applies the list again. Test: `Satellites.test.tsx` renders under `<StrictMode>` (fake R3F) and finds the satellites in the registry; it fails without the fix.
2. **Satellites jumped when a slot shifted.** Slots are sticky (`orbitSlots(specs, previous)`), and an in-place orbit change blends over `ORBIT_TWEEN` (0.6 s). Tests: a new Steward spawning, a Waykeeper replaced, a Waykeeper arriving after a Steward took slot 0, a flight arriving at a crowded body (residents' offsets equal a director that never saw the change), and a role change with no jump and small steps.
3. **The list rule is explicit.** `showsSatellite` with `keepFailed` / `keepLanded` (off by default), `hasLanded`; tests for the default and both options.
4. **The pale spot on bright planets.** The beam's vertex colours follow a cubic falloff over 12 rings (the old cone had one ring, so the fade was linear: ≈ 0.6 luminance added halfway down); the bloom gain is 1.25 (apex luminance ≈ 1.07, still above the threshold). From halfway down it adds ≤ 0.155, ≈ 0.02 at the footprint. Tested numerically (`satellite-mesh.test.ts`); no headless screenshot was taken for this fix.
5. **One-frame position lag.** Body placement (`useOrbit`, the belt spin) runs at `useFrame(cb, PLACE_BODIES = -1)` (`frame-order.ts`), before every reader at the default 0. Test: `frame-order.test.tsx` runs a fake R3F loop in priority order with a reader subscribed before the body; it sees the current position (it fails at priority 0).

Nits: a flight or landing running when reduced motion turns on ends at once; beams cut short fade out over 0.3 s; satellites without an anchor take no budget; a running scan keeps its budget; the cap's passes and the pixel-size function are hoisted (no per-frame allocation); satellites grow in and shrink out over 0.4 s. Not done: `view.blend` for archetype and landed transitions (archetypes are not drawn until P4-03, and landing already uses `view.landing`), and skipping the dispose of shared geometry and materials in StrictMode's rehearsed unmount (dev-only; three.js uploads a disposed geometry again on its next use).

## Tests (Vitest, no WebGL)

There are 63 new tests in 5 files under `apps/web/src/scene/satellites/`:

- `machine.test.ts` (21):
  - the transition table, including a run that checks every observed change against it;
  - creation and determinism;
  - periodic scans: count over 60 s, beam fade, seeded intervals, no scans when not working, de-synchronised agents;
  - flights: timing, completion with no intermediate call, archetype and landing deferred until arrival, retargeting;
  - landing and take-off; archetypes;
  - reduced motion: no scans, instant flights, landings and blends; a running scan ends;
  - easing and interval bounds.
- `satellite-model.test.ts` (8): which agents get a satellite (live Waykeepers and Stewards; not the Harmonizer until asked; none without a status record; ended states removed, every live state kept); which body (work body; moved task and moved project follow; fallback); `sameSatellites`.
- `orbits.test.ts` (7): slots (Waykeeper first, order-independent), determinism, radius and handedness conventions, and spacing: 13 satellites on one body never closer than 0.15 R over 120 s, with distinct planes.
- `director.test.ts` (18):
  - placement follows a moving anchor; hidden without an anchor; size floor and ceiling; separation on a crowded body;
  - actors kept, added and dropped across list changes; registry publishing;
  - flight arc and arrival; flight completion with no frames drawn; landing to the surface;
  - beams only during scans;
  - the cap: flights exempt, Waykeepers first, focus first, tier ordering; on mobile, no more animated satellites than the cap over 30 s of 20 satellites;
  - the instancing switch;
  - reduced motion: frozen positions, no beams, instant moves; turning it on mid-run.
- `satellite-mesh.test.ts` (9): geometry, matrices (dish faces the body, beam reaches the surface and is `BEAM.width` wide, sweep swings it, hidden collapses), beam colour with and without bloom, body colour, instance capacity.

The full repo gates are listed at the end.

## Performance

**Method.** This follows P3-08's method, with a throwaway harness that was not committed (deleted; a copy is in the agent's scratch folder).

- **Build.** A production `vite build` of a page that mounts the real `SolarScene`, served by `vite preview` on 127.0.0.1:4477.
- **Browser.** Chrome 154 headless, `--use-angle=metal` (`ANGLE Metal Renderer: Apple M3 Pro`), 1440×900 at DPR 2, driven over CDP.
- **World.** The catalogue's 31 bodies; 10 projects (7 planets; Europa and Titan as sub-projects; Io independent), each with a Waykeeper and 2 project tasks with Stewards; 30 task asteroids, 10 of them with Stewards. That makes **10 Waykeepers + 30 Stewards = 40 satellites**, all `working`, so they scan.
- **Modes.**
  - "none": the same world with no live Waykeepers or Stewards, which is the before;
  - "instanced": the shipping path, since 40 > `instanceAbove` on every tier;
  - "per-mesh": `instanceAbove` forced to 1000, to show what instancing saves.
- **Views.** System (the default camera) and Jupiter (`flyTo`). Each run had 4 s of settling (5 s after the flight), then a 6 s window. Draw calls and triangles per frame were counted by wrapping WebGL2's draw calls. The machine's load average was 1.5–3.6.

| tier | view | draw calls: none → instanced (per-mesh) | triangles: none → instanced | fps vsync: none / instanced / per-mesh | headroom fps no-vsync: none / instanced / per-mesh |
|---|---|---|---|---|---|
| high | system | 146 → **148** (195) | 189k → 192k | 60 / 60 / 60 | 194 / 188 / 185 |
| high | Jupiter | 42 → **44** (56) | 153k → 156k | 60 / 60 / 60 | 184 / 184 / 183 |
| balanced | system | 146 → **148** (195) | 119k → 121k | 60 / 60 / 60 | 331 / 328 / 326 |
| balanced | Jupiter | 42 → **44** (57) | 87k → 89k | 60 / 60 / 60 | 323 / 326 / 317 |
| mobile (capped) | system | 130 → **132** (176) | 62k → 65k | 30 / 30 / 30 (p95 33.4 ms) | ≈ 25 / 25 / 24 * |
| mobile (capped) | Jupiter | 25 → **27** (38) | 30k → 32k | 30 / 30 / 30 | ≈ 25 / 25 / 25 * |

\* The capped mobile loop is driven by the frame cap's own rAF. With `--disable-frame-rate-limit` that rAF ticks irregularly, so these figures are the same with and without satellites and say nothing about satellite cost.

**Reading it:**

- The instanced path costs **2 draw calls** whatever the satellite count.
- The per-mesh path for 40 satellites would have cost about 49 calls at the system view, because every satellite is in view and some beams are on.
- Triangles: +2.6k (≈ 64 per satellite + beams).
- 60 fps vsync holds on high and balanced in both views, and the mobile cap holds a steady 30.
- No-vsync headroom changes by −3 % to +1 %, inside P3-08's run-to-run noise (±10 %).
- Under the per-mesh threshold (≤ 12 satellites, ≤ 8 on mobile), the cost is at most 2 calls per satellite while it scans, 1 otherwise.

## What Cosmin should look at

1. **The look.**
   - Satellites are small, unlit, gold (Waykeeper) or light blue (Steward), with a pixel-size floor so they show at the system view.
   - Beams are thin cyan cones that glow only at the apex. The first version's footprint read as a pale spot on Jupiter; the review fix's steep falloff should remove it (verified numerically, not yet by eye).
   - Worth checking on the Mac (`pnpm dev`, a world with running agents): is the beam too strong or too faint, and are the satellites big enough?
   - Constants are in `look.ts` (`BEAM`, `SATELLITE_LOOK`).
2. **Ended agents shrink out** over 0.4 s. P4-04 decides how completion lands them (`keepLanded`); P4-02 keeps failed ones (`keepFailed`).
3. **The cap numbers** (16 / 12 / 6) and **instancing thresholds** (12 / 12 / 8) are guesses sized to the measured cost (tiny either way). Tune them in `quality.ts`.
