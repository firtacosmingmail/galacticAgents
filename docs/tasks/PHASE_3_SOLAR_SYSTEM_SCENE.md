# Phase 3 — Solar system scene

**Current task:** — (phase complete) · **Task status:** —
**Phase status:** done (2026-10-03) — 12/12; merged into `main` — on branch `phase-3`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

The spectacular map, driven by real data: Sun, planets, moons and the asteroid belt on the classic WebGL renderer, with navigation, picking and domain labels. No agent animation yet (Phase 4) and no planet interiors (Phase 6).

## Entry criteria

- Phase 2.5 exit criteria met (the panel exists; the scene plugs into its selection model).

## References

- `IMPLEMENTATION_PLAN.md` → Phase 3; corner cases 21, 22, 24, 25, 26.
- `TECHNOLOGY.md` §2.1 (R3F, drei, postprocessing, WebGL only, instancing, LOD, fake scale, quality tiers).
- `SPEC.md` §3.2 (moon display rules), §4.1 (view requirements, click mapping), decision 20.

## Design notes for implementation

- **WebGL only** (`WebGLRenderer`); no WebGPU code paths. Keep custom GLSL minimal.
- Scene = R3F canvas; all UI chrome stays in React outside the canvas (Phase 2.5 panel).
- **Fake scale** by default (hand-tuned spacing), "true scale" toggle as an extra.
- **Instancing** for the belt; only task-hosting asteroids get individual meshes and labels.
- **LOD tiers** and a quality setting (`high | balanced | mobile`) from settings; the mobile tier must hit ≥30 fps on the phone over LAN.
- **Click mapping** (SPEC §4.1): planet/moon → its project & Waykeeper; asteroid → its task & Steward; satellite (Phase 4) → that agent. Selection goes through the shared store from Phase 2.5.
- Orbital motion is decorative; never let it hide a busy body behind the Sun; camera can always reach any body.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P3-01 | Canvas, renderer, tiers, skybox, Sun. |
| 2 (parallel) | P3-02, P3-03, P3-04 | Bodies, belt and camera are independent once the canvas exists. |
| 3 (parallel) | P3-05, P3-06 | Picking/selection and LOD/quality. |
| 4 | P3-07 | Domain binding needs picking and bodies. |
| 5 | P3-08 | Performance pass last. |

## Tasks

