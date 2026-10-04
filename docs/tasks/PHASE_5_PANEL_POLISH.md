# Phase 5 — Side panel polish and scene integration

**Current task:** P5-05 (closes when P5-06 and P5-07 land), P5-06 (wave 3, branch `p5-wave3-conformance`) · **Task status:** in progress
**Phase status:** in progress (5/7 done) — on branch `phase-5`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

The Phase 2.5 panel becomes the spec's panel, wired to the scene: selection flows both ways, status views and history exist, and the panel works with and without the scene.

## Entry criteria

- Phase 4 exit criteria met.

## References

- `IMPLEMENTATION_PLAN.md` → Phase 5.
- `SPEC.md` §4.2 (panel), §4.3 (requests), §4.4 (states).
- `TECHNOLOGY.md` §4 (status views without LLM calls).

## Design notes for implementation

- Selection is one shared store: scene picks and panel navigation both write it.
- Status views are computed from projections (P2-15) — no LLM call for the basic view; the Harmonizer's narrative status is a separate, optional request.
- History includes archived bodies, moved links, and every question (including supervisor-answered ones).

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 (parallel) | P5-01, P5-02, P5-03 | Independent panel features. |
| 2 | P5-04 | Accessibility and list-mode toggle after features exist. |
| 3 | P5-05 | Spec conformance checklist last. |

## Tasks

### P5-01 — Bidirectional selection and Earth = Harmonizer
- **Status:** done (2026-10-04) · **Depends on:** P3-05, P25-02 · **Parallel with:** P5-02, P5-03
- Scene pick ↔ panel selection in both directions with camera fly-to on panel selection; clicking Earth or deselecting returns to the Harmonizer chat; selecting a satellite selects that agent.
- **Acceptance:** every selection path in `SPEC.md` §4.1–4.2 works in both directions.

### P5-02 — Status views
- **Status:** done (2026-10-04) · **Depends on:** P2-15, P25-02 · **Parallel with:** P5-01, P5-03
- System / project / task / agent summary views from the derived states (counts, blocked items first, cost totals, open questions); "blocked on user" is the loudest everywhere; optional "ask the Harmonizer for a narrative status" button.
- **Acceptance:** "ask for the status of anything" (SPEC §4.3) is answerable without an LLM call.

### P5-03 — History view
- **Status:** done (2026-10-04) · **Depends on:** P2-13, P25-01 · **Parallel with:** P5-01, P5-02
- Archived projects/tasks with their bodies, moved-to links, closure dates; past questions with kind, holder chain and who answered; search/filter; reopen from history.
- **Acceptance:** an archived project can be found, inspected and reopened.

### P5-04 — Keyboard, accessibility and list mode
- **Status:** done (2026-10-04) · **Depends on:** P5-01, P5-02, P5-03 · **Parallel with:** —
- Keyboard navigation of lists and cards, focus management, ARIA on cards and inbox, reduced-motion preference respected; scene hide/show toggle keeps the panel fully functional (list mode).
- **Acceptance:** panel usable with keyboard only and with the scene hidden.

### P5-05 — Spec §4.2/§4.3 conformance checklist
- **Status:** in progress · **Depends on:** P5-04 · **Parallel with:** —
- Walk every line of `SPEC.md` §4.2 and §4.3 with and without the scene; record gaps in `docs/tasks/notes/P5-05-checklist.md` and fix them or file follow-ups.
- **Acceptance:** checklist fully ticked and committed.

### P5-06 — Controls for the Harmonizer (added 2026-10-04)
- **Status:** in progress · **Depends on:** P5-05 · **Parallel with:** P5-07
- From P5-05's checklist (row §4.2.42h) and Cosmin's choice (decision 82): the Harmonizer's dock offers Pause, Resume and a confirmed "Restart Harmonizer" (stop + a fresh one on the same runtime, seeded from the database), never a plain Stop; "Resume session" only for an interrupted Harmonizer.
- **Acceptance:** each control works from the dock with and without the scene; a restart leaves exactly one live Harmonizer and the user informed; tests; the conformance row §4.2.42h ticked.

### P5-07 — Work controls in conversation (added 2026-10-04)
- **Status:** done (2026-10-04) · **Depends on:** P5-05 · **Parallel with:** P5-06
- From P5-05's follow-up F1 and Cosmin's choice (decision 83): a Harmonizer `control_work` tool — pause, resume and edit at once; stop and cancel only after a confirmed `ask_confirmation`; trust level excluded.
- **Acceptance:** brain-harness tests for each action and the confirmation gate (refused without it); the conformance row §4.3.25 ticked.

## Exit criteria (from the plan)

Everything in `SPEC.md` §4.2 and §4.3 is doable from the panel, with and without the scene.
