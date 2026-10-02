# P2-19 — End-to-end exit run (2026-10-02)

**Run by:** Cosmin, on the dev machine (macOS), with `pnpm dev` and the real Claude Harmonizer (the default since commit 096cc16), driving the console's Hierarchy page.

**Result:** reported by Cosmin: "I tested it and it seems to work ok." The coordinating agent did not observe the run; this note records the user's report, not a step-by-step log.

**What the run surfaced and what was changed because of it (same day):**
- `pnpm dev` started a fake Harmonizer → the real one is now the default (P2-08 follow-up, 096cc16).
- Too many permission cards (a Steward's venv in a temp folder, `python -c`, `pip install`, WebSearch) → per-project trust levels with a `trusted` preset: everything except push without a card (P2-22, SPEC decision 49).

**Covered by automated checks instead of this manual run:** the real-SDK checks (`pnpm check:real`, P1-12 note §4), the console exit path (`exit-run.test.tsx`), the hierarchy `kill -9` drill (`brains/resume.test.ts`).

**For the next manual run (Phase 2.5 onwards):** a `kill -9` of the server mid-project with real agents and an observed resume; a resumed real Steward continuing from the restart notice; the console over the real WebSocket across the restart.
