# P3-07 — Domain binding and labels

Branch `p3-07-labels` (from `p3-wave4-labels`), 2026-10-03.

## What was built

Everything lives in `apps/web/src/scene/labels/`. Only `LabelProjector.tsx` and `MoonMarkers.tsx` import three.js, and both run inside the canvas. The rest is in the panel's chunk.

| File | What |
| --- | --- |
| `label-model.ts` | World → labels, with no three.js and no DOM. **A body hosting a project** (planet or moon) or **a task** (asteroid) shows the work's name (shortened to 32 characters; `fullTitle` keeps the full name) and its state. The state is the server's derived `state` (P2-15), shown as a pill: `in progress`, `blocked on you`, `awaiting closure`, `✓ completed`, `paused`, `failed`, … **A planet or moon with only a `movedTo` marker** shows the work that left and `moved to <target body>`; an asteroid with one gets no label (see "Moved asteroids"). Hosted work wins over a stale marker. **Reserved bodies** (`kind: 'star'`, `meta.reserved`: the Sun, Earth, the Moon) and **free bodies** show no label. Work not loaded yet shows the body's name with a neutral `loading` pill. Every label carries a tone (`beacon`, `active`, `waiting`, `warn`, `fail`, `done`), `selected`, and a de-clutter priority: selected 5 > blocked on user 4 > in progress 3 > other open work 2 > finished or moved 1. **Moons** hosting a project are `sub-project` (the project has a `parentProjectId`: `↳ part of <parent>`) or `independent` (an "own project" badge). `independentMoons(world)` lists the moons that get a ring. |
| `layout.ts` | The projector's maths, with no three.js. `projectToScreen` (column-major view-projection; `undefined` behind the camera). `occluded` checks whether the line of sight passes through the Sun or a planet in front of the body; the body itself is skipped. `labelRect` places the label centred above the body's top on screen, with a 4 px gap; a `pinTop` label (the selected body's, the camera focus's) that would stick out above the viewport is clamped to its top edge, over its body. `onScreen` culls labels outside the viewport, including one pushed entirely above it. `declutter` is greedy: priority, then the nearer body, then the id, with a 2 px margin. `movedEnough` is the 0.5 px write threshold. `Throttle` allows at most `hz` updates a second, takes forced updates, and reports `wait` for the on-demand loop. |
| `registry.ts` | Where the DOM layer meets the projector: bodyId → {element, priority, measured size}, plus what was last written. `setShown` and `writePosition` are the only DOM writes, and both are counted in `labelStats` (`updates`, `writes`). `labelAt(x, y)` answers which shown label covers a point, for picking. `hideAll` runs on the projector's unmount. |
| `LabelLayer.tsx` | ONE absolutely positioned layer over the canvas, mounted by `SceneArea` under the scene chrome (fps meter, breadcrumb, scale toggle), the hover label and the popover. React renders the **content** from `useAppStore` (bodies, projects, tasks, the selection's body), so a state change appears on the next render, well within a second. React never renders the **position**. A label is measured (`offsetWidth/Height`) only when what it shows changes (title, state, moon role, parent, priority, selection), not on every world change, and it starts hidden (CSS) until the projector places it. The labels take **no pointer events**: picking resolves a click or hover on a label (see "Labels and the pointer"). The hovered body's label is highlighted. The layer has `aria-hidden` and the labels are not in the tab order (see "Accessibility"). |
| `LabelProjector.tsx` | Inside the canvas: one `useFrame` pass for every label, at most `quality.labelHz` times a second. Each pass computes one view-projection matrix and projects each label's anchor. It hides a label when its body is behind the camera, off screen, without an anchor, or behind the Sun or a planet. Then it de-clutters, and it writes `transform` only when the label moved more than 0.5 px and `visibility` only when it changed. A new or removed label, a new or removed anchor, a content or size change, or a canvas resize forces the next pass (a label can register before its body's anchor: the label in a layout effect, the anchor in a passive one). Under the `demand` loop (reduced motion), a skipped frame schedules a single `invalidate()` for when the next pass is due, so a camera that stops between two passes still leaves its labels in the right place. Under the mobile cap (`never` + `FrameCap`), the pass rides the capped frames: 15 Hz from 30 fps. |
| `MoonMarkers.tsx` | A thin teal ring facing the camera around each independent-project moon (radius × 1.7, at least 5 px), depth-tested, not a pick target, and outside the anchor's subtree, so the outline never collects it. |
| `labels.css` | The look. Amber stays "blocked on you" (the panel's beacon: a filled amber pill with a pulsing dot that stops under reduced motion, an amber border and a glow). Blue is the selected body's label border. Teal marks "own project". Finished work and "moved to …" labels are dimmed by their frame and pill (dashed, fainter border and pill, a greyer title), never by `opacity`, so every line of text keeps at least 4.5:1; a moved label's title is in italics. The layer's z-index comes from the scene area's stacking order (`scene.css`). |

### Independent vs sub-project moons (SPEC §3.2) — chosen and why

- **Independent small project:** an **"own project" badge** in teal on the label, **plus a teal ring around the moon** in the scene. The ring keeps the distinction visible when de-clutter hides the label or the label is off screen. A ring reads as "a boundary of its own". Teal is free in the palette: amber is reserved for "blocked on you", and blue is the selection and outline.
- **Sub-project:** no marker on the body. It reads as part of its planet, which is what §3.2 asks for. Its label adds a second line, `↳ part of <parent project>`, so it is never mistaken for a project of its own.
- Considered and not done: colour-coding each project family with a hashed hue. Two unrelated projects can land on similar hues, so it is not reliable, and it adds a palette that competes with the state colours. Tinting the moon's surface was also rejected, because it fights the realistic look from P3-02 and P3-09.

### The belt's labels

P3-03's drei `<Html>` name label on task asteroids is **removed**. Those asteroids now get their label from this layer, showing the task's description and state instead of the asteroid's name; the name is still on hover. `Belt.tsx` lost the `Html` import, the fixed portal and the label style. No other drei `Html` remains in the scene.

### Moved asteroids

Planets and moons with a marker show `moved to …`. **An asteroid whose task moved away has no anchor** (decision 63: "a freed asteroid, or one whose task moved away, is just part of the belt"), so the model builds no label for it at all (review fix: it used to build one that could never show). If Cosmin wants the marker on asteroids too, keep bodies that have a `movedTo` in `taskAsteroids` and drop the asteroid check in `bodyLabel`.

### Labels and the pointer (review fixes)

The first version made each label a DOM click target over the canvas. That blocked the canvas's gestures: a wheel over a label did not zoom, a drag starting on one did not orbit, a press-drag-release on one still selected (against decision 65's "dragging never selects"), a planet's label over its moons took their clicks, and the hover cleared over labels. Now:

