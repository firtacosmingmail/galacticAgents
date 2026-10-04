# P6-03 — Cutaway layers

Branch `p6-03-cutaway` (from `p6-wave2-visuals-cutaway-hq`). Code in `apps/web/src/scene/detail/cutaway/`. The technical summary is in `TECHNOLOGY.md` §2.1 ("Cutaway layers").

## What was built

- **A detail part, `'cutaway'`** (`parts.ts` `DETAIL_PARTS`: kinds rocky, giant and moon; `accepts` only bodies with layer data, `target.ts`). It is mounted with the sub-scene and does nothing visible until the switch is on.
- **The cut.** A 90° wedge is removed through both poles, around the body's spin axis (the planet's tilt is applied; a moon's frame is already its planet's equator).
  - The wedge is centred 20° off the camera's azimuth and follows the camera, so the cut always faces the user. One face is seen nearly face-on and the other at a glance, so it reads as a solid, not as a disc split in two.
  - **How the surface is cut:** two world-space clipping planes with `clipIntersection` are set on the body's own sphere materials. Only the wedge is removed. The outer surface keeps its material, maps, bump and eclipse shading, so eclipse shading on the outer surface is unaffected.
  - **The faces:** two half discs of flat-coloured (unlit) concentric bands, one per layer, built as one vertex-coloured geometry and drawn twice, turned to the planes' azimuths. That is 2 extra draw calls and no custom shader.
- **Which meshes are cut.** The part finds the body's group in the detail frame (the object whose `userData.bodyId` is the body's) and walks its subtree, skipping any subtree with another `userData.bodyId` (the moons).
  - A mesh is cut when its geometry is a `SphereGeometry`, or when it sets `userData.cutaway = true`.
  - `userData.cutaway = false` keeps a mesh whole. Rings, orbit lines and other geometry are never cut.
  - This is the contract for P6-02. An atmosphere or cloud shell built as a sphere is cut automatically if its material supports clipping. Built-in materials do. A `ShaderMaterial` needs `clipping: true` and three's clipping chunks, otherwise the planes are ignored and the translucent shell stays whole over the cut, which is harmless.
  - Materials are re-scanned every frame while the cut is open, because a body's material is replaced when its near maps arrive. Their planes are removed when the cut closes, when the view is left, or when the part unmounts.
  - The renderer's `localClippingEnabled` is turned on while the part is mounted, and restored afterwards.
- **Motion.** The wedge opens and closes over 0.6 s with smoothstep, and is instant with reduced motion.
  - It opens only once the detail cross-fade is past 0.6 (`mixGate`), so it never shows in the system view. On the way out it closes with the fade.
  - A change of the switch asks for a frame, so the on-demand loop used with reduced motion redraws.
- **Labels.** One DOM pill per layer (a colour swatch and the name) sits over the canvas in the domain labels' stacking slot, under the scene chrome. They are `CutawayLabels`, mounted in `SceneArea`.
  - The part writes their positions every frame through `label-registry.ts`, as the domain labels' projector does. Each label points at the middle of its band, 35° above the equator, on whichever cut face is drawn further right, so the text reads away from the body.
  - Labels are spread vertically so they are at least 19 px apart, and they fade with the opening.
  - The layer is `aria-hidden`. The toggle's description carries the same names for assistive technology.
- **Toggle — where it lives.** A **"Cutaway"** button follows the breadcrumb's trail in a detail view ("Solar system › Earth › Detail [Cutaway]"), in the slot where "Detail view" stood before going in (`CutawayToggle`, rendered by `CameraBreadcrumb`).
  - It appears only for a body with layer data, and nowhere else: not in the system view, not for Io or an asteroid.
  - It is a real `<button>` with `aria-pressed`, in the tab order like the crumbs (decision 81), with a `title`. Its `aria-describedby` points at a visually hidden sentence, for example: "Earth's layers, from the surface inward: crust (granite and basalt), mantle (hot silicate rock), outer core (liquid iron and nickel), inner core (solid iron and nickel)."
  - There is no dock or side-panel entry. The breadcrumb is the scene's own chrome and the place for scene-view actions.
  - There is no keyboard shortcut. Tab reaches the button, and adding a letter key would need a new entry in `SCENE_SHORTCUTS`. That is deferred.
  - **Remembered per session.** It is one switch for every body, kept in `sessionStorage` (`galactic.scene.cutaway`). Turn it on for Earth, go to Jupiter, and Jupiter opens cut too. A reload keeps it, and a new tab starts with it off.
- **Chunks.** The toggle, the labels, the layer table and the store use no three.js and are in the panel's chunk. The part (`Cutaway.tsx`) is only in the scene's chunk. After the build, `index-*.js` still has no `WebGLRenderer`, `Object3D` or `Matrix4`.

## The layer data and its sources

`layers.ts`, keyed by name and kind, so a made-up moon named "Mars" gets no cutaway.

