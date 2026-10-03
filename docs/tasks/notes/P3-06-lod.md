# P3-06 — LOD and quality setting

Branch `p3-06-lod`, from `p3-wave3-picking-lod`, with P3-05 merged back in. Every planet and moon now has levels of detail, and the quality tier controls everything that costs frames or memory, from one table. Tier switches apply at runtime and leak nothing.

## What was built

| File | What |
|---|---|
| `scene/quality.ts` | The tier table gains `shadowMapSize`, `lod` (levels and hysteresis), `textureBudgetMB`, `ringSegments`, `orbitSegments` and `maxFps`. The doc comment gives the sizing rule behind the numbers. The file is still three-free, so it stays safe in the panel's first chunk. |
| `scene/bodies/lod.ts` | `selectLodLevel(distance, levels, current, hysteresis)` is pure. `distanceInRadii` measures the camera's distance to the body's world position, divided by the body's radius. `useLodLevel(anchorRef, radius, lod)` re-evaluates the level every rendered frame and re-renders the body only when the level changes. A tier change starts again from the farthest level. |
| `scene/bodies/surface.ts` | `paintSurfaceLayers(look, w, h, withDetail)` paints the colour map and, for rocky and Earth-like surfaces (`hasRelief`), an RG detail map in the same pass from the same noise. The detail map holds height in R (bump) and roughness in G: Earth's oceans are glossy at 0.4, everything else matte at 0.95, and the polar ice is in between. Maps wider than 256 texels get up to 2 extra faint octaves (`extraOctaves`). `paintSurface` is unchanged: same pixels at 256 texels. `PLANET_TEXTURE` and `MOON_TEXTURE` are gone; their sizes are now in the tier table. |
| `scene/bodies/painter.ts`, `paint-worker.ts` | `paintAsync(request, signal)` paints in a module Web Worker (Vite emits `paint-worker-*.js`, 2.5 kB). Jobs run one at a time from a client-side queue, so an aborted job that has not started yet is dropped; aborting the running job terminates the worker, and the next job gets a fresh one (a stale 2048 paint never blocks the queue). The worker is a singleton for the page's lifetime. Without workers (jsdom, or a worker that fails to load) the job runs on the main thread after a macrotask, and `paintsOffMainThread()` turns false: the bodies then ask for lighter maps (see `textures.ts`). A worker that fails fails its jobs, and the bodies ask again. |
| `scene/bodies/texture-cache.ts` | `TextureCache<T extends Disposable>`, three-free:<br>• entries are reference-counted and keyed by content;<br>• a pending entry nobody wants any more is aborted;<br>• an entry nobody uses goes idle and is evicted least recently used first beyond the byte budget;<br>• `dropIdle()` disposes every idle entry;<br>• a load that finishes after its entry was abandoned disposes what it made. |
| `scene/bodies/textures.ts` | `nearTextures`: one shared cache of `SurfaceMaps` (colour + optional detail `DataTexture`).<br>• Keys come from `surfaceMapsKey(look, width, detail)`; byte estimates from `surfaceMapsBytes` (CPU copy + GPU copy with mipmaps).<br>• `useBodyMaps(look, kind, lod, level)` returns the far map, painted at once and owned by the body, until the level's own maps are ready, then those. On a level change it keeps showing the previous level's maps (and holds their cache reference) until the new ones resolve, then releases them, so flying into Jupiter goes 1024 → 2048, never 1024 → 256 → 2048.<br>• `nearMapsSpec`: without a paint worker, near levels are capped at the middle level's size (high: 1024 planet / 512 moon) and paint no detail map, so the main thread never paints 2048 + detail (about 1.5 s).<br>• `useNearTextureBudget(budgetMB, tier)` sets the budget and drops idle maps on a tier change or unmount, in a microtask after the bodies' own releases.<br>• `useSphereGeometries(lod)` builds one unit sphere per level and kind, shared by all bodies and disposed on a tier change. |
| `scene/bodies/Bodies.tsx` | `Bodies` takes `quality`. A planet or moon mesh uses the shared sphere for its level, scaled by its radius, and a `SurfaceMaterial`. That material is keyed on whether a detail map is present (adding a bump map needs a new shader), and its detail map serves as both `bumpMap` and `roughnessMap`. Orbit lines and rings take their segment counts from the tier. |
| `scene/motion.ts` | `motionSeconds()`: the orbits' and spins' own clock (wall time since first use). R3F's `clock.elapsedTime` restarts at 0 on every frame-loop change (a tier switch to or from the capped mobile loop, the fps meter), which made every planet jump back to its starting angle. |
| `scene/frame-cap.tsx` | `cappedFrameloop` and `FrameCap`. While motion runs, a capped tier switches the loop to `never`, and `FrameCap` calls `advance()` at most `maxFps` times a second (`frameDue`, with 4 ms of slack for timer jitter). Under `never`, R3F ignores `invalidate()`, so the camera following a body is capped too. The fps meter (`?show_fps=true`) lifts the cap so it measures the headroom. |

