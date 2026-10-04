# Phase 4, batch 4 (wave 4: P4-06, P4-07) — review

Branch `p4-wave4-harness-scrubber` against `phase-4`, 2026-10-04. Two parallel agents: P4-06 the dev scene harness (`/dev/harness/*`, the "/debug → Scene harness (dev)" tab, fake agents with no process, real domain commands and agent events) and event toasts (`scene/toasts/`); P4-07 the timeline replay (`GET /api/history/events`, a client fold from the log with checkpoints, `sceneWorld = replayWorld ?? world` read by every scene file, the replay bar). P4-07 finished first; the coordinator relayed the `sceneWorld` switch to P4-06 (toasts read it and stay quiet over a replay). Decisions 78 and 79 recorded.

An independent review found the harness could act on the user's real work. Fixed, each with a test:

| # | Finding | Fix |
|---|---|---|
| S1 | Setting a state on a real ended Steward emitted `agent.spawned`; on the next restart recovery resumed its real Claude session in its real worktree; the real Harmonizer was not refused | state, activity and question routes refuse anything that is not a harness row (409 `not_harness`, nothing written); the tab lists fake agents only |
| S2 | "Answer" resolved any question with `allow` by default — a real `rm -rf` permission included | only questions asked by harness agents |
| S3 | move / complete / close / create accepted real tasks and projects; `control.close` woke the live real Harmonizer (an LLM turn per harness completion); a fake Steward under a real Waykeeper woke it | harness work only; closes without a control event; `concernedSupervisors` skips harness targets; fake agents only under harness Waykeepers (SPEC 79 narrowed) |
| S4 | Escape exited a replay only with focus in its bar | page-wide Escape that yields to popovers, menus, dialogs and text fields |
| S5 | Replays silently stopped after 200 pages | read until done, with progress; a stuck server is an error |
| nits | the dormant harness Harmonizer could become the panel's Harmonizer when no real one existed; membership changed between pages; a false flight on leaving a replay; toast freshness on the client's clock | excluded; one membership token per read; satellites snap on enter/exit; the server's clock (`serverTime` on snapshot and catch-up) |

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 67, server 939 (+1 skipped), web 1034.

Open: Phase 4's exit check with the harness (Cosmin), including a first look at the toasts in WebGL.
