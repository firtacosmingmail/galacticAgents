# Phase 6 wave 3 review (P6-04, P6-06, P6-07)

Review of `phase-6...p6-wave3-overlay-hq-view`, 2026-10-05. No blockers. Fixes landed on
`p6-wave3-review-fixes` and were merged into the batch branch; gates green afterwards
(protocol 70, server 976 + 1 skipped, web 1494).

## Integration (checked, OK)

- The HQ viewing slot (P6-06) and the Steward placement (P6-04) both write satellite frames but
  never the same one: the overlay only claims Stewards orbiting the shown body, the slot only moves
  the Harmonizer's frame, after the director and before the HQ writer, activities and picking.
  Earth and the Moon are reserved (decision 25), so Earth's view has no task markers for the slot to
  overlap.
- P6-07's highlight-ring fade only touches the shown body's ring; the overlay's task rings are
  separate meshes. Moon shadows are dropped only in a planet's detail view.
- Frame order: PLACE_DETAIL → PLACE_OVERLAY (−0.6) → director (−0.5, overrides then HQ pose) →
  camera → READ_BODIES.

## Should-fix (all fixed)

1. **Markers lost on a body swap.** The overlay cleared its marker registry in a passive unmount
   effect without an identity check, after the next body's layout effect had published. Now
   published and withdrawn in one layout effect, own set only; the cutaway's plane registry got
   the same treatment.
2. **A robot removed by the cutaway stayed pickable** and its rings and activities drew over the
   wedge. Placement overrides carry `hidden`; the director clears the frame's visibility.
3. **Docs:** SPEC 88's cap rule reworded to the code (archived and moved work never shown; past the
   cap the newest completed tasks go first); stale "proposed" references now cite 88/89; the
   TECHNOLOGY mesh count corrected.

## Nits (fixed)

- Instance lists sized from the actual marker counts; a marker that does not fit is neither drawn
  nor pickable.
- The HQ slot keeps a 1.7 R reach so the Moon (2.2 R orbit) cannot cover it at wide aspects; the
  test derives the Moon's orbit from the layout.
- Per-frame allocations removed (cached marker looks, scratch tuples in the slot, belt fade caches
  the shown body's kind); the marker memo depends on tasks only; robots shrink with presence.

## Left open

- A Steward jumps from its robot spot back to its orbit when its task completes and it lands
  (needs the claim to ease through the landing; P6-04 notes).
- The slot reads the previous frame's camera (one frame late under reduced motion); cut planes are
  read one frame late by the overlay. Negligible.
- Marker pick targets are at least 9 px — small on touch; the panel is the touch route.
- No browser re-check after the review fixes (unit tests only).
