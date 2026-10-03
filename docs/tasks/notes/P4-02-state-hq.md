# P4-02 — State → visual mapping and HQ station

Branch `p4-02-state` (from `p4-wave2-state-activity-beacons`), 2026-10-03.

## What was built

| File | What it does | three.js? |
|---|---|---|
| `scene/satellites/look.ts` | `STATE_LOOK`: one entry per `AgentState` (all 10). Each entry has a tint, a pulse, a level, a reduced-motion level (`still`), a size multiplier, an orbit rate, and the legend's words. `satelliteTint`, `satelliteBrightness(spec, view, now, reducedMotion)`, `satelliteScale`, `satelliteOrbitRate`, `beamTint`, `pulseAt`, `linearRgb`. The Waykeeper's colour moved from gold `#ffd27a` to warm white `#ffe6b0`, so it no longer looks like the amber. The Harmonizer's look grew to 0.42 R (at least 7 px). | no |
| `scene/satellites/director.ts` | Each frame takes the state's tint, brightness, size multiplier and beam tint (`SatelliteFrame.beamTint`, new). Each satellite now has its own **orbit clock** that runs at its state's rate. On a state change the clock first advances to "now" at the old rate, so pausing or resuming never makes the satellite jump. The clock stops while the satellite lands, which keeps the angle it came down at (the same behaviour as before). | no |
| `scene/satellites/satellite-mesh.ts` | `beamColor` uses `f.beamTint`. | yes |
| `scene/satellites/satellite-model.ts` | `SCENE_SATELLITES = { keepFailed: true, harmonizer: true }` (P4-04 adds `keepLanded` here). `isSuperseded`: a failed agent's satellite goes once a **live** agent of the same role works on the same task (Steward) or project (Waykeeper). The predicate change is one line in `showsSatellite`; the archetype path is untouched. | no |
| `scene/satellites/Satellites.tsx` | Uses `SCENE_SATELLITES`. Keeps the HQ out of the ordinary renderers (`ordinarySatellites`; `writeInstanced` skips the harmonizer frame and packs the instances). Writes the HQ in the same frame loop, right after the director (`writeHq`). | yes |
| `scene/satellites/hq/hq-model.ts` | `HQ.ringSpin` (0.22 rad/s idle, 1.6 rad/s thinking), `hqThinking`, `hqRingSpeed` (0 under reduced motion, paused or failed), `RingSpin` (an integrated angle, so a speed change never jumps), `hqFrame`, `ordinarySatellites`. | no |
| `scene/satellites/hq/hq-mesh.ts` | The procedural station. The core is a hub, a top module, a dish facing Earth (−y, the same orientation as a satellite), a truss with two blue wings, and a beacon. The ring is a torus with six light and dark segments plus two spokes, so you can see it turn. | yes |
| `scene/satellites/hq/HqStation.tsx` | Three meshes (core, ring, beam) on `DECOR_LAYER`, plus `HqTargets` and `writeHq`. | yes |
| `scene/legend/Legend.tsx`, `legend.css` | The legend. It is in the panel chunk, with no three.js. | no |
| `scene/SceneArea.tsx` | Mounts `<SatelliteLegend />`. | — |

### The HQ station

The HQ is **the Harmonizer's ordinary satellite entry**. It uses the same list entry (`satelliteList(world, { harmonizer: true })`, on `b-earth`), the same actor, director frame and registry entry, and the same state look. So picking, the hover card and click → select the Harmonizer (`satelliteSelection` already handled the harmonizer role) came for free. Only the model is different.

Its "thinking" cue has three parts:
- the habitat ring spins about 7× faster while the Harmonizer is `working`;
- the station breathes like any working satellite;
- it scans Earth with the beam now and then.

When idle it is grey and steady, with the ring turning slowly. When it waits for the user it turns amber, grows larger and blinks, like every other satellite.

### Legend

