# P2-13 — Closure, retention and archival (notes)

Built in a worktree branched from `p2-wave5-flows`, 2026-10-02, in parallel with P2-09, P2-11 and P2-12. The phase file, README, SPEC, TECHNOLOGY and PLAN were not edited (coordination rule). The texts below are ready to paste.

**No migration, no new event type, no protocol change.** The retention clock comes from the event log (see the decision below), so migration 0009 was not needed. The web reducer and the conformance walk are unchanged.

## What was built

| File | What |
|---|---|
| `apps/server/src/domain/retention.ts` (new) | `retained(log, retentionMs)` lists the finished, unpinned projects and standalone tasks the timer runs for, each with `since` and `dueAt`, sorted by `dueAt`. `sweepRetention(log, retentionMs)` archives everything due, each item in its own command as `{type:'system'}`. A domain refusal (an active sub-project) goes into `skipped` and is retried on the next sweep. Then it calls `sweepMarkers(retentionMs)`. It returns `{archived, skipped, markers}`. |
| `apps/server/src/domain/closure.ts` (new) | `ClosureRequest` (`project.meta.closureRequest = {by, summary, tasks, questionId?}`), `closureRequestOf`, and `withdrawClosureQuestion(ctx, projectId, reason)`. |
| `apps/server/src/runtime/archival.ts` (new) | `Archival` class: `sweep()`, `pending()`, `start(intervalMs, {immediate})`, `stop()`, `running`. Timers are injectable and unref'd. `ARCHIVAL_INTERVAL_MS` is 1 h. A sweep that throws goes to `onError` and the timer keeps ticking. |
| `apps/server/src/brains/harmonizer/closure-tools.ts` (new) | `CLOSURE_TOOLS`, described below. |
| `apps/server/src/brains/harmonizer/closure.test.ts` (new) | The end-to-end closure relay, using the harness. |
| `apps/server/src/domain/retention.test.ts`, `runtime/archival.test.ts` (new) | Fake-clock acceptance tests, plus tests for the timer and its composition. |

The Harmonizer's closure tools:
- **`ask_closure {projectId, summary?}`** (ends the turn): opens the user-held clarification "Anything else on <project>? <summary>" with the options `Close <project>` and `Something else: …`. It stores the question id in `meta.closureRequest.questionId`. It is idempotent while that question is still open.
- **`close_project {projectId}`**: `control.close` with the Harmonizer as `by`. Its description and the prompt allow it only on the user's word.
- **`finished_work {kind, id, action: archive|pin|unpin|reopen}`**: the panel's finished-work actions, done conversationally (decision 11b).

**Flow.** The Waykeeper calls `request_project_closure` (P2-10, unchanged). The Harmonizer is woken by the report and calls `ask_closure`. The user then closes the project in one of two ways:
- with `control.close` from the panel;
- or by answering "Close …", after which the Harmonizer calls `close_project`.

`Commands.control` stops the Waykeeper and the Stewards (P2-14's `agentEffect`). The project becomes `completed`, `closeProject` withdraws the still-open "anything else?" question, and the retention clock starts. The archival job archives the project after the retention period and frees its body (`body.freed`, which P2-09's un-parking reacts to).

**Reopen.** The project goes back to its old body if that body still holds it or is free. Otherwise it goes to `input.bodyId`. Without one, it now goes to the **catalogue's choice for its kind**: a planet for a planet, a moon for a moon, and for a sub-project a moon of its parent's planet. The old body's id is appended to `meta.previousBodyIds`, which is the link. Before this change the reopen was refused unless a body was named, and the panel's `control.reopen` cannot name one. The Harmonizer is woken by `control.reopen`, and the prompt tells it to `spawn_waykeeper`.

**Blocked closure (SPEC §3.2).** These already existed and are now covered by tests:
- close and archive-now are refused while a sub-project moon is active;
- the archival job skips such a planet (reported in `skipped`) and archives it on the sweep after the sub-project finishes.

A sub-project can become active again after its planet closed: a reopen does not check the parent's state.

## Shared files touched (all small and additive)

- `domain/projects.ts`:
  - `closeProject` calls `withdrawClosureQuestion`.
  - `reopenProject` gains an `opts: ChooseOptions` parameter and the catalogue fallback (new helper `reopenBody`), and records `meta.previousBodyIds`.
- `domain/projects.test.ts`: the "needs another body" test expects one more `project.updated` (the link) and no longer expects the refusal.
- `domain/commands.ts`: `reopenProject` passes `this.choose`.
- `domain/cascade.ts`: the doc comment of `retentionDue` points to `retention.ts`. The function itself is unchanged and is no longer used by the job.
- `brains/harmonizer/index.ts`: `harmonizerBrain` registers `CLOSURE_TOOLS` between its own tools and `SUPERVISOR_TOOLS`, and re-exports them.
- `brains/harmonizer/prompt.ts`: the "Closure" section, rewritten in 3 lines.
- `runtime/compose.ts`:
  - new option `archival?: {retentionMs?, intervalMs?, timers?}`;
  - `ComposedRuntime.archival`; the timer starts only with `intervalMs`;
  - the job is stopped in `shutdown` and `dispose`.
- `config/config.ts`: `retentionDays` in the file, `GALACTIC_RETENTION_DAYS`, `ServerConfig.retentionMs` (default 7 days, fractions allowed, must be > 0). Test added.
- `index.ts`: passes `archival: {retentionMs: config.retentionMs, intervalMs: ARCHIVAL_INTERVAL_MS}`.
- `test/harness.ts`, `apps/web/src/client/resume.test.ts`: `retentionMs` added to their literal `ServerConfig`.

