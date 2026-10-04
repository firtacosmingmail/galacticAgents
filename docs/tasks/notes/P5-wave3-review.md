# Phase 5, batch 3 (wave 3: P5-05, P5-06, P5-07) — review

Branch `p5-wave3-conformance` against `phase-5`, 2026-10-04. P5-05 split SPEC §4.2 and §4.3 into 77 requirements and proved each in both modes (`apps/web/src/conformance/`, 72 tests × 2 modes, plus brain-harness tests for the conversational mappings); 75 passed at once, one small gap was fixed (the Harmonizer's own cost), and two needed Cosmin's choices: controls for the Harmonizer itself (decision 82 → P5-06: Pause, Resume, Resume session, a confirmed Restart, no plain Stop) and work controls in conversation (decision 83 → P5-07: `control_work`, stop and cancel behind a confirmation). Four SPEC wordings were corrected from the checklist (§4.2/§4.3 edit, decisions 69, 80, answering through a supervisor). Result: 77/77 with and without the scene.

An independent review found no blocker. Fixed, each with a test:

| # | Finding | Fix |
|---|---|---|
| 1 | Unbounded restarts filled the global per-hour spawn window (≈ 30 blocked every Steward and Waykeeper for an hour) and paid a seeded turn each | Harmonizer spawns no longer count toward the window (decision 43); restarts limited to 3 per 10 min, 429 with Retry-After |
| 2 | A confirmation was used up in a second transaction after the control: two parallel calls could both pass; a crash between left it reusable | consumed in the control's own command, recorded on the question (decision 83) |
| 3 | A failed start after the stop left no Harmonizer; a failed stop left an undriven live one | stop first, nothing else unless it ended; one fallback start; 500 for unexpected errors |
| 4 | Restarting with an interrupted last Harmonizer stranded the questions it held | the new one starts beside it and its held questions go to the user (also on the automatic path) |
| nits | no structural one-Harmonizer guard; restart during a resume; harness rows in the live check; focus lost after "Yes, restart"; conformance titles not one-to-one with rows | a single-flight start lock; 409 while reserved; harness rows ignored; focus kept; every row id greps to one test |

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 70, server 976 (+1 skipped), web 1286.

Open (SPEC §8): whether remote clients may restart the Harmonizer or stop processes.
