# Phase 15 — Project dashboard

**Current task:** P15-03 · **Task status:** P15-03 in progress
**Phase status:** in progress (2/10)

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

Every long-term project gets one dashboard owned by its Waykeeper: panels (tiles, charts, tables, lists, calendars, status boards, text) fed by the runs of the project's jobs or by its own tasks, with limits that mark values very bad or very good, refresh, arrange mode, a phone layout and a job map.

## References

- Design (authority for this phase): `docs/superpowers/specs/2026-11-11-project-dashboard-design.md`.
- Plan: `docs/superpowers/plans/2026-11-11-project-dashboard.md` (Global Constraints, Tasks 1–10).
- Code precedents: Phase 10 jobs (`packages/protocol/src/long-term.ts`, `events.ts`, `world.ts`, `apps/server/src/db/tables.ts`, migration 0016).

## Design notes for implementation

The plan's Global Constraints bind every task. Branch flow: the phase branch is `agent-project-dashboard`; commits are prefixed with the task id (`P15-nn: …`). Gates before asking to merge: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P15-01 | Protocol, storage and world fold (plan Task 1). |
| 2 | P15-02 | Runs report data and record their sources (Task 2). |
| 3 | P15-03 | Panel commands and the combined panel card (Task 3). |
| 4 | P15-04 | Dashboard data, evaluation and refresh (Task 4). |
| 5 | P15-05 | Waykeeper tools and prompt (Task 5). |
| 6 | P15-06 | Dashboard view on the Mac (Task 6). |
| 7 | P15-07 | Arrange mode (Task 7). |
| 8 | P15-08 | Phone layout and the cards (Task 8). |
| 9 | P15-09 | Job map (Task 9). |
| 10 | P15-10 | Docs, task board and the real run (Task 10). |

All run in order, one wave each. Tasks 6–9 all touch the dashboard pane, so none run in parallel.

## Tasks

### P15-01 — Protocol, storage and world fold
- **Status:** done (2026-11-11) · **Depends on:** — · **Parallel with:** —
- Plan Task 1.

### P15-02 — Runs report data
- **Status:** done (2026-11-11) · **Depends on:** P15-01 · **Parallel with:** —
- Plan Task 2.

### P15-03 — Panel commands and card
- **Status:** in progress · **Depends on:** P15-02 · **Parallel with:** —
- Plan Task 3.

### P15-04 — Dashboard data, evaluation and refresh
- **Status:** todo · **Depends on:** P15-03 · **Parallel with:** —
- Plan Task 4.

### P15-05 — Waykeeper tools and prompt
- **Status:** todo · **Depends on:** P15-04 · **Parallel with:** —
- Plan Task 5.

### P15-06 — Dashboard view on the Mac
- **Status:** todo · **Depends on:** P15-05 · **Parallel with:** —
- Plan Task 6.

### P15-07 — Arrange mode
- **Status:** todo · **Depends on:** P15-06 · **Parallel with:** —
- Plan Task 7.

### P15-08 — Phone layout and cards
- **Status:** todo · **Depends on:** P15-07 · **Parallel with:** —
- Plan Task 8.

### P15-09 — Job map
- **Status:** todo · **Depends on:** P15-08 · **Parallel with:** —
- Plan Task 9.

### P15-10 — Docs and real run
- **Status:** todo · **Depends on:** P15-09 · **Parallel with:** —
- Plan Task 10.
