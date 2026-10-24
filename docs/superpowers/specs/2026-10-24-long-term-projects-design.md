# Long-term projects, moons as areas, and recurring jobs — design

Date: 2026-10-24 · Status: approved by Cosmin (2026-10-24)

First of three projects brainstormed together on 2026-10-23/24, built in this order:

1. **Long-term projects with moons and recurring jobs** — this document.
2. More AI providers (ChatGPT, Gemini next to Claude), chosen per job or task — separate design.
3. A configurable dashboard: building blocks (number tiles with week/month changes, tables,
   charts, diagrams, lists, plans, text) that the Waykeeper lays out from what Cosmin asks, fed by
   what the jobs report — separate design.

This document must leave room for 2 and 3 (a job has a provider; a run can report named
numbers), but builds neither.

## Intent

Cosmin has a new application that receives feedback messages. He wants GalacticAgents to look
after it over months, not only to build it: read the feedback regularly and suggest features,
improvements and replies; run marketing, sales, financial and feature-research routines; and keep
building new features in the same project and folder. Today every project is meant to finish and
close; nothing runs on a schedule.

His picture a month in: the app is a **big planet** with **moons** for feedback, marketing,
sales, financial analysis and feature research. Each moon holds **several recurring jobs** (the
marketing moon: periodic posts, trend analysis, post ideas, a campaign report with suggested
improvements). Feature work and one-off tasks still get Stewards on the planet, as today.

## What Cosmin decided

- **Long-term projects exist**, with a **purpose and long-term goals**. New features and tasks keep
  landing on the same project, in the same folder.
- **Usually decided at creation**; an existing project **can become long-term later**.
- **Big planet with moons.** Recurring work goes on the planet's moons; small and one-time tasks
  keep their Stewards on the planet "like before".
- **A moon is an area of the business with several recurring jobs**, each on its own schedule.
- **Jobs are generic.** Where the data lives (a database, an API, an email inbox) is the job's
  business, not GalacticAgents' — "this will not scale with different projects" otherwise.
- **Setting up a job: just ask the Waykeeper** ("I need a recurring job"); it asks for whatever is
  missing.
- **Every finding comes back to Cosmin as a question.** For a suggested feature or improvement he
  may have a ticket created, have it implemented, or drop it. For a drafted reply he may edit it
  and then tell the Steward to send it.
- **Missed runs run as soon as Mission Control is back** (the Mac was asleep, Mission Control off).
- **A failed run asks in the inbox; the job retries after Cosmin fixes the cause.**
- **He sees the jobs in two places — both:** a moon shows its own jobs; the Waykeeper's view gets a
  **Jobs** tab listing every moon's jobs, what needs him first. (Mockup:
  `.superpowers/brainstorm/71747-1792855799/content/recurring-jobs.html`, options A and B.)
- **Agent tokens are fine** — no new limit on what jobs spend in tokens.
- **Real money is different:** an action that spends real money (paying for an ad) is
  **explicitly asked for approval, marked differently from the other approvals**.
- **Providers are chosen per job or task, with a project default** (for cost and features;
  delivered by project 2 — until then every job runs on Claude).
- **Unattended permissions are granted with the job.** The job's confirmation card lists what each
  run may do without asking (e.g. "may call `api.myapp.com`", "may run `psql` against the read-only
  replica"). Cosmin approves them once with the job; every run gets exactly those rules on top of
  the project's policy, nothing more. Anything outside them still asks him (and, unattended, the
  run waits until its wall clock ends and counts as failed — see failed runs). Changing the list is
  a job change (one card). These rules never cover a money approval.
- **Credentials stay where they live today**: the project's environment (`.env`, the shell
  environment Mission Control starts agents with) and the tools' own logins (`gh`, `gcloud`, …).
  Never in a job's instructions, which are stored in SQLite and shown on cards. A dedicated secret
  store is out of scope.
