# P8-19 – P8-21 review (question sets)

Per-task reviews of the batch branch `p8-19-question-sets` (from `main` 45920fb), 2026-10-18, done
as the plan `docs/superpowers/plans/2026-10-18-question-sets.md` ran: one independent review per
task (spec compliance, then quality), a re-review after every fix round. P8-20 (Task 5) and the
P8-21 card (Task 6) ran in parallel worktrees branched from the batch branch and were merged back
into it; the merged branch passed every gate and `pnpm test` (server 1916, web 1908, protocol 147)
before Task 7 (this note, the end-to-end test, the docs and the board). No blocker in any task.

| Task | Ticket | Commits | Review | Fix rounds |
| --- | --- | --- | --- | --- |
| 1 Protocol | P8-19 | 156dcb0 | approved, minors | — |
| 2 Domain commands | P8-19 | 2f61e5c | approved, minors | — |
| 3 Routes and client | P8-19 | 348d6a4 | approved, minors | — |
| 4 Brain tools, wake lines, docs | P8-19 | 5c3922a, e0ffb46 | approved, minors | — |
| 5 Steward multi-question asks | P8-20 | b4d4faa, 9d22c75, 84a5cee | 1 Important | 1, all addressed |
| 6 The card | P8-21 | 1aba2a1, fbf3254 | 1 Important + product calls | 1, all addressed |
| 7 End to end, docs, board | P8-21 | this commit range | self-review | — |

## Checked and sound

- **A set is N ordinary rows sharing `context.set`**: routing, escalation, orphan reassignment,
  holders, versions and a Steward adapter's per-question `answer()` work unchanged; no migration
  (drafts are `question.drafted` folded into `meta.draft`). A fold-equality test pins the server
  rows to the protocol reducer.
- **Every check before any write**: a refused `openQuestionSet` / `answerQuestionSet` /
  `draftQuestion` / `dismissQuestionSet` leaves `seq` unchanged, asserted in every refusal test.
- **One delivery per answerer**: the user's send resolves every row they hold in one transaction (a
  partial send is `invalid`); the log publishes a commit synchronously and the runner drains on
  `setImmediate`, so the asker gets one turn — `runner.test.ts` and `common-tools.test.ts`; the
  end-to-end test shows it in a real Waykeeper brain's turn prompt.
