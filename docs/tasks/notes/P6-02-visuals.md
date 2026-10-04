# P6-02 — High-detail visuals

Branch `p6-02-visuals` (from `p6-wave2-visuals-cutaway-hq`, with P6-03 and P6-05 merged in). Code in `apps/web/src/scene/detail/visuals/` plus the per-kind components of `detail/DetailScene.tsx`. The technical summary is in `TECHNOLOGY.md` §2.1 ("High-detail visuals").

## What was built

- **Each body looks like itself, in every view.** The surface looks (`bodies/appearance.ts`) now carry `features` (`bodies/features.ts`; moved from `visuals/` in the review fixes so the system layer does not import the detail layer, like `rings.ts` and `paint-jobs.ts`), painted by the one procedural painter on top of the body's style at every texture size. The system view gets them too, and the detail map only adds resolution and relief, so nothing pops in when it arrives.
  - Jupiter: bolder bands, the Great Red Spot at 22° S with the bands swirled round it, and a small white oval.
  - Saturn: pale, broad, low-contrast bands.
  - Uranus: cyan, barely banded. Neptune: blue with stronger bands and the Great Dark Spot.
  - Mars: ochre, darker maria, light craters, polar caps (already there).
  - Venus: the thick cloud deck with chevron (V-shaped) streaks.
  - Mercury and the Moon: cratered grey (the Moon also has its maria).
  - Moons: craters for most; maria for Ganymede, Iapetus (its dark hemisphere), Io (volcanic patches) and Triton; lineae (cracks) for Europa, Enceladus, Miranda and Triton.
- **Rings from a measured profile** (`bodies/rings.ts`, `RingLook.bands`). Saturn has its faint C ring, bright B ring, the nearly empty Cassini division, the A ring and the Encke gap. Uranus has its nine narrow dark ringlets out to the bright ε ring. The same profile paints the system's 256-texel strip and the detail view's 2048 / 1024 / 512 one (`Rings` got a `textureWidth` prop), with more segments in the detail view.
- **Detail level for the shown body** (`visuals/budget.ts`, `visuals/detail-textures.ts`):
  - A colour map beyond the LOD table: 4096 for a planet and 2048 for a moon on high, 2048 / 1024 on balanced, 1024 / 512 on mobile.
  - A tangent-space **normal map** derived in the worker from the same unquantised relief (`paintSurfaceLayers(…, heights)`), on high and balanced. Earth's relief is flat at sea, so its normals tilt on land only; it is box-blurred first, because the land mask's coastline steps were embossed otherwise.
  - Earth's roughness map: glossy oceans, matte land, the ice in between.
  - Giants and Venus get no normal map (no relief).
  - The moons orbiting a planet keep their nearest LOD level. Saturn's six moons at 2048 with normals would be about 250 MB.