## Decisions (ready to paste)

**SPEC §7, decision N — Retention clock, pin and reopen (2026-10-02, P2-13).**
> | N | Retention clock | **From the moment the work finished; a pin suspends it** (2026-10-02, P2-13): the retention period (decision 4, a setting, default 7 days) of a closed or cancelled project and of a finished standalone task counts from the moment it last *entered* a finished state — a later edit does not move it. A pinned item is never archived; unpinning starts a full period again (unpinning old work never archives it on the spot). An hourly job archives what is due (the body is freed) and clears "moved to …" markers with the same period; a planet whose sub-project moon is active again is skipped until that sub-project is finished. A project's tasks stay with it. Reopening puts the work back on its old body when that is free, else on the catalogue's choice for its kind (a sub-project: a moon of its parent's planet), keeping the old body in its history. |

**SPEC §7, decision N+1 — The closure relay (2026-10-02, P2-13).**
> | N+1 | Closure relay | **One question, answered by closing** (2026-10-02, P2-13): the Harmonizer relays a Waykeeper's closure request as one question to the user, "Anything else on <project>?", with the Waykeeper's summary and the choices "Close <project>" / "Something else". Answering "close" makes the Harmonizer close the project; asking for more becomes a work request for the project; closing from the panel withdraws the question. Closing stops the Waykeeper and its Stewards (transcripts kept) and starts the retention clock. |

**SPEC §2.7 (append to the closure bullet):** "The 'anything else?' question is withdrawn when the user closes the project from the panel (decision N+1)."

**TECHNOLOGY §6.2 (append):** "**Retention (P2-13).** The retention clock is derived from the event log, not stored: for a project or a standalone task it is the later of its last `*.state_changed` into `completed`/`failed` from a non-finished state and its last `*.updated{pinned: false}` (one `json_extract` query per kind over `events`). It falls back to `updatedAt` for a row created finished or a pruned log. `domain/retention.ts` (`retained`, `sweepRetention`) computes it. `runtime/archival.ts` runs it hourly from the composition, sweeping once at start, with injectable timers and the log's injectable clock. Archiving is the ordinary `archiveProject` / `archiveTask` by `{type:'system'}` (`*.state_changed` + `body.freed`), so no new event and no client fold exist. The period is `config.retentionMs` (`retentionDays` in `config.json` or `GALACTIC_RETENTION_DAYS`, default 7)."

**TECHNOLOGY §5 (Harmonizer tools, append):** "`ask_closure`, `close_project`, `finished_work` (archive / pin / unpin / reopen) — P2-13."

**TECHNOLOGY §8 / config (append):** "`retentionDays` (default 7)."

**Why from the log and not a `finishedAt` column.**
- A column needs a migration, a protocol field and a client fold. The log already holds the exact moment, and that moment is the source of truth the rows are projected from (TECHNOLOGY §6.1).
- Unpinning needs a second timestamp, which a single `finishedAt` cannot hold.
- It also avoids a migration-number gap: this branch would have needed `0009` on top of `0005`, and the runner refuses gaps.

The cost is a fallback to `updatedAt` once event pruning exists (not in v1), and the client cannot show a countdown without folding the same rule. If either becomes a problem, add a `retained_since` column, set by `setProjectState` / `setTaskState` and by unpinning, and folded alike.

## Deferred

- **Countdown in the UI.** `Archival.pending()` gives `{since, dueAt}` per item but no route exposes it yet. A settings or history view (Phase 3+) can expose it over REST.
- **Settings page.** The period is a config value only. No REST route or UI changes it at runtime.
- **The Harmonizer after a restart.** It does not re-ask closure requests recorded while it was down (`meta.closureRequest` without `questionId` on an unfinished project). P2-16 (resume) could seed it from the record.
- **Reopen.** A reopen leaves `meta.closureRequest` as it was; the next request overwrites it. Reopening a sub-project does not check that its planet is still open.
- **`finished_work` on tasks.** Archiving a project task through it works, but project tasks are not archived by the job; they follow their project's record.
- **Free asteroids** still accumulate after archival (P2-02's note): the scene should hide them.

## Tests

- `domain/retention.test.ts`, 14 tests with a fake clock:
  - archive after the period (not before), with the exact events;
  - an edit does not move the clock;
  - a cancelled project and a standalone task are archived; a running task is not;
  - pin suspends the timer; unpin restarts it; a pinned task is kept;
  - archive-now;
  - the period is a setting; markers are swept;
  - reopen on the same body, with the clock restarting on the re-close;
  - reopen an archived project on a free old body;
  - reopen on a new, linked body; a sub-project reopens on a moon of its planet;
  - a planet cannot be closed or archived with an active sub-project;
  - the job skips such a planet, then archives it.
- `runtime/archival.test.ts`, 3 tests: the job is off by default (manual sweep); it sweeps at start and on each tick and stops on dispose; errors go to `onError` and the timer keeps ticking.
- `brains/harmonizer/closure.test.ts`, 2 harness tests, both starting with the Waykeeper's `request_project_closure` and the Harmonizer's `ask_closure` (the question is user-held and linked):
  - the user closes from the panel: the Waykeeper is stopped, the project is `completed`, the question is withdrawn, and the body is freed after the retention period;
  - the user answers "Close CSV tool": the Harmonizer calls `close_project`, the Waykeeper is stopped and the project is `completed`.
- `config/config.test.ts`: the retention setting (default, file, environment, invalid value).

Totals: protocol 50, server 676 (+1 skipped), web 31.