- **A moon can hold several areas**, so a long-term project never runs out of room: when the
  planet's moons are all taken, a new area shares a moon, shown as a ring or label on it. Areas are
  spread over free moons first.
- **A big planet is Jupiter, Uranus or Saturn** (4 or more moons).

## Behaviour proposed by Claude and accepted in the playbacks

- A long-term project **never closes by itself**: the "anything else?" closure flow (decision 11)
  does not start because its tasks are all done; only Cosmin ends it.
- Each job gets the **project's purpose and goals** as context.
- A job **remembers its earlier runs**, so it does not re-suggest the same feature or re-draft a
  reply to a message already handled.
- **Runs that find nothing do not bother Cosmin**; findings come as questions with their actions.
- The **project's Waykeeper looks after the moons' jobs** too (sets them up, changes them, reads
  their results).
- Setting up a job ends with **one confirmation card**: name, moon, schedule, instructions,
  provider (decision 3: work requests are confirmed once).
- **Several missed runs become one catch-up run** covering the gap.
- A failed job **pauses** (no new runs pile up); when Cosmin answers that it is fixed, it retries at
  once, then returns to its schedule.
- **Changing or stopping a job** works the same way: tell the Waykeeper, confirm one card.
- **Converting** an ordinary project: ask in chat, confirm a card; it moves to a big planet if it is
  not on one (its satellites fly, decision 9).
- **The money approval** carries the amount and what it is for; it is **never decided by the
  project's rules or "Allow similar"** (decision 138), **never answered by a supervisor**, always
  reaches Cosmin. GalacticAgents cannot tell by itself that a command spends money: the job's
  instructions and the Steward's rules make it ask — the approval is the guard, not detection.
- In the scene a moon shows a **satellite only while one of its jobs runs**, like any working agent.

## Goals

- A long-term project lives on a big planet with a purpose, goals and area moons, and stays open.
- Recurring jobs run on schedule, catch up after downtime, pause on failure, and resume after a fix.
- Findings reach Cosmin as inbox questions with the actions above; nothing outward happens without
  him.
- Cosmin can see, per moon and per project, every job's schedule, last result, next run and
  history.
- Spending real money is always a distinct, explicit approval.

## Non-goals (this project)

- The configurable dashboard and week/month comparisons (project 3). A run may already record
  named numbers so project 3 can chart them, but nothing charts them here.
- Running jobs on ChatGPT or Gemini (project 2). The job's provider field exists; only Claude runs.
- Integrations with specific data sources (feedback APIs, CRMs, ad platforms).
- Detecting money-spending commands automatically.
- Jobs on standalone asteroids or ordinary (short) projects.

## Anti-goals (it fails even if it technically works when…)

- A job sends a reply, posts, or spends money without Cosmin's approval.
- A broken job keeps running and failing, or floods the inbox with one question per failed run.
- After downtime, a daily job fires a burst of runs for every missed day.
- Cosmin cannot tell what a job did, when it last ran, or when it runs next.
- A long-term project closes itself, or nags to close, because its current tasks are done.
- A money approval looks like an ordinary permission and is clicked through.

## Constraints (from the repo)

- Domain mutation + event insert in one transaction; projections over the event log; schema changes
  need a migration; speculative fields in `meta`. Types in `packages/protocol`.
- Decision 1 (finite planets, a hard cap) and decision 10 (moons host sub-projects or independent
  small projects): area moons are a **third kind of moon occupant**, owned by their planet's
  long-term project, and one moon may hold several areas of that project — record it as a new
  SPEC decision amending 10. Area moons never hold another project's work.
- Decision 11 (user closes projects): unchanged; long-term only removes the automatic "anything
  else?" prompt.
- Decision 14 (a git worktree per Steward): unchanged for tasks.
- Decision 7 / 138: permissions are the policy's or the user's, never an LLM's — the money approval
  extends this and must not be decidable by a rule.
