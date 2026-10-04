# P6-01 — Planet detail sub-scene and transition

Branch `p6-01-detail` (from `p6-wave1-detail-scene`). Code in `apps/web/src/scene/detail/`; the technical summary is in `TECHNOLOGY.md` §2.1 ("Planet detail view").

## What was built

- **A detail sub-scene per body kind.** `RockyPlanetDetail` (Mercury, Venus, Earth, Mars, made-up planets), `GiantPlanetDetail` (Jupiter, Saturn, Uranus, Neptune), `MoonDetail`, `AsteroidDetail` (`DetailScene.tsx`). It is a separate tree of meshes, mounted only while a body is shown in detail and disposed when the view is left. It is not the system's meshes at a higher LOD. Minimal first version of each:
  - A planet: at its nearest LOD level (sphere segments and maps, the maps shared through the near-texture cache with the system body), with its rings, its moons on their orbits with orbit lines, and eclipse shading among them as in the system view.
  - A moon: at its nearest level, shaded by its planet and its large siblings.
  - An asteroid: the task rock. Its halo fades out with the cross-fade, because at 2.4 radii it filled the whole view with cyan.
- **Transition.** A camera flight plus a cross-fade over a backdrop: a dark sphere about the body, the sky's own stars, and the Sun in its real direction. The fade takes 0.9 s in and 0.7 s out with smoothstep, can reverse mid-way, and is an instant switch under reduced motion. Once the fade in has ended, the rest of the solar system is not drawn at all.
- **Ways in:**
  - zooming in: the camera focused on a body, not flying, and closer than **3 body radii**;
  - the breadcrumb's **"Detail view"** button, shown when the camera is on a planet, moon or asteroid;
  - a **second `Enter`** on the focused body. The first `Enter` still selects, as in P5-01. The second, which would change nothing (the body's agent is already selected, or its card is already open), goes in.

  An explicit enter flies the camera to 2.4 radii.
- **Ways out:**
  - zooming out past **4.5 radii** (hysteresis; never during a flight);
  - `Escape`, which now unwinds popover → **detail view** → camera body → selection → system;
  - the body's crumb ("Solar system › Jupiter › Detail": "Jupiter" goes back out);
  - `Home`, the "Solar system" crumb, `]` / `[`;
  - a click on another body, or a panel selection whose agent's body is elsewhere.

  Leaving with `Escape` or the crumb flies back to the body's system framing (≈ 8.5 radii), with the reverse fade.
- **Breadcrumb.** "Solar system › Jupiter › Detail" and "Solar system › Jupiter › Europa › Detail". The "Detail view" button follows the trail as an action, without a "›".
- **Selection persists.** The mode never touches the selection or the URL. Any flight to the body being shown keeps the detail framing, so these never fly out of the view:
  - a click on the body;
  - the panel selecting its agent (the sync's flight);
  - the beacon or satellite activations that fly to it;
  - the scale toggle's re-framing.
- **Picking, labels, beacons, rings, outline.** These follow the view's **scope**: a planet and its moons; a moon, its planet and its siblings; an asteroid alone. Bodies behind the backdrop are no pick targets, carry no label and no beacon, and are never ringed or outlined. The beacons and rings are drawn over everything, and the outline's x-ray would show through the backdrop.

## Architecture and API for P6-02 / P6-03 / P6-04 / P6-05

**Frame.** The sub-scene draws in the body's own frame: a group that copies the body's **anchor matrix** every frame at `PLACE_DETAIL` (−0.75, after the bodies move, before every reader). In that frame the origin is the body's centre and the axes follow the anchor:
- a planet: translation only, with the tilt applied inside, as `Bodies.tsx` does;
- a moon: tilted with its planet's equator;
- an asteroid: turning with the belt.

The sub-scene is drawn at the anchor's visual radius (`DetailBody.radius`; a ringed planet's includes its rings), from the same layout the system uses (`resolveDetailBody` → `buildRenderList` / `taskAsteroids`). So:
- **The anchors stay the system's.** Nothing re-registers. Camera, picking, labels, satellites, activities, beacons, colonies and toasts keep working around the big body unchanged. The system anchors are neither suspended nor replaced (tested: the anchor list is identical across enter and exit).
- The system hides only its own meshes of the shown body (`useDetailStore` `shown`), and the swap is seamless because the detail meshes start out identical:
  - a planet: its tilt group with its moons, and its orbit line;
  - a moon: its mesh and its orbit line;
  - an asteroid: its rock and halo.
- **Stand-ins** (`stand-ins.ts`): `registerStandIn(bodyId, object)` tells the selection outline which meshes draw a body now. Each detail group registers itself. A group must carry `userData.bodyId`, so a planet's outline does not descend into its moons' groups.
- The **anchor registry stacks** registrations of one id: the newest wins, and removing it restores the one below. A later view that draws a body *elsewhere* (P6-02 might spread the moons out for the detail view) can call `registerAnchor({ ...systemAnchor, object: detailObject })` while mounted. Picking, labels and satellites then follow the detail object, and the system anchor comes back on unmount. Satellites of that body would jump to the new place at that moment, so do it under the fade.

**Modules:**

| Module | What it gives |
|---|---|
| `mode.ts` (three-free) | `useDetailStore` holds `mode`, `shown`, `fade`, `covered`, `zoomArmed`, plus `enter(bodyId, {fly})`, `exit({fly})`, `settle()`, `reset()`. Also exports `detailMix(state, now)` (0 system … 1 detail), `detailBodyId()`, `detailKind(body)`, `detailScope(bodies, id)`, `currentDetailScope()`, `inDetailScope(id)`, `zoomStep(view)` (the pure threshold machine), `bindCameraToDetail()`, `breadcrumbTrail()` / `breadcrumbText()`, and the constants `ENTER_RADII` 3, `EXIT_RADII` 4.5, `DETAIL_FRAME_RADII` 2.4, `ENTER_FADE_S` 0.9, `EXIT_FADE_S` 0.7. |
| `detail-body.ts` | `DetailBody` (kind, id, name, radius, and the layout item: `planet`, `moon` + `parent`, or `asteroid`), `resolveDetailBody`, `backdropRadius`, `planetReach`. |
| `parts.ts` | **The extension slot.** `DETAIL_PARTS: DetailPart[]`, each `{ id, kinds, accepts?, Component }`. The `Component` gets `{ body, quality, mix }` and is mounted in the body's frame after the body. `mix()` is the cross-fade, read per frame: fade materials with it to avoid pops. P6-03 (`'cutaway'`), P6-04 (`'project-overlay'`) and P6-05 (`'earth-hq'`, `accepts: b => b.bodyId === 'b-earth'`) each append one entry. |
| `DetailScene.tsx` | The per-kind components (each takes `children`, drawn in the body's frame or tilted frame), the frame, and the backdrop. **P6-02** enriches the per-kind components (atmosphere, clouds, maps beyond the LOD table, moon layout). `SurfaceMaterial`, `Rings`, `OrbitLine` and `useOrbit` are exported from `bodies/Bodies.tsx` for reuse. |
| `DetailLayer.tsx` | In the canvas. Mounts `DetailScene` keyed by the body, runs the zoom watcher at `READ_BODIES` (after the camera rig, so a flight the rig just started counts as flying), settles the fade, and resets the mode when the canvas unmounts. |

**Camera additions:**
- `CameraRequest` focus carries an optional `radii`.
- `CameraDirector.focus(…, radii?)`, and `limits(…, holdId?)`, so zooming never goes inside the detail body after a pan.
- `focusPose(…, radii?)` and `focusDistance` in `flight.ts`.
- `setFocusFraming(provider)` in `camera/store.ts`; `mode.ts` installs it.

**P4 overlays in the detail view.** They are kept, not hidden: satellites, activities, beacons, colonies, toasts and the HQ station are drawn around the big body exactly as in the system view, because the frame is the anchor's. Those of out-of-scope bodies are hidden by the backdrop (by depth once it is opaque) or filtered (beacons, labels, pick targets, rings, outline). P6-04 replaces the Steward look on the body (robots or drones) inside its part. P6-05 can either use the existing HQ satellite or add its station as a part.

**URL.** Not in the URL, decided. Like the camera focus it is a way of looking, not a selection (decision 53 keeps the selection only). A reload opens the system view. The selection, which is in the URL, still flies the camera to the body.

**Replay.** The sub-scene and the scope read `sceneWorld`, so a replay shows the replayed world's body. Opening or closing a replay keeps the view while the body exists (planets and moons always do).

## SPEC decision 84 (recorded)

> **Planet detail view** (2026-10-04, P6-01; §4.1, decisions 53, 63, 64, 65, 66, 68, 74, 81): coming close to a planet, moon or asteroid opens its **detail view**: zoom in until the body fills most of the view (closer than about three of its radii), click "Detail view" in the scene's breadcrumb, or press `Enter` a second time on the body the camera is on (the first `Enter` still selects it). The camera flies closer and the rest of the solar system fades out behind the body, leaving the stars and the Sun in its real direction. A planet keeps its rings and its moons going round; the breadcrumb reads "Solar system › Jupiter › Detail". The selection does not change, and nothing about it goes in the URL: a reload opens the whole system. Satellites, labels and question beacons of the body and its moons stay as they are; those of other bodies are hidden. Only the body and its moons (a moon's planet and siblings) can be clicked: clicking the body selects as usual without leaving, clicking a moon or another body leaves for it. The user leaves by zooming back out (past about four and a half radii), with `Escape` (after any open card, before the camera's body), with the body's crumb, which returns to the system view framed on the body, or with "Solar system" / `Home`. With reduced motion the switch is instant.

## Tests (Vitest, no WebGL)

- `detail/mode.test.ts` (24 tests):
  - zoom thresholds with hysteresis;
  - the re-arming after an explicit exit;
  - focus-change and lost-body exits;
  - enter and exit fades, with the flight and its framing;
  - a reversed fade;
  - reduced motion;
  - detail framing kept for flights to the body;
  - the selection is never changed;
  - `bindCameraToDetail` (overview, another body, the same body);
  - detail kinds; the scope, including during a replay;
  - **anchor registry consistency** across modes, and the stacking registry;
  - breadcrumb text ("Solar system › Jupiter › Io › Detail").
- `detail/detail-ui.test.tsx` (14 tests, DOM):
  - Enter selects, then enters; an info body; the Sun has none;
  - the **Escape chain** popover → detail → body → selection; Home; `]`;
  - the breadcrumb's button, crumbs and exits;
  - **selection persistence** (selection and URL unchanged; a click on the body selects without leaving; a click elsewhere leaves; a panel flight to the body keeps the view).
- `detail/detail-body.test.ts` (6 tests):
  - resolution per kind, with the anchor radius, in both scales;
  - the backdrop holds the camera and the view's bodies in front of its Sun and stars;
  - the stars are the sky's;
  - the Sun's direction and size;
  - parts selection.
- Added to existing suites:
  - `picking/Picking.test.tsx`: only the scope is pickable; a click behind the backdrop picks nothing; the outline uses the stand-in and nothing out of scope;
  - `labels/labels-ui.test.tsx`: labels follow the scope;
  - `camera/camera-ui.test.tsx`: the crumb text now ends with "Detail view".
- Gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` all green. Web 101 files and 1333 tests at the first commit; re-run after the review fixes (see the commit log). three.js is still absent from the panel's first chunk (`index-*.js`: no `WebGLRenderer`, `Object3D`, `Matrix4`).

## Browser check and performance

- **Harness.** A throwaway page, not committed and deleted afterwards. It mounted the real `SolarScene`, `LabelLayer`, `PickingOverlay` and `CameraBreadcrumb` with the whole catalogue (8 planets, 22 moons), a project on Jupiter (a Waykeeper and 2 Stewards), one on Mars, and a task asteroid. It was built with `vite build` and served by `vite preview` on 127.0.0.1:7431.
- **Browser.** Headless Chrome on CDP port 9471 with its own profile in scratch, `--use-angle=metal` (Apple M3 Pro), 1440×900 at DPR 2, tier **high**. Frame times come from rAF deltas, and draw calls from counting `draw*` calls per frame.
- **Each case:** fly to the body, enter explicitly (flight plus fade, 1.8 s window), settle, then exit (1.8 s window).

| Body | Enter fps / p95 / max ms | Detail draws (system view) | Exit fps / max ms |
|---|---|---|---|
| Mercury | 56.7 / 16.8 / 100 (first entry: shader compile) | 23 (40–46) | 60 / 16.8 |
| Venus | 60 / 16.8 / 16.8 | 26 (43) | 60 / 16.8 |
| Earth | 59.5 / 16.8 / 33 | 26 (37) | 60 / 16.8 |
| Mars | 60 / 16.7 / 16.8 | 25 (35) | 60 / 16.8 |
| Jupiter | 60 / 16.7 / 16.8 | 29 (38) | 60 / 16.8 |
| Saturn | 59.5 / 16.8 / 33 | 35 (43) | 60 / 16.8 |
| Uranus | 59.5 / 16.8 / 33 | 30 (37) | 60 / 16.8 |
| Neptune | 59.5 / 16.8 / 33 | 28 (29) | 60 / 16.8 |
| Europa, Titan, Moon | 60 / 16.8 / 16.8 | 24–30 (30–53) | 60 / 16.8 |
| 7 Iris (asteroid) | 60 / 16.8 / 16.8 | 24–26 (45) | 60 / 16.8 |

- **Zoom path** (25 wheel steps into Jupiter, then out): enters and leaves by the thresholds, 59.7 / 60 fps.
- **Mobile tier**, two bodies: 57–60 fps; one 50–66 ms frame at the first entry. The fps meter lifts the 30 fps cap (P3-06), so the capped loop was not measured. The fades are time-based, so a capped loop simply shows fewer steps.
- **Reading the numbers.** The settled detail view costs fewer draw calls than the system view it replaces, because the rest of the system is not drawn. During the fade both views are drawn, at most +4 draw calls over the system view. The single slow frame (33–100 ms) is the first time the backdrop's programs compile in a context.
- **Visual checks** (screenshots):
  - Saturn before, mid-fade and settled: the rings and moons stay in place, the system fades out, and the stars do not move.
  - Jupiter settled: Waykeeper satellite scanning, label, Io's eclipse spot.
  - Europa: system vs detail lit identically.
  - 7 Iris: the halo fades out.
- **Fixed during the check:**
  1. The backdrop stars were drawn over Saturn's rings, which write no depth. Once settled, the stars now go first among the transparent objects.
  2. The asteroid's halo filled the view at the detail framing. It now fades with the mix.
- Every process started for the check was stopped: Chrome on 9471 and `vite preview` on 7431. Checked with `pgrep` and `lsof` (nothing listening, no process left).

## Deferred, or for later tasks

- **P6-02:** real detail (atmosphere, clouds, maps beyond 2048, normal and specular), a detail moon layout (with an anchor override, see above), and asteroid relief (the rock is the system's detail-1 icosahedron).
- **Pre-warming** the backdrop's programs (`gl.compile`) to remove the first-entry hitch.
- **Fade sorting:** during the fade, a beam or halo that sits behind the body's centre is dimmed by the transparent backdrop for those 0.9 s, because of z-sorting. Not visible in the checks.
- **True scale:** the backdrop grows with a far moon's orbit (Nereid). Correct, but large. Not measured.
- **A11y:** the second-`Enter` rule is announced only through the button's title. A screen-reader hint could come with P5-04's follow-ups.
- **Saturn's framing** uses the anchor radius including its rings (2.4 × ≈ 2.3 R). The planet itself is therefore framed from farther than the others, which is consistent with the system framing.

## What Cosmin should try

1. Click Jupiter (or `]` to it), then scroll in. Past about 3 radii the rest of the system fades out behind it while the moons keep orbiting. Scroll back out and it returns.
2. With the camera on a body, click "Detail view" in the breadcrumb, then click "Jupiter" in "Solar system › Jupiter › Detail". The camera flies back out to the system framing.
3. Keyboard: `]` to a body, `Enter` (selects), `Enter` again (goes in), then `Escape` repeatedly: detail → camera body → selection → whole system.
4. In Jupiter's view click a moon: it selects or shows its card and leaves for it. Click Jupiter: it selects its Waykeeper and stays.
5. Turn on reduced motion in macOS: the switch becomes instant.
6. Try Saturn, Earth (with its HQ station), a task asteroid, and a moon such as Titan.
