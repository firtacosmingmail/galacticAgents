# Phase 3, batch 1 (wave 1: P3-01) — review

Branch `p3-wave1-canvas` against `phase-3`, 2026-10-03. One agent built the canvas, renderer and quality tiers; the decision (SPEC 62) and the TECHNOLOGY §2.1 bullets were written before the review. An independent review found no blocker: three.js stays out of the panel's first chunk (grep on the build), WebGL only, R3F disposes the renderer and forces context loss on unmount, errors (including a failed chunk load) reach the boundary, ACES is applied exactly once in every tier, the `demand` loop is invalidated on changes, all storage access is guarded, the dependencies are permissively licensed and run no install scripts. A fix agent closed its findings:

| # | Finding | Fix |
|---|---|---|
| 1 | The Hide/Show toggle's `aria-pressed` read backwards | dropped; the label carries the state |
| 2 | A lost GPU context left a black canvas with no message | `webglcontextlost` → "3D scene unavailable" with Retry (SPEC 62) |
| 3 | The probe accepted WebGL1 (three 0.186 needs WebGL2) and ran in list mode too | `webgl2` only, probed when the scene is to be shown |
| 4 | About 5 % of the stars bloomed | threshold 1.0, stars capped at 0.85, the Sun raised to ≈ 1.95; tested |
| nits | empty shadow passes, redundant renderer defaults, "applies live" wording | shadows off until P3-02, defaults removed, "at once in this browser" |

Watch in P3-02: R3F's peer range is react `>=19 <19.4` (the next React minor needs an R3F bump); respect `prefers-reduced-motion` for orbital motion and camera flights; check the middle layout (1101–1699 px) in a real browser.

Open: the 60 fps at "high" check on Cosmin's Mac (`/?show_fps=true`, steps in `P3-01-canvas.md`).

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 64, server 842 (+1 skipped), web 219.
