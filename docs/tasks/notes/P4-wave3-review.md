# Phase 4, batch 3 (wave 3: P4-04) — review

Branch `p4-wave3-transitions` against `phase-4`, 2026-10-04. One agent built the body transitions: moves and promotions fly every satellite of the work from the old body to the new one (the director already retargeted on the server's existing events; the fix was the flight origin: last drawn position, else the orbit round the old body, else a ghost), completed work's satellites land and stay during retention (`keepLanded` on, widened to "the newest agent that ran on completed work, however it ended", because a close stops the idle Steward and status records go after 24 h), a colonised mark (warm lights) on a body whose own work is completed. The phase's exit criterion "moving a task to a project flies its satellite there" is covered by a test that feeds the server's real event shapes through the client reducer. Decision 77 recorded, 68 and 72 reworded.

An independent review found no blocker. Fixed:

| # | Finding | Fix |
|---|---|---|
| 1 | Landed satellites flooded picking: a completed project with 30 tasks opened a 31-item "what's here" list; up close the surface selected a landed Steward | landed satellites are picked only by a direct hit at their drawn size up close; clicking the body reaches its Waykeeper |
| 2 | No bound: hundreds of landed satellites over retention; the landing rule scanned every agent per agent (O(n²)) | newest-agent index once per list; at most 6 landed per body (SPEC 77) |
| 3 | A promotion made landed satellites take off and land again | re-created landed on the new body, growing in over 0.4 s |
| nits | ghost-origin wording; a stale origin after a hidden tab; a draw call per colony; lights floating off asteroids | corrected; stale (> 2 s) origins dropped; one `Points` for all colonies, dimmed on the day side; lights follow the rock |

Open for Cosmin: whether a failed Steward of a task closed anyway lands with the finished look (today) or keeps its failure tint; whether 6 landed per body is right.

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 67, server 910 (+1 skipped), web 999.
