# Phase 4, batch 1 (wave 1: P4-01) — review

Branch `p4-wave1-satellite` against `phase-4`, 2026-10-03. One agent built the satellite actor: a satellite per running Waykeeper and Steward on its work's body (anchor registry), a pure eight-mode state machine on the absolute motion clock (flights 3 s, always complete), scanning beams on `DECOR_LAYER`, an instanced path above 12 satellites (8 on mobile), a per-tier animation cap (16/12/6), reduced motion frozen. 40 satellites cost +2 draw calls instanced; 60 fps on high and balanced, 30 capped mobile (headless, M3 Pro). Decision 68 recorded.

An independent review found no blocker. Fixed:

| # | Finding | Fix |
|---|---|---|
| 1 | Under StrictMode (dev) the satellite registry stayed empty until the set changed | cleanup resets the applied list and the director; StrictMode test |
| 2 | Slots recomputed by rank: a new Steward or a replaced Waykeeper made residents jump | sticky slots, newcomers take the lowest free one; in-place orbit changes blend over 0.6 s |
| 3 | Decision 68 dropped finished and failed agents, against decision 4 and P4-02's failure colour | 68 reworded; `showsSatellite` options `keepFailed` (P4-02) and `keepLanded` (P4-04), off by default |
| 4 | The beam's near-linear fade washed out sunlit Jupiter (the "pale spot") | 12-ring cone, cubic falloff: ≤ 0.155 luminance over the body, apex still blooms (numbers tested, not yet seen by eye) |
| 5 | Bodies placed after some readers: a one-frame lag, a shudder around fast moons | body placement at `useFrame` priority −1 (`scene/frame-order.ts`) |
| nits | reduced motion mid-flight froze it; beams popped; anchorless satellites took budget; per-frame closures; no fade on start/end | all fixed; a scanning satellite keeps its budget |

## Added after Cosmin's look (P4-08, P4-09)

Cosmin saw the satellites and asked for a hover card, a hidable managed-agents column and compact project rows with a Steward count. P4-08 (satellite hover card, decision 70) and P4-09 (hidable cards, compact rows, decision 69) were built in parallel and reviewed together. Fixed after the review: the system-view hover flickered between a speck planet's satellites (it now names the body, "+n"); clicks on orbiting satellites missed (the satellite under the pointer at press is clicked); a hover grace keeps a satellite hovered while the pointer rests on or follows it; per-frame allocations and frame-rate re-renders removed. In the panel: hiding the cards lost every project and task control (a controls strip in the main header now carries the selected agent's work controls); the Steward count counted every Steward ever spawned (now tasks: "N active, M in total", paused not active).

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 67, server 845 (+1 skipped), web 700.