- The `outer` value of each layer is its outer radius as a fraction of the body's mean radius. Layers are listed surface first and fall strictly, and the innermost layer reaches the centre.
- The values are approximate and rounded, and the giants' interiors are model-dependent. The picture is a schematic.
- Thin layers are drawn at least 4.5 % of the radius thick (`displayRadii`). Every rocky crust is under 2.5 %, so each one is drawn thicker than it really is. All other boundaries are drawn to scale.

| Body | Layers (outer radius / R) | Sources |
|---|---|---|
| Mercury (R 2440 km) | crust 1 · mantle 0.986 · outer core (liquid) 0.83 · inner core (solid) 0.41 | NASA Mercury fact sheet; Hauck et al. 2013, *JGR Planets* (MESSENGER: core ~2020 km); Genova et al. 2019, *GRL* (solid inner core) |
| Venus (6052 km) | crust 1 · mantle 0.995 · core 0.50 | NASA Venus fact sheet; model estimates (no seismic data), core radius ~3000 km |
| Earth (6371 km) | crust 1 · mantle 0.995 · outer core 0.546 · inner core 0.192 | PREM, Dziewonski & Anderson 1981 (CMB 3480 km, inner core 1221 km); crust ~35 km continental average |
| Moon (1737 km) | crust 1 · mantle 0.977 · partial melt 0.276 · outer core 0.19 · inner core 0.138 | Wieczorek et al. 2013, *Science* (GRAIL crust ~34–43 km); Weber et al. 2011, *Science* (Apollo seismic: 480 / 330 / 240 km) |
| Mars (3390 km) | crust 1 · mantle 0.985 · core (liquid) 0.54 | Knapmeyer-Endrun et al. 2021 and Stähler et al. 2021, *Science* (InSight: crust 24–72 km, core ~1830 km) |
| Jupiter (69 911 km) | molecular hydrogen 1 · metallic hydrogen 0.80 · core (dilute) 0.25 | NASA Jupiter overview; Wahl et al. 2017, *GRL*; Militzer et al. 2022, *PSJ* (Juno: dilute core) |
| Saturn (58 232 km) | molecular hydrogen 1 · metallic hydrogen 0.55 · core 0.22 | NASA Saturn overview; Mankovich & Fuller 2021, *Nature Astronomy* (ring seismology: diffuse core) |
| Uranus (25 362 km) | hydrogen–helium envelope 1 · ice mantle (water, ammonia, methane) 0.80 · rocky core 0.20 | NASA Uranus overview; Helled et al. 2020, *Space Sci. Rev.* |
| Neptune (24 622 km) | hydrogen–helium envelope 1 · ice mantle 0.85 · rocky core 0.25 | NASA Neptune overview; Helled et al. 2020 |

**Colours.** All are sRGB, chosen to read apart on the dark backdrop next to a white label.

- **Rocky bodies:** brown crust `#8a6a4c`, orange mantle `#c8562c`, amber outer core `#f0a43a`, pale-yellow inner core `#fff1b8`. The Moon's partial-melt layer is `#e2763a`.
- **Gas giants:** an envelope in the planet's own beige, metallic hydrogen in blue-grey `#7d8fbf`, a brown rocky core `#8a5d3e`.
- **Ice giants:** a pale-blue envelope, a deep-blue ice mantle, the same brown core.

## Proposed SPEC text

The SPEC was not edited (it is out of scope for this task). The proposed text is a new decision in §7, numbered at merge:

> | 8x | Cutaway layers | **See inside a body in its detail view** (2026-10-04, P6-03; §4.1, decisions 81, 84): in the detail view of a body whose interior is known — Mercury, Venus, Earth, Mars, the Moon, Jupiter, Saturn, Uranus, Neptune — a "Cutaway" button follows the breadcrumb ("Solar system › Earth › Detail · Cutaway"). Pressing it cuts a quarter wedge out of the body, facing the viewer, and the cut shows its layers as coloured bands, each labelled: crust, mantle and core for rocky bodies (Earth's outer and inner core, the Moon's partial-melt layer); molecular and metallic hydrogen over a core for Jupiter and Saturn; a hydrogen–helium envelope over an ice mantle and a rocky core for Uranus and Neptune. Sizes are approximate (thin crusts are drawn thicker so they can be seen). The cut opens and closes smoothly, at once with reduced motion; the outside of the body looks and is lit as before. The setting is the same for every body and is remembered until the browser tab is closed. The button is reachable with Tab and says whether it is on; a screen reader hears the layers' names. Other bodies (other moons, asteroids) have no cutaway. |

And in §4.1, after "internal layers where relevant": "(the cutaway, decision 8x)".

## Tests (Vitest, no WebGL)

**New `cutaway/cutaway.test.ts` (19 tests):**

- **Layer tables:**
  - the tables cover exactly the 9 bodies, each of the right kind;
  - every one is in the appearance table;
  - radii fractions start at 1 and fall strictly, each in (0, 1], and the bands sum to 1 (≤ 1);
  - names are unique, colours are hex and notes are filled in;
  - the expected layer names for rocky bodies, Jupiter/Saturn and Uranus/Neptune;
  - lookup by name and kind ("Mars" as a moon, "Moon" as a planet, Io, the Sun, an asteroid and `toString` all have none);
  - `displayRadii` keeps the minimum band and stays monotonic, with Earth's cores to scale;
  - the screen-reader sentence.
