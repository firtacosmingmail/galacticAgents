# P3-03 — Asteroid belt

Branch `p3-03-belt` (from `p3-wave2-bodies-belt-camera`), 2026-10-03.

## What was built

All of it lives in `apps/web/src/scene/belt/`, apart from the generator move and one field added to the tier table (see "Shared files touched").

| File | What |
| --- | --- |
| `belt-model.ts` | Plain data with no three.js. `generateBelt(count, seed)` builds the background rocks from one mulberry32 stream, seeded with `BACKGROUND_BELT_SEED` (`BELT_SEED ^ 0xb0c45eed`, so it never replays asteroid `n`). Each rock takes an orbit from the shared `drawBeltOrbit` (2.2–3.3 AU, phase, inclination ±0.15 rad), plus a size (0.1–0.55 units, mostly small), a per-axis squash, a rotation and a grey-to-brown tint. Every rock uses 12 draws, so a lighter tier's belt is a **prefix** of a heavier one: switching tiers thins the belt without reshuffling it. `orbitPosition(orbit, mode)` puts a body at distance `auToScene(radius, mode)` from the Sun, at azimuth `phase` and elevation `inclination`. The distance from the Sun is exactly the scaled radius. `taskAsteroids(world.bodies)` lists the `asteroid` bodies that have a `host`, sorted by id. Freed asteroids and asteroids with only a "moved to" marker are left out. `asteroidOrbit(body)` reads `meta.orbit` (radius clamped into the belt). Without it, it uses `asteroidSpec(meta.number)`, and failing that a hash of the id, so a hand-made asteroid still sits in the belt at a stable place (corner case 26). Also: `pickData` / `PICK_TARGET_NAME` (the marker P3-05 raycasts for), `asteroidSquash(seed)`, and `beltSpin(delta, reducedMotion)`. |
| `belt-mesh.ts` | The three.js side, testable in jsdom. `rockGeometry(seed, detail)` is a jittered icosahedron. The geometry is not indexed, so the jitter is applied per corner and the rock stays closed. `writeBeltInstances(mesh, belt, mode)` writes the matrices and `instanceColor`, then calls `computeBoundingSphere()` / `computeBoundingBox()`. InstancedMesh computes these over all instances, so frustum culling sees the whole ring. |
| `hooks.ts` | `useBodyAnchor(bodyId, ref, radius, kind)` registers the object in `scene/anchors.ts` on mount, re-registers when the id, radius or kind changes, and unregisters on unmount. `usePrefersReducedMotion()` reads `matchMedia`, follows changes, and is safe without `window`. |
| `Belt.tsx` | One `<group name="asteroid-belt">` that holds two things. **`BackgroundRocks`** is a single `<instancedMesh name="belt-rocks">`: one geometry, one `MeshStandardMaterial` (flat-shaded, fully rough), instance colours, keyed on the count. Its matrices are written in a layout effect on `[belt, mode]`, and the effect then calls `invalidate()`. **`TaskAsteroidMesh`**, one per hosted asteroid, is an anchor `<group>` at `orbitPosition`. It contains a detail-1 rock, 1.1 units across with a seeded squash, in a lighter tan with a warm emissive at 0.3 (below the bloom threshold). It also has a cyan additive back-face halo (×1.5), an invisible pick sphere (×1.8, `material.visible = false`: raycastable, never drawn) carrying `userData = {bodyId, kind: 'asteroid', hostId}`, and a drei `<Html>` name label (11 px, `pointer-events: none`). The rock count comes from the settings' tier via `useSettingsData()`; R3F v9 bridges contexts into the Canvas. The scale mode comes from `useSceneScale`, and the bodies from `useAppStore`. |

**Motion.** The whole group spins at `BELT_ANGULAR_SPEED` = 0.004 rad/s, one turn in about 26 minutes. The spin is added in `useFrame` from the frame's delta, capped at 0.1 s per frame. Under the `demand` frame loop it only moves when something else renders. With `prefers-reduced-motion` it does not move at all. Task asteroids are inside the spinning group, so they stay in place relative to the rocks. Their anchors are the objects themselves, so the camera reads live world positions.

