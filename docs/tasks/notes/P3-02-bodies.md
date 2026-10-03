# P3-02 — Planets, moons, orbits and scale

Branch `p3-02-bodies`, from `p3-wave2-bodies-belt-camera`. It has the wave-2 branch merged in twice, once with P3-04 and once with P3-03, so it was tested together with the camera and the belt.

## What was built

| File | What |
| --- | --- |
| `scene/scale.ts` | **Fake scale** is now a hand-tuned spacing table, `FAKE_SPACING`, given as [AU, scene] knots: Sun 0, Mercury 16, Venus 24, Earth 33, Mars 43, Jupiter 90, Saturn 125, Uranus 160, Neptune 192. Values between knots are interpolated linearly, and past Neptune the curve continues at 3 units per AU. `auToScene(au, mode)` keeps its signature, is strictly increasing in both modes, and treats a negative input as 0. **True scale** is `TRUE_UNITS_PER_AU` = 35, chosen so that Neptune plus Nereid stays inside the star shell (inner radius 1200). Sizes and moon orbits use `TRUE_UNITS_PER_KM` = 2e-5, which is `TRUE_SIZE_EXAGGERATION` ≈ ×85 against the distances. The file also has `PLANET_AU` and `KM_PER_AU`. `useSceneScale` is unchanged. |
| `scene/motion.ts` (shared) | `useReducedMotion()`: `useSyncExternalStore` on `matchMedia('(prefers-reduced-motion: reduce)')`, live, guarded, and `false` without `matchMedia`. Also `prefersReducedMotion()`, `motionEnabled()` and `sceneFrameloop({motion, fpsMeter})`. The belt's `usePrefersReducedMotion` (`belt/hooks.ts`) is now a re-export of it, as the coordinator asked. |
| `bodies/appearance.ts` | A static table keyed by name, for the 8 planets and the 22 seeded moons. Each entry has a surface style (`rocky`, `gas`, `ice`, `earth` or `cloudy`), a palette, the fake radius, the real radius in km, the real axial tilt (Uranus 97.77°, Venus 177.4°, and so on), polar caps for Earth and Mars, rings for Saturn (1.24–2.27 R, bright, with a Cassini-like gap) and Uranus (1.64–2.0 R, faint and dark), the real moon distance in km, and a seed. Unknown names get `DEFAULT_LOOK` / `DEFAULT_MOON_LOOK`, a grey rock seeded by the body id. |
| `bodies/layout.ts` | The pure world → render list. `buildRenderList(bodies, mode)` takes the store's record or an array. It keeps planets sorted by `meta.orbit` then id. A planet with no usable orbit, or with an orbit that is already taken, goes to the next orbit past the last. Moons are grouped by `parentId` and ranked by orbit. Moons of a planet that isn't drawn are skipped. Stars and asteroids are ignored. Reserved bodies (Earth, Moon) are drawn like the others. Each item carries its distance, radius, outer radius (rings included), phase and period. Moon orbits in fake scale are `outer + 1.6 + r + (rank-1)·1.4`. In true scale they are the real km × K, at least 1.25 × outer. The file also has `safePhase` (static start angles stay ≥ 30° out of the cone behind the Sun as seen from the default camera), `orbitPosition`/`orbitAngle` (counter-clockwise seen from +y), `anchorSpecs`, and `circlePoints` for the orbit lines. Periods are decorative: planets 100 s × orbit^1.2 (Mercury ≈ 1.7 min, Neptune ≈ 20 min), moons 24 s × rank^1.1, spin 40 s. |
| `bodies/surface.ts` | **Procedural surfaces**, painted as plain data with no canvas and no three.js. 3D value noise and fbm are sampled on the unit sphere, so the maps wrap seamlessly and don't pinch at the poles. Gas giants get wobbled latitude bands, ice giants soft bands, Earth gets ocean and land plus caps, rocky bodies get fbm plus speckle, cloudy bodies (Venus, Titan) get soft fbm. Rings get a radial RGBA profile with ringlets and faded edges. Textures are 256×128 for planets, 128×64 for moons and 256×1 for rings. |
| `bodies/textures.ts` | Wraps the pixels in a `DataTexture` (sRGB, mipmapped, anisotropy 4). Textures are memoised by content key, so a world update doesn't repaint them, and disposed on unmount. |
| `bodies/anchor-binding.ts` | `attachAnchor(binding, object)`: registers and returns the cleanup, and is a no-op without an object. It is the testable core of the components' `useBodyAnchor`. |
| `bodies/Bodies.tsx` | Reads `world.bodies` and the scale mode, and renders `<Planet>`/`<Moon>`. A planet is an orbit line, plus an anchor group (`userData.bodyId`, moved along its orbit), plus a tilted equatorial frame holding the spinning sphere, the rings and the moons. Moons orbit in their planet's equatorial plane, so Uranus's moons go round "vertically". Every planet and moon registers its moving group as an anchor, with `radius` = its visual radius at the current scale (Saturn's and Uranus's include the rings, for framing). The anchor re-registers when the radius changes on a scale toggle, and the id stays the same. `useOrbit` places a body at its start angle on mount, on a scale change or when motion turns off (then `invalidate()`), and every frame while motion runs. |
| `bodies/ScaleToggle.tsx` + `scale-toggle.css` | The **"True scale"** toggle: DOM over the canvas, bottom-right (the camera breadcrumb is bottom-left), `aria-pressed`, with the corner-case-25 note beside it. In the default mode it reads "Readable layout — distances and sizes not to scale". In true scale it reads "True distances — sizes and moon orbits enlarged ×85, Sun not to scale". It imports no three.js, so it sits in the panel's first chunk (about 1 kB). |
| `SolarScene.tsx` (allowed edits only) | The **Sun** registers as anchor `SUN_ANCHOR_ID` ('b-sun', kind `star`, radius `SUN_RADIUS`) with `userData.bodyId`. The **frame loop** is `sceneFrameloop({motion: !reducedMotion, fpsMeter})`: `always` while motion runs, `demand` under reduced motion with no meter. **Shadows**: `shadows={quality.shadows ? 'percentage' : false}`, and the Sun's point light has `castShadow={quality.shadows}`, a 1024 map, near = SUN_RADIUS, far 1300, bias −0.0005, normalBias 0.02. Planets and moons cast and receive; rings receive. `castShadow` follows the tier, so a high ↔ balanced switch changes the lights' state and the materials recompile. |