- **The wedge:**
  - it removes exactly the quarter about its centre, through both poles, and a closed wedge removes nothing;
  - opening and closing take `OPEN_S`, instant with reduced motion, with the easing;
  - `mixGate`;
  - face geometry: vertex count, everything inside the unit half disc, colours per band;
  - label points sit mid-band on the face;
  - the vertical spread keeps the order, the gap and stays centred.
- **The part:**
  - it is registered once, for the rocky, giant and moon kinds;
  - it mounts for Earth, Mars, Jupiter, Saturn and the Moon, but not for Phobos, a made-up planet or an asteroid;
  - it cuts at the planet's sphere radius (not the rings' framed radius) and tilt, with the Moon untilted;
  - `isCutMesh` cuts spheres and opt-ins, never rings or boxes, and respects opt-outs.

**New `cutaway/cutaway-ui.test.tsx` (5 tests, jsdom, with the real breadcrumb and scene key handler):**

- the toggle appears only in the detail view of a body with layer data: Earth, Jupiter and the Moon yes; Io, an asteroid and the system view no;
- it is a `<button>` in the tab order (no `tabindex`) that takes focus, with `aria-pressed` that follows clicks and `aria-describedby` with the layers sentence;
- Enter on the focused toggle does not reach the scene: no selection change, no detail change;
- the setting is remembered in `sessionStorage` across bodies;
- the labels layer: `aria-hidden`, one hidden label per layer only while on, registered for the part, place/hide writes, gone for a body without data.

**Changed `detail/detail-body.test.ts`:** the line that expected `partsFor(earth)` to be empty now checks an empty part list explicitly (`partsFor(earth, [])`), because Earth now has the cutaway part.

**Gates:** `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` all green.

- Web: 104 files, 1372 tests. Server: 976 tests (+1 skipped). Protocol: 70 tests.
- three.js is still absent from the panel's first chunk.

## Browser check

**Setup.** Everything was run from the worktree and stopped afterwards:

- this branch's own dev server (`GALACTIC_DEV=1 GALACTIC_HARMONIZER=fake`) on 127.0.0.1:7791, with `GALACTIC_HOME` in scratch;
- Vite on 127.0.0.1:7711;
- headless Chrome (`--use-angle=metal`) on CDP 9473, with a profile in scratch.

**What was checked:**

- **Earth, Mars, the Moon, Jupiter, Saturn, Neptune:** the cut opens facing the camera, the bands read clearly, and every label sits next to its band. The day/night shading of the outer surface stays as it was.
- **Saturn:** the rings are not cut.
- **Turning it off:** the body is whole again.
- **Reduced motion** (emulated `prefers-reduced-motion`): fully open within 120 ms.
- **Leaving the view:** no labels left and the system's bodies are whole. The system meshes are never touched.

**Change made after the first look:** the wedge was centred exactly on the camera, which made the cut look like a flat disc split down the middle. It is now turned 20° (`WEDGE_TURN`).

**Clean-up:** Cosmin's servers (5173, 4321) were not touched. Afterwards `pgrep` and `lsof` showed nothing left on 7711, 7791 or 9473.

## Shared files touched

- `apps/web/src/scene/detail/parts.ts`: one `DETAIL_PARTS` entry and its import.
- `apps/web/src/scene/camera/Breadcrumb.tsx`: `<CutawayToggle />` after the trail, plus a header comment line.
- `apps/web/src/scene/SceneArea.tsx`: `<CutawayLabels />` after `<LabelLayer />`, plus a header comment line.
- `apps/web/src/scene/detail/detail-body.test.ts`: one line, see Tests.
- `docs/TECHNOLOGY.md` §2.1: a new "Cutaway layers" bullet after "Planet detail view".

## Deferred

- **More bodies.** The Galilean moons and Titan have well-studied interiors (Io's iron core, Europa's ocean under ice, Ganymede's layered ice). Pluto is not in the catalogue. Adding a body is one table entry.
- **A keyboard shortcut** for the toggle (for example `C` in `SCENE_SHORTCUTS`), and an announcement when the cut opens. For now the pressed state and the description carry it.
- **The selection outline** (postprocessing) does not apply the clip planes. If a cut body is selected, its outline is still the whole sphere.
- **P6-02's atmosphere shader:** if it is a `ShaderMaterial`, it should opt in to clipping (`clipping: true` and the clipping chunks) so it is cut with the surface, or set `userData.cutaway = false` explicitly.
- **Lighting the cut faces.** They are unlit flat colour on purpose (readable on the night side). A soft rim or Sun-facing shade could be added later.
- **The labels' de-clutter is vertical only.** At very small view sizes, long names such as "Hydrogen–helium envelope" can run past the canvas edge.