### P3-01 — Canvas, renderer and quality tiers
- **Status:** done (2026-10-03; the 60 fps check on the Mac is Cosmin's) · **Depends on:** P25-02 · **Parallel with:** —
- R3F `<Canvas>` with `WebGLRenderer`, colour management, resize handling; quality tier config read from settings (pixel ratio, shadow/effects flags); star-field skybox; Sun with emissive material and bloom via `@react-three/postprocessing`; scene mounted beside the panel with a toggle to hide it (list mode).
- **Acceptance:** scene renders at 60 fps on the Mac at "high"; hiding it leaves the panel fully functional.

### P3-02 — Planets, moons, orbits and scale
- **Status:** done (2026-10-03) · **Depends on:** P3-01 · **Parallel with:** P3-03, P3-04
- `<Planet>` / `<Moon>` components: textures, axial tilt, rings for Saturn and Uranus, major moons on orbits around their planet; hand-tuned spacing table; slow decorative orbital motion; "true scale" toggle (with the UI note from corner case 25).
- **Acceptance:** all 8 planets and the seeded moons visible and identifiable; toggle switches scale without breaking selection.

### P3-03 — Asteroid belt
- **Status:** done (2026-10-03) · **Depends on:** P3-01 · **Parallel with:** P3-02, P3-04
- Instanced belt (thousands of rocks) from the deterministic generator seed (P2-02) so the belt looks stable across runs; task-hosting asteroids rendered as individual meshes with labels and pick targets; belt navigable.
- **Acceptance:** one draw call for the belt; task asteroids stand out and are pickable.

### P3-04 — Camera controls and fly-to
- **Status:** done (2026-10-03) · **Depends on:** P3-01 · **Parallel with:** P3-02, P3-03
- Orbit/pan/zoom controls (drei), click-to-focus with smooth flight to a body, breadcrumb "back to system", focus always reachable (corner case 26), keyboard shortcuts for next/previous body.
- **Acceptance:** flying to any body and back works from any camera state.

### P3-05 — Picking, hover and selection
- **Status:** done (2026-10-03) · **Depends on:** P3-02, P3-03, P3-04 · **Parallel with:** P3-06
- Picking by ray vs the anchors' bounding spheres (decided in P3-05 instead of `three-mesh-bvh`: about 40 spheres, LOD-independent); hover highlight; selection outline (postprocessing); "what's here" popover listing all bodies under the pointer (corner case 24); click mapping into the shared selection store (planet/moon → project, asteroid → task).
- **Acceptance:** selecting a body in the scene selects the right Waykeeper/task in the panel and vice versa.

### P3-06 — LOD and quality setting
- **Status:** done (2026-10-03; the phone ≥30 fps check is Cosmin's, recorded in P3-08) · **Depends on:** P3-02, P3-03 · **Parallel with:** P3-05
- LOD tiers per body (low-poly at system scale, textured with bump/roughness detail when zoomed); quality setting toggles effects, pixel ratio, belt density; mobile tier defined for the phone.
- **Acceptance:** switching tiers at runtime works; mobile tier ≥30 fps on the phone over LAN.

### P3-07 — Domain binding and labels
- **Status:** done (2026-10-03) · **Depends on:** P3-05, P2-15 · **Parallel with:** —
- Bodies bound to the domain model from the store: hosted project/task name and derived state as one HTML label layer projected in a throttled pass (no drei `Html`; decision 66), throttled updates; independent-project moons visibly distinct from sub-project moons (SPEC §3.2); reserved bodies unlabelled; `moved` and `completed` markers as label states (animations come in Phase 4).
- **Acceptance:** every assigned body shows the right name and state; a state change in the store updates the label within a second.

### P3-08 — Performance pass and phone test
- **Status:** done (2026-10-03; Cosmin's look on the Mac and the phone accepted as the device run — its findings became P3-10…P3-12; his fps numbers are recorded when he sends them) · **Depends on:** P3-06, P3-07 · **Parallel with:** —
- Profile with many assigned bodies and labels; cap simultaneous label updates; verify 60 fps at "high" on the Mac and ≥30 fps at "mobile" in Safari on the phone over LAN (Tailscale not yet needed); record numbers in `docs/tasks/notes/P3-08-perf.md`.
- **Acceptance:** exit criteria numbers recorded.

### P3-09 — Earth with its real continents (added 2026-10-03)
- **Status:** done (2026-10-03) · **Depends on:** P3-02, P3-06 · **Parallel with:** —
- Cosmin, after looking at the scene: "Planet Earth does not look like Earth." Earth's procedural surface gets the real coastlines: a small equirectangular land/sea mask generated once from public-domain Natural Earth data (script and source recorded), committed as a compact data file, and used by the surface painter (colour by land/sea, latitude biomes and ice caps, noise for texture; the detail map's ocean gloss follows the mask) at every LOD level and tier, in the worker and the main-thread fallback alike.
- **Acceptance:** the continents are recognisable at the close-up level on every tier; the mask adds at most ~20 kB to the scene chunk and nothing to the panel's first chunk; the licence is recorded.

### P3-10 — Planet-sized shadows over Jupiter and Saturn (added 2026-10-03)
- **Status:** done (2026-10-03) · **Depends on:** P3-02, P3-06, P3-08 · **Parallel with:** P3-11, P3-12
- Cosmin, looking at the scene: "very big shadows going over Jupiter from time to time, big enough to cover the entire planet. I saw it on Saturn as well. If it is the shadow of a moon, it should definitely not be that big." Find the cause (suspected: the Sun is a point light, so a planet passing between the Sun and an outer planet throws a magnified shadow in the enlarged readable layout) and fix it so shadows stay plausible: a moon's shadow is a small spot, a planet never eclipses another, Saturn keeps its shadow on its rings.
- **Acceptance:** no planet-sized shadow on any body over a full orbital cycle at "high" (screenshot evidence), Saturn's ring shadow kept, a test for the casting rules.

### P3-11 — The fps meter does not show (added 2026-10-03)
- **Status:** done (2026-10-03) · **Depends on:** P3-01 · **Parallel with:** P3-10, P3-12
- Cosmin: adding `?show_fps=true` to the localhost URL shows nothing. Find why (URL rewriting, the scene hidden, the stacking order, the dev server) and fix it so `?show_fps=true` on any panel URL shows the meter at the scene's top-left and `?show_fps=false` hides it.
- **Acceptance:** `?show_fps=true` works from a cold load of `/`, `/waykeeper/<id>` and `/steward/<id>`, in `pnpm dev` and in a build; a test.

### P3-12 — Top bar on small screens (added 2026-10-03)
- **Status:** done (2026-10-03) · **Depends on:** P25-02 · **Parallel with:** P3-10, P3-11
- Cosmin: "on mobile the menus on the top are mixed in each other; a better design is needed there, maybe a hamburger menu, or something better suited for mobile." Redesign the top bar for narrow screens: the essentials stay visible (back to the Harmonizer, "N waiting for you"), the rest (notifications, scene toggle, settings, history, debug, forget token) moves into a menu that is keyboard- and screen-reader-accessible; the desktop layout is unchanged.
- **Acceptance:** no overlapping controls from 320 px to 1100 px wide; every top-bar action reachable on the phone; tests.

## Exit criteria (from the plan)

60 fps on your Mac at "high", ≥30 fps at "mobile" tier in Safari on the phone over the LAN; every assigned body can be clicked and shows the right project/task.

## Exit check (2026-10-03)

- **"Every assigned body can be clicked and shows the right project/task":** met. Picking through the anchor registry selects the right Waykeeper or Steward for every planet, moon and task asteroid (P3-05, decision 65), labels show each body's work and state and follow the store within a second (P3-07, decision 66); both are covered by tests through `<App/>` and by headless-browser checks.
- **"60 fps on your Mac at 'high', ≥ 30 fps at 'mobile' in Safari on the phone over the LAN":** measured headless on an M3 Pro with a heavy world (11 projects, 30 task asteroids, 42 labels): 60 fps (vsync) on high and balanced in every view, a steady 30 on capped mobile, also 30 in software GL at phone size (P3-08 notes). Cosmin looked at the scene on his Mac and his phone; what he found (planet-sized shadows, the fps meter, the phone's top bar) was fixed in wave 6 (P3-10…P3-12, faster at high than before). He accepted the phase on 2026-10-03 and asked for the merge; his own fps readings (`?show_fps=true`) go into the P3-08 notes' Device runs table when he sends them.
- Open questions carried forward (SPEC §8): a per-device quality tier (before Phase 7); moved asteroids keeping a marker; notifications while the tab is focused.
- Gates on `phase-3`: build, typecheck, lint, format:check green; protocol 67, server 845 (+1 skipped), web 549.