- The labels have `pointer-events: none`; every pointer event reaches the canvas, so OrbitControls and the click-vs-drag threshold (`ClickTracker`) see it like any other.
- **The label-vs-body rule** (`labelUnder` in `Picking.tsx`): on a click (after the drag threshold) and on hover, a body the pointer's ray passes through — its drawn sphere or its minimum 6 px target — takes precedence. Otherwise a shown label's rectangle under the pointer (`registry.labelAt`, from the last written position and the measured size) means that label's body, and wins over near misses (bodies merely within `CLUSTER_PX`, such as the label's own body just under it, or a speck nearby). So a moon under its planet's label stays clickable, and a click on the label anywhere off a body acts on the label's body. Hovering a label shows its body's name and highlights the label.
- The full work name was in the label's `title` tooltip; a non-pointer element shows no tooltip, so it is gone. The hover label shows the body's name, and the panel shows the full name.

### Stacking order (review fix)

The label layer had z-index 20 while the breadcrumb, the scale toggle and the fps meter had none, so labels painted over them. The order inside the scene area is now one set of custom properties on `.pnl-scene` (`scene.css`, documented there): canvas < labels (10) < scene chrome: fps meter, breadcrumb, scale toggle (20) < hover label (30) < popover (40). `.pnl-scene` isolates its stacking context. `stacking.test.ts` reads the stylesheets and checks the order, `pointer-events: none` on the labels, and the finished labels' contrast.