### Why shadows are on (high tier only)

Only `high` has `shadows: true`. The point-light shadow map is six cube-face depth passes over about 30 meshes; at the system view it shows the planets' night sides as solid. Its visible pay-off comes when zoomed in: Saturn's shadow on its rings, and moons eclipsed by their planet. Rings only receive. A transparent ring casting would throw a solid annulus, because the depth pass ignores alpha. The cost on the Mac should be checked with `?fps=1`, and P3-06/P3-08 can drop it.

## Proposed SPEC / TECHNOLOGY text

**SPEC §7, new decision (scene scale and motion):**

> **Readable layout by default, true scale on request** (P3-02, corner case 25): the solar system opens in a hand-tuned "readable layout" in which distances and sizes are not to scale, and the scene says so in a note next to a **True scale** toggle. True scale puts every planet at its real relative distance from the Sun. Planet sizes and moon orbits are enlarged by one common factor (about ×85, shown in the note) because they would otherwise be invisible, and the Sun keeps its readable size. Toggling moves and resizes bodies but never changes which body is which, so the selection and the camera's focus survive it. The choice is not remembered (each load starts readable). Planets go slowly round the Sun (one to twenty minutes per turn), moons round their planets, and planets spin. The motion is decorative, not real time. When the system asks for reduced motion everything stands still at starting positions chosen so that no planet hides behind the Sun from the default view.

**TECHNOLOGY §2.1, after the quality tiers:**

> - **Bodies and scale** (P3-02, `apps/web/src/scene/bodies/`, `scale.ts`, `motion.ts`). Planets and moons are rendered from `world.bodies` (catalogue order `meta.orbit`, moons by `parentId`), dressed by a static per-name appearance table (style, palette, real radius and tilt, rings for Saturn and Uranus). Unknown bodies get a default grey look. Surfaces are **procedural** `DataTexture`s painted at runtime from seeded 3D value noise: no image assets. Fake scale is a monotonic [AU → scene] knot table (Mercury 16 … Neptune 192, so the belt at 2.2–3.3 AU lands at ≈ 52–66, between Mars's moons and Jupiter's). True scale is 35 units/AU with sizes and moon orbits ×≈85 (2e-5 units/km), inside the 1200 star shell. Each planet and moon registers its moving group as an anchor, with its visual radius at the current scale. The frame loop is `always` while decorative motion runs, and `demand` under `prefers-reduced-motion` (one shared `useReducedMotion` in `scene/motion.ts`). On tiers with `shadows` the Sun's point light casts a PCF shadow (1024 map); bodies cast and receive, rings receive.

## Assets and licences

None. Every surface and ring texture is generated at runtime from code in this repository (`bodies/surface.ts`), and the planet colours are hand-picked palettes. No image files were added and nothing is downloaded at build time.

## Shared files touched

- `apps/web/src/scene/scale.ts`: owned by P3-02. The numbers changed (spacing table, true-scale constants). `auToScene`'s signature and monotonicity are kept, and so is `useSceneScale`.
- `apps/web/src/scene/SolarScene.tsx`: only the Sun (anchor registration and `userData`), the `frameloop` line, the `shadows` prop and the point light's shadow props, plus their doc comments.
- `apps/web/src/scene/SceneArea.tsx`: imports and renders `<ScaleToggle />` (one import, one line).
- `apps/web/src/scene/quality.ts`: the `shadows` doc comment only (it said "not wired yet"). There was a merge conflict with P3-03's `beltRocks` comment; it is resolved with both kept.
- `apps/web/src/scene/belt/hooks.ts`: its private `usePrefersReducedMotion` was replaced by a re-export of the shared `scene/motion.ts` hook, as the coordinator asked. `Belt.tsx` is untouched.
- `apps/web/src/scene/motion.ts`: new shared module, moved from `bodies/`.
- `anchors.ts`, `camera/`: not touched. The Sun uses P3-04's `SUN_ANCHOR_ID` ('b-sun').

