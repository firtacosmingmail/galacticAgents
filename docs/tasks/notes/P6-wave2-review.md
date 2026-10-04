# Phase 6 wave 2 review (P6-02, P6-03, P6-05)

Review of `phase-6...p6-wave2-visuals-cutaway-hq`, 2026-10-04. No blockers. Fixes landed on
`p6-wave2-review-fixes` and were merged into the batch branch; gates green afterwards
(protocol 70, server 976 + 1 skipped, web 1433).

## Should-fix (all fixed)

1. **Idle detail-texture budget never kept anything.** The budget hook lived in `DetailFrame`,
   which is remounted per body, so leaving a view dropped every idle level and re-entering Earth
   repainted the 4096 level (~8–10 s). Moved to `DetailLayer` (canvas lifetime). Re-entry now
   starts no paint job (measured in the browser). The cap covers live + idle together, so the
   high-tier worst case is ~224 MB of textures with the 96 MB near cache; 128 MB budget kept.
2. **Clouds and orbiting-moon near maps queued behind the 4096 paint**, then popped in at full
   opacity. The painter now has a priority (near levels and clouds before detail levels, FIFO
   within a priority, no preemption) and clouds fade in over 1.2 s from map arrival.
3. **P6-05 had no browser check.** Done in headless Chrome: proportions, strobe, nav lights and the
   model swap during the fade are good. Found that the station is rarely on screen at the detail
   framing → new task P6-06.
4. **HQ click overwrote the stored Chat/Status choice** (device-wide, Waykeepers included).
   `revealChat()` now uses a transient override that ends on the next selection change or user
   pick. SPEC 85 reworded; §8 asks whether the system-view HQ click should open the chat at all.

## Nits (fixed)

- Cutaway: planes stay assigned while the part is mounted and are parked when the cut is closed,
  so open, close and fade no longer recompile shaders.
- Cutaway: swapped-out materials are pruned from the clipped set.
- Planetshine is described as a faint uniform glow capped at 0.12 (it is not night-side only).
- `features.ts`, `rings.ts`, `paint-jobs.ts` moved into `scene/bodies/`; the system layer no
  longer imports from `detail/visuals/`.

## Left open

- Dark station (no Harmonizer) has no click target — documented, acceptable.
- Outline on a cut body still outlines the whole sphere — deferred in the P6-03 notes.
- From the browser screenshots: belt rocks and a light-blue band show in Earth's detail view, the
  Moon's eclipse shadow is a large dark disc, and Earth can overfill a square canvas → new task
  P6-07. Earth coastline stair-stepping at the 4096 level is still visible (known, P6-02 notes).