### Accessibility

The layer is `aria-hidden` and no label is focusable: labels are pointer-only extras. Everything they say (the work's name and state, sub-project or own project, moved to) is in the panel, which has full keyboard and screen-reader access; in the scene itself the keyboard path is `]` / `[` to move between bodies and `Enter` to select the one the camera is on (decisions 64, 65).

## Proposed SPEC text (recorded as SPEC decision 66)

> | 66 | Scene labels | **Every body with work says what and how it is** (2026-10-03, P3-07; §3.2, §4.1, §4.4, decisions 4, 10, 15, 63, 65): a planet, moon or asteroid that hosts a project or task carries a small label with the work's name and its state (in progress, blocked on you, awaiting closure, paused, failed, interrupted, ✓ completed …); "blocked on you" is the loudest (the amber beacon, as in the panel). A body that work moved away from says "moved to <body>" until it is freed, and finished work is dimmed. The Sun, Earth and the Moon (reserved) and free bodies carry no label; Earth's role is the Harmonizer's, one click away. A moon hosting an independent small project is ringed in teal and its label says "own project"; a moon hosting a sub-project has no ring and its label says "part of <the planet's project>". When labels would overlap, the selected body's wins, then "blocked on you", then work in progress, then the rest; labels of bodies behind the Sun or a planet, or off screen, are hidden. Clicking a label is clicking its body. Labels follow the bodies a little less often than the picture moves (30 times a second, 15 on the phone's tier) and change as soon as the state does. |

**§4.1** could add one bullet: "Bodies with work carry a label with the work's name and state; independent-project moons are ringed (decision 66)."

**TECHNOLOGY §2.1:** written in this branch. There is a new **Domain labels** bullet, before "Renderer setup". The belt bullet no longer mentions the drei `Html` label, and the quality-tier bullet gains `labelHz` 30/30/15.

**IMPLEMENTATION_PLAN / phase file:** the P3-07 task text said "HTML labels anchored to bodies (drei `<Html>`)". I suggested "one HTML label layer projected in a throttled pass (no drei `Html`)"; the coordinator has since rewritten the task text in the phase file to that wording. This branch did not edit the phase file.

## Shared files touched

- `apps/web/src/scene/SolarScene.tsx`: imports, and mounts `<MoonMarkers />` and `<LabelProjector hz={quality.labelHz} />` after `<Picking>`. One paragraph added to the doc comment.
- `apps/web/src/scene/SceneArea.tsx`: `<LabelLayer />` before `<PickingOverlay />`. One paragraph added to the doc comment.
- `apps/web/src/scene/quality.ts`: additive. A `labelHz: number` field in `SceneQuality` and its doc comment, with high 30, balanced 30 and mobile 15.
- `apps/web/src/scene/belt/Belt.tsx`: the drei `Html` label is removed (import, portal layer, `LABEL_STYLE`, prop), and the doc comment is updated.
- `docs/TECHNOLOGY.md` §2.1: see above.
- Read but not changed: `anchors.ts`, `camera/store.ts` (`anchorPosition`), `picking/body-action.ts` (`bodyName`, `selectionBody`), `picking/store.ts` (`activateBody`), `picking/pick.ts` (`pixelScale`), `picking/fixtures.ts`, `state/store.ts`.
- Not touched: the phase file, `docs/tasks/README.md`, SPEC, IMPLEMENTATION_PLAN, `bodies/`, `picking/`, `camera/`.
- Review fixes (branch `p3-07-fixes`): `picking/Picking.tsx` (label hits, `labelUnder`) and its test, `picking/picking.css`, `bodies/scale-toggle.css` and `scene.css` (z-index from the stacking order), `SceneArea.tsx` (doc comment), new `stacking.test.ts`.

## Deferred

- **Keyboard on labels.** The labels are not focusable (see "Accessibility"). Making 40 labels tab stops would bury the panel. A roving "label list" could come with the Phase 5 polish.
- **De-clutter hysteresis.** Two labels of equal priority that hover at the edge of overlapping can swap as the bodies move (the nearer one wins). I did not see it as flicker in the headless runs. If it shows, prefer the label that was shown last.
- **Project tasks on a planet** have no label of their own. The planet's label carries the project's state, and that state already includes "blocked on you" from any of its tasks (P2-15). Satellites (Phase 4) will show the Stewards.
- **The beacon (§4.1)** in the scene, as opposed to on the label, is Phase 4, with the satellites.
- The asteroids' invisible pick spheres are still unused (P3-05 notes).

## Tests (Vitest, jsdom, no WebGL)

- Review fixes added: `stacking.test.ts` (5: the stacking order, labels never take the pointer, finished labels' contrast ≥ 4.5:1, no opacity, still dimmer); `Picking.test.tsx` +4 (a click on a label's rectangle selects its body; a moon under a planet's label wins, beside it the label; a drag starting on a label selects nothing; hovering a label hovers its body, a hidden label is no target); `labels-ui.test.tsx` +3 (an anchor registering after its label shows on the next pass under the demand loop; a label is re-measured only when its content changes; the focused body's label is clamped to the top edge), and the "click a label" test now checks the label is no click target and the hovered label is marked; `layout.test.ts` +1 (above-the-viewport culling and `pinTop` clamping); `label-model.test.ts` +1 (no label for a moved asteroid; a moved moon keeps one). Web **502**.
- `label-model.test.ts` (16): which bodies get labels (assigned and moved, nothing else). Reserved bodies (Sun, Earth, Moon), free bodies and unknown bodies are unlabelled, even a reserved body with a host. Project and task labels with name and state. Every `WorkState` has a text and a tone, and only `blocked_on_user` is a beacon. Completed work is dimmed with the lowest priority. "moved to …" on a planet and on an asteroid, and host wins over a stale marker. Unloaded work. Shortened titles. The selected flag and priority. Independent vs sub-project moons and `independentMoons`. The priority order.
- `layout.test.ts` (14): projection against three's own `Vector3.project`, and behind the camera. Occlusion behind the Sun (behind, beside, in front, self, behind the eye), and a moon behind and in front of its planet. Label placement, off-screen culling, de-clutter by priority (selected > blocked > in progress > others > done), ties by depth then id. The 0.5 px write threshold. The throttle: 30 updates from 60 frames at 60 fps, 15 from 30 frames at the capped 30 fps, forced updates and rate changes.
- `labels-ui.test.tsx` (11, R3F hooks mocked with a manual frame loop and a driven `performance.now`):
  - The layer's content for the picking world.
  - **A store state change updates the label at once** (blocked, then completed).
  - The selection marks a label and raises its priority.
  - **Clicking a label = clicking its body** (selects the Waykeeper and flies; a body with no agent opens the info card).
  - An unassigned body loses its label.
  - The projector shows labels and hides the one behind the Sun. It writes nothing for a still camera, one transform per visible label after a move, and nothing for a sub-half-pixel move. It runs at 30 Hz at 60 fps and 15 Hz at 30 fps. A new label forces a pass, and on demand a skipped frame schedules a render.
  - De-clutter in place: in progress beats approved, and the selected label beats in progress.
  - Labels are hidden behind the camera, off screen, and all of them on unmount.
- Gates from the repo root: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, all green. Counts: protocol 67, server 842 (+1 skipped), web **488** (was 447; +41). three.js is still absent from the panel's first chunk (see the build check in the report).

## Performance (headless Chrome, not committed)

A throwaway page (since deleted) mounted `SolarScene` and `LabelLayer` with the catalogue's 31 bodies. **Load:** 10 projects (7 planets; Europa and Titan as sub-projects; Io as an independent project), Phobos with a "moved to Mars" marker, and 30 task asteroids, with states cycling through in progress, blocked, awaiting closure, paused, completed, approved, failed and interrupted. That makes 41 labels. **Setup:** Chrome over CDP, ANGLE Metal on an Apple M3 Pro, 1440×900 at DPR 2. **Method:** 5 s warm-up, then 6 s measured. "Flights" means `flyTo` every 1.5 s across Jupiter, an asteroid, Saturn, Europa, Mars and another asteroid. fps comes from the scene's own meter (`onFps`, which lifts the mobile cap). "Updates" are projection passes per second. "Writes" are DOM style writes per second.

| tier | labels | camera | fps (avg / min) | updates/s | DOM writes/s | labels shown |
| --- | --- | --- | --- | --- | --- | --- |
| high | on | overview | 60 / 59.7 | 25–28.5 | 15.3–15.7 | 7 of 41 |
| high | on | flights | 60 / 59.7 | 26–29 | 145–150 | 1–7 |
| high | off | overview | 60 / 59.8 | — | 0 | — |
| high | off | flights | 60 / 59.9 | — | 0 | — |
| balanced | on | overview | 60 / 59.9 | 28.2 | 15.3 | 7 |
| balanced | on | flights | 60 / 59.8 | 28.1 | 148 | 1–7 |
| balanced | off | both | 60 / 59.8 | — | 0 | — |
| mobile (meter, cap lifted) | on | overview | 60 / 59.8 | 14.3 | 14.8 | 7 |
| mobile (meter, cap lifted) | on | flights | 60 / 59.8 | 14.3 | 89 | 1–7 |
| mobile (capped, no meter) | on | overview | (30 cap) | 14.5 | 15.2 | 7 |
| mobile (capped, no meter) | on | flights | (30 cap) | 14.1 | 90 | 1–7 |

- Labels cost nothing measurable in fps on this machine. The very first high run measured 44–50 fps with and without labels alike: shader compilation and texture paints still finishing in a cold profile. Two later repeats were 60/60.
- For comparison: with drei `Html`, every label is a projection plus a style write on every rendered frame, about 31 × 60 ≈ 1 900 writes/s for the belt alone. Here it is about 15/s while orbiting, and at most about 150/s during a flight.
- At the overview, de-clutter shows 7 of the 41 labels: the three "blocked on you" ones win, then the in-progress ones. Zooming in shows the rest as they separate (see the Jupiter screenshot: Io with its teal ring and "own project", Europa with "part of GalacticAgents itself", Jupiter, Neptune).
- The phone numbers (Safari, mobile tier) are P3-08's.

## What Cosmin should look at

1. `pnpm dev` with some projects and asteroid tasks: every planet, moon or asteroid with work has a label with name and state. Earth, the Moon, the Sun and free bodies have none.
2. Make a Steward ask you a question: its asteroid's label (or its project's planet) turns amber "blocked on you" within a second, and wins over its neighbours at the overview.
3. An independent small project on a moon: a teal ring and "own project". A sub-project moon: no ring, "↳ part of …". Is the teal ring too subtle, or too loud?
4. Move a task into a project, or promote one: the old planet or moon shows "moved to …", dimmed. (On an asteroid it shows nothing; see "Moved asteroids", decision 63.)
5. Close a project: its label dims with "✓ completed".
6. Click a label: the same as clicking the body, unless a body (a moon) is right under the pointer. Drag or scroll starting on a label moves the camera as anywhere else.
7. At the overview many labels are hidden by de-clutter. Is the order (selected > blocked > in progress > the rest) right, and is showing about 7 of 41 at the overview acceptable?
8. Decide decision 66's text and whether moved asteroids should keep their marker label.
