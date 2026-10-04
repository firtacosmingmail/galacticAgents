# Phase 5, batch 1 (wave 1: P5-01, P5-02, P5-03) — review

Branch `p5-wave1-selection-status-history` against `phase-5`, 2026-10-04. Much of Phase 5 already existed from earlier phases, so each of the three parallel agents audited first and built only the gaps: P5-01 (28 selection paths: 24 already worked, 4 fixed — deselect by clicking empty space or Escape's step-back chain, flights for selections made on the settings or history page, replay-safe flights; decision 65 amended, one §8 question), P5-02 (status views without an LLM call — a Chat | Status switch in the Harmonizer's and Waykeepers' dock, system / project / task status, blocked on you first; decision 80), P5-03 (history: closure dates, moves and promotion links, holder chains, an in-place inspector, a detail route and migration 0009; decision 61 amended).

An independent review found no blocker. Fixed:

| # | Finding | Fix |
|---|---|---|
| 1 | No status view when no Harmonizer row exists — exactly where a deselect lands | the switch and the system status show without a Harmonizer |
| 2 | "Active today" summed lifetime cost; task and project costs overclaimed | "agents active today (lifetime cost)"; the 24 h retention caveat on every cost (SPEC 80) |
| 3 | The system view picked a Harmonizer by insertion order and counted harness stand-ins | `currentHarmonizer`; harness agents filtered once |
| nits | Escape could never exit a replay with the scene focused; a deep link flew after list mode; duplicate attention entries; cap-meter caveats; a frozen clock; colours not tokens; history trail names, duplicate back entries, project agents missing a moved task's Steward | all fixed with tests |

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 70, server 949 (+1 skipped), web 1094.
