# P3-05 — Picking, hover and selection

Branch `p3-05-picking` (from `p3-wave3-picking-lod`), 2026-10-03.

## What was built

The code is in `apps/web/src/scene/picking/`. Only `Picking.tsx` and `outline.ts` import three.js at runtime, and both run inside the canvas. Everything else uses no three.js, so it can live in the panel's first chunk. The build confirms it: `WebGLRenderer`, `Raycaster`, `OrbitControls` and `OutlineEffect` appear only in the `SolarScene` chunk.

| File | What |
| --- | --- |
| `pick.ts` | `pickBodies(ray, spheres, pxScale)` tests the ray against each anchor's bounding sphere (world centre plus visual `radius`). Pixel sizes are measured at each body's depth (`pxScale = height / (2 tan(fov/2))`). Every body gets a pickable radius of at least `MIN_TARGET_PX` = 6. A body counts as a candidate when it is within its target radius plus `CLUSTER_PX` = 6 of the pointer. **Choice:** the nearest body the ray passes through is chosen if it is at least `CLEAR_TARGET_PX` = 12 px on screen. Because the nearest one wins, a body in front hides the ones behind it. Otherwise a single candidate is chosen, and several candidates show the "what's here" list (capped at 8). The list puts bodies the ray passes through first, nearest first, then the rest by distance to the pointer. Bodies behind the camera, or around it, are skipped. |
| `body-action.ts` | `bodyAction(world, bodyId)` returns either a select or an info result. **Planet or moon hosting a project:** selects its Waykeeper. **Asteroid hosting a task:** selects its Steward. Both pick the newest live agent, else the newest, using the panel's own `primaryAgent` with `agentsFor`, the same rule as the navigation and notifications (decision 53). **Earth** (the Harmonizer's `bodyId`, falling back to `b-earth`): selects the Harmonizer. Otherwise it returns info: `free`, `reserved — headquarters` (the Moon), `reserved — the Sun`, `moved to <body>`, or `<work name> · <state> · no agent yet`. `selectionBody(world, selection)` maps a selection to its body: the Harmonizer to HQ, a Waykeeper to its project's body, a Steward to its task's body (a project task lives on the project's planet). It falls back to `agent.bodyId`. |
| `click.ts` | `ClickTracker` tells a click from a drag. It must be the primary button, the pointer must travel no more than `CLICK_SLOP_PX` = 4 (measured over the whole press, so dragging out and back still counts as a drag), the press must last at most 800 ms, and no second pointer may be down (pinch). |
| `store.ts` | `usePickingStore` (zustand) holds `hover` (name, `+n`, position) and `popover` (`info` or `here`). `activateBody(bodyId, at, {fly})` flies to the body, then either selects or shows the info popover. `selectFromScene` tags the selection so the sync skips it. |
| `sync.ts` | `SelectionSync` drives panel → scene, with `useSelectionSync()` mounted by `SceneArea`. See the rules below. |
| `outline.ts` | `outlineMeshes(anchor.object, bodyId)` collects the meshes under the anchor. It does not descend into nested anchors (a planet's moons), and it skips the invisible pick target, `visible: false` materials, and additive glows (the asteroid halo). |
| `Picking.tsx` | Runs inside the canvas. It listens for pointer events on the canvas element; R3F's raycaster stays unused. Hover is picked at most once per animation frame on pointer move, only while no button is held. A click is picked on a release that wasn't a drag. The cursor becomes `pointer` over a body. There are two billboard rings, drawn without depth test and never smaller than 10 px in radius: a faint white one on hover and a blue one on the selected agent's body. `OutlineSync` sets the outline effect's selection from `outlineMeshes`, re-collected every frame and written only when the list changes, so it follows LOD swaps. |
| `PickingOverlay.tsx`, `picking.css` | DOM over the canvas, one element each: the hover label (`Jupiter +3`) and the popover. The info popover shows the name and the detail. The "what's here" popover is a list of buttons, and the first one takes focus. The popover is clamped inside the scene area and has a close button. |

### Click and selection mapping (SPEC §4.1, decision 53)

- **Click on a body:** the camera always flies there (`flyTo`). If the body hosts work with an agent, that agent is selected (`waykeeper:<id>` or `steward:<id>`). Earth selects the Harmonizer (SPEC §4.2: "deselect, or click Earth"). Any other body shows the info popover and leaves the selection unchanged.
- **Several bodies under the pointer** (corner case 24): the "what's here" list appears. Choosing an entry activates that body the same way a click does. At system scale, clicking Jupiter lists Jupiter and its four moons. Close up, Jupiter is chosen directly. A small moon passing in front of its planet produces a list rather than a guess.
- **Empty space:** a click closes the popover. **Drag:** never picks.
- **Keyboard:** `Enter` on the focused scene area (not on a button inside it) activates the camera's focused body without flying again. `Escape` closes an open popover first; a second `Escape` is the camera's "back". `aria-keyshortcuts` now includes `Enter`.

### Panel → scene sync (decided here; see the proposed text)

The camera flies to the selected agent's body only when the user changes the selection outside the scene: navigation, a card's "open agent", a notification, back/forward. The rules:

- Snapshots and events never trigger a flight. A world change only retries a flight that is still waiting for its body.
- These changes don't fly: a selection the scene made itself (it has already flown), a selection of the Harmonizer (returning to the default conversation leaves the camera where it is), and a selection whose body the camera is already on.
- **On load:** only a deep link (`/waykeeper/<id>`, `/steward/<id>`) flies, and only once its body's anchor exists. A plain load keeps the overview. Showing the scene again later does not fly.
- A waiting flight is dropped when the user drags, scrolls or selects something else.
- A selection change from outside the scene also closes the info popover.

### Outline and the mobile tier

- **Tiers with a composer** (high, balanced): postprocessing `<Outline>` runs first in the composer, with blue visible edges, dimmer hidden edges, `xRay` and strength 4. `EffectComposer` now has `autoClear={false}`, which the outline requires (it warns otherwise); the render pass still clears. The blue ring is drawn only while the body is under 18 px on screen, where the outline alone is too small to see.
- **Mobile tier** (no composer): the blue ring is the selection marker at every distance.
- **Outline target:** the selected agent's body (`selectionBody`). With the Harmonizer selected, that is Earth.

## Why there is no `three-mesh-bvh`

Picking never raycasts a mesh. It runs a ray-vs-bounding-sphere test over the anchor registry: about 40 spheres (the Sun, 8 planets, the seeded moons, the task asteroids), O(n) with no allocations beyond the result. That is cheap enough to run on every hover frame. It is independent of whatever mesh P3-06's LOD draws, and the instanced background belt is never a candidate. A BVH speeds up ray-vs-triangle tests, and none are done here, so the dependency was not added. The asteroids' invisible pick spheres (`belt/`) are not used, because the anchor sphere does the same job; they could be removed in P3-08 if nothing else needs them. If Phase 4 satellites ever need triangle-exact picks, add the BVH then.

## Proposed SPEC / TECHNOLOGY text (recorded: SPEC decision 65, a §8 question on a per-device tier, TECHNOLOGY §2.1)

**SPEC §7, new decision (scene picking and selection):**

> **Picking in the scene** (2026-10-03, P3-05; §4.1, §4.2, decision 53, corner case 24): clicking a planet or moon that hosts a project selects its Waykeeper; clicking an asteroid that hosts a task selects its Steward (the newest live agent, else the newest); clicking Earth selects the Harmonizer. In every case the camera flies to the body. A body with nobody working on it — free, reserved (the Sun, the Moon), showing "moved to …", or work no agent has started yet — shows a small card with its name and what it is, and the selection does not change. When several bodies are under the pointer (a planet and its moons at system scale, a moon in front of its planet), the click shows a "what's here" list to choose from instead of guessing. Dragging never selects. Hovering a body highlights it and shows its name. The body of the selected agent is outlined (a ring on the phone's tier). When the selection changes in the panel (navigation, a link, a notification, back/forward), the camera flies to that agent's body, except when going back to the Harmonizer. The camera does not move on its own on load unless the page was opened on a Waykeeper or Steward link. With the scene focused, `Enter` selects the body the camera is on.

**TECHNOLOGY §2.1, after the camera bullet:**

> - **Picking** (`apps/web/src/scene/picking/`): ray vs the anchors' bounding spheres (centre + visual radius) with screen-space sizes measured at each body's depth — a minimum 6 px target, a 6 px cluster slop, and a 12 px "clear target" threshold below which several candidates open the "what's here" list. No mesh raycast and no `three-mesh-bvh`: about 40 spheres per pick, independent of LOD meshes; the instanced belt is not pickable. Pointer events are read on the canvas element (a release within 4 px of its press is a click), hover is picked at most once per frame. The selection outline is postprocessing's `Outline` (the composer runs with `autoClear={false}`) over the selected anchor's meshes, re-collected per frame (LOD-safe); the mobile tier, without a composer, uses a camera-facing ring. Panel → scene sync flies only on user selection changes (`SelectionSync`).

**IMPLEMENTATION_PLAN / phase file:** the P3-05 task text mentions `three-mesh-bvh`. Suggest changing it to "ray-vs-bounding-sphere picking over the anchors".

## Dependencies added

None.

## Shared files touched

- `apps/web/src/scene/SolarScene.tsx`: imports `Outline` and `Picking`. `<Picking outline={quality.bloom ? outlineRef : undefined} />` is mounted after `<CameraRig />`. The `EffectComposer` gets `autoClear={false}` and an `<Outline>` before `Bloom`. The doc comment gained one paragraph.
- `apps/web/src/scene/SceneArea.tsx`: `useSelectionSync()`. `<PickingOverlay />` is rendered before the breadcrumb. `onSceneKey` first calls `pickingKey` (Escape closes the popover; Enter activates the focused body). `aria-keyshortcuts` is now `"] [ Escape Home Enter"`. The doc comment gained one paragraph.
- Read but not changed: `anchors.ts`, `camera/store.ts` (`flyTo`, `focusedId`, `anchorPosition`), `belt/belt-model.ts` (`PICK_TARGET_NAME`), `panel/nav-model.ts` (`primaryAgent`), `console/hierarchy/shared.tsx` (`agentsFor`), `console/hierarchy/HierarchyConsole.tsx` (`currentHarmonizer`), `state/selection.ts`, `state/store.ts`.
- Not touched: `scene/bodies/`, `scene/quality.ts`, the belt (all P3-06's), the phase file, `docs/tasks/README.md`, SPEC and TECHNOLOGY.

## Decisions taken here (conservative; confirm)

1. **Earth selects the Harmonizer.** The brief said "reserved Earth → popover", but SPEC §4.2 says the Harmonizer is "one click away (deselect, or click Earth)", and SPEC wins on behaviour. The Moon and the Sun show the "reserved" popover.
2. **Selecting the Harmonizer never flies.** Earth is still outlined while the Harmonizer is selected, which is the default, so Earth carries a faint outline at start-up. If that is too much, remove the HQ case from `selectionBody`; it is one line.
3. **Deep links fly; plain loads and re-shows don't.**
4. **Enter does not fly again;** the camera is already on the body.

## Deferred

- The hover label is recomputed only when the pointer moves. Bodies orbiting under a still pointer keep the old label until the next move. The label is cleared on every click.
- Satellites (Phase 4) are not pickable yet. `bodyAction` would gain an "agent" case.
- Touch: a tap counts as a click (same tracker). Hover does not exist on touch, and the popover position follows the tap. Not tried on the phone.
- P3-07 labels could reuse `bodyName` and `bodyAction(...).detail`.
- The asteroid's invisible pick sphere is now unused (see above).

## Tests (Vitest, no WebGL)

- `pick.test.ts` (11): `pixelScale`, nearest pick and empty space, occlusion by a nearer body (and past its edge), nearest wins over biggest, the minimum target for a speck, the "what's here" cluster (planet and moons at system scale, in order), a clear target despite a nearby moon, a small moon in front of its planet (ambiguous), the body under the pointer listed before a speck in front of it, behind the camera and camera inside, the cap of 8.
- `body-action.test.ts` (11, world fixture `fixtures.ts`): project → Waykeeper (newest live, else newest), asteroid → Steward, Earth → Harmonizer, "no agent yet" for a project and a task, free / reserved Moon / Sun / moved / unknown, the Sun's name without a catalogue, HQ fallback; `selectionBody` for each role, including a project task's Steward and a moved task; the round trip from body to selection and back to body.
- `click.test.ts` (5): click, drag beyond the slop (even when returning), the slop boundary, right button, long press, two fingers, recovery afterwards, release without a press, cancel.
- `sync.test.ts` (8): panel selections fly; the scene's own don't; the Harmonizer doesn't; no flight when already there; a plain load and snapshots don't; a deep link waits for the snapshot and the anchor, flies once, then never again; a deep link that no longer matches doesn't; a waiting flight is dropped on camera input or another selection.
- `outline.test.ts` (2): moons, halo and pick target excluded; an LOD swap is followed.
- `picking-ui.test.tsx` (14, jsdom, real stores with fake anchors): `activateBody` (Waykeeper plus the URL, Steward, Earth, the free-body popover with close, "no agent yet"); the hover label `+n`; the "what's here" list (order, focus, choosing a body with no agent → info, choosing one with an agent → select and close); `Enter` (selects without a new flight request; ignored on an inner button or with no focus; shows the info for the Moon); `Escape` (popover first, then back); `useSelectionSync` (panel vs scene vs world updates vs Harmonizer; a panel selection closes the popover and the scene's own does not; a deep link flies once the anchor registers; a plain load does not).
- Gates from the repo root: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`: all green. Test counts: protocol 67, server 842 (+1 skipped), web 372 (was 321; 51 of them in `picking/`).

### Smoke check in a real browser (not committed)

A throwaway page (since deleted) mounted `SolarScene` with a hand-made world: the catalogue's Sun, Mercury to Saturn, the Moon, Jupiter's four moons, a project on Jupiter with a Waykeeper, and an asteroid task with a Steward. Headless Chrome (SwiftShader) drove it over CDP at `high` and at `mobile`:

- Hovering Jupiter showed the label and the faint ring.
- Clicking Jupiter at system scale opened "what's here" with Jupiter first and its four moons.
- Choosing Jupiter selected `waykeeper:a-wk` (URL `/waykeeper/a-wk`), flew there, and outlined Jupiter. The screenshot shows a clean blue outline at `high` and the blue ring at `mobile`.
- A left-drag on Jupiter orbited and selected nothing.
- Clicking a free moon close up showed "free". Clicking the Sun showed "reserved — the Sun".
- `select(steward)` from outside the scene flew to the asteroid and closed the popover.
- `Enter` on the focused scene selected the asteroid's Steward.
- No console errors, and no "Outline requires autoClear" warning.

One change came out of this check: the outline was drawing the asteroid's additive halo as a big disc, so glows are now excluded.

## What Cosmin should try

1. `pnpm dev` with the scene shown and some work running.
2. Hover planets, moons and task asteroids: the name follows the pointer, a faint ring appears, and the cursor becomes a hand.
3. At the overview, click Jupiter (or Earth): "What's here" lists the planet and its moons. Pick one.
4. Click a planet hosting a project: the panel opens its Waykeeper, the camera flies there, and the planet is outlined. Do the same with a task asteroid and its Steward.
5. Click a free planet, the Moon, the Sun, and a project still `approved` with no Waykeeper: each shows a small card and the panel stays put.
6. Click Earth: back to the Harmonizer.
7. Drag across a body: it orbits and selects nothing.
8. In the panel, open a Waykeeper from the navigation: the camera flies to its planet. Return to the Harmonizer: the camera stays.
9. Reload on `/steward/<id>`: the camera flies to the asteroid once the scene is drawn. Reload on `/`: no flight.
10. Click the scene, press `]` until a body with work is focused, then `Enter`: it is selected. `Escape` closes a card before going back to the system.
11. Switch the tier to `mobile` in the settings: the outline becomes a ring.
12. Earth has a faint outline while the Harmonizer is selected. Keep it or drop it (decision 2 above).