- **Where:** top-right of the scene area, in the scene chrome's stacking layer (`stacking.test.ts` now checks `.scene-legend` too). The fps meter is top-left, the breadcrumb bottom-left and the scale toggle bottom-right. The legend is not part of the docked chat, so the chat cannot overlap it.
- **What it draws:** the same table as the satellites, as CSS swatches with matching animations: breathe, blink, stutter, flicker, and a spinning segmented ring for the HQ. Under reduced motion nothing animates, and the swatches keep their sizes.
- **Collapsing:** it collapses to a small "Legend" button with three dots. Open or closed is remembered per browser (`galactic.scene.legend.open`).
- **Default:** open above the 1100 px stacked breakpoint, closed on phones. Its maximum width is `min(300px, 100% − 16px)` and it scrolls inside itself.

## Colour table

| State | Tint | Pulse | Size | Orbit | Reduced motion (brightness) |
|---|---|---|---|---|---|
| working | the role's colour: Waykeeper `#ffe6b0`, Steward `#a8dcff`, HQ `#e8f0ff` | breathe, 3.2 s, 0.82–1.2, de-synchronised; scans with a cyan beam | ×1 | ×1 | 1.1 |
| starting | the role's colour | steady 0.8 | ×1 | ×1 | 0.8 |
| **waiting_for_input** | **amber `#ffb547`** (the panel's `--pnl-beacon`, the labels' beacon) | **blink**, 1.6 s, 0.4 ↔ 1.9 (blooms when on), synchronised across satellites | **×1.35** | ×1 | 1.7 |
| idle | grey `#8e97ad` | steady 0.7 | ×1 | ×1 | 0.7 |
| paused | violet `#a58fff` | steady 0.85 | ×1 | **0** (holds still) | 0.85 |
| stalled | orange `#ff7a45` | stutter: a double hiccup every 2.4 s | ×1 | ×1 | 1.0 |
| failed | red `#ff4d5a` | flicker: level 0.6 with seeded drop-outs (14 % of 0.12 s cells) | **×0.8** | **0.3** (drifts) | 0.5 |
| finished (P4-04, landed) | the role's colour | steady 0.6 | ×1 | ×1 | 0.6 |
| stopped / interrupted | grey `#6f7891` | steady 0.5 | ×1 | ×1 | 0.5 (not shown today) |

**Colour-blind safety.**
- Every state that is shown differs from every other state in pulse, size, orbit or level, not only in colour (tested).
- Under reduced motion, waiting, failed, paused and idle still differ by size or brightness (tested).
- No state or role other than waiting uses the amber (tested).

**Beams.** A beam is cyan while the agent works, which is the only time it scans. If the state changes during a scan, the fading beam takes the new state's colour at the cyan's luminance, so the beam turns amber as the agent starts waiting. `MAX_BODY_LUMINANCE` still holds.

## Proposed SPEC decision (for the coordinator to record as §7 decision 72, and a line in 68)

> | 72 | Satellite states and the HQ station | **A glance tells busy, blocked and failed apart** (2026-10-03, P4-02; §4.1, §4.4, decisions 65, 66, 68, 70): a satellite's look follows its agent's state, and colour is never the only cue. A working satellite keeps its role's colour (the Waykeeper warm white, Stewards light blue), breathes slowly and scans its body now and then. One waiting for the user is amber (the panel's and the labels' "blocked on you" colour, used for nothing else), larger, and blinks in step with every other waiting satellite: the loudest thing in the scene. An idle one is grey and steady. A paused one is violet and holds still on its orbit. A stalled one is orange and hiccups. A failed one is red, smaller, flickers and drifts slowly round its body; it stays until a new agent takes over its task or project (a respawned Steward, a new Waykeeper). With reduced motion nothing pulses and nothing moves, but sizes and brightness still tell waiting (larger, brightest), failed (smaller, dim), paused and idle apart. The Harmonizer has a headquarters station orbiting Earth, larger than any satellite, with solar wings and a habitat ring that turns slowly while the Harmonizer is idle and fast while it thinks. It takes the same state colours (amber and blinking when it waits for the user). Hovering it shows the Harmonizer's card, and clicking it selects the Harmonizer. A legend in the scene's top-right corner shows these colours and pulses with the same visuals. It folds into a small "Legend" button and remembers that per device, starting folded on phones. |

