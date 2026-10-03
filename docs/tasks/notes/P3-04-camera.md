# P3-04 — Camera controls and fly-to

Branch `p3-04-camera` (from `p3-wave2-bodies-belt-camera`), 2026-10-03.

## What was built

Everything is in `apps/web/src/scene/camera/`. Only `CameraRig.tsx` imports three.js, drei or R3F. The rest is plain TypeScript on `[x, y, z]` tuples, so the store, the breadcrumb and the keyboard handler can live in the panel's first chunk (checked: `grep` on the build finds `OrbitControls`/`WebGLRenderer` only in the `SolarScene` chunk).

| File | What |
| --- | --- |
| `flight.ts` | The pure maths. Vector helpers. `easeInOutCubic`. `framingDistance(radius, view)`: the body's angular radius is `FOCUS_FILL` (0.3) of the narrower half field of view (vertical, or horizontal on a portrait viewport), and the camera never comes closer than 1.5 radii. A radius below 0.05 is framed as 0.05. `approachDirection(body, camera, sunRadius, distance)`: keeps the current viewing direction when the line of sight from the framing point clears the Sun by 1.5 Sun radii. Otherwise it turns the direction just enough to point `MIN_OUTWARD` (cos 0.3) away from the Sun, keeping its sideways part (or leaning up when there is none). `overviewPose(extent, view)`: the Sun at the centre, the initial camera's slope (40 over 140), backed off until a sphere of `extent` spans the narrower field of view, and never closer than the initial camera. `flightDuration`: 0.8–1.5 s, longer for longer trips, and 0 for reduced motion. `flightPose`: an eased lerp of position and target, with the camera pushed outside 2 Sun radii, so a flight goes around the Sun, not through it. `leaveDistance(radius)` = 1.5 radii. |
| `director.ts` | `CameraDirector`, three-free, with three modes. **free**: OrbitControls alone. **flying**: to a body or to the overview; the goal is recomputed every frame from the live anchor, so a moving body is met where it is. **following**: the target moves with the body, and the camera's offset turns about +Y with the body's orbit (`follow`), so the user's chosen view and its Sun-safe geometry are kept as the body goes round. Events: `arrived`, `overview`, `left` (the user panned the target off the body), `lost` (the anchor went away). `interrupt()`: user input stops a flight where it is. `limits()`: OrbitControls' min/max distance. Focused, the minimum lets a tiny asteroid fill the view but never puts the camera inside the body. Around the Sun, the minimum keeps the camera outside it. The maximum is 1.6 × the overview distance (at least 200). Every step keeps the camera outside 1.3 Sun radii. |
| `store.ts` | `useCameraStore` (zustand), the API outside the canvas (below). `bodyOrder(anchors)`: the order for next/previous. `anchorPosition(anchor)`: the world position, from `updateWorldMatrix` plus the matrix translation, with no three import. `anchorWorld()`: the registry as the director sees it in one frame (positions, radii, the Sun's radius from the `star` anchor, else 6, and the system's extent). `prefersReducedMotion()`. |
| `CameraRig.tsx` | Replaces the placeholder. drei `<OrbitControls makeDefault enableDamping dampingFactor={0.08}>`: drag to orbit, right-drag or two fingers to pan, wheel or pinch to zoom. Each frame (`useFrame`) it reads the camera and the target, takes a new store request (by `seq`), steps the director, writes the pose back (only when it changed), reports events to the store, sets min/max distance, and turns damping off during a flight and under reduced motion. It raises `camera.far` when the zoom-out limit needs it (never below 6000). It calls `invalidate()` on a new request, on an anchor change, and on every frame of a flight. OrbitControls invalidates on input and while its damping settles. Until the first request or user input, the camera snaps to the overview whenever anchors register, so the first view fits whatever P3-02/P3-03 register. A scale-mode change (`useSceneScale`) reframes: the focused body again, or the overview if the user had moved. Unmount clears the store's focus. |
| `keys.ts` | `sceneKeyAction(event)`: `]` next, `[` previous, `Escape`/`Home` back to the system. Ignored with Ctrl/Meta/Alt, during IME composition, and when the target is an input, textarea, select or contenteditable. |
| `Breadcrumb.tsx` | `CameraBreadcrumb`: "Solar system › Jupiter › Europa", over the scene's bottom-left. "Solar system" is always a button that flies back to the overview from any camera state (`aria-current` when nothing is focused). A moon's planet is a button that flies to the planet. The focused body has `aria-current="location"`. Names come from `world.bodies` (an unknown id shows the id, and `SUN_ANCHOR_ID` shows "Sun"). |

### The fly-to API (for P3-05 and the panel)

```ts
import { useCameraStore } from '../scene/camera/store.js';

useCameraStore.getState().flyTo(bodyId); // false (nothing changes) if no anchor is registered for it
useCameraStore.getState().back();        // the whole system, from any state
useCameraStore.getState().next();        // / previous(): returns the id it flies to
useCameraStore((s) => s.focusedId);      // the body flown to or followed; undefined = free / overview
useCameraStore((s) => s.flying);
```

