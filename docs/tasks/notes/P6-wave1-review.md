# Phase 6, batch 1 (wave 1: P6-01) — review

Branch `p6-wave1-detail-scene` against `phase-6`, 2026-10-04. One agent built the planet detail view: a separate sub-scene per body kind mounted over the system (copying the body's anchor every frame, so camera, picking, labels and P4 overlays keep working), a cross-fade with a backdrop dome (stars and the Sun in its real direction), entering by zooming in past 3 R, the breadcrumb's "Detail view" or a second Enter, leaving past 4.5 R, by Escape, the body's crumb, Home or "Solar system"; the `DETAIL_PARTS` slot for P6-02…05. 60 fps on every planet in a headless check. Decision 84 recorded.

An independent review found one blocker. Fixed, each with a test:

| # | Finding | Fix |
|---|---|---|
| B1 | In true scale, 15 of 22 moons left the detail view as soon as the flight landed (the flight framed a clamped radius, the watcher divided by the raw one) | one `framedRadius()` everywhere; every catalogue body enters and stays, both scales |
| S1 | "Detail view" mid-flight covered the system before the camera arrived (a dark ball from far away) | cover only once the fade ended and the camera is in place |
| S2 | Belt rocks and nearby bodies inside the asteroid view's dome popped out when the fade ended | hide only what is wholly outside the dome; the body's orbit line fades |
| S3 | After a pan the camera could enter the body | keep-out clamp at 1.3 R from the body's centre |
| nits | per-frame allocations, stale visibility selectors, duplicated glow code, anchor stacking without a user | scratch objects, per-frame checks, a shared helper, stacking kept and tested for P6-0x |

Visible consequence: in fake scale, Jupiter lies inside the asteroid view's dome and stays visible behind the rock (it used to pop out).

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 70, server 976 (+1 skipped), web 1348.
