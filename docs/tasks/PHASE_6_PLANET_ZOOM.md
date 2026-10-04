# Phase 6 — Planet zoom and structure

**Current task:** P6-02, P6-03, P6-05 (wave 2, after wave 1 is merged into `phase-6`) · **Task status:** todo
**Phase status:** in progress (1/5 done) — on branch `phase-6`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

Zooming into a planet shows it "as it is in our solar system" — high-detail surface, atmosphere, rings, moons in orbit, optional cutaway — with the project's tasks placed on the surface or in orbit and Stewards as robots or drones.

## Entry criteria

- Phase 5 exit criteria met.

## References

- `IMPLEMENTATION_PLAN.md` → Phase 6.
- `TECHNOLOGY.md` §2.1 (separate planet-detail sub-scene, LOD).
- `SPEC.md` §3.2 (sub-project moons shown as part of the project), §4.1 (zoom requirement, Steward activities on surfaces), decision 9 (project tasks on the body).

## Design notes for implementation

- The detail view is a **separate sub-scene** swapped in on zoom, not the system-scale meshes at higher LOD; transition is a camera flight + cross-fade.
- Task placement is deterministic per task id (surface slot or orbit slot) so it is stable across sessions.
- Everything here is WebGL; keep shaders minimal (atmosphere and clouds are the two custom ones).

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P6-01 | Sub-scene and transition. |
| 2 (parallel) | P6-02, P6-03, P6-05 | Visual detail, cutaway and Earth HQ are independent. |
| 3 | P6-04 | Project overlay needs the sub-scene and placement rules. |

## Tasks

### P6-01 — Planet detail sub-scene and transition
- **Status:** done (2026-10-04) · **Depends on:** P3-04, P3-06 · **Parallel with:** —
- Sub-scene component per body kind (rocky, gas giant, moon, asteroid); zoom threshold triggers a smooth transition (fly + cross-fade) and back; breadcrumb; selection persists across the transition.
- **Acceptance:** smooth transition from system scale to planet scale and back for every planet.

### P6-02 — High-detail visuals
- **Status:** todo · **Depends on:** P6-01 · **Parallel with:** P6-03, P6-05
- High-res textures with normal/specular maps, atmosphere shader, clouds for Earth, rings for Saturn/Uranus, the planet's moons orbiting in the detail view; quality tier respected.
- **Acceptance:** each planet recognisably itself at detail scale at 60 fps on the Mac.

### P6-03 — Cutaway layers
- **Status:** todo · **Depends on:** P6-01 · **Parallel with:** P6-02, P6-05
- Optional cutaway showing internal layers (crust/mantle/core; gas giant envelopes) with labels; toggle in the panel.
- **Acceptance:** cutaway works for at least one rocky planet and one gas giant.

### P6-04 — Project overlay: tasks, Stewards, sub-project moons
- **Status:** todo · **Depends on:** P6-01, P4-03, P2-02 · **Parallel with:** —
- Project tasks placed on the surface or in orbit (deterministic slots), clickable; Stewards as surface robots (rocky bodies) or orbital drones (gas giants) using the Phase 4 archetypes; sub-project moons rendered as part of the project with their own Waykeeper satellite; independent-project moons distinguished.
- **Acceptance:** project tasks are placed and clickable in the detail view; selecting one selects the task in the panel.

### P6-05 — Earth as headquarters
- **Status:** todo · **Depends on:** P6-01, P4-02 · **Parallel with:** P6-02, P6-03
- Distinct HQ station in Earth orbit as the Harmonizer's home; idle/thinking indication; clicking it opens the Harmonizer chat.
- **Acceptance:** Earth detail view shows the station and links to the Harmonizer.

## Exit criteria (from the plan)

Smooth transition from system scale to planet scale and back; project tasks are placed and clickable in the detail view.
