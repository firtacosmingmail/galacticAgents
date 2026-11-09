# Phase 14 — "Allow similar" per reason

**Current task:** P14-08 · **Task status:** P14-08 in progress
**Phase status:** in progress (7/8) — branch `agent-allow-similar-reasons`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

The permission card's "Allow similar" chooser offered "exactly this" (never useful), withheld prefix and category outside the workspace (leaving only that), did not show which part of the call asked, and could not generalise network access by site. The chooser now shows the whole call with the asking parts marked, one ticked row per reason (a folder, a site, a command prefix, a category), allows the call once and remembers the ticked rows; a later call passes only when every reason it asks for is covered.

## References

- Spec (authority for this phase): `docs/superpowers/specs/2026-11-09-allow-similar-per-reason-design.md`.
- Plan: `docs/superpowers/plans/2026-11-09-allow-similar-per-reason.md` (Tasks 1–6).
- SPEC decisions 138 (rules, amended here) and 144; Phase 9 task P9-17 and Phase 13 (Waykeeper approvals) for the code it builds on: `apps/server/src/domain/permission-rules.ts`, `apps/web/src/panel/cards/AllowSimilar.tsx`.

## Design notes for implementation

The plan's Global Constraints bind every task. Branch flow: the phase branch is `agent-allow-similar-reasons`; commits are prefixed with the task id (`P14-nn: …`). To keep the repo compiling between tasks, Task 1 only adds optional fields; Task 4 makes them required and removes the old ones on the server, Task 5 on the web. Gates before asking to merge: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P14-01 | Protocol shapes and the phase board. |
| 2 | P14-02 | Structured findings in the permission engine. |
| 3 | P14-03 | Coverage — every asked reason must be covered. |
| 4 | P14-04 | Drafting rows and answering with ticks. |
| 5 | P14-05 | The chooser on the card, the rule list. |
| 6 | P14-06 | Docs, board, gates. |
| 7 | P14-07 | Final review fixes. |
| 8 | P14-08 | Residual permission holes. |

P14-01…08 run in order.

## Tasks

### P14-01 — Protocol shapes and the phase board
- **Status:** done (2026-11-09) · **Depends on:** — · **Parallel with:** —
- Plan Task 1: `folder`/`site` scopes, `host` match, folder `access`, per-reason `SimilarOption`/preview/body/input shapes (new fields optional until Tasks 4–5), `PermissionDecided.ruleIds`.
- **Acceptance:** the protocol schema tests pass (site and folder rules parse, empty `digests` fails, `ruleIds` and old `ruleId` parse); build and typecheck are green.

### P14-02 — Structured findings in the permission engine
- **Status:** done (2026-11-09) · **Depends on:** P14-01 · **Parallel with:** —
- Plan Task 2.
- **Acceptance:** the plan's Task 2 tests pass: the engine reports one finding per reason, with the shown part of the call.

### P14-03 — Coverage — every asked reason must be covered
- **Status:** done (2026-11-09) · **Depends on:** P14-02 · **Parallel with:** —
- Plan Task 3.
- **Acceptance:** the plan's Task 3 tests pass: a call passes only when every reason is covered; partial coverage asks about the rest.

### P14-04 — Drafting rows and answering with ticks
- **Status:** done (2026-11-09) · **Depends on:** P14-03 · **Parallel with:** —
- Plan Task 4.
- **Acceptance:** the plan's Task 4 tests pass: one row per reason, allow once and store the ticked rules, `ruleIds` on the event.

### P14-05 — The chooser on the card, the rule list
- **Status:** done (2026-11-09) · **Depends on:** P14-04 · **Parallel with:** —
- Plan Task 5.
- **Acceptance:** the plan's Task 5 tests pass: the card shows the call, a tick per row and the widen choices; the rule list shows folder and site rules.

### P14-06 — Docs, board, gates
- **Status:** done (2026-11-09) · **Depends on:** P14-05 · **Parallel with:** —
- Plan Task 6.
- **Acceptance:** SPEC decision 138 amended, TECHNOLOGY and the plan consistent, the full gates are green.

### P14-07 — Final review fixes (added 2026-11-09)
- **Status:** done (2026-11-09) · **Depends on:** P14-06 · **Parallel with:** —
- The whole-branch review's findings with the controller's rulings F-1, F-2 and M1–M5: a prefix or category rule covers nothing in a command that runs outside the workspace (a later segment after an outside `cd` included); a prefix assignment no longer makes a line folder-unsafe (except on `cd` and for the directory variables), `GH_TOKEN`/`GITHUB_TOKEN` on `gh` keeps its site, a line folder rules never cover gets no folder row; widen never offers system folders; the card offers the chooser for a push call's other reasons; drafting ignores reasons existing rules already cover; an attached short option's path (`-o/etc/x`) is a path.
- **Acceptance:** the rulings' tests pass; SPEC 138 and TECHNOLOGY updated; the full gates are green.

### P14-08 — Close the residual permission holes (added 2026-11-09)
- **Status:** in progress · **Depends on:** P14-07 · **Parallel with:** —
- Four holes left after P14-07: a prefix assignment keeps folder coverage only on an allow-list of inert variables (`GH_TOKEN`, `GITHUB_TOKEN`, `LANG`, `LC_*`, `TZ`, `NO_COLOR`, `CI`, `FORCE_COLOR`), so `GIT_EXTERNAL_DIFF=… git diff` in a folder asks; a leading assignment's value is a guarded-write candidate (`GIT_DIR=.git/hooks git status`); a short option with a value glued after clustered letters (`-ro/etc/x`, `-o$HOME/.zshrc`) yields a path; the precommand modifiers `noglob`, `nocorrect` and `-` are skipped to find a command's name (`noglob cd /tmp/x && rm -rf *` runs outside).
- **Acceptance:** the brief's tests pass (every listed prefix assignment asks under a folder rule, `LANG=C` and `GH_TOKEN=` stay covered; the four `GIT_*` paths are guarded; the four glued options are not allowed; `noglob cd` taints the later segments); SPEC 138 and TECHNOLOGY updated; the full gates are green.

## Exit criteria (verified 2026-11-09)

- Every task done (7/7).
- Full gates green: `pnpm build`, `typecheck`, `lint`, `format:check`, `test`.
- The card of a `cd /tmp/x; …` command offers a folder row and a `curl`/`gh` call a site row; a later call to the same folder or site passes without a card (covered by the P14-03/04 server tests and the P14-05 card tests).
- After the final review (P14-07): Cosmin's line `cd /tmp/pr83; git log …; GH_TOKEN=$(gh auth token) gh pr view 83 --json body` offers a folder row and a site row, and with both stored passes without a card; a folder rule plus a category never allow `rm -rf /tmp/pr83`.
