# Phase 3, batch 3 (wave 3: P3-05, P3-06) — review

Branch `p3-wave3-picking-lod` against `phase-3`, 2026-10-03. Two parallel agents with split ownership: P3-05 (a new `scene/picking/`, the composer and `SceneArea`) picks through the anchor registry rather than meshes, so P3-06 (`bodies/`, `quality.ts`, belt density) could swap LOD meshes freely; the one conflict was imports at the top of `SolarScene.tsx`. Decision 65 (picking), a §8 question (per-device tier) and the TECHNOLOGY bullets were written before the review; the plan and the task text now name sphere picking instead of `three-mesh-bvh`.

An independent review found no blocker: every body → selection case maps right (Earth → the Harmonizer per §4.2), panel → scene flights only follow user changes, tier switches rebuild and dispose cleanly, the paint worker is a separate 2.5 kB chunk and three.js stays out of the panel's first chunk. A fix agent closed its findings, each with a test:

| # | Finding | Fix |
|---|---|---|
| 1 | The default Harmonizer selection outlined Earth: the outline's depth pass re-rendered the scene every frame (100 → 168 draw calls at high) | the Harmonizer gets the ring, no outline (SPEC 65); 104.6 vs 175 draw calls measured |
| 2 | Approaching a body fell back to the blurry far map while the near map painted | the shown maps stay until the next level is ready |
| 3 | Touch taps (5–10 px of travel) read as drags | 10 px slop for touch and pen, 4 for the mouse |
| 4–5 | The popover survived hiding the scene; focus fell to `<body>` after a "what's here" choice | closed on unmount; focus back to the scene |
| 6 | Without a worker, 2048 maps painted on the main thread (≈ 1.5 s freeze) | near maps capped at the middle size, no detail |
| nits | a stale paint blocked the queue; a recreated outline effect lost its selection; the info card stayed at the click point; a stale hover label; orbits snapped back on a frame-loop switch | worker restarted on abort; effect compared; card follows the body; re-pick on camera moves; own motion clock |

Open for Cosmin (exit criteria, recorded in P3-08): 60 fps at "high" on the Mac, ≥ 30 fps at "mobile" in Safari on the phone over the LAN (and whether the 30 fps cap feels smooth), taps on the phone. Open question (SPEC §8): a per-device quality tier.

P3-09 (added after Cosmin's look at the scene): Earth painted from a 1024×512 land/sea mask rasterised from public-domain Natural Earth 1:50m land (+13.6 kB to the scene chunk, nothing to the panel's), with latitude biomes, desert regions and ice; checked by 30 tests (known land/sea points, orientation against a real `SphereGeometry`, other bodies byte-identical) and headless screenshots. While merging it, two real-git server tests timed out at Vitest's 5 s default on a machine loaded by a stray headless Chrome; the server suite now has a 20 s test timeout.

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 67, server 842 (+1 skipped), web 447.