## Deferred / for later tasks

- **Three reduced-motion readers**: the shared hook, and P3-04's non-hook `prefersReducedMotion()` in `camera/store.ts`, which is identical in behaviour. The review could make the camera import `scene/motion.ts` too.
- The scale mode isn't persisted. A per-browser preference like the scene visibility would be a one-liner if wanted.
- P3-06 LOD: sphere segments are fixed (planets 48×32, moons 24×16). The 192/96-segment orbit lines and the texture sizes are LOD candidates. Moon orbit lines could fade at system scale.
- P3-07 / SPEC §3.2: independent-project moons look like sub-project moons for now. The look table has room for a marker.
- True scale is honest about distances, so the inner planets are sub-pixel at the system view. The orbit lines show where they are, and the camera's fly-to (P3-04) reaches them (it frames radii ≥ 0.05).
- Polar caps show a slightly stepped edge at 256×128 when zoomed right in. A higher-resolution LOD texture (P3-06) fixes it.

## Tests (Vitest, jsdom; no WebGL)

- `scene/bodies/bodies-model.test.ts` (26). The seeded catalogue is **parsed from migration 0005 itself**, so the tests follow the catalogue.
  - Scale: `auToScene` strictly increasing in both modes; the knots hit exactly; the belt (2.2–3.3 AU) lies between Mars's and Jupiter's moon systems in both modes; no planet system reaches a neighbour's lane or the Sun, and all stay inside the star shell; true scale keeps real proportions; the scale store toggles.
  - Appearance: covers every seeded planet and moon; rings on exactly Saturn and Uranus; real tilts; every moon farther out than its planet's radius; surface and ring painting is deterministic, opaque and finite for every look.
  - Render list: 8 planets in orbit order with 22 moons; reserved Earth and Moon included; the record form works; Sun and asteroids ignored; unknown planets and moons get the default look and the next orbit; orphan moons are skipped; duplicate orbits don't overlap; an empty world draws nothing.
  - Motion: no static start angle behind the Sun (both modes); `safePhase`; periods slow and growing outward; the orbit direction; the orbit-line circle; reduced motion (none without `matchMedia`, a stubbed `matchMedia` → motion off and `demand`, the fps meter still `always`).
  - Anchors: 30 specs with the same ids in both modes, different radii, Saturn framed with its rings; attach, cleanup and re-register keep the id; a stale cleanup doesn't remove a newer registration; no object means no anchor; the Sun's id is the catalogue's star.
- `scene/bodies/scale-toggle.test.tsx` (2): readable by default with the "not to scale" note; the toggle switches the store and the note, and `aria-pressed` follows.
- Gates on `p3-02-bodies` (with P3-03 and P3-04 merged in): `pnpm build`, `typecheck`, `lint`, `format:check` and `test` are all green. protocol 67, server 842 (+1 skipped), web 307.

### Bundle (`pnpm --filter @galactic/web build`, with the belt and camera merged)

| Chunk | Size | gzip |
| --- | --- | --- |
| `index-*.js` (the panel's first chunk) | 479.36 kB | 140.72 kB |
| `SolarScene-*.js` (lazy) | 1,049.36 kB | 281.91 kB |
| `index-*.css` | 26.08 kB | 5.97 kB |

The first chunk has no `WebGLRenderer` or `DataTexture` (checked with grep). From P3-02 it carries only `scale.ts`, `ScaleToggle` and its CSS.

### Smoke check in a real browser (not committed)

I used a throwaway page that seeds the store with the parsed catalogue and mounts `SolarScene`, and drove it through headless Chrome over CDP (GPU, high tier):

- 31 anchors registered: Sun, 8 planets, 22 moons. No console errors.
- Motion is on by default and the planets move. With `--force-prefers-reduced-motion` the layout is static.
- True scale: real spacing, tiny planets.
- The mobile tier renders.
- With P3-03 and P3-04 merged: the belt is visible between Mars and Jupiter; `flyTo('b-saturn')` frames Saturn with its rings and follows it while it moves; flipping to true scale while focused on Jupiter reframes Jupiter.

## What Cosmin should look at

1. `pnpm dev` with the scene shown. Check that all 8 planets and the moons are identifiable: Saturn's and Uranus's rings, Uranus tipped over, Earth's blue and green with its Moon, Jupiter's four moons.
2. Click **True scale** at the bottom-right. Read the note, then use the breadcrumb or `]` to fly to Earth, then toggle back. The camera should stay on the same body.
3. `?fps=1` at **High** (shadows on): does it hold 60 fps? If not, shadows are the first thing to drop (set `shadows: false` in the tier table).
4. macOS Reduce motion: the planets stop, none sits behind the Sun, and the fps meter (if on) is the only thing keeping the loop running.
5. Taste: the procedural look (palettes, band contrast), orbit-line opacity, and whether the moon orbit lines are too busy at system scale.
