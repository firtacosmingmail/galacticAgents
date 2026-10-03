# P3-07 — Domain binding and labels

Branch `p3-07-labels` (from `p3-wave4-labels`), 2026-10-03.

## What was built

Everything lives in `apps/web/src/scene/labels/`. Only `LabelProjector.tsx` and `MoonMarkers.tsx` import three.js, and both run inside the canvas. The rest is in the panel's chunk.

| File | What |
| --- | --- |
| `label-model.ts` | World → labels, with no three.js and no DOM. **A body hosting a project** (planet or moon) or **a task** (asteroid) shows the work's name (shortened to 32 characters; the tooltip keeps the full name) and its state. The state is the server's derived `state` (P2-15), shown as a pill: `in progress`, `blocked on you`, `awaiting closure`, `✓ completed`, `paused`, `failed`, … **A body with only a `movedTo` marker** shows the work that left and `moved to <target body>`. Hosted work wins over a stale marker. **Reserved bodies** (`kind: 'star'`, `meta.reserved`: the Sun, Earth, the Moon) and **free bodies** show no label. Work not loaded yet shows the body's name with a neutral `loading` pill. Every label carries a tone (`beacon`, `active`, `waiting`, `warn`, `fail`, `done`), `selected`, and a de-clutter priority: selected 5 > blocked on user 4 > in progress 3 > other open work 2 > finished or moved 1. **Moons** hosting a project are `sub-project` (the project has a `parentProjectId`: `↳ part of <parent>`) or `independent` (an "own project" badge). `independentMoons(world)` lists the moons that get a ring. |
| `layout.ts` | The projector's maths, with no three.js. `projectToScreen` (column-major view-projection; `undefined` behind the camera). `occluded` checks whether the line of sight passes through the Sun or a planet in front of the body; the body itself is skipped. `labelRect` places the label centred above the body's top on screen, with a 4 px gap. `onScreen` culls labels outside the viewport. `declutter` is greedy: priority, then the nearer body, then the id, with a 2 px margin. `movedEnough` is the 0.5 px write threshold. `Throttle` allows at most `hz` updates a second, takes forced updates, and reports `wait` for the on-demand loop. |
| `registry.ts` | Where the DOM layer meets the projector: bodyId → {element, priority, measured size}, plus what was last written. `setShown` and `writePosition` are the only DOM writes, and both are counted in `labelStats` (`updates`, `writes`). `hideAll` runs on the projector's unmount. |
| `LabelLayer.tsx` | ONE absolutely positioned layer over the canvas, mounted by `SceneArea` under the hover label and the popover. React renders the **content** from `useAppStore` (bodies, projects, tasks, the selection's body), so a state change appears on the next render, well within a second. React never renders the **position**. A label is measured (`offsetWidth/Height`) only when its content changes, and it starts hidden (CSS) until the projector places it. Clicking a label calls `activateBody(bodyId, at)` (P3-05): the camera flies there and the click either selects the agent or opens the info card, exactly like a click on the body. The layer has `aria-hidden` and the labels are not in the tab order (see Deferred). |
| `LabelProjector.tsx` | Inside the canvas: one `useFrame` pass for every label, at most `quality.labelHz` times a second. Each pass computes one view-projection matrix and projects each label's anchor. It hides a label when its body is behind the camera, off screen, without an anchor, or behind the Sun or a planet. Then it de-clutters, and it writes `transform` only when the label moved more than 0.5 px and `visibility` only when it changed. A new or removed label, a content or size change, or a canvas resize forces the next pass. Under the `demand` loop (reduced motion), a skipped frame schedules a single `invalidate()` for when the next pass is due, so a camera that stops between two passes still leaves its labels in the right place. Under the mobile cap (`never` + `FrameCap`), the pass rides the capped frames: 15 Hz from 30 fps. |
| `MoonMarkers.tsx` | A thin teal ring facing the camera around each independent-project moon (radius × 1.7, at least 5 px), depth-tested, not a pick target, and outside the anchor's subtree, so the outline never collects it. |
| `labels.css` | The look. Amber stays "blocked on you" (the panel's beacon: a filled amber pill with a pulsing dot that stops under reduced motion, an amber border and a glow). Blue is the selected body's label border. Teal marks "own project". Finished work and "moved to …" labels are dimmed (opacity 0.6, dashed border), and a moved label's title is in italics. |

### Independent vs sub-project moons (SPEC §3.2) — chosen and why

- **Independent small project:** an **"own project" badge** in teal on the label, **plus a teal ring around the moon** in the scene. The ring keeps the distinction visible when de-clutter hides the label or the label is off screen. A ring reads as "a boundary of its own". Teal is free in the palette: amber is reserved for "blocked on you", and blue is the selection and outline.
- **Sub-project:** no marker on the body. It reads as part of its planet, which is what §3.2 asks for. Its label adds a second line, `↳ part of <parent project>`, so it is never mistaken for a project of its own.
- Considered and not done: colour-coding each project family with a hashed hue. Two unrelated projects can land on similar hues, so it is not reliable, and it adds a palette that competes with the state colours. Tinting the moon's surface was also rejected, because it fights the realistic look from P3-02 and P3-09.

### The belt's labels

P3-03's drei `<Html>` name label on task asteroids is **removed**. Those asteroids now get their label from this layer, showing the task's description and state instead of the asteroid's name; the name is still on hover. `Belt.tsx` lost the `Html` import, the fixed portal and the label style. No other drei `Html` remains in the scene.

### Moved asteroids

The model gives a `moved to …` label to any body with a marker. Planets and moons have anchors and show it. **An asteroid whose task moved away has no anchor** (decision 63: "a freed asteroid, or one whose task moved away, is just part of the belt"), so its label never shows. I kept decision 63 as it is. If Cosmin wants the marker on asteroids too, the change is one line in `taskAsteroids` (keep bodies that have a `movedTo`), and the labels work as they are.

## Proposed SPEC text (recorded as SPEC decision 66)

> | 66 | Scene labels | **Every body with work says what and how it is** (2026-10-03, P3-07; §3.2, §4.1, §4.4, decisions 4, 10, 15, 63, 65): a planet, moon or asteroid that hosts a project or task carries a small label with the work's name and its state (in progress, blocked on you, awaiting closure, paused, failed, interrupted, ✓ completed …); "blocked on you" is the loudest (the amber beacon, as in the panel). A body that work moved away from says "moved to <body>" until it is freed, and finished work is dimmed. The Sun, Earth and the Moon (reserved) and free bodies carry no label; Earth's role is the Harmonizer's, one click away. A moon hosting an independent small project is ringed in teal and its label says "own project"; a moon hosting a sub-project has no ring and its label says "part of <the planet's project>". When labels would overlap, the selected body's wins, then "blocked on you", then work in progress, then the rest; labels of bodies behind the Sun or a planet, or off screen, are hidden. Clicking a label is clicking its body. Labels follow the bodies a little less often than the picture moves (30 times a second, 15 on the phone's tier) and change as soon as the state does. |

**§4.1** could add one bullet: "Bodies with work carry a label with the work's name and state; independent-project moons are ringed (decision 66)."

**TECHNOLOGY §2.1:** written in this branch. There is a new **Domain labels** bullet, before "Renderer setup". The belt bullet no longer mentions the drei `Html` label, and the quality-tier bullet gains `labelHz` 30/30/15.

**IMPLEMENTATION_PLAN / phase file:** the P3-07 task text says "HTML labels anchored to bodies (drei `<Html>`)". I suggest "one HTML label layer projected in a throttled pass (no drei `Html`)". I did not edit the phase file.

## Shared files touched

- `apps/web/src/scene/SolarScene.tsx`: imports, and mounts `<MoonMarkers />` and `<LabelProjector hz={quality.labelHz} />` after `<Picking>`. One paragraph added to the doc comment.
- `apps/web/src/scene/SceneArea.tsx`: `<LabelLayer />` before `<PickingOverlay />`. One paragraph added to the doc comment.
- `apps/web/src/scene/quality.ts`: additive. A `labelHz: number` field in `SceneQuality` and its doc comment, with high 30, balanced 30 and mobile 15.
- `apps/web/src/scene/belt/Belt.tsx`: the drei `Html` label is removed (import, portal layer, `LABEL_STYLE`, prop), and the doc comment is updated.
- `docs/TECHNOLOGY.md` §2.1: see above.
- Read but not changed: `anchors.ts`, `camera/store.ts` (`anchorPosition`), `picking/body-action.ts` (`bodyName`, `selectionBody`), `picking/store.ts` (`activateBody`), `picking/pick.ts` (`pixelScale`), `picking/fixtures.ts`, `state/store.ts`.
- Not touched: the phase file, `docs/tasks/README.md`, SPEC, IMPLEMENTATION_PLAN, `bodies/`, `picking/`, `camera/`.

## Deferred

- **Keyboard on labels.** The labels are not focusable. The panel's navigation has full keyboard access, and the scene has `]` / `[` + `Enter` (decision 64/65). Making 40 labels tab stops would bury the panel. A roving "label list" could come with the Phase 5 polish.
- **Pointer over a label.** A label takes the pointer, so a drag or wheel that starts on it neither orbits nor zooms. Labels are small, and a click on one works. If it bothers Cosmin, forward wheel and drag to the canvas, or make only the title clickable.
- **De-clutter hysteresis.** Two labels of equal priority that hover at the edge of overlapping can swap as the bodies move (the nearer one wins). I did not see it as flicker in the headless runs. If it shows, prefer the label that was shown last.
- **Project tasks on a planet** have no label of their own. The planet's label carries the project's state, and that state already includes "blocked on you" from any of its tasks (P2-15). Satellites (Phase 4) will show the Stewards.
- **The beacon (§4.1)** in the scene, as opposed to on the label, is Phase 4, with the satellites.
- The asteroids' invisible pick spheres are still unused (P3-05 notes).

## Tests (Vitest, jsdom, no WebGL)

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
6. Click a label: the same as clicking the body. Drag or scroll starting on a label does not move the camera (deferred).
7. At the overview many labels are hidden by de-clutter. Is the order (selected > blocked > in progress > the rest) right, and is showing about 7 of 41 at the overview acceptable?
8. Decide decision 66's text and whether moved asteroids should keep their marker label.