- **Supervisor first** (Cosmin's option B): `answer_question_set` answers the rows the brain holds
  and escalates the rest it holds in the same transaction; set rows refuse every single-question
  path ("part of set …: answer or dismiss the set"), and the brain tools name
  `answer_question_set`. A chat reply to a set row quotes it and never answers it (send route
  guard, `reply-routes.test.ts`).
- **Permissions never enter a set**: refused in the domain; the adapters only open clarification
  sets; an invalid set ref from an adapter opens a plain question instead of hanging the agent.
- **Steward sets** (P8-20): the Agent SDK and ACP adapters open every row at once, hold the Steward
  until all are resolved, refuse the whole call on a dismissal and withdraw every row on an
  interrupt (the conformance case answers one row first).
- **The card** (P8-21): pure model + stateful card + presentational parts; reuses the protocol's
  helpers (no redeclared types); the stale race, the offline queue (same `answerId` on retry,
  duplicate = sent), two devices and resume are tested against the real store and stream; axe
  clean on a page and on the review.
- **Boundaries**: nothing outside `apps/server/src/adapters` imports a runtime SDK; every new type
  is in `packages/protocol` (`question-set.ts`, the harness bodies in `dev.ts`).

## Findings fixed in the batch

- **Task 5 — Important: an ACP set's skipped typed field was asked again alone.** A boolean or
  number field answered `(skipped by the user)` (or a supervisor's "yes — note") failed the field's
  parse, so the adapter re-asked it on its own after the set. Fixed (84a5cee): a skip is left out
  of the content before parsing, "choice — text" is read by its choice, an answer that still does
  not read is left out with a transcript line, never re-asked one by one; tests for both. Also in
  that round: the interrupt conformance case answers one row first; TECHNOLOGY §3.2 explains the
  ACP "Other" box; the SDK adapter's doc comment says it relies on whole-set dismissal.
- **Task 6 — Important: answers given offline never became drafts after reconnecting** (the
  design's anti-goal "Cosmin loses answers already given"). Fixed (fbf3254): when the stream goes
  from offline to live, every edited, open, user-held row whose value differs from the server's is
  saved; test.
- **Task 6 — the Steward view and the consoles rendered set rows as single cards** that the server
  refuses (bites once P8-20's Steward sets exist). Folded into the fix round rather than a new task:
  one `QuestionSetCard` per set in `StewardPanelView` and the hierarchy console; the flat
  `AgentsConsole` (no `ApiContext`) shows set rows read-only, pointing to the inbox; tests.
- **Task 6 — viewing a row could overwrite another device's draft** (re-graded from Minor: lost
  answers). Fixed: a per-row dirty flag; only rows edited on this device are saved; another
  device's draft replaces a row unless it is shown and edited here.
- **Task 6 — product calls taken conservatively** (recorded as Claude's calls in decision 141):
  × on a set asks one confirmation (up to ten rows and their drafts go at once); Skip keeps the
  typed text in the draft (the skip wins on send); a thread test guards the hidden Reply.
- **Task 4 — decision 141 presented builder choices as Cosmin's** (the 2–10 / ≤ 8 limits, the
  "(skipped by the user)" text, the " — " format). Fixed in Task 7: moved under Claude's calls with
  the other builder choices.
- **Task 2 — the chat Reply path** would have refused a whole reply quoting a set row; carried into
  Task 3, which guards it in the send route (tested).

## Deferred minors (not fixed; none changes behaviour a user relies on)

- Protocol: `withoutDraft` sits between `patch`'s doc comment and `patch` (`world.ts`); no size
  caps on `SetAnswer.choices` / `text` and `AnswerSetBody.answers` beyond the domain's checks;
  missing reducer tests (answered with `answerId` + `detail`; cancel without `by` while drafted).
- Domain: an agent's retry of `answers: []` with the same `answerId` is refused `conflict`, not a
  duplicate (`commands.ts`); a user send that resolves nothing succeeds silently; no test of a
  partial adapter send followed by a retry recording the missing rows; a dead `by.id ? … : 'you'`
  branch; no 121-character title test; the permission-kind guard lacks a comment.
- Routes: the draft route maps every `conflict` (also "already answered") to 400, not 409; a no-op
  `answers.map`; protocol import order; no tests for a retry without `answerId`, an agent-peer
  dismiss (403) or the three client wrappers.
- Brains: the runner's one-turn test relies on a 30 ms wait and uses a generic brain, not a
  Waykeeper; `answer_question_set` recomputes the passed-up rows instead of the command returning
  them.
- Adapters: `openFromNeedsInput`'s sibling lookup scans every question and does not check that a
  sibling's `total` / `title` match.
- Card: "via <supervisor>" is inferred from versions and the supervisor chain (wrong after a dead
  level was skipped or a row was reassigned; a durable fix records the route on escalation); a set
  split between the user and a supervisor appears in both inbox groups; stored queue entries are
  validated shallowly; one doc line over the wrap width; the console `StewardView` hides its
  "Read-only" line while a set row is open.

## Task 7 (end to end, docs, board)

- `e2e/tests/12-question-sets.spec.ts`, at desktop size and at 390×844 (`isMobile`, `hasTouch`): a
  real Waykeeper brain on the fake runtime asks three questions with `ask_questions`; the Harmonizer
  answers the first with `answer_question_set`, passing two up; the card reads "Waykeeper · <title>"
  "via Harmonizer" with two pages; one is answered (multi-select), the page reloads (the draft is
  read back from the server's `question.drafted` and the card resumes on the unanswered page with
  the choices still pressed), the other is skipped; the review shows the Harmonizer's answer
  read-only; "Send 1 answer"; the server has "date, amount" and "(skipped by the user)" by the
  user; the Waykeeper's transcript (the fake runtime echoes each turn's prompt) has the
  Harmonizer's answer in one turn and both of the user's answers in one later turn.
- The fake runtime never chooses a tool, and the scene harness's agents have no process, so a
  **dev-only harness addition** drives it: `runtime/harness-brains.ts` with
  `POST /dev/harness/brains/waykeeper` (a new prepared project with a real Waykeeper brain on the
  fake runtime under the running Harmonizer) and `POST /dev/harness/brains/:id/tool` (a running
  brain calls one of its tools as its model would, through the new `BrainRunner.callTool` — same
  handler, context and turn rules). Only fake-runtime brains are driven (`invalid` otherwise); the
  routes sit behind the dev routes' token and local-only guards. Unit tests in
  `harness-brains.test.ts`. The project it creates is not `meta.harness` (a real brain runs it), so
  the harness's Clear does not archive it — fine for the e2e server, which is thrown away.
- Open questions are not in `/api/history/questions` (answered and cancelled only), so the test
  reads the draft from `/dev/events`.

## Open items

- **The real Claude `askSet` conformance prompt has not been run** (`GALACTIC_REAL_CLAUDE=1`,
  local only): check that the model sends two questions in one `AskUserQuestion` call and that its
  "Other" wording does not break `fitsQuestionSet`. Cosmin to run it once.
- **The scene's beacons and the managed-agents cards still count a set per row** (the inbox, the
  top bar and the status counts count it once): follow-up **P8-22**.
- Product calls Cosmin may overrule (decision 141, Claude's calls): the × confirmation, "via"
  inferred, Skip keeping the typed text, offline drafts saved on reconnect, the limits and formats.