### The tier table

Distances are in body radii. Each level holds while the camera is closer than its `within` value; the levels below are listed near → far.

| | high | balanced | mobile |
|---|---|---|---|
| DPR cap / MSAA / bloom | 2 / yes / 1.4 | 1.5 / yes / 1.0 | 1 / no / no composer |
| Shadows, map size | on, 1024 | off (512) | off (256) |
| Stars, belt rocks | 9000, 6000 | 5000, 3500 | 2000, 1200 |
| LOD near | < 16: planet 128×96, moon 64×48; maps 2048 / 1024 + detail | < 12: 96×64, 48×32; 1024 / 512 + detail | < 12: 48×32, 24×16; 512 / 256, no detail |
| LOD mid | < 32: 64×48, 32×24; 1024 / 512 | < 24: 48×32, 24×16; 512 / 256 | — |
| LOD far | 48×32, 24×16; 256 / 128 (the P3-02 baseline) | 32×24, 16×12; 256 / 128 | 24×16, 12×8; 256 / 128 |
| Hysteresis | 15 % | 15 % | 15 % |
| Near-texture budget | 96 MB | 32 MB | 8 MB |
| Ring / orbit segments | 128 / 192, 96 | 96 / 128, 64 | 64 / 96, 48 |
| Frame cap while moving | — | — | 30 fps |

**Sizing rule.** A sphere at distance *d* (in body radii) spans about H·dpr / (0.414·d) device pixels, and about half the texture faces the camera, so a level's texture width should be at least twice that span at the level's far boundary.

**Framing constraint.** The camera frames a body at about 8.5 of its anchor radii (P3-04), so every tier's near boundary × 0.85 must be above 8.5. The first measurement run caught mobile's original boundary of 10 sitting exactly on 8.5: the near level was never entered.

**Exceptions.**
- Ringed planets are framed on their outer radius, about 19 sphere radii away, so they show the mid level (1024 on high).
- On a portrait phone the narrower field of view is horizontal, so framed bodies sit at about 17.7 radii and stay on the far 256 map. That map is sharp enough there: about 120 px across.

## Proposed SPEC / TECHNOLOGY text (recorded: SPEC decision 65, a §8 question on a per-device tier, TECHNOLOGY §2.1)

No SPEC change. Product question for §8 (Cosmin): the tier is one server-wide setting (decision 51), so choosing `mobile` for the phone also downgrades the Mac (after a reload). Should the tier be per-device (stored in the browser, with the server value as the default)? Until that is decided, the conservative behaviour stays as it is.

TECHNOLOGY §2.1, replacing the "Level of detail (LOD) is mandatory" bullet's second half and extending the Quality tiers bullet:

> - **LOD** (P3-06, `scene/bodies/lod.ts`, `textures.ts`, `painter.ts`):
>   - Each planet and moon picks a level from the tier's `lod` table by the camera's distance in body radii (so it works in both scales), with 15 % hysteresis.
>   - A level swaps only the mesh's geometry (unit spheres per level, shared by all bodies, scaled by the mesh) and its material's maps. The anchor group is never replaced and its binding does not depend on the level.
>   - The far map (256/128) is painted at once per body. Nearer maps are painted lazily in a Web Worker, one job at a time, and dropped if no longer wanted. Rocky and Earth-like surfaces also get an RG detail map from the same noise, used as `bumpMap` (R) and `roughnessMap` (G: glossy oceans).
>   - Near maps live in a reference-counted cache keyed by content and size, kept idle within the tier's budget (96/32/8 MB, least recently used out) and dropped on a tier change. Not three's `LOD` / drei `<Detailed>`: those swap child objects, while a level here also means a lazily painted texture, and the anchor must stay put.
> - **Quality tiers** add: `shadowMapSize` 1024/512/256 (the light is keyed on it: three never resizes a cube shadow map); LOD levels high 3 (2048 + detail near 16 radii, 1024 to 32), balanced 3 (1024 + detail near 12, 512 to 24), mobile 2 (512 near 12); ring segments 128/96/64; orbit segments 192·96 / 128·64 / 96·48; `maxFps` 30 on mobile while motion runs: the loop switches to `never` and a rAF loop calls `advance()`, so even a camera follow is capped; the fps meter lifts the cap.

## Shared files touched

- `apps/web/src/scene/SolarScene.tsx` (outside the composer):
  - the `frame-cap` import and the `cappedFrameloop(...)` call that feeds `frameloop`;
  - `<FrameCap>` when capped;
  - the point light: `key={quality.shadowMapSize}` and `shadow-mapSize` from the tier (`SHADOW_MAP_SIZE` removed, doc comment updated);
  - `<Bodies quality={quality} />`.

  The merge with P3-05 conflicted only on the imports and the top of the component; both sides were kept.
- Everything else is in files I own: `scene/quality.ts`, `scene/bodies/*`, the new `scene/frame-cap.tsx`. The belt needed no change: its counts per tier were already in the table, and it is still one draw call.
- No composer change and no new composer flag.

## Tests

`apps/web/src/scene/bodies/lod.test.tsx`, 29 tests, jsdom, no WebGL:
- **Tier table:**
  - completeness and level ordering;
  - hysteresis bands that do not overlap;
  - monotonicity (mobile ≤ balanced ≤ high on every scalar, and on segments, texture and detail at 16 sample distances);
  - the mobile phone profile;
  - a framed body reaches the near level on every tier;
  - the system view is far-level;
  - the budget fits one near map.
- **`selectLodLevel`:** bands, hysteresis both ways, no flicker around a boundary, multi-level jumps, clamping after a table change, and distance in radii from the world position.
- **Detail painting:** same colours as `paintSurface`, a detail map only where there is relief, deterministic, Earth's glossy oceans, extra octaves.
- **Asynchronous painting** (main-thread fallback): same pixels, and a queued job is dropped on abort.
- **`TextureCache`:**
  - key uniqueness and byte estimates;
  - sharing, idle and reuse, then `dropIdle`;
  - least-recently-used eviction that never touches an entry in use;
  - aborting a pending load, and disposing a late result;
  - forgetting a failed load.
- **`useBodyMaps`:** the far map first, the 2048 + detail maps once painted; a tier switch keeps a same-size far map, releases the near maps and disposes them on `dropIdle`; a far-size change disposes the old map; unmount disposes too. Shared spheres are all disposed.
- **Anchors:** a probe mirroring `Planet` goes through LOD and tier changes (high → mobile → balanced). The anchor stays the same object, with the same radius and the same children, and there are no registry changes.
- **Frame cap:** 30 of 60 jittered ticks; applies only to `always`, never with the meter.

Gates from the repo root:
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: green.
- `pnpm test`: web 401/401 (44 files), protocol 67/67. The server's `waykeeper.test.ts` "conflict with the project's own merged work" failed once in the full run and passes alone (9/9): a timing flake unrelated to this task.
- The panel's first chunk has no `WebGLRenderer` or `DataTexture`.