**Labels.** drei's `Html` appends its element to `events.connected || gl.domElement.parentNode`. The events connect after the first render, so the target changed while the root was mounting. React then warned "Attempted to synchronously unmount a root while React was already rendering", and in the smoke run one label of five stayed empty. `Belt` now passes a `portal` fixed to `gl.domElement.parentNode` from the start, which fixed both: no warnings, 5/5 labels.

## How "one draw call" is ensured

- The background belt is one `InstancedMesh`, with one non-array material, a geometry with no groups and no children. Size and squash, rotation and colour vary per instance (instance matrix plus `instanceColor`), so there are no geometry variants to split the draw.
- Unit test (`belt.test.tsx`, "instanced belt mesh"): after `writeBeltInstances`, `mesh.count` equals the rock count, the material is not an array, there are no children and no geometry groups, `instanceColor` holds every rock, and the bounding sphere is centred near the Sun, has a radius at least 0.95 × the belt's outer edge, and contains sampled rock positions.
- **Draw-call evidence (real browser).** A throwaway page, not committed, mounted `<Belt>` in an R3F canvas with the default camera `(0, 40, 140)` and drove headless Chrome (SwiftShader) over CDP. It reset `gl.info`, ran one `gl.render`, and read `info.render.calls`:

  | World | Scale | Draw calls | Triangles | Rocks | Anchors | Labels |
  | --- | --- | --- | --- | --- | --- | --- |
  | no task asteroids (one freed asteroid) | fake | **1** | 120 000 | 6000 (`high`) | 0 | 0 |
  | 5 task asteroids + 1 freed | fake | 11 = **1** belt + 5 × (rock + halo) | 124 000 | 6000 | 5 | 5 |
  | 5 task asteroids + 1 freed | true | 1 (the task asteroids were out of the frustum at that camera) | 120 000 | 6000 | 5 | 5 |

  The freed asteroid was neither drawn nor anchored. The pick targets added no draw calls. Bounding-sphere radius: 107.4 in fake scale and 219.7 in true scale. The screenshot showed the ring lit from the Sun's side, and the five task asteroids standing out with their halos and labels.

## Shared files touched

- `apps/web/src/scene/quality.ts`: additive only. Adds a `beltRocks: number` field to `SceneQuality` and to its doc comment, with values `high` 6000, `balanced` 3500 and `mobile` 1200.
- **Generator moved into the protocol package** (the task allowed it):
  - New `packages/protocol/src/belt.ts`, exported from `index.ts`. It holds `mulberry32`, `BELT_SEED`, `BELT_ORBIT` (`innerAu` 2.2, `widthAu` 1.1, `outerAu` 3.3, `maxInclination` 0.15), `BeltOrbit`, `drawBeltOrbit(rand)`, `asteroidSeed(n)`, `AsteroidSpec` and `asteroidSpec(n)`. It is pure and uses no Node APIs. `drawBeltOrbit` keeps the original float expressions (`2.2 + r × 1.1`, `(r − 0.5) × 0.3`), so the rounded values are bit-identical.
  - `apps/server/src/domain/catalogue.ts`: the local PRNG, name tables and `asteroidSpec` were removed. It now imports `asteroidSpec` from `@galactic/protocol` and re-exports `BELT_SEED`, `asteroidSpec` and `AsteroidSpec`, so no server import changed.
  - `packages/protocol/src/belt.test.ts` pins `asteroidSpec(1, 2, 7, 42, 1000)` to the values captured from the server before the move. The server's `catalogue.test.ts` (19 tests) is unchanged and passes.
- Not touched: `SolarScene.tsx`, `scale.ts`, `anchors.ts`, `bodies/`, `camera/`, the phase file, the task README, SPEC and TECHNOLOGY.

## Proposed SPEC / TECHNOLOGY text (for the coordinator to apply)

**TECHNOLOGY §2.1**, a new bullet after the quality-tier bullet:

> - **Asteroid belt** (P3-03, `apps/web/src/scene/belt/`). The asteroid generator (mulberry32, `BELT_SEED`, `BELT_ORBIT` = 2.2–3.3 AU and ±0.15 rad, `asteroidSpec(n)`) lives in `packages/protocol` (`belt.ts`). The server's catalogue names and places task asteroids with it, and the client draws the decorative belt from the same seed and ranges. The background belt is **one `InstancedMesh`**: one jittered-icosahedron geometry and one material, with per-instance scale, rotation and colour, and a bounding sphere computed over all instances. That is one draw call whatever the count. The count comes from the tier table (`beltRocks`: high 6000, balanced 3500, mobile 1200). Every rock takes a fixed number of PRNG draws, so a lighter tier draws a prefix of the same belt. An orbit is placed at `auToScene(radius)` from the Sun, at azimuth `phase` and elevation `inclination`. Only asteroids that host work get individual meshes (rock, additive halo, an invisible pick sphere carrying `userData {bodyId, kind, hostId}`, and a drei `Html` label portalled to a fixed layer), and each registers its anchor. The belt spins at 0.004 rad/s from `useFrame` delta, so it is still under the `demand` loop and off with `prefers-reduced-motion`.

And in the quality-tier bullet, add "belt rocks 6000 / 3500 / 1200" to the three tiers.

**SPEC.** No new product decision is needed; §3.1 and decision 1 already cover the behaviour. Optionally, add one line under §4.1: "Only asteroids hosting a task are drawn and labelled individually; a freed asteroid, or one whose task moved away, is just part of the belt."

## Deferred / notes for the next tasks

- **P3-05 (picking).** Raycast the meshes named `pick-target` (`PICK_TARGET_NAME`) and read `userData.bodyId` / `hostId`. The anchor group carries the same `userData`. The background rocks are not pickable and should be excluded from raycasts (they hold no data). When three-mesh-bvh arrives, the instanced belt needs no BVH.
- **P3-06 (LOD / quality).** The tier switch already changes the rock count live: a new `InstancedMesh` keyed on the count, with the same rocks as a prefix. Possible further LOD: detail 0 vs 1 for task asteroids, and hiding labels beyond a camera distance.
- **P3-07 (labels).** Labels show `Body.name` for now. Bind the task title and state there. With many task asteroids, consider capping or throttling the `Html` labels (each costs a DOM transform update per rendered frame).
- **Reduced motion.** `usePrefersReducedMotion` lives in `belt/hooks.ts`. If P3-02 or P3-04 add their own, merge them into one shared hook in the review.
- The halo is a translucent back-face sphere. If the selection outline (P3-05) looks better on asteroids, the halo could become the hover/selection state instead.
- `useFrame` spin under `demand` is intentionally static. Once P3-02 switches the loop to `always` for orbital motion, the belt turns with it.

## Tests

- `apps/web/src/scene/belt/belt.test.tsx` (16 tests, jsdom, no WebGL) covers:
  - determinism, and the prefix property between tiers;
  - the count per tier (≥ 1000, lighter on mobile);
  - band and size ranges, and placement within `auToScene(2.2..3.3)` with a bounded height, in both scale modes;
  - orbit placement;
  - world → task asteroids: only hosted ones, sorted, catalogue orbit, both scales;
  - the fallback orbit for asteroids without `meta.orbit`, and clamping;
  - the pick marker;
  - the instanced mesh (a single object/material/geometry, instance colours, bounding sphere containing the rocks);
  - rock determinism;
  - the spin (delta, reduced motion, cap);
  - the anchor hook (mount, change, unmount).
- `packages/protocol/src/belt.test.ts` (3 tests) covers the pinned pre-move `asteroidSpec` values, the seed and ranges, and PRNG determinism.
- Gates on `p3-03-belt`: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` are all green. Counts: protocol 67 (was 64), server 842 (+1 skipped, unchanged), web 235 (was 219).
- Bundle: three.js stays out of the panel's first chunk (no `WebGLRenderer` in `index-*.js`). The lazy `SolarScene` chunk is about 995 kB, about 272 kB gzip; drei `Html` is now in it.