- Hard caps (decision 18) apply to job runs like any Steward (wall clock, tool calls, concurrency,
  spawns); budgets (P8-01) apply as today.
- Restart = stop then auto-resume (SPEC §7); a run interrupted by a restart is a missed run.
- Phone (decisions 90, 140): the Jobs views must work in the one-screen phone layout.

## Calls Claude made (Cosmin can overrule)

- **A job run is a Steward run in the project's workspace folder, not a worktree.** Jobs mostly
  read and draft; work that changes the code goes through the "have it implemented" action, which
  creates an ordinary task with its own worktree (decision 14).
- **Job memory is a short run log the next run reads** (the previous runs' summaries and what
  Cosmin did with each finding), not the full transcripts — enough to avoid duplicates, cheap in
  tokens.
- **A finding is a question with fixed actions** (create ticket / implement / drop; for replies:
  edit then send / drop), raised by the run's Steward; "implement" becomes a task proposal on the
  planet through the Waykeeper, "create ticket" a task in the project left unstarted ("ticket" means
  a GalacticAgents task until a ticket integration exists — see open questions).
- **"Send" is performed by a follow-up run of the same job** with the approved text, so the sending
  uses the job's own access and instructions.
- **Schedules** are expressed in plain words in chat and stored as a recurrence (daily at a time,
  weekdays, weekly on given days, monthly on a date) in the Mac's local time zone.
- **One run of a job at a time**; a run still going when the next is due makes the next one wait,
  not overlap.
- **The money approval is a new question kind next to permission and clarification** (working
  name `spend`), shown with a distinct colour and a "$" badge, amount and purpose; the phone may
  answer it only under the same remote rules as permissions (decision 90).
- **The money approval applies to every agent**, not only job runs: any Steward (task or job)
  that is about to spend real money must ask with a `spend` question. Cosmin's rule named no
  exception.
- **Findings and spend requests outlive their run.** A run ends when its work is done; its
  findings and spend requests are items owned by the job and wait in the inbox for as long as
  Cosmin likes. They never hold a Steward alive and never block the next run ("one run at a time"
  counts runs, not open findings). An approved send or spend is carried out by a follow-up run of
  the same job, given the approved text or amount.
- **Finished runs do not wake the Waykeeper.** It reads runs through a tool when Cosmin asks, or
  when it needs them (setting up or changing a job). Only failures and findings reach Cosmin, in
  the inbox. This keeps a long-term Waykeeper's session from growing with every run for months.
- **Converting an existing project** moves it to a free big planet. If none is free it stays on its
  planet when that planet has moons (areas share them); a project on Mercury or Venus (no moons)
  cannot convert until a planet with moons is free, and the Harmonizer says so (decision 1: planets
  are finite).

## Open questions for later (add to SPEC §8)

- "Create a ticket": a GalacticAgents task, or an issue in an external tracker (Jira, GitHub
  Issues)? Assumed a GalacticAgents task for now.
- Can a moon hold an independent recurring job outside a long-term project (e.g. a recurring job on
  a standalone moon)? Assumed no.

## Left to the builder

- Data model: long-term flag and purpose/goals on the project; area moons; jobs (schedule,
  instructions, provider, state); runs (start, end, outcome, summary, findings, named numbers for
  project 3) — tables, events and migrations.
- The scheduler inside Mission Control (timers vs a periodic tick), catch-up computation on start,
  and how it interacts with restart/resume.
- The Waykeeper's tools (propose/update/pause/delete a job; read runs) and the run Steward's tools
  (report a finding, request a spend approval, report numbers).
- How a run's summary and findings are produced (the Steward's final report, structured).
- The visual design of the moon's job list and the Jobs tab within the mockup's layout, and the
  scene's area-moon look (including how a moon shared by several areas shows them).
- How the job's unattended rules are stored and applied to a run (reusing the policy table's rule
  shape, scoped to the job).
- Limits (jobs per moon, runs kept in history).