Decision 68's sentence "A failed agent keeps its satellite in its failure colour (P4-02)" could become "… until a new agent takes over its work (decision 72)".

## Tests (Vitest, no WebGL)

There are 33 new tests: 24 in 3 new files and 9 added to existing ones (web 745 → 778):

- **`satellites/look.test.ts` (14):**
  - the table is complete for every `AgentState`, with valid tints for every role;
  - the legend covers every state that is shown;
  - working keeps the role colours;
  - amber is unique to waiting, and waiting is the loudest (peak brightness, size, still level);
  - every shown state has a distinct non-colour cue;
  - reduced-motion distinctness;
  - orbit rates;
  - pulsing versus steady states;
  - reduced motion is constant at `still`;
  - blink is synchronised and breathing is not;
  - blink's on/off range and period;
  - the flicker ratio, deterministic per agent;
  - beam tint luminance;
  - `linearRgb`.
- **`satellites/hq/hq.test.ts` (7):**
  - ring speed per state, and 0 under reduced motion;
  - `RingSpin` has no jump;
  - the HQ is the largest look;
  - `hqFrame` and `ordinarySatellites`;
  - the geometry is vertex-coloured and about one unit across;
  - the ring sits in the hub plane and has segments;
  - the ring matrix turns about the core's axis.
- **`legend/Legend.test.tsx` (3, jsdom):**
  - rows for every `LEGEND_STATES` entry, with the satellites' colours, pulse classes and the waiting scale, plus the role and HQ rows;
  - hide and show, persisted;
  - default open when wide, closed when stacked, and a stored choice wins.
- **`satellites/director.test.ts` (+5):** frames carry tint, size, beam tint and blink; reduced-motion brightness is constant; paused holds still and resumes with no jump; failed drifts at its rate; the HQ frame is on its body.
- **`satellites/satellite-model.test.ts` (+2):** `keepFailed` supersession; `SCENE_SATELLITES` keeps failed agents and puts the HQ on `b-earth` only with its status record.
- **`satellites/Satellites.test.tsx` (+2):** the HQ is drawn with its own three meshes and not as an ordinary satellite, and a failed agent is kept; an HQ alone draws without anchors.
- **`stacking.test.ts`:** the legend is in the chrome layer.
- **Fixtures:** `satellite-mesh.test.ts` and `picking/fixtures.ts` gained `beamTint`.

## Performance