- **Atmosphere** (`visuals/atmosphere-shader.ts` and `Atmosphere`). The detail view's only hand-written shader, one program for every body. It is an additive shell just above the surface. The glow is the view ray's path through the shell outside the body, normalised and raised to a power: a soft ring at the limb with no hard outer edge, a faint veil over the disc, and only on the day side. Colours: Earth blue, Venus yellowish, Mars thin pink, the giants faint, Titan orange (also in Saturn's view). Drawn on every tier (one draw call, no texture). It fades in with the cross-fade.
- **Clouds for Earth** (`Clouds`). A standard-material shell at 1.01 R with a procedural alpha map: domain-warped noise, with the latitude climate making the equatorial zone and the storm tracks cloudy and the subtropics clear. It turns with the surface plus a 4 % drift, and holds still under reduced motion. It is shaded by the Sun and eclipsed with the planet (the Moon's shadow darkens the clouds too), casts nothing, and fades in with the cross-fade and, because its map can arrive after the fade, also over 1.2 s from the map's arrival (`cloudFadeIn`; at once under reduced motion). The texture is 2048 / 1024 / 512 wide by tier.
- **Moons' lighting.** In a planet's view (and a moon's own view), a moon gets **planetshine**: the material's emissive is set every frame to the planet's mean colour, scaled by how much of the planet's lit side faces the moon and by the planet's apparent size, capped at 0.12. It is a faint uniform glow over the whole moon, not a light on its night side only (emissive has no direction; on the day side the Sun's light swamps it), so it shows where the moon is otherwise dark. It drops to zero in the planet's shadow. No light was added, since a new light would recompile every material in the scene.
- **Quality tiers.** Each tier has its sizes (`DETAIL_TIERS`). Mobile drops the normal maps and lowers the colour, cloud and ring sizes; the atmosphere stays. Switching tiers inside a detail view works: the old level shows until the new one is painted, and idle levels are dropped on the switch.
- **Eclipse shading kept** on the body, its clouds and its rings (the planet's shadow on the rings). Every detail material keeps P3-10's patch and shared program cache key. The atmosphere skips it.
- **Cutaway (P6-03) integration.** The detail material accepts the cutaway's clipping planes. The atmosphere shader has `clipping: true` and three's clipping chunks, and the cloud sphere is cut with the surface. Checked in the browser: Earth's wedge removes surface, clouds and glow together, with no veil over the layer faces.

## Memory

A detail texture frees its CPU copy once uploaded (`freeAfterUpload`, three's `onUpdate`), so a level costs its GPU size. The cache drops every idle entry when the canvas goes, so a texture is never uploaded twice. Idle levels are kept across exits and body switches within the tier's budget: the budget hook lives in `DetailLayer` (canvas lifetime), not in the view (review fix: it first lived in `DetailFrame`, which unmounts on every exit, so leaving Earth dropped its level and re-entering repainted it for ~8 s). The budget caps live and idle ready bytes together, so the detail cache holds at most max(budget, the live view): ≤ 128 MiB on high, about 224 MiB of textures with the near cache's 96 MiB. Measured after the fix: re-entering Earth starts no paint job and shows the 4096 level at once. Estimates include mipmaps (× 4/3), in MiB (the harness's cache numbers):

| Tier | Earth view (surface + clouds) | Rocky planet (Mars, Mercury) | Giant | Moon on its own | Idle budget |
|---|---|---|---|---|---|
| high | 106.7 + 5.3 | 85.3 | 42.7 | 21.3 (with normals) | 128 |
| balanced | 26.7 + 1.3 | 21.3 | 10.7 | 5.3 | 32 |
| mobile | 2.7 + 0.3 | 2.7 | 2.7 | 0.7 | 8 |

The painter runs small jobs first (`paintPriority`: near levels and clouds before detail levels, first come first served within a priority, a running job never preempted), so the clouds and an orbiting moon's near maps do not wait behind a 4096 level. Worker paint times (dev build, M3 Pro, high): Earth 8.0 s, Mars 8.5 s, Mercury 5.2 s, Venus, Jupiter and Saturn about 4 s, Uranus and Neptune about 2.8 s, a moon at 2048 about 1.8 s. Balanced Earth (2048) takes 2.0 s, mobile Earth (1024) 0.5 s. The nearest LOD level shows until the level arrives.

## Performance

**Setup.** A throwaway harness page, never committed and deleted afterwards. It mounted the real `SolarScene` with the seeded catalogue: 8 planets, 22 moons, no projects. It was served by Vite (dev build) on 127.0.0.1:7642. The browser was headless Chrome on CDP port 9642 with its own profile in scratch, `--use-angle=metal` (Apple M3 Pro), 1440×900 at DPR 2. Frame times are rAF deltas; draw calls are counted from `draw*` calls per frame; texture memory is the sum of uploaded texture sizes, with mipmaps.

**Each case:** fly to the body, enter explicitly, record a 1.8 s window over the flight and fade, wait for the detail level to paint, then record 2 s settled. The `onFps` callback lifts the mobile tier's 30 fps cap, as in P3-06 and P6-01, so mobile shows headroom.

| Body | high: enter fps / max ms | high: settled fps / p95 | high: draws | high: GPU textures (all) | mobile: enter fps / max ms | mobile: settled fps | mobile: draws | mobile: textures |
|---|---|---|---|---|---|---|---|---|
| Mercury | 60.0 / 17 | 60.0 / 16.7 | 25 | 210 MB | 59.4 / 33 | 60.0 | 8 | 8 MB |
| Venus | 58.9 / 50 | 60.0 / 16.7 | 34 | 178 MB | 59.4 / 33 | 60.0 | 17 | 9 MB |
| Earth | 59.4 / 33 | 60.0 / 16.8 | 30 | 272 MB | 58.3 / 50 | 60.0 | 13 | 10 MB |
| Mars | 59.4 / 33 | 60.0 / 16.7 | 26 | 244 MB | 58.9 / 50 | 60.0 | 8 | 11 MB |
| Jupiter | 58.3 / 50 | 60.0 / 16.7 | 36 | 192 MB | 58.3 / 67 | 60.0 | 15 | 13 MB |
| Saturn | 58.9 / 50 | 60.0 / 16.8 | 37 | 176 MB | 58.3 / 67 | 60.0 | 20 | 13 MB |
| Uranus | 59.4 / 33 | 60.0 / 16.8 | 34 | 198 MB | 58.9 / 50 | 60.0 | 13 | 13 MB |
| Neptune | 58.9 / 50 | 60.0 / 16.7 | 25 | 199 MB | 58.9 / 50 | 60.0 | 9 | 12 MB |
| Moon | 60.0 / 17 | 60.0 / 16.8 | 23 | 158 MB | 60.0 / 17 | 60.0 | 7 | 8 MB |
| Titan | 60.0 / 17 | 60.0 / 16.8 | 25 | 126 MB | 60.0 / 17 | 60.0 | 15 | 8 MB |
| Europa | 60.0 / 17 | 60.0 / 16.8 | 23 | 120 MB | 60.0 / 17 | 60.0 | 11 | 9 MB |

- **High "GPU textures (all)"** is everything uploaded in the context at that moment: the system's far maps, the near cache (up to 96 MB idle, P3-06), the idle detail levels within 128 MB, and the view's own level. Earth's own view is 112 MiB of it.
- **Earth tier switch inside the view** (high → mobile → high): 60 fps throughout. Mobile holds 7.6 MB of textures with 12 draw calls; back on high, the 4096 level is repainted and shown again (a tier change drops idle levels on purpose).
- **Cutaway on Earth:** one 250 ms frame when the wedge opens (every cut material recompiles with clipping planes; P6-03's, unchanged by this task), then 60 fps.
- **The enter hitch** (33–67 ms, one frame) is the new programs compiling: the normal-mapped material, the atmosphere, the clouds. It was 33–100 ms in P6-01 for the backdrop.

**Acceptance:** every planet is recognisably itself at detail scale at 60 fps on the Mac. The table above covers the measurement; the screenshot checks are below.

## Screenshots (described; not committed)

- **Earth, high:** real coastlines with green and desert biomes, drifting white cloud systems (denser in the storm tracks), a blue glow at the limb, and the Moon's eclipse shadow falling on both the ocean and the clouds. The first attempt embossed the coastlines' mask steps; the relief is now blurred before the normals.
- **Earth with the cutaway open:** the wedge removes surface, clouds and atmosphere together; the layer faces are clean.
- **Jupiter:** bold cream, tan and rust bands with turbulent edges and the white oval. The Great Red Spot was on the far side in that frame; the test checks its pixels.
- **Saturn:** pale bands, the C ring faint, the B ring bright, the Cassini division and the Encke gap sharp, Titan orange beside it.
- **Mars:** ochre with dark maria and crisp relief-lit craters, and a thin pink limb.
- **Mercury:** heavily cratered grey. Rims are lit on the Sun side and floors shadowed; the terminator is sharp.
- **The Moon:** grey with maria and craters.
- **Venus:** seen from the night side, a glowing yellow crescent of atmosphere.
- **Neptune:** deep blue with soft bands and a faint limb glow.
- **Fixed during the check:** Venus showed teal blotches. Brightening features pushed colour channels past 255, and the `Uint8Array` wrapped them instead of clamping. Feature colours are now clamped, and a test covers it.

## SPEC text (recorded as decision 87)

> **Detail-view visuals** (2026-10-04, P6-02; §4.1, decisions 51, 84): in its detail view a planet or moon looks like the real one — Earth with its coastlines, drifting clouds and blue atmosphere, Jupiter's bands and Great Red Spot, Saturn's pale bands and its rings with the Cassini division, Mars's ochre with dark plains and polar caps, Venus's yellow cloud deck, Mercury and the Moon cratered grey, Uranus and Neptune cyan and blue — with relief that catches the sunlight. The sharper surface arrives a few seconds after entering (the body is shown as in the system view meanwhile). The same features, at lower resolution, are visible in the system view. The quality setting decides the detail: "mobile" draws smaller surfaces without relief and coarser clouds but keeps the atmosphere glow. With reduced motion the clouds stand still.

## Tests (Vitest, no WebGL)

`visuals/visuals.test.ts` (23 tests):
- The look tables cover every catalogue planet and moon (parsed from migration 0005). Every body except Earth (land mask) and Titan (haze) has features, and each planet has its signature features.
- The Great Red Spot is painted red at 64 and 256 texels. The storm swirl stays within its reach. Crater sizes follow the texture width. Brightened colours never wrap past 255.
- Detail budget per tier:
  - high gives Earth 4096 with normal and roughness maps, Mars normals, giants colour only;
  - every tier gives every body more than its nearest level, and mobile has no normals;
  - the largest view (Earth with its clouds) fits each tier's budget, with the byte formula checked;
  - mobile clouds and rings are coarser, and the rings never go below the system's 256;
  - there is no detail level without a worker;
  - cache keys differ by content (mask version, features), size and maps.
- Paint jobs:
  - flat relief gives flat normals and a slope tilts them;
  - the blur keeps a flat field flat;
  - Earth gets normals and roughness, a giant gets neither, and the detail colour equals the surface painter's;
  - clouds are deterministic, within the coverage, and follow the climate.
- Rings: the Cassini division and Encke gap are near empty, the B ring is full, Uranus's ε is present, and the structure is the same at 256 and 2048 texels.
- Atmosphere: per-planet colours (Earth blue, Venus yellowish, Mars pinkish), the giants fainter than Earth, Earth's clouds inside its glow, and the glow profile (bright just past the limb, faint over the disc, nothing at the shell's edge).
- Reduced motion: the clouds hold still; otherwise they drift slightly faster than the surface.
- Planetshine: strongest between the planet and the Sun, zero in its shadow, capped.
- (Review fixes) The clouds' fade-in from their map's arrival, eased, instant under reduced motion.

`visuals/detail-textures.test.tsx` (7 tests, jsdom):
- `freeAfterUpload` drops the pixels.
- `DetailMaps` disposes all its maps.
- `useCachedPaint` shows the old entry until the new one is ready, releases on change and unmount, and disposes over budget.
- `useDetailTextureBudget` drops idle levels on a tier change; (review fix) leaving and re-entering a view keeps the idle level (no repaint), and unmounting the layer drops it.
- `useDetailMaps` paints a moon at the mobile size in the (fake) worker, then caches and disposes it; without a worker it asks for nothing.
- `useCloudMaps` paints at the mobile size.

Existing suites adjusted:
- `bodies/earth-mask.test.ts`: the P3-09 golden hashes now check each body's **style** painted without its features. Unchanged: features are painted on top.
- `bodies/near-maps.test.tsx`: `PaintJob` is a union now.
- (Review fix) `bodies/lod.test.tsx`: near and cloud jobs run before queued detail levels, the running one is not preempted.

Gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`, all green. Web: 108 files, 1427 tests; server 976 (+1 skipped); protocol 70. three.js is still absent from the panel's first chunk (`index-*.js`: no `WebGLRenderer`, `Matrix4`).

## Shared files touched (outside `visuals/` and the per-kind components)

- `bodies/appearance.ts`: `features` per body, `RingLook.bands`.
- `bodies/surface.ts`: features hook, `heights` output, `hash3` exported, ring profile delegation.
- `bodies/textures.ts`: features in `surfaceKey`, `useRingTexture(rings, width)`.
- `bodies/Bodies.tsx`: `Rings` `textureWidth`, `BUMP_SCALE` exported.
- `bodies/painter.ts`, `paint-worker.ts`, `paint-worker-fake.ts`: jobs go through `runPaintJob`; (review fix) `paintPriority` orders the pending jobs.
- (Review fix) `bodies/features.ts`, `bodies/rings.ts`, `bodies/paint-jobs.ts` (moved from `visuals/`; `CloudLook` now declared in `paint-jobs.ts` and re-exported by `looks.ts`).
- `detail/DetailScene.tsx`: the per-kind components.
- `detail/DetailLayer.tsx`: `useDetailTextureBudget` (review fix; first in `DetailFrame`).
- `parts.ts` and `SPEC.md` are untouched.

## Deferred

- **Earth's coastlines** still show the land mask's steps at 4096. The mask pyramid (P3-09) tops out below that resolution. A higher mask level, or a signed-distance coast, would fix it.
- **Pre-compiling** the detail programs (`renderer.compileAsync`) would remove the one-frame enter hitch, and the cutaway's 250 ms hitch on opening.
- **Asteroid relief:** the task asteroid is still the system's detail-1 rock.
- **Night lights, specular sun glint on Earth's oceans** (beyond the roughness map), and Saturn's hexagon.
- **Paint time:** 8 s for Earth and Mars at 4096 is long. Painting in two workers, or reusing the near level's noise, could halve it.
- **Production-build numbers.** This check ran a dev build; P6-01's ran a production build. GPU-bound frame times should not differ.

## What Cosmin should try

1. Enter Earth's detail view, wait a few seconds for the sharp surface, and watch the clouds drift. Toggle "Cutaway": clouds and glow are cut with the surface.
2. Saturn: look at the rings' gaps. Jupiter: wait for the Great Red Spot to turn into view.
3. Mercury or the Moon at a low Sun angle: the craters' relief.
4. Switch the quality tier to "mobile" while in a detail view, then back to "high".
