# P3-10 — Planet-sized shadows over Jupiter and Saturn

Branch `p3-10-shadows`, from `p3-wave6-device-fixes` (7521196). Cosmin: "There are some very big shadows going over Jupiter from time to time, big enough to cover the entire planet. I saw it on Saturn as well. If it is the shadow of a moon, it should definitely not be that big."

## Root cause

The Sun was a **point light** at the origin with a cube shadow map (`SolarScene.tsx`). A point light's shadow widens with distance: a caster of radius r at distance d_c from the Sun throws a shadow of radius r × d_r / d_c at distance d_r. The readable layout enlarges the bodies and compresses the distances (`scale.ts`, `appearance.ts`), and every planet orbits in the same plane (y = 0), so each conjunction is a central eclipse. Inner planets therefore threw shadows larger than the outer planets:

| caster → receiver | caster r / d | shadow radius at the receiver | receiver radius |
| --- | --- | --- | --- |
| Venus → Jupiter | 1.6 / 24 | 6.0 | 4.5 |
| Mercury → Jupiter | 1.0 / 16 | 5.6 | 4.5 |
| Earth → Jupiter | 1.7 / 33 | 4.6 | 4.5 |
| Mars → Jupiter | 1.2 / 43 | 2.5 | 4.5 |
| Venus → Saturn | 1.6 / 24 | 8.3 | 3.8 |
| Earth → Saturn | 1.7 / 33 | 6.4 | 3.8 |
| Jupiter → Neptune | 4.5 / 90 | 9.6 | 2.5 |

### Evidence

1. **Analytic scan.** A scratch script used the layout's own phases, periods and fake-scale distances to find every time an inner planet's point-light shadow reached an outer planet. Over 6000 s of motion clock: Jupiter 79 events, shadowed 13.3 % of the time; Saturn 87 events, 13.3 %; Uranus 12.2 %; Neptune 12.7 %. In one Saturn year (860 s) there were 49 events across the four giants. The first was Venus over Jupiter at t ≈ 50 s, so it shows within a minute of opening the scene.
2. **Reproduced in headless Chrome** (Chrome headless with ANGLE Metal, M3 Pro, 1440 × 900, the "high" tier). A throwaway harness page, never committed, mounted the real `SolarScene` with the seeded catalogue and offset `performance.now` to jump the motion clock. At t = 50.25 s, focused on Jupiter, Jupiter's whole lit disc is black. Switching off `castShadow` on Venus's mesh alone, same frame, brings Jupiter back fully lit, leaving only a moon-sized spot. The same toggle test identified the caster for Earth over Saturn (t = 146 s) and Mars over Jupiter (t = 858 s): a black disc covering about half of Jupiter.
3. **Measured over a full cycle (before).** For each of the 49 alignments in one Saturn year, the harness focused the outer planet, froze the clocks at the alignment's middle, and compared the frame with and without the inner caster's `castShadow`. The share of the target's disc darkened: Jupiter 72–83 % (all of the lit part; the rest is the night side), Saturn 72–100 %, Uranus and Neptune 100 %.

### The other hypotheses, checked

- **A big moon close to its planet:** not the cause. Inside a system, the rays from the Sun are almost parallel (a magnification of d_r / d_c ≈ 90 / 83.5 ≈ 1.08 for Io on Jupiter). A moon's shadow is the moon's own drawn size, about 10 % of Jupiter's radius. Near the terminator it is stretched along the light direction, which is correct projection.
- **Shadow-camera near/far, acne, bias, wrong casters:** not the cause. Only planets and the 7 large moons had `castShadow` (listed from the live scene). The Sun mesh, glow, rings, belt and LOD meshes did not. The near plane (6) and far plane (1300) bracketed everything, and no acne was visible.

## The fix: eclipse shading per planet system (no shadow map)

The shadow map is gone. Each planet, moon and ring system computes its own eclipses in its fragment shader. It traces the ray from the fragment to the Sun against the spheres of **its own planet system's casters**: the planet and its moons of real radius ≥ 1000 km (`castsShadow`, unchanged), at most 6, largest first. Casters from other systems are never in a receiver's list, so a planet can never eclipse another. The receiver itself is excluded, which avoids self-shadowing from tessellation.

- `apps/web/src/scene/bodies/eclipse.ts`: plain data and maths, no three.
  - `eclipseCasters(planet)` and `eclipseReceivers(planet)` are the casting rules.
  - `eclipseLight(p, casters, sunRadius)` is the TypeScript mirror of the shader.
  - It also holds the GLSL chunks and `patchEclipseShader`, which throws if three renames an anchor chunk.
  - The soft edge is `t × R_sun / d_sun`, capped at a quarter of the caster's radius, so a moon's shadow is a spot with a dark core.
  - Only the Sun's direct light is scaled (`reflectedLight.directDiffuse/Specular` after `lights_fragment_end`). Ambient light and the rings' faint emissive are left alone, as the shadow map did.
