# P6-05 — Earth as headquarters

Branch `p6-05-earth-hq` (from `p6-wave2-visuals-cutaway-hq`), 2026-10-04. The technical summary is in `TECHNOLOGY.md` §2.1 ("Earth as headquarters in the detail view").

## What was built

| File | What it does | three.js? |
|---|---|---|
| `scene/detail/earth-hq/earth-hq-model.ts` | `EARTH_HQ_PART`, `isHeadquarters` (only `b-earth`), `stationMood` / `stationLook(state, reducedMotion)` (ring spin, lights, glow, dark, still), `navLevel`, `strobeLevel`, `glowLevel`, `restingPose`, the `STATION` constants. | no |
| `scene/detail/earth-hq/earth-hq-mesh.ts` | The procedural station (no assets), about one unit across like the system HQ: spine, two habitation modules, a node, a top module, a dish and mast toward Earth (−y), a docking ring with two docking ports, radiators, a truss with four solar arrays (two panels a side, cells in two shades); an eight-segment habitat ring with four spokes; red/green navigation lights at the arrays' tips; a white strobe; a glow disc. `simple` (mobile): fewer segments, two arrays, no ports or radiators. | yes |
| `scene/detail/earth-hq/EarthHq.tsx` | The part's component. Claims the HQ while mounted; `writeEarthHq` (per frame, `READ_BODIES`) places, colours and animates it. `EarthHqTargets` caches the look per state. | yes |
| `scene/detail/parts.ts` | One `DETAIL_PARTS` entry: `{ id: 'earth-hq', kinds: ['rocky'], accepts: isHeadquarters, Component: EarthHq }`. | — |
| `scene/satellites/hq/hq-model.ts` | `claimHqStation()` / `hqClaimed()`: a counted claim (StrictMode-safe). | no |
| `scene/satellites/hq/HqStation.tsx` | `writeHq` hides core and ring while claimed; the beam is still drawn. | yes |
| `scene/picking/store.ts` | `activateSatellite`: with the Harmonizer selected, `revealChat()`. | no |
| `panel/dock-state.ts` | `requestDockOpen()` (a listener set `useDockPrefs` registers; with no dock mounted it writes `open: true` to the stored preference), `revealChat()` (restore + a transient Chat view, not stored; review fix). `setOpen` no longer rewrites storage when the value is unchanged. | no |

### How the station works

- **One HQ, two models.** The station is the Harmonizer's satellite frame (the same list entry, director frame and registry entry as the system HQ of P4-02). While Earth is shown in detail the part is mounted and claims the HQ: the system station's core and ring are hidden, the detail station is drawn at exactly the frame's pose and size. The frame stays published, so **picking, the hover card ("Harmonizer · …"), the hover ring and the click are unchanged** — there is no second pick target to keep in step. The system HQ keeps drawing the beam when the Harmonizer scans Earth (its apex is the station's position).
- **Same footprint.** The detail model is about one unit across, like the system one, scaled by the frame's `size` (0.42 Earth radii). It is *more detailed*, not bigger, so the pick sphere and hover ring still fit it; up close in the detail view it reads as a large station anyway.
- **Indication** (`stationLook`):

  | Harmonizer | Hull | Habitat ring | Nav lights / strobe | Glow |
  |---|---|---|---|---|
  | thinking (`working`, `starting`) | role colour, breathing | fast (1.6 rad/s) | blink / double flash | cyan, breathing (1.8 s) |
  | waiting for the user | amber, blinking, larger (the state look) | slow (0.22 rad/s) | blink | none |
  | idle | grey | slow | blink | none |
  | paused | violet | still | steady | none |
  | stalled | orange, hiccup | slow | blink | none |
  | failed | red, flicker | still | off | none |
  | none (no frame: none running, or ended) | dark `#3b4354` × 0.55 | still | off | none |
  | reduced motion | as above, still | still | steady (failed/none off) | steady 0.6 while thinking |

