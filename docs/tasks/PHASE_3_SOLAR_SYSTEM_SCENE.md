# Phase 3 — Solar system scene

**Current task:** P3-05, P3-06 (wave 3, branch `p3-wave3-picking-lod`) · **Task status:** in progress
**Phase status:** in progress (4/8 done) — on branch `phase-3`

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
- **Status:** in progress · **Depends on:** P3-02, P3-03, P3-04 · **Parallel with:** P3-06
- Raycast picking with `three-mesh-bvh` for dense scenes; hover highlight; selection outline (postprocessing); "what's here" popover listing all bodies under the pointer (corner case 24); click mapping into the shared selection store (planet/moon → project, asteroid → task).
- **Acceptance:** selecting a body in the scene selects the right Waykeeper/task in the panel and vice versa.

### P3-06 — LOD and quality setting
- **Status:** in progress · **Depends on:** P3-02, P3-03 · **Parallel with:** P3-05
- LOD tiers per body (low-poly at system scale, textured with normal/specular when zoomed); quality setting toggles effects, pixel ratio, belt density; mobile tier defined for the phone.
- **Acceptance:** switching tiers at runtime works; mobile tier ≥30 fps on the phone over LAN.

### P3-07 — Domain binding and labels
- **Status:** todo · **Depends on:** P3-05, P2-15 · **Parallel with:** —
- Bodies bound to the domain model from the store: hosted project/task name and derived state as HTML labels anchored to bodies (drei `<Html>`), throttled updates; independent-project moons visibly distinct from sub-project moons (SPEC §3.2); reserved bodies unlabelled; `moved` and `completed` markers as label states (animations come in Phase 4).
- **Acceptance:** every assigned body shows the right name and state; a state change in the store updates the label within a second.

### P3-08 — Performance pass and phone test
- **Status:** todo · **Depends on:** P3-06, P3-07 · **Parallel with:** —
- Profile with many assigned bodies and labels; cap simultaneous label updates; verify 60 fps at "high" on the Mac and ≥30 fps at "mobile" in Safari on the phone over LAN (Tailscale not yet needed); record numbers in `docs/tasks/notes/P3-08-perf.md`.
- **Acceptance:** exit criteria numbers recorded.

## Exit criteria (from the plan)

60 fps on your Mac at "high", ≥30 fps at "mobile" tier in Safari on the phone over the LAN; every assigned body can be clicked and shows the right project/task.