- `apps/web/src/scene/bodies/eclipse-binding.ts`:
  - `EclipseSystem`: one per planet; it knows its casters' meshes.
  - `EclipseBinding` / `useEclipse`: one per receiver, with stable uniforms. `onBeforeCompile` patches the material, and every body material shares one program (`customProgramCacheKey`). The mesh's `onBeforeRender` writes the casters' world positions. That runs after three updates the world matrices, so the order of the orbit callbacks doesn't matter.
  - When the tier has no `shadows`, the count is 0, so the shader's loop does nothing and a tier change needs no recompile.
- `Bodies.tsx`: no `castShadow` / `receiveShadow`. Planet, moon and ring meshes carry the binding.
- `SolarScene.tsx`: the Canvas has no `shadows`, the point light has no `castShadow`, and `SHADOW_FAR` is removed. `Bodies` receives `sunRadius`.
- `quality.ts`: `shadowMapSize` is removed (it sized the cube map). `shadows` still exists and is still on for `high` only.

Kept: Saturn's shadow on its rings, now also Titan's. The planet's shadow on its moons, and the moons' spots on the planet, are kept too. The rings never cast before and still don't, so there is no ring shadow on the planet.

## Screenshots (headless Chrome, "high", same harness; kept in the agent's scratch folder, not committed)

- **Before, Jupiter at t = 50.25 s:** the whole lit disc is black (Venus's shadow); Io and Europa are lit beside it. **Same frame with Venus's `castShadow` off:** Jupiter fully lit, with one small elongated moon spot near the terminator.
- **Before, Saturn at t = 146 s:** Saturn's disc is black inside its lit rings (Earth's shadow). **With Earth's `castShadow` off:** normal.
- **Before, Jupiter at t = 858 s:** a sharp black disc about half Jupiter's diameter (Mars).
- **After, the same three frames:** Jupiter and Saturn fully lit. At t = 50.25 s, a soft-edged moon spot the size of the moon that casts it.
- **After, Saturn at t = 526 s, seen from beside and behind:** the planet's shadow darkens the rings behind it. **The same frame with the eclipse switched off:** no dark band on the rings.
- **After, Jupiter at t = 763.5 s:** a round spot from Ganymede on the disc, about the moon's own size, and a moon darkened in Jupiter's shadow behind it.

### Full cycle (after)

The same 49 alignments of one Saturn year, measured as before but comparing eclipse on and off. The worst darkened share of a target's disc was **5.2 %** (Jupiter at t = 763.5 s, Ganymede's spot). Of the 49, 44 were 0 %. Before, every one was 72–100 %.

## Performance

Headless Chrome, uncapped (`--disable-gpu-vsync --disable-frame-rate-limit`), dev build, "high", 1440 × 900 at DPR 1. Other agents kept the machine's load averages at 20–68 during these runs, so the fps numbers are only comparable as back-to-back pairs. The draw counts do not depend on load.

| view | draw calls / frame before → after | fps before → after (two alternating pairs) |
| --- | --- | --- |
| system | 100 → 85 | 91–95 → 108–114 |
| Jupiter | 55 → 40 | 90–95 → 107–110 |
| Saturn | 56 → 41 | 91–98 → 109–115 |

This removes the cube shadow's passes: 15 draws a frame here, and up to six per caster as the camera moves. In exchange, each body fragment does at most 5 sphere tests. The result is roughly 15–20 % more uncapped headroom at "high". P3-08 had measured the shadows' cost at about 30 %. The `balanced` and `mobile` tiers have no shadows and are unchanged, apart from an empty loop in the shader.

## Tests

- `apps/web/src/scene/bodies/eclipse.test.tsx` (new, 19 tests):
  - **Root cause, as a regression record:** in the readable layout, Mercury, Venus and Earth throw point-light shadows wider than Jupiter and Saturn, and a Venus caster would black out Jupiter's whole disc.
  - **Casting rules:**
    - each system's casters, biggest first;
    - every planet, moon and ring system receives, only from its own system and never from itself;
    - a planet never eclipses another;
    - Saturn shades its rings, and rings never cast;
    - a moon takes its planet and its sibling casters, and the planet takes its moons;
    - the list is capped at the shader's array size, keeping the largest;
    - only `high` shades.
  - **Maths:**
    - the spot is the moon's size, not magnified;
    - a caster behind the point or past the Sun casts nothing;
    - overlapping casters multiply and stay in [0, 1];
    - Saturn's shadow reaches its rings behind it.
  - **Shader patch:** anchors on three's real `ShaderLib.standard` sources, inserts the code once, puts the eclipse after the lights, and throws on a missing anchor.
  - **Binding:**
    - it writes the casters' world positions and radii;
    - it writes nothing with shadows off, and keeps the same uniforms when the tier changes;
    - it skips a caster whose mesh is gone;
    - every receiver shares one program key.
- `lod.test.tsx`: no `shadowMapSize` in the tier table any more (it was also in the monotonic check). `bodies-model.test.ts`: wording only.

Gates on the branch: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`; results are in the final report. Under the machine's heavy load, a few slow tests elsewhere (server brain tests, the Earth-mask paint) timed out once; each passed when re-run alone.

## Follow-ups (not done)

- The eclipse shading is now cheap enough to consider for `balanced`. That is a product and performance decision for the P3-08 device run, not this task.
- If Cosmin wants moon spots smaller than the drawn moons, scale the caster radius in `eclipseCasters` (one number). Today the spot matches the moon as drawn.
