# P9-13 — Phase 9 acceptance run

**Result:** passed — 2026-10-12, Cosmin, on the Mac (desktop app) and the phone over Tailscale.

Cosmin went through the Phase 9 exit criteria and the features added during the phase and reported that everything works:

- deliverables declared by a Steward, shown in the Steward view and, after the merge, in the project's Deliverables (re-pointed or copied into the project's `deliverables/` folder);
- the project folder opened in the IDE and the Finder;
- `pnpm dev` run from the panel after a confirmation, its output and port, Stop;
- closing the project and restarting the server leave no run behind;
- from the phone: deliverables listed, viewed and downloaded, a run stopped; open, launch and start refused;
- dismissing questions (P9-14), permission requests in the menu bar (P9-15), phone access from the desktop app with its status (P9-16), "Allow similar" (P9-17).

## Decisions confirmed

Cosmin confirmed the two choices made in the P9-17 review fixes (`P9-17-review.md`): the preview digest is required (an older open tab gets an error from "Allow similar" until reloaded), and the extra guarded paths (`~/.claude.json`, the other shell login/logout files).

## Findings

None new. Still open: the SPEC §8 question on a run/answer capability token (a real boundary instead of the agent-peer speed bump).