`focusedId` is set as soon as `flyTo` is called, so the breadcrumb and the panel update at once. It goes back to `undefined` when the user interrupts the flight, pans off the body, or the anchor is unregistered. Orbit and zoom keep it. Picking (P3-05) should call `flyTo(hit.bodyId)` (and select through `state/selection.ts`, decision 53). The camera never touches the selection.

### Behaviour

- **Flight**: eased (cubic in-out), 0.8–1.5 s by travel. Any user input on the canvas (OrbitControls `start`: drag, wheel, touch) stops it where it is and drops the focus. A new `flyTo`/`back` during a flight starts from the current pose.
- **Focus mode**: after arrival, the target stays on the moving anchor and the view turns with its orbit. Orbiting and zooming around the body keep the focus. Panning the target more than 1.5 radii off the body leaves it.
- **Corner case 26**: a body is always reachable: every anchor can be flown to from any camera state, and the zoom limits always allow its framing distance, down to a 0.05-radius asteroid. A flight never ends with the Sun between the camera and the body, because the approach is turned whenever the line of sight would pass within 1.5 Sun radii. Following keeps that geometry because the offset turns with the orbit. Flights detour around the Sun, and the camera is never inside it.
- **Reduced motion**: `prefers-reduced-motion: reduce` makes every flight an instant jump and turns damping off.
- **Keyboard**: the scene section is focusable (`tabIndex=0`, `aria-keyshortcuts`, a focus ring on `:focus-visible`). A pointer-down on the scene focuses it, so the shortcuts work right after a click.
- **Order of next/previous**: the Sun, then the planets, the moons, the asteroids; within a kind, by distance from the Sun (for asteroids, by orbit radius); ties by id. It wraps around. With nothing focused, `]` starts at the Sun and `[` at the last body.

## Proposed SPEC / TECHNOLOGY text (recorded: SPEC decisions 63, 64 and TECHNOLOGY §2.1)

**SPEC §7, new decision (camera navigation):**

> **Camera: fly to a body, follow it, always come back** (P3-04): the user drags to orbit, right-drags (two fingers) to pan, and scrolls (pinches) to zoom, with a little inertia. Focusing a body (a click once picking lands, a breadcrumb, a keyboard shortcut, or the panel) flies the camera there in about a second, eased, and frames the body by its size; the camera then follows the body along its orbit until the user pans away. Any drag or scroll during a flight stops it where it is. A breadcrumb over the scene ("Solar system › Jupiter › Europa") shows where the camera is; "Solar system" flies back to the whole system from any camera state. With the scene focused, `]` and `[` go to the next and previous body (Sun, planets outward, moons, asteroids), and `Escape` or `Home` goes back to the system. With "reduce motion" set in the system, flights become instant jumps. Every body can always be reached: a flight never ends with the Sun hiding the body, and the zoom limits allow framing the smallest asteroid (corner case 26).

**TECHNOLOGY §2.1, after the quality tiers:**

> - **Camera** (`apps/web/src/scene/camera/`): drei `OrbitControls` (damping 0.08) driven by a three-free `CameraDirector` (free / flying / following) that reads bodies only through the anchor registry. Requests go through a zustand `useCameraStore` (`flyTo(bodyId)`, `back()`, `next()`, `previous()`, `focusedId`) that is usable outside the canvas. The flight maths: framing distance = radius / sin(0.3 × the narrower half FOV); eased 0.8–1.5 s; the approach keeps the current direction unless its line of sight passes within 1.5 Sun radii, in which case it turns to cos ≥ 0.3 away from the Sun; flights keep 2 Sun radii from the Sun and the camera keeps 1.3. The rig calls `invalidate()` during flights (the frame loop stays `demand`), raises `camera.far` with the zoom-out limit, and treats `prefers-reduced-motion` as instant.

## Shared files touched

- `apps/web/src/scene/SceneArea.tsx`: the section gets `tabIndex={0}`, `aria-keyshortcuts`, `onKeyDown={onSceneKey}` (exported, so it can be tested) and `onPointerDown` (focus); `<CameraBreadcrumb />` is rendered after the error boundary (DOM over the canvas). The doc comment mentions the shortcuts.
- `apps/web/src/scene/scene.css`: `.pnl-scene:focus-visible` and the `.pnl-scene-crumbs` styles (bottom-left; the fps meter stays top-left).
- `apps/web/src/scene/SolarScene.tsx`: **not touched**. The `camera` prop stays `(0, 40, 140)`, fov 45, far 6000. The rig raises `far` at runtime when the system needs it (true scale).
- `anchors.ts`, `scale.ts`, `bodies/`, `belt/`: not touched. `scale.ts` is only read (`useSceneScale.subscribe`).

## Notes for P3-02 / P3-03 / P3-05

