# GalacticAgents — Task board

Local, file-based task management. One file per phase; each phase file lists its purpose, references, design notes, an execution order (waves that can run in parallel) and the tasks with status, dependencies and acceptance criteria. The ticket flow is in `/CLAUDE.md`.

## Phase overview

| Phase | File | Status | Tasks | Current task |
|---|---|---|---|---|
| 0 — Foundations | `PHASE_0_FOUNDATIONS.md` | done (2026-09-30) | 18/18 | — |
| 1 — Agent runtime and adapters | `PHASE_1_AGENT_RUNTIME.md` | done (2026-10-01) | 38/38 | — |
| 2 — Hierarchy | `PHASE_2_HIERARCHY.md` | in progress (branch `phase-2`) | 0/19 | P2-01 (in progress) |
| 2.5 — Minimal side panel | `PHASE_2.5_MINIMAL_PANEL.md` | not started | 0/9 | — |
| 3 — Solar system scene | `PHASE_3_SOLAR_SYSTEM_SCENE.md` | not started | 0/8 | — |
| 4 — Living overlays | `PHASE_4_LIVING_OVERLAYS.md` | not started | 0/7 | — |
| 5 — Panel polish and scene integration | `PHASE_5_PANEL_POLISH.md` | not started | 0/5 | — |
| 6 — Planet zoom and structure | `PHASE_6_PLANET_ZOOM.md` | not started | 0/5 | — |
| 7 — Remote and mobile access | `PHASE_7_REMOTE_MOBILE.md` | not started | 0/6 | — |
| 8 — Hardening (ongoing) | `PHASE_8_HARDENING.md` | not started | 0/8 | — |

Phases run in order 0 → 1 → 2 → 2.5 → 3 → 4 → 5 → 6 → 7; Phase 8 tasks are picked whenever their dependencies are met. Phase 7 depends on Phase 5, not on Phase 6.

Keep this table in sync with the header lines of each phase file whenever a task changes status.

## Task IDs

`P<phase>-<nn>` (Phase 2.5 uses `P25-nn`). IDs are stable; never renumber. New tasks discovered during implementation are appended to the phase file with the next free number and a "(added <date>)" note.

## Task statuses

`todo` → `in progress` → `done (<date>)`, plus `blocked (<reason>)` and `dropped (<reason>)`.

## Notes

Run logs, spike findings and checklists referenced by tasks live in `docs/tasks/notes/<task-id>-<slug>.md`.
