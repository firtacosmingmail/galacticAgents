# Phase 10 review (P10-01 – P10-08)

Reviews of the batch branch `p10-1-long-term-projects` (cut from `phase-10`), task by task
(plan Tasks 1–14), 2026-10-24 – 2026-10-27 — Cosmin's long-term projects, area moons, recurring
jobs and real-money approvals (SPEC decisions 142–145). Each task had a review; every Important
finding was fixed on the branch and re-reviewed clean. The batch's final review is the
coordinator's, after P10-08.

## Fixed

- **Conversion and closure (P10-02).** Converting a project in the middle of the "anything else?"
  flow left the flow alive; conversion now withdraws the closure question and `ask_closure`
  refuses a long-term project.
- **Reopening a long-term project (P10-03).** Its areas and job tasks pointed at moons freed on
  close, maybe taken since; a reopen now takes moons again (`retakeAreaMoons`) and a stale area
  is refused.
- **Failure question without a Waykeeper (P10-04).** A failed run asked nothing when the project
  had no Waykeeper row; it now asks through the Harmonizer.
- **Spend answers from the phone (P10-05).** The first build refused remote spend answers
  outright, stricter than the permission rule the design asked for; spend answers now follow
  decision 90 exactly (ledger ruling R7).
- **The scheduler (P10-04).** A run the user stopped was run again at once (ruling R9: it keeps
  its schedule now); a catch-up after an interrupted run covered the wrong span; an interrupted
  follow-up run moved the schedule.
- **Parked long-term cards (P10-06).** They offered downsizes that always failed; they offer
  only closing a completed project early now. Job cards preview their moon (ruling R10).
- **Spend notifications (P10-07).** A spend's OS notification read "A question for you"; it reads
  "Spend approval needed" with the amount and purpose (ruling R11: kind `permission`).

## Left open (minor, deferred)

- A user's stop on a follow-up run drops its approved send or spend (SPEC §8).
- A user's pause then resume of a job runs it at once (the opposite pull to ruling R9).
- A failed long-term project reopened onto another planet keeps its areas on the old planet's
  moons when its moons are taken; the reopen is refused when no moon is left.
- `job_runs` are not exported: an import restarts each job's run history (TECHNOLOGY §10.1).
- `attachJobRunAgent`, `reportJobRun` and the 200-run pruning write no event (run rows are not
  log-derived; TECHNOLOGY §10.1).
- The cap refusal of a job spawn is recognised by its error text, not a typed code; a `retry`
  label shows when a job is reactivated through `setJobState`.
- "Create a ticket" files a `proposed` task that has no approve path of its own yet (SPEC §8).
- The finding card's reply box is seeded once (stale if the same finding is asked again); the
  `RejectForm` import cycle `JobCard` ↔ `ProposalCard`; the instructions' collapse counts
  newlines only.
- The scene label's `fullTitle` ("· n jobs") is computed but not rendered; the "n areas" badge is
  in the DOM label, not the 3D marker; clicking an area moon stores the Jobs view as the dock's
  choice.
- The Jobs view's "needs you" dot recomputes the model on every world change; a stopped job's
  0.6 opacity has not been checked for contrast.
- On a phone, an area moon's label over a ringed planet (Saturn) is only partly tappable: the
  planet's rings, or a satellite near the label, take taps on part of it (seen in e2e 13).
- A DST fall-back test depends on the machine's zone (verified by hand in Europe/Berlin).
- The ESM import cycle `questions.ts` ↔ `findings.ts` (function-level use only).
- Several tasks wrote the implementation before the tests and showed RED by reverting it.

## End to end (P10-08)

`e2e/tests/13-recurring-jobs.spec.ts`: the whole flow on the fake runtime through the dev
harness (`/dev/harness/brains/harmonizer`, `/dev/harness/jobs/:id/run`, `/dev/harness/jobs/tick`),
plus the phone checks at 390 px. On a phone an area moon may start behind its planet or out of
the small scene, and a ringed planet takes taps near it, so the test turns the camera until the
moon's label shows, waits for it to rest, and taps the label away from the planet.
