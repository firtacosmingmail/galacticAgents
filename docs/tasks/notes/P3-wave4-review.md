# Phase 3, batch 4 (wave 4: P3-07) — review

Branch `p3-wave4-labels` against `phase-3`, 2026-10-03. One agent built the domain labels: one DOM layer whose text React renders from the store and whose positions one throttled pass inside the canvas writes (30 Hz, 15 on mobile; ≈ 150 writes/s in flights against ≈ 1,900 for a drei `Html` per body; 60 fps with 41 labels on every tier, headless). Independent-project moons get a teal ring and an "own project" badge; sub-project moons say "↳ part of …". Decision 66 and the TECHNOLOGY bullet were written before the review.

An independent review found no blocker. A fix agent closed its findings, each with a test:

| # | Finding | Fix |
|---|---|---|
| 1 | Labels painted over the breadcrumb and the scale toggle and caught their clicks | one documented stacking order (canvas < labels < chrome < hover label < popover), tested from the stylesheets |
| 2 | Labels blocked wheel-zoom and drags, a press-drag-release on a label selected, a planet's label stole its moons' clicks | labels take no pointer events; picking resolves label hits — a body under the pointer wins (SPEC 66) |
| 3 | A label whose anchor registered after it stayed hidden under the demand loop | the projector also listens to anchor changes |
| 4 | SPEC 66 promised "moved to" on asteroids that decision 63 folds back into the belt | 66 narrowed to planets and moons; the model skips moved asteroids; the choice is an open question (§8) |
| nits | every label re-measured on any world change; labels above the viewport counted as shown; finished labels' "part of" line at ≈ 3:1 | measured on content change only; the selected / focused label clamps to the top edge; dimmed frame and pill, text ≥ 4.5:1 |

Side effect: labels no longer show a native `title` tooltip (no pointer events); hovering shows the body's name, the panel the full work name.

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 67, server 842 (+1 skipped), web 502.