## Measured numbers

Method: a throwaway page (not committed, deleted) seeded the store with the catalogue (Sun, 8 planets, 22 moons, no task asteroids) and mounted `SolarScene`. Headless Chrome 154 was driven over CDP, with the camera flown through `useCameraStore.flyTo`. Over 2–3 s windows, per frame: `gl.info.render.calls` and `triangles` (with `autoReset` off, so these include composer passes and the shadow cube faces). `gl.info.memory` gives the geometry and texture counts. "Body maps MB" is the bound map / bump / roughness textures in the scene × 4/3 for mipmaps. Shadow, composer and star textures are not included. "Cache" is the near-texture cache (entries / idle / MB).

**GPU** (ANGLE Metal, Apple M3 Pro), 1440×900 at DPR 2, before the P3-05 merge:

| tier | view | fps | calls | triangles | geometries | textures | body maps MB | cache |
|---|---|---|---|---|---|---|---|---|
| high | system | 60 | 100 | 196,869 | 38 | 51 | 2.3 | 0/0/0 |
| high | Jupiter | 59.7 | 54 | 202,545 | 40 | 52 | 12.8 | 2/1/23.3 |
| high | Saturn | 59.6 | 55 | 169,852 | 40 | 54 | 9.8 | 5/2/37.3 |
| high | Earth | 60 | 53 | 210,225 | 40 | 57 | 23.1 | 6/3/65.3 |
| high | back to system | 57.9 | 99 | 193,505 | 40 | 58 | 2.3 | 7/7/70.0 |
| balanced | system | 60 | 84 | 94,273 | 38 | 50 | 2.3 | 0/0/0 |
| balanced | Jupiter | 60 | 39 | 86,049 | 40 | 52 | 4.8 | 2/1/5.8 |
| balanced | Saturn | 60 | 40 | 75,841 | 40 | 53 | 2.8 | 4/3/8.2 |
| balanced | Earth | 59.9 | 38 | 85,345 | 40 | 56 | 6.6 | 6/4/16.3 |
| mobile (capped) | system / Jupiter / Earth | 30 | 68 / 22 / 22 | 37,938 / 28,872 / 28,538 | 38–39 | 34–36 | 2.3–2.8 | ≤ 2/1/2.3 |
| mobile (meter on, uncapped) | system / Jupiter / Earth | 60 | 68 / 22 / 22 | same | | | | |

**After merging P3-05** (same setup):

| tier | view | fps | calls | triangles |
|---|---|---|---|---|
| high | system | 56.6 | 168 | 360,726 |
| high | Jupiter | 55.3 | 79 | 355,266 |
| high | Earth | 56 | 75 | 364,162 |
| mobile | system / Jupiter / Earth | 30 | 69 / 23 / 23 | 38,130 / 29,064 / 28,730 |

The increase on high comes from P3-05's outline, with the default Harmonizer selection outlining Earth; see below. Fixed in `p3-wave3-fixes`: the default selection is no longer outlined (104.6 calls per frame at high's system view, 175 with a body outlined; P3-05 notes).

**SwiftShader** (software GL, a lower bound):

| setup | tier | view | fps | calls | triangles |
|---|---|---|---|---|---|
| phone-sized: 390×844, DPR 3 → capped to 1 | mobile, capped | every view | 30 | — | — |
| phone-sized | mobile, uncapped | system | 60 | 68 | 37,938 |
| phone-sized | mobile, uncapped | Jupiter | 60 | 21 | 2,616 |
| phone-sized | mobile, uncapped | Earth | 60 | 13 | 24,890 |
| phone-sized | balanced, uncapped | system | 9.3 | — | — |
| phone-sized | balanced, uncapped | Jupiter | 14.8 | — | — |
| phone-sized | balanced, uncapped | Earth | 11.4 | — | — |
| desktop: 1440×900, DPR 2 | high | system | 1.7 | — | — |
| desktop | high | other views | 2–5 | — | — |

