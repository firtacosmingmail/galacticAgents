# P5-07 — Work controls in conversation

From P5-05's follow-up F1 and Cosmin's choice (SPEC decision 83). The Harmonizer can now pause, resume, stop, cancel and edit a task or a project the user names in conversation, through the same `DomainCommands.control` command the panel's `POST /api/control` calls.

## What was built

- **`control_work`** (`apps/server/src/brains/harmonizer/control-tools.ts`), registered in `harmonizerBrain` after the closure tools.
  - Input: `{target: {kind: 'task' | 'project', id}, action: 'pause' | 'resume' | 'stop' | 'cancel' | 'edit', changes?, questionId?}`, parsed with zod (strict: an unknown key, an agent target or another action such as `close` is refused as `invalid`).
  - **Pause, resume, edit** run at once.
  - **Stop, cancel** run only with the `questionId` of an `ask_confirmation` question that this Harmonizer asked for exactly that action and target, answered by the user with its first choice (or yes). This is decision 42's check, `checkUserAgreed` in `closure-tools.ts`, now exported. Without such an answer the tool error says to ask first.
  - **One answer, one call.** The answer is used up in the control's own transaction: `control(..., {confirmation: questionId})` marks the question row's `meta.usedFor` ("stop task t-1") and records the control in one `runCommand` (`consumeConfirmation`, `domain/questions.ts`). The same answer is refused on a second call ("already used … ask_confirmation again"), also when two calls race; a control the domain refuses rolls the mark back, so the answer stays valid. (Wave-3 review: the first version wrote `meta.usedConfirmations` on the target in a second transaction after the control — two parallel calls both passed, and a crash between them left the answer reusable.)
  - **Edit** takes a task's `description` and/or `priority` (`TaskPriority`) or a project's `name`. These are the panel's edit fields minus the trust level. `permissionPolicy`, `trustLevel`, `policy`, `trust`, `preset` and `autoApproveRemote` are refused with a decision-49 message ("tell the user to change it on the project's edit form"). Any other field is refused too, as are empty changes and `changes` given with another action. The domain's `taskEdit` / `projectEdit` check the edit again.
  - **Scene-harness rows** (`meta.harness`, decision 79) are refused.
  - The control is recorded with the Harmonizer as `by`. Its write options carry the turn's origin, and supervisors are woken by `concernedSupervisors`, exactly as for a panel action.
- **`ask_confirmation`** accepts `stop` and `cancel`. The choice offered first reads `Stop <task "…" (id) | project> (its agents stop)` or `Cancel … (it fails, its agents stop)`.
- **The turn's origin for tools** (P2-21's seam, deferred until now): `BrainToolContext.origin` is `originOfMessages` over the `message.sent` events folded into the current turn. It is `local` only when every message is a local user's; otherwise it is `remote` or absent (unknown, floored). The runner sets it in `toolContext()`. `control_work` passes it as `control(..., { origin })`. No `control_work` edit writes a policy today, so the origin is defence in depth.
- **Prompt:** a "Work controls" section tells the Harmonizer when to use `control_work`: for work the user names, and `pause_agent` etc. only for agents. It also says to confirm stop and cancel first with `ask_confirmation`, that one answer allows one call, and that the trust level is never its to change.

## Tests

`apps/server/src/brains/harmonizer/control-work.test.ts` uses the brain harness with the real Harmonizer definition and a scripted model. It has 8 tests:

- **Pause, resume and edit at once.** Pause, resume and a task edit (description and priority) run on a project task, plus a project rename. The Steward is paused and resumed, and the rows are updated. The Waykeeper brain's prompts carry "paused task …", "resumed task …" and "edited project …" (supervisors woken as for a panel action). The work-level `control.*` events show the Harmonizer as `by`. No question is asked.
- **Stop and cancel.** Both are refused without a confirmation. A stop is accepted after a confirmed `ask_confirmation`: the task is `paused`, its Steward `stopped`, and the answer is recorded as used on the question (no `task.updated`). A second stop with the same answer is refused. A cancel after its own confirmation is accepted and the task is `failed`. A stop of the failed task, confirmed, is refused by the domain and leaves its answer unused.
- **Two calls at once** with one answer (the handler called twice in parallel): exactly one goes through, the other is refused "already used".
- **Nothing else unlocks a stop.** These do not: a confirmation for another action (cancel, pin), for another task, an answer "No", or a question another agent asked that the user answered "yes".
- **Refused edits.** The trust level (`permissionPolicy`, `trustLevel`), a task `name`, an invalid priority, a project `description`, a blank name, an edit without changes, changes with pause, the `close` action, an agent target and an unknown id are all refused. Nothing changed and no control was logged.
- **Harness rows** (task and project) are refused.
- **The runner's origin:** `local`, `remote` and unknown for a message without one.
- **The handler's call:** `control_work` passes the Harmonizer as actor and the turn's origin to `control` (unit test with a stub context).

## Decisions

- **Consumption lives on the question's row** (`meta.usedFor`), written in the control's transaction (`ControlOptions.confirmation` in `packages/protocol`); the control event is the event of that command, so the work's history gets no extra `task.updated` / `project.updated`. Close and `finished_work` keep their earlier rule (not consumed): they are not repeatable in a harmful way, because their state transitions refuse a second run.
- **The answer is used up after the control, not before.** A control the domain refuses (for example a cancel while a sub-project is active) leaves the user's answer valid for a retry.
- **The trust-level list is broader than `permissionPolicy`.** Names a model might invent (`trustLevel`, `policy`, …) get the decision-49 message instead of a generic "unknown field".
- **Closing a project task** stays the Waykeeper's (decision 11). Decision 83 does not add it; the control map lists it as "by design".

## Shared files touched

- `apps/server/src/brains/definition.ts`: `BrainToolContext.origin?`.
- `apps/server/src/brains/runner.ts`: `toolContext()` computes the origin.
- `apps/server/src/brains/harmonizer/index.ts`: registration and re-exports only, not the start code.
- `apps/server/src/brains/harmonizer/closure-tools.ts`: exports `checkUserAgreed`, `labelOf` and `CONFIRMED_CONTROLS`; `ask_confirmation` takes stop and cancel.
- `apps/server/src/brains/harmonizer/prompt.ts`.
- `docs/TECHNOLOGY.md` §5.3: the Harmonizer tools row and the conversational control map.
- `docs/tasks/notes/P5-05-checklist.md`: row §4.3.25 is now ✓ in both modes, and the control map rows are updated. The checklist's summary line ("75 ✓, 1 ✗, 1 partial") was left for the coordinator, since P5-06 changes §4.2.42h in parallel. With both tasks merged it should read 77 ✓.