- **No Harmonizer.** No frame is published, so the station rests dark at a fixed place (innermost shell, a little above the equator, `restingPose`). It is not a pick target; a click on it lands on Earth (selects the Harmonizer, decision 65) or empty space (deselects to the Harmonizer). The dock is where decision 82's Restart lives.
- **Click → chat.** `activateSatellite` selects the Harmonizer and flies to Earth (in Earth's detail view the flight keeps the detail framing, P6-01), then `revealChat()`: the dock restores if it was minimised (decision 71, the stored preference updated as with its own button) and the dock shows Chat for this click only: a transient override in `useDockView` (`showTransient`), not stored, so the remembered Chat/Status choice (decision 80, device-wide, also used for Waykeepers) is unchanged and shows again when the selection changes or the user picks a view (review fix; first version stored Chat). This applies to **every HQ click**, the system view's too: the HQ is the Harmonizer's home and clicking it means "talk to the Harmonizer". Clicking Earth itself is unchanged (selects, does not restore the dock), and other satellites are unchanged.
- **Cross-fade.** The swap of models happens when the part mounts (start of the fade in, the camera still far: the station is a few pixels). The navigation lights, strobe and glow fade in with `mix()`.
- **Quality and cost.** High/balanced: core, ring, nav, strobe, + glow while thinking = 4–5 draw calls (the system HQ's 2 are hidden, so +2–3 net). Mobile: the simple model, no glow (thinking reads by the ring and the breathing). The glow is a vertex-coloured `RingGeometry` disc billboarded in Earth's frame — no canvas texture.
- **Disposal.** Every geometry is disposed on unmount (tested); materials are R3F-owned JSX and disposed with their meshes.

## SPEC text (recorded as decision 85; decision 72 amended)

A sentence for decision 84 (or a new decision 8x "Earth as headquarters"):

> **Earth as headquarters** (2026-10-04, P6-05; decisions 71, 72, 80, 82, 84): in Earth's detail view the Harmonizer's HQ station is drawn up close as a detailed station — modules, four solar arrays, a docking ring, a habitat ring, blinking red and green navigation lights and a white strobe — in place of the small one, never both. It shows the same state colours as the small station (amber and blinking when the Harmonizer waits for the user); its habitat ring turns fast and a soft cyan glow breathes around it while the Harmonizer thinks, the ring turns slowly while it is idle, and stands still when it is paused or failed. With no Harmonizer running the station is dark and still. With reduced motion nothing turns, blinks or breathes; thinking still shows by the steady glow. Hovering it shows the Harmonizer's card. **Clicking the HQ station — in the detail view or the whole system — selects the Harmonizer and opens its chat**: a minimised dock is restored and its "Chat | Status" switch goes to Chat. Clicking Earth itself still only selects the Harmonizer.

Decision 72's "clicking it selects the Harmonizer" could become "clicking it selects the Harmonizer and opens its chat (decision 8x)".

## Tests (Vitest, no WebGL)

25 new tests in 2 new files (web 1348 → 1373; 102 → 104 files), plus one assertion updated in `detail/detail-body.test.ts` (the registered parts are no longer empty: `earth-hq` on Earth, not on Jupiter).

- **`detail/earth-hq/earth-hq.test.ts` (21):**
  - the part is registered once, with `EarthHq`, and mounts only for Earth (not Mars, Jupiter, the Moon, a task asteroid);
  - state mapping: every `AgentState` → none / thinking / waiting / idle / halted;
  - thinking: fast ring, blinking lights, glow breathing between its bounds;
  - idle and waiting: slow ring, no glow (waiting's amber blink is the state look's);
  - none: dark, still, lights off; halted: paused steady, failed off;
  - the blink and double-flash patterns;
  - **reduced motion**: for every state the ring is still and nav, strobe and glow are constant in time; the glow is steady while thinking, absent when idle;
  - the resting pose;
  - geometry: vertex-coloured, about one unit across, −y toward Earth; more than twice the system core's vertices; the mobile model under 60 % of the full one; the ring in the spine's plane;
  - `writeEarthHq`: placed at the frame in Earth's frame with the frame's size and colour; the ring integrates fast while thinking and slow while idle, glow on/off; no Harmonizer → dark at the resting place, lights and glow off, ring still; a hidden frame hides it; lights fade with the mix; reduced motion gives the same picture at any time; no glow target on mobile; a released target writes nothing;
  - **no double HQ**: while claimed, `writeHq` hides the system core and ring and keeps the beam; release restores; claims count (StrictMode).
- **`detail/earth-hq/earth-hq-ui.test.tsx` (5, jsdom):**
  - the part claims the HQ while mounted (under StrictMode) and releases and disposes its geometry on unmount;
  - the mobile tier mounts the station without the glow;
  - **click → Harmonizer**: the whole app on a Waykeeper link with the dock minimised and on Status; `activateSatellite('a-harmonizer')` selects the Harmonizer, restores the dock (and the stored preference), shows Chat and "chat with Harmonizer" without storing it (the stored view stays Status, and shows again once a Waykeeper is selected);
  - the user's own pick during the reveal is stored and ends the override;
  - another satellite's click leaves the dock and its view alone.
- Gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` all green (protocol 70, server 976 + 1 skipped, web 1373). three.js is still absent from the panel's first chunk (`index-*.js`: no `WebGLRenderer`, `Object3D`, `Matrix4`); the station is in the `SolarScene` chunk.

## Not done / deferred

- **"Headquarters" label** in the detail view: skipped. The label layer is per body; a label for a non-body would need a new label kind. The hover card already names the Harmonizer.
- **The dark station is not clickable** (no frame to pick); a click lands on Earth or empty space, both of which select the Harmonizer, but without restoring the dock. A pick target for it could come with a `registerAnchor`-style extension of picking if wanted.
- **Model swap at the start of the fade**: the detailed hull replaces the simple one at once (the lights and glow fade in). Checked in the browser (below): not noticeable.
- **The station is rarely in view in Earth's detail view** (browser check below): new task P6-06.
- **Beams to the Waykeepers' planets**: out of scope, as briefed.

## Browser check (wave 2 review, 2026-10-04)

**Setup** (all from the review branch's worktree, all stopped afterwards; Cosmin's 5173/4321 untouched): the dev server (`GALACTIC_DEV=1 GALACTIC_HARMONIZER=fake`, `GALACTIC_HOME` in scratch) on 127.0.0.1:7792, Vite on 7712, headless Chrome (`--use-angle=metal`, Apple M3 Pro) on CDP 9482 with a scratch profile, driven over raw CDP; the app's own stores (`useCameraStore.flyTo`, `useDetailStore.enter/exit`) and the scene read through a `Scene.onBeforeRender` hook. Viewports 1440×900 and 2400×1000 at DPR 2. Screenshots were kept in the session scratchpad, not the repo.

- **Proportions.** The detailed station is about 0.42 Earth radii across on its 1.8-radii shell, as designed: it reads as a large station beside Earth — habitation modules, docking ring, habitat ring with spokes, four solar arrays (two panels a side) on high and balanced, two arrays on mobile, a red light at one array tip and a green one at the other. Nothing is out of scale.
- **Visibility (new task P6-06).** At the detail framing (camera 2.4 radii out) the station is on screen only near Earth's limb: on its near side it is outside the view, on its far side behind Earth. Sampled over a minute: in a square canvas (dock minimised, 860×804) it was visible in ~3 % of the samples, and seen at the limb it is washed out by the atmosphere's additive glow; in a wide canvas (≈ 2:1) about a quarter of its orbit, clearly. Not changed here: it needs a framing or placement choice (P6-06).
- **Glow with and without bloom.** The Harmonizer (fake) was idle during the check, so the thinking glow was off; its disc was not seen. The white strobe is drawn at 1.6 (HDR, `toneMapped: false`): on high it is above the bloom threshold (1.0), so it blooms; on mobile (no composer) it is a clipped white dot. The navigation lights stay at ≤ 1 and do not bloom on either tier. The high and mobile crops looked alike apart from the model's detail (the strobe's flash did not fall in a crop, so its halo was not seen in a screenshot). Neither looks over- or under-lit.
- **Strobe.** Sampled every 50 ms: a double flash (two ~0.15 s pulses 0.4 s apart) about every 2 s; the navigation lights blink (~0.8 s on, ~0.8 s dim at 0.18). As specified.
- **Model swap during the fade.** 80 ms into the cross-fade the detailed station is already there, about 60 px across, with no frame showing both models or none.
- **Fix 1 confirmed (P6-02):** first entry painted Earth's 4096 level in 10.3 s (jobs in order: clouds 2048, near maps 1024 and 512, then the 4096 detail level — small jobs first); after exit the level and clouds stay idle in the cache (117 MiB); re-entering started **no** paint job and showed the detail level at once.

## Shared files touched

- **Owned:** the new `scene/detail/earth-hq/` folder.
- **Shared, small edits:**
  - `scene/detail/parts.ts`: two imports and one `DETAIL_PARTS` entry (P6-03 adds its own entry to the same array: a trivial merge);
  - `scene/detail/detail-body.test.ts`: one assertion (the registered parts);
  - `scene/satellites/hq/hq-model.ts`: `claimHqStation` / `hqClaimed` appended;
  - `scene/satellites/hq/HqStation.tsx`: one import, three lines in `writeHq`, a doc line;
  - `scene/picking/store.ts`: one import, two lines in `activateSatellite`, a doc line;
  - `panel/dock-state.ts`: `requestDockOpen`, `revealChat`, a `useEffect` in `useDockPrefs`, `setOpen` skips an unchanged value.
- **Docs:** `docs/TECHNOLOGY.md` §2.1, a new bullet after "Planet detail view".
- **Not touched:** `SPEC.md`, the phase file's status lines, `docs/tasks/README.md`, `DetailScene.tsx` and `detail/visuals/` (P6-02).

## What Cosmin should try

1. With a Harmonizer running, click Earth, then "Detail view". The HQ station is the detailed one; send it a message and watch the ring speed up and the cyan glow breathe; when it asks you something it turns amber and blinks.
2. Minimise the dock, switch it to Status, then click the station: the dock comes back on the chat.
3. Turn on reduced motion: the ring stops, the lights are steady, the glow is steady while thinking.
4. Decide whether the "click HQ opens the chat" rule should hold in the whole-system view too (implemented) or only in Earth's detail view (now an open question in `SPEC.md` §8).