**Runtime tier switching** (GPU): start at high near Earth, then three cycles of high → balanced → mobile → high, with the cache emptying on each switch. After each switch:

| tier | geometries | GPU textures |
|---|---|---|
| high | 38 | 51 |
| balanced | 38 | 50 |
| mobile (new context) | 38 | 34 |

JS heap: 78–105 MB with no upward trend.

**Painting cost** (V8, main thread; this is what the worker absorbs). For `paintSurface`, the Mars, Earth, Jupiter and Io looks:

| width | time |
|---|---|
| 256 | 21–35 ms |
| 512 | 71–118 ms |
| 1024 | 287–467 ms |
| 2048 | 1.1–1.9 s |

A focused planet's 2048 map therefore arrives about 1–2 s after the flight on high. The mid map (1024) is usually ready by then because it is entered earlier in the flight.

## Deferred

- **Prefetching on `flyTo`:** paint the target's near maps when the flight starts, not when the camera arrives.
- **Normal maps** (instead of bump) and **specular on the ice giants.** Bump plus roughness from the same noise covers the "normal/specular when zoomed" wording cheaply.
- **Freeing the `DataTexture`'s CPU copy after upload.** This would halve near-texture memory, but a re-upload, for example in a new context, would then need a repaint.
- **Task asteroid LOD** (detail 0 vs 1) and **belt rock detail per tier.** The belt is still one draw call; only the counts are per tier.
- **Hiding moon orbit lines at system scale.**

## For P3-05 / the coordinator

- **Body meshes change under the anchor.** A body's mesh may change its `geometry` (shared unit spheres, scaled by `mesh.scale = radius`) and its material object (keyed `plain` / `detail`) when the level changes. The anchor group, its `userData` and the mesh object itself stay the same. The Outline's per-frame re-collection from the anchor subtree handles this. All my glows are unchanged: Saturn's and Uranus's rings are normal-blended meshes inside the planet's tilt group, so they are outlined with the planet as before.
- **Outline cost.** With the merged Outline, high at the system view went from 100 to 168 draw calls and from 197k to 360k triangles, and from 60 to about 56 fps headless, with the default selection. That selection is the Harmonizer, whose body (Earth) was outlined: `OutlineEffect` skips its depth/mask passes only when its selection is empty. Fixed in `p3-wave3-fixes`: the Harmonizer's Earth gets the ring, not the outline.
- **No composer flag added.** The mobile tier still has `bloom: null`, so there is no composer, and P3-05's blue ring stands in for the outline.
- **Mobile now runs with `frameloop: 'never'` while motion runs.** `invalidate()` is ignored there, but the 30 fps `advance()` loop draws hover and selection changes within 33 ms. Under reduced motion, or with the fps meter on, the loop is unchanged (`demand` / `always`).

## What Cosmin should check

1. **The Mac at "high" with `?show_fps=true`.** 60 fps at the system view and near Jupiter? The P3-05 outline costs about 4 fps headless; see above.
2. **Zoom right into Earth and Mars on high.** After about 1–2 s the surface sharpens (2048 map) and gains relief. Earth's oceans should show a sun glint, and the polar caps' stepped edge from P3-02 should be gone. Fly away and back: the map should not take another 1–2 s (it is cached).
3. **Switch tiers on the settings page while looking at Jupiter.** There should be no reload and nothing left blank. Mobile recreates the context (antialias), so the camera returns to the system view.
4. **The phone** (Safari over the LAN, tier "mobile"):
   - With `?show_fps=true` the meter shows the uncapped rate: it should be ≥ 30 at the system view and focused on a planet.
   - Without the meter the scene runs at 30 fps while the planets move. Check that motion and camera follow still look smooth enough at 30. If not, set `maxFps: null` for mobile in `quality.ts`.
   - In portrait, focused planets stay on the 256 map (they are about 120 px across). Say if they look soft.
5. **The phone's battery and heat** over a few minutes with the scene open, capped versus uncapped (`?show_fps=true`).