- The Sun is recognised by `kind: 'star'`, not by its id. `anchors.ts` exports `SUN_ANCHOR_ID = 'sun'`, while the brief says P3-02 registers `'b-sun'`; either works. Its radius is used for every Sun keep-out.
- Anchors may be nested (moons inside a planet group); positions are read from world matrices.
- Orbital motion has to keep its own frames coming (`frameloop` always, or `invalidate()` per frame); the rig follows in whatever frames are rendered and does not keep the loop alive by itself outside flights.
- An anchor's `radius` must be the visual radius at the current scale; the rig re-reads it every frame.
- If the true-scale system extends beyond the 1200–2400 star shell, the stars will sit inside the system. P3-02's call.
- Other bodies can still occlude a focused one (a moon behind its planet); only the Sun is avoided. Corner case 24 ("what's here", P3-05) is the place for that.

## Deferred

- Click-to-focus is P3-05 (picking calls `flyTo`). The breadcrumb, the keyboard and the store are ready.
- Approaching the lit side: the approach keeps the current direction when it is safe, so a body on the far side of the Sun is seen against the Sun, partly in shadow. A "prefer the day side" bias is a one-line change in `approachDirection` if Cosmin wants it.
- The overview fits the system's bounding sphere in the narrower field of view. On a wide screen the planets use about half the width. Tune `overviewPose` once real bodies exist.
- Keyboard pan/orbit (OrbitControls `keyEvents`) is off, to avoid clashing with arrows; it could be added later.

## Tests (Vitest; no WebGL)

- `camera/flight.test.ts` (16): easing (ends, symmetry, monotonic, clamping, slow ends); framing distance (fill, scaling, portrait, tiny asteroid); approach direction (kept when safe, including from the overview; the Sun never between the camera and a body from five hostile cameras × four radii; a blocked direction turned to exactly `MIN_OUTWARD` and leaning up; the Sun itself); segment clearance; overview (initial camera, back-off); flight duration (bounds, reduced motion); flight endpoints; going around the Sun; `pushOutside`; `rotateY`/`azimuth`.
- `camera/director.test.ts` (11): fly and frame; an unknown body is ignored; a reduced-motion jump; meeting a moving body, then following it with the view turned (same outward lean and distance); orbit and zoom keep the focus, a pan leaves it; interruption; anchor removal; the overview from behind Neptune going around the Sun; the Sun keep-out; corner case 26 as a matrix (five bodies, including a 0.05 asteroid and the Sun, × four cameras: arrives, the Sun not in the line of sight, the zoom limits allow the framing); `follow` around the Sun only translates.
- `camera/store.test.ts` (11, with fake anchors as plain three `Object3D`s): the order (Sun, planets outward, moons, asteroids); world positions of nested anchors; `anchorWorld` (Sun radius, extent, the default); `flyTo` (known/unknown), new `seq` per request, `back`, next/previous walking and wrapping, previous from nothing, the rig's reports (started, arrived, released, at the overview), no bodies.
- `camera/camera-ui.test.tsx` (6, jsdom): the key map; modifiers, composition and typing in input/textarea/select/contenteditable ignored; `onSceneKey` on a section driving the store, with typing in a field inside it ignored; the breadcrumb at the overview, for a moon under its planet (clicking the planet and "Solar system"), and the Sun's name.
- Gates (from the repo root): `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` all pass. protocol 64, server 842 (+1 skipped), web 263 (was 219).

### Smoke check in a real browser (not committed)

A throwaway page mounted `SolarScene` with temporary orbiting spheres registered as anchors (a planet of radius 0.8, 2 and 5, and a 0.08 asteroid) and was driven through headless Chrome over CDP:

- the initial overview fitted the bodies;
- `flyTo` arrived in about 1 s, framed each body the same size on screen (the 0.08 asteroid too), and followed it (Sun and body in the same arrangement two seconds later while it orbited);
- a drag mid-flight stopped it and cleared the focus;
- an orbit-drag kept the focus; a right-drag pan left it;
- `back()` returned to the overview;
- the breadcrumb tracked every step.

No console errors; only R3F's own `THREE.Clock` deprecation warning.

## What Cosmin should try

1. `pnpm dev`, open the panel with the scene shown (once P3-02 registers bodies; on this branch alone there are no anchors, so only the overview, orbit, pan and zoom can be tried).
2. Drag to orbit, right-drag to pan, scroll to zoom. Check that the camera can't enter the Sun or zoom out past the system.
3. Click the scene, then press `]` repeatedly: Sun, planets outward, moons, asteroids, each flown to in about a second, with the breadcrumb updating. `[` goes back one. `Escape` or `Home` returns to the whole system.
4. During a flight, drag: it stops where it is and the breadcrumb returns to "Solar system".
5. Focused on a planet, orbit and zoom around it while it moves along its orbit (the camera follows), then pan away (the breadcrumb drops the planet).
6. Fly to a small asteroid: it fills about a third of the view.
7. Focus a moon: the breadcrumb shows "Solar system › planet › moon"; clicking the planet flies to it.
8. macOS System Settings → Accessibility → Display → Reduce motion: flights become instant jumps.
9. Flip the true-scale toggle (P3-02) while focused: the camera reframes the same body.
