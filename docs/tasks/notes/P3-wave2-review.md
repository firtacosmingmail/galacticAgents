# Phase 3, batch 2 (wave 2: P3-02, P3-03, P3-04) — review

Branch `p3-wave2-bodies-belt-camera` against `phase-3`, 2026-10-03. Before launching the three parallel agents the coordinator committed a shared contract — one folder and one pre-mounted slot per task (`bodies/`, `belt/`, `camera/`), the anchor registry (`scene/anchors.ts`) and the scale mapping (`scene/scale.ts`) — so the three never edited the same file; the merges were clean except one doc comment in `quality.ts`. Decisions 63 (scale and motion) and 64 (camera) and the TECHNOLOGY §2.1 bullets were written before the review.

An independent review found no blocker: the generator moved to `packages/protocol` gives identical results (n = 1..5000 diffed), three.js stays out of the panel's first chunk, anchor ids are consistent (`b-sun`, `Body.id`) and survive the scale toggle and StrictMode, freed / moved asteroids unregister, resources are disposed, the belt rewrites its instances only on scale or count changes. A fix agent closed its findings:

| # | Finding | Fix |
|---|---|---|
| 1 | A remounted camera rig (hide/show, tier to/from mobile) replayed the last flight while the breadcrumb said "Solar system" | the request is cleared on release; a new rig starts from the store's current seq |
| 2 | `]` / `[` sorted moons by live distance, so the order changed as they orbited | stable `order` on anchors (planet orbit; moons orbit×1000+rank; asteroids by number); SPEC 64 |
| 3 | In true scale the overview camera sat outside the star shell | the star field is centred on the camera every frame; the overview frames planets, not far moons |
| 4–6 | stale TECHNOLOGY sentence on shadows; a second reduced-motion check in the camera; the belt reading the tier inside the Canvas | removed; `scene/motion.ts`; `rocks` prop |
| 7–9 | per-frame anchor world in free mode; per-frame tuples; 30 shadow casters on high | lazy `AnchorWorld` with cached extent; allocation-free `placeOnOrbit`; moons cast from 1000 km up (15 casters) |
| 10–12 | stale comments; duplicate anchor hook; opposite orbit conventions | rewritten; `scene/anchor-binding.ts`; `scene/orbit.ts` (the belt is mirrored once as a result) |

Not checked in a real browser after the fixes: the star field following the camera and the reduced shadows. Open for Cosmin: the fps check at "high" (`/?show_fps=true`), a look at the scene and the true-scale toggle.

Watch in P3-08: drei `Html` labels project every frame (P3-07 adds ~31); shadows remain the first thing to drop if "high" misses 60 fps.

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 67, server 842 (+1 skipped), web 321.
