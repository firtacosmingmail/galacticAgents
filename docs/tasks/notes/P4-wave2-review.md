# Phase 4, batch 2 (wave 2: P4-02, P4-03, P4-05) — review

Branch `p4-wave2-state-activity-beacons` against `phase-4`, 2026-10-03/04. Three parallel agents with split ownership: P4-02 the state look (`satellites/look.ts`, `STATE_LOOK`), the list options (`SCENE_SATELLITES`, failed agents kept) and the Harmonizer's HQ station on Earth plus the legend; P4-03 the Steward activity archetypes (`satellites/archetype.ts`, `satellites/activity/`); P4-05 the question beacons (`scene/beacons/`). The coordinator relayed each finished task's interface changes to the agents still running (per-satellite orbit clock, `PLACE_SATELLITES`, the shared amber blink); merges conflicted only on adjacent mount lines and TECHNOLOGY bullets. Decisions 72 (state looks, HQ), 73 (activities; proposed as 72 and renumbered) and 74 (beacons) recorded.

An independent review found no blocker. A fix agent closed its findings, each with a test:

| # | Finding | Fix |
|---|---|---|
| 1 | A failed satellite came back when its replacement ended, and lingered ≤ 24 h after its work was cancelled or closed | superseded by any newer agent of the same role on the work (live or not); hidden when the work is over (SPEC 72) |
| 2 | The instanced beam mesh drew all 40 beams, zero-scaled (~19k triangles, a draw call between scans) | only scanning beams are written; the mesh hides when none scan |
| 3 | Beacons rebuilt on every 100 ms status flush (≈ 10 renders/s, hover flicker) | no status read; the list and frames are kept while unchanged; the hover card selects only what it needs |
| 4 | 3 draw calls per beacon, uncapped, off-screen ones drawn | off-screen beacons hidden; shared shapes (instancing judged not worth a custom shader for a handful) |
| 5 | A 2 s minimum dwell could break "the archetype changes within a second" | dwell 1 s, release 1.5 s; a sweep test proves ≤ 1 s (SPEC 73) |
| 6 | Stalled ≈ working under reduced motion for colour-blind viewers | stalled is dimmer and smaller (SPEC 72) |
| nits | MCP names and compound shell commands misclassified; beacons depended on mount order after the camera rig; per-frame allocations; a "reporting back" rule that never fires | classified by part; camera at its own frame priority (`PLACE_CAMERA`, −0.25); scratch objects; SPEC 73 reworded |

## Added after Cosmin's feedback (P4-11 … P4-14)

- **P4-11** — Allow on "May WebSearch run?" showed "Internal": two parallel tool calls shared one pending-question slot in the Claude adapter, the second overwrote the first, the first's answer threw after it was written and rolled back. Pending questions are now by id; the status store keeps every open question (the agent stays waiting while any is open).
- **P4-12** — the inbox hides like the managed agents (decision 75), "N waiting" and beacons bring it back; closed work is out of the navigation behind "Show closed"; every row has "⋯" with the strip's actions to clear leftover demo projects.
- **P4-13** — one beacon per question (40 px apart, at most 6 per body, Cosmin approved); clicking selects the asker, flies there and opens the question; non-catalogue planets are drawn only while something is on them (decisions 74, 63).
- **P4-14** — Waykeepers clean up their Stewards' processes, the server sweeps as a safety net (decision 76). Two reviews: the first found the cleanup could stop the user's daemonised programs started in a worktree (tmux, `code .`, nohup) and a reused process group from a previous server run — fixed with an agent marker in every agent's environment (unreadable → not taken), session-exact windows and this run's groups only, held helpers for live Stewards, a re-check before every signal; the second found user-facing apps a Steward itself opens (VS Code, tmux) would take the user's work in them, and that macOS hides the marker of Apple shells — fixed: app bundles and multiplexers never taken through an orphan, identities remembered while the Steward ran. Residual risks are listed in the P4-14 notes.

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 67, server 845 (+1 skipped), web 966; server 910.

Open for Cosmin: the three beacon choices (a beacon on Earth for the Harmonizer's own questions; one beacon per body; a click opens the question without moving the selection or camera), and how the looks, activities and beacons read in motion.