**Method.** This followed P4-01's method:
- a throwaway harness (never committed; a copy is in the agent's scratch folder `p402/`) mounting the real `SolarScene` and the legend;
- a production build served by `vite preview` on 127.0.0.1:6642;
- headless Chrome on CDP port 9442, `--use-angle=metal` (Apple M3 Pro), 1440×900 at DPR 2;
- draw calls counted by wrapping WebGL2's draw calls;
- 6 s windows after settling.

**World.** The world was P4-01's: 10 Waykeepers and 30 Stewards = **40 satellites, plus the HQ**. Three modes were measured:
- "none": no live agents and no HQ;
- "working": everyone working;
- "mixed": waiting, failed, paused, stalled, idle and working spread across the 40.

| tier | view | draw calls: none → working / mixed | triangles: none → with | fps (vsync) |
|---|---|---|---|---|
| high | system | 146 → 150 / 150 | 189k → 210k | 60 / 60 / 60 |
| high | Jupiter | 41 → 43 / 43 | 153k → 173k | 60 / 60 / 60 |
| mobile (capped) | system | 130 → 134 / 134 | 62k → 83k | 30 / 30 / 30 (p95 33.4 ms) |
| mobile (capped) | Jupiter | 24 → 26 / 26 | 29k → 49k | 30 / 30 / 30 |

**Reading it.**
- The state look costs **no draw calls**: mixed states equal all-working, because colour is per instance.
- The +4 at the system view are the two instanced meshes plus the HQ's core and ring (its beam adds one while it scans). At Jupiter the HQ is culled out of view: +2.
- About 20k of the extra triangles are not the HQ (it is ≈ 0.9k). They are the instanced **beams**: the 12-ring cone has 480 triangles, and the instanced beam mesh draws every instance, zero-scaled or not (40 × 480 ≈ 19k). That cost came from P4-01's review fix, whose P4-01 measurement of +2.6k predates the 12-ring cone. It is not P4-02's cost. A follow-up could set the instanced beams' `count` to only the scanning ones, or reorder them.
- The machine was loaded (load average 3.5–5.4) during the run.

**Bundle.** three.js is still out of the panel's first chunk; the legend imports only `look.ts` and `machine.ts`, which import no three.js.

## Seen in headless Chrome (screenshots in scratch `p402/`)

- The HQ station orbits Earth, with its wings and ring readable. It turns amber and grows when the Harmonizer waits.
- At Mars: the Waykeeper scans with its cyan beam, a Steward is amber and another is a small red dot.
- At Jupiter: two violet paused Stewards hold still.
- The legend renders top-right.

## Deferred

- The instanced beams' triangle count (above).
- **Stalled vs failed on bodies with many satellites at the system view.** At a few pixels, the pulse carries the distinction more than the hue. The labels and the beacon (P4-05) carry "blocked on you" at a distance.
- **A shape marker** (an "x" for failed) was not added, to stay inside the "no extra draw calls" budget. Failed is told apart by smaller size, flicker, slow drift and red instead.
- **Legend text** follows the panel's font in the app. In the harness it fell back to the browser's serif, because the harness has no `.pnl` wrapper.

## Shared files touched

- **Owned:** `satellites/look.ts`, `satellites/satellite-model.ts` (the `SCENE_SATELLITES` constant, `isSuperseded`, one line in `showsSatellite`, doc comment), the new `satellites/hq/` and `scene/legend/`.
- **Shared, small edits:**
  - `satellites/director.ts`: imports, a `beamTint` frame field, an orbit clock per entry (`advanceClock`, used in `setSpecs` before a spec change, in `update`, and in `changeOrbit`), `size × satelliteScale`, a doc bullet. The archetype paths were not edited.
  - `satellites/Satellites.tsx`: list options, the HQ split, `writeInstanced` packing, render.
  - `satellites/satellite-mesh.ts`: `beamColor`.
  - `scene/SceneArea.tsx`: one import and one mount line.
  - `scene/stacking.test.ts`: the legend's sheet and selector.
  - `scene/picking/fixtures.ts`: a `beamTint` field.
- **Docs:** `docs/TECHNOLOGY.md` §2.1 has a new "Satellite state look and HQ station (P4-02)" bullet after the P4-01 satellites bullet.
- **Not touched:** SPEC.md, the phase file's status lines, `docs/tasks/README.md`.

**Note for merging with P4-03:** `SatelliteFrame` gained `beamTint`, and the director's orbit angle now comes from `e.clock` (named `t` in the loop), not from `now`. Archetype code that places things on the orbit should use the same `t`.

## What Cosmin should look at

1. **The colours on the Mac**, with a mix of states:
   - Is the amber blink loud enough without being annoying?
   - Is the failed red flicker readable at the overview?
   - Do paused (violet) and idle (grey) read apart?
   - All the constants are in `look.ts` (`STATE_LOOK`, `PULSE`).
2. **The Waykeeper's colour** moved from gold to warm white, to keep amber for "waiting for you" only.
3. **Paused satellites stop moving** and **failed ones drift at 30 %**: decide whether that motion cue feels right.
4. **The HQ station's size** (0.42 Earth radii, at least 7 px) and its ring speed (idle versus thinking).
5. **The legend:** top-right, open by default on wide screens. Is that the right place and default?
6. **A failed satellite stays** until a replacement agent of the same role is live on the same work. That is my reading of decision 68. The alternative is to stay only for the retention period, which the server already bounds.
