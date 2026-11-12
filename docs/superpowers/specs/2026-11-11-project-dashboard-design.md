# Project dashboard — design

Date: 2026-11-11 · Status: draft for Cosmin's approval

Third of the three projects brainstormed on 2026-10-23/24 (see
`2026-10-24-long-term-projects-design.md`): 1. long-term projects with area moons and recurring jobs
(Phase 10, done), 2. more AI providers (Phase 11, done), 3. **this dashboard**.

## Intent

Cosmin runs his apps as long-term projects: recurring jobs read feedback, check marketing, sales and
money, and report. Today what they find arrives as inbox questions and run summaries; there is no
single place that shows **how the app is doing**. He wants one dashboard per long-term project that
he can glance at on the Mac or the phone and immediately see what matters.

What goes on it differs from app to app — installs, live users and churn for a mobile app; visits
and accounts for a web app; money; which marketing platform and strategy perform better, what is
being tested and what it costs; feedback, emails, comments and reviews; the state of feature work
(possibly from Linear). So GalacticAgents does **not** ship a dashboard per kind of app: it ships a
fixed set of **panel types**, and Cosmin tells the Waykeeper what to show, where to get it and how to
show it. The Waykeeper remembers that and keeps the panels filled.

The mockups Cosmin reacted to are in
`.superpowers/brainstorm/43929-1794390238/content/` (`dashboard-idea.html`,
`arrange-and-mobile.html`, option A chosen; `job-map.html`, option A chosen).

## What Cosmin decided

- **One dashboard per long-term project**, owned by its Waykeeper. No cross-project dashboard.
- **A fixed set of panel types**: number tiles with a change versus last week/month, line and bar
  charts (and other common charts), tables, lists, calendars, a status board, plain text.
- **Panels are defined by talking** to the Waykeeper: what to show, how to get it, how to display it.
  The Waykeeper remembers each panel and keeps it populated.
- **Data is collected on a schedule by recurring jobs** (Phase 10), not fetched when he looks. Each
  panel has a **refresh** button.
- **He can arrange the panels himself**: move, resize, hide.
- **Phone: it follows the Mac's order** (option A): number tiles become a swipeable strip at the
  top; every other panel is one full-width card in the Mac's order, the first ones open and the rest
  folded to a title line he taps. It must be productive on the phone, not a shrunken desktop.
- **One combined card per panel request.** When Cosmin asks for a panel, the Waykeeper proposes one
  card that shows the panel and, when needed, the job side:
  - **An already working job can feed it:** the card says which job ("filled by job 'Usage', which
    already reports `churn_30d`") and no job is created or changed.
  - **An existing job must report something new:** the card shows that job change (what the job
    must report, under fixed names) next to the panel.
  - **No job collects this data yet:** the card proposes the new job together with the panel.

  Cosmin can ask for changes to either part — the panel or the job — before confirming; the
  Waykeeper then re-proposes the card. One confirmation covers both. The job part keeps the job
  card's rules (decision 144): if it widens what the job may do, the card can be confirmed only on
  the Mac, and it counts as the job's one waiting card.
- **He can clear a panel's history** (see the calls below for how).
- **Job details as a pipeline map** (option A in `job-map.html`): a job's details show, left to
  right, four columns — **gathers from** (sources: MCP servers, sites, files, databases) →
  **collects** (the values and rows it takes from each source) → **processes** (how they are
  computed, e.g. the churn formula) → **shown in** (the panels it feeds, each a link that jumps to
  that panel on the dashboard). Hovering or tapping an item highlights everything that depends on
  it. A source that failed on the last run is marked red with what went wrong. Above the map: last
  run (time, result, duration), next run, schedule. On the phone the columns stack top to bottom.
- **Very bad values are strongly red; very good values are green with fireworks.**
- **Anti-goal in his words:** he would stop opening it if it had too much data and gave him nothing
  important to see.

## Behaviour proposed by Claude and accepted in the playbacks

- A panel shows **where its data comes from and how old it is** (a small line: "from job 'Usage' ·
  1 h ago").
- **Every run's values are kept**, so charts have history and tiles compare with last week/month.
- **Refresh runs the panel's job now**; if that job is already running, it waits for that run instead
  of starting another (one run per job, decision 144).
- Jobs report **more than numbers**: rows for a table, items for a list (feedback), dated entries for
  a calendar.
- The **status board can come from the project's own tasks** with no job. Linear (or any tracker) is
  read by a job like any other source — through the user's MCP servers (the `brainUserMcp` setting) — GalacticAgents does not integrate with Linear itself.
- **Adding or changing a panel ends with one confirmation card** (decision 3), like a job — the
  combined panel-and-job card described above.
- In Arrange mode, a panel the Waykeeper adds goes **at the end** and never moves Cosmin's
  arrangement. A panel hidden on the Mac is hidden on the phone. The phone needs no arranging of its
  own and works in the one-screen phone layout (decision 140).
- **Very bad / very good limits are set with the panel** ("churn above 6% is very bad"; "installs
  +30% on last week is very good"). Without limits from Cosmin the Waykeeper proposes them from the
  panel's history, confirmed on the panel's card.
- **Fireworks play once per new result**, not every time the page opens, and become a steady green
  glow under the system's "reduce motion" setting.
- **"Needs a look" row:** panels that are currently very bad or very good rise to a short row at the
  top (Mac and phone), so the important things are seen first.
- **Against clutter:** a cap on panels per dashboard; the Waykeeper may suggest removing a panel that
  has not changed in weeks, never removes one without Cosmin's OK.

## Goals

- Each long-term project has a dashboard Cosmin opens from the project, on the Mac and the phone.
- Cosmin adds, changes and removes panels by asking the Waykeeper and confirming one card.
- Panels are filled from recurring jobs' runs, keep history, show their source and age, and refresh
  on demand.
- Cosmin arranges panels on the Mac; the phone shows the same dashboard in a usable one-column form.
- What is very bad or very good is impossible to miss; everything else stays calm.

## Non-goals

- A dashboard for ordinary (short) projects, asteroids, or across projects.
- Built-in integrations with specific data sources (App Store Connect, Stripe, analytics, Linear):
  jobs fetch data however their instructions say (decision 144: "jobs are generic").
- Fetching data live when the dashboard opens.
- Free-form layout on the phone, or a separate phone arrangement.
- Arbitrary custom code or HTML inside panels; only the fixed panel types.
- Alerts outside the dashboard (push notifications for a red panel) — possible later, not now.

## Anti-goals (it fails even if it technically works when…)

- The dashboard is full of numbers and nothing tells Cosmin what matters.
- A panel shows a stale value as if it were fresh, or hides that its job failed.
- The Waykeeper rearranges, removes or restyles Cosmin's panels without asking.
- Colour is the only signal for very bad / very good (unreadable to some eyes, invisible in a
  screenshot description); fireworks every time the page loads.
- The phone view is a shrunken Mac grid that needs pinching and sideways scrolling.
- A panel definition becomes a way to run commands or reach data the job was not approved for.

## Constraints (from the repo)

- Domain mutation + event insert in one transaction; projections over the event log; a migration for
  any schema change; types in `packages/protocol`; speculative fields in `meta`.
- Jobs (decision 144) already store per-run **named numbers** (`job_runs.numbers`, up to 30 per run,
  "kept for the dashboard, project 3"); the run's Steward reports them. This design widens what a run
  may report (rows, items, dated entries) — extend, do not replace.
- Data reaches panels only through job runs (and the project's own tasks); a panel never grants new
  permissions. What a job may do is decided only by the job part of a card, under decision 144's
  unattended rules — the panel part never widens it.
- Cards are decided by the user; the Waykeeper proposes (decision 3). A panel card never covers a
  money approval or a permission.
- Phone: one-screen layout (decision 140); remote answers follow decision 90.
- The Waykeeper of a long-term project has the views Chat, Status, Deliverables and Jobs; the
  dashboard is reached from the project like those.
- Hard caps and budgets (decision 18, P8-01) apply to refresh-triggered runs like any run.

## Calls Claude made (Cosmin can overrule)

- **Where it lives:** a fifth view of a long-term project's Waykeeper, **Dashboard**, first in the
  row, and the default view when a long-term project is opened. An area moon keeps opening Jobs.
- **A panel definition** stores: type, title, the source (one job and the named values it reads, or
  the project's tasks), how to show it (series, columns, comparison period, chart kind), very
  bad/very good limits, and its place and size. Stored in SQLite as domain objects with events, not
  as free text the Waykeeper re-reads.
- **Panel types for the first version:** number tile (value + change vs previous week or month),
  line chart, bar chart, table, list, calendar (month), status board (columns of items), text. More
  chart kinds (pie, area, stacked) only if cheap with the chosen chart library.
- **Text panels** are written by a job run (e.g. "the Waykeeper's weekly note" as a job), not edited
  by hand on the dashboard.
- **Staleness:** a panel whose job's last run failed or is paused shows that, with the time of the
  last good value; it is never coloured red or green from a stale value.
- **Colour plus a word:** very bad / very good panels also carry a label ("very bad", "very good")
  and an arrow, so the signal is not colour alone.
- **Cap:** 24 panels per dashboard. The "unchanged for weeks" suggestion uses four weeks.
- **Refresh** is available on the Mac and the phone; from the phone it is allowed (it only runs an
  already-approved job).
- **History kept:** what the jobs already keep (the last 200 runs per job); a chart covers at most
  that.
- **Clearing history:** each panel has "Clear history" (with a confirmation); its charts and
  week/month comparisons restart from the next run. The job's run records stay, so other panels
  reading the same job keep theirs. The job details screen also has "Clear stored values" for the
  whole job, which lists the panels it affects before confirming. Clearing is an event like any
  other change and is not undoable.
- **Where the job map comes from:** the job card (new or changed, including the job part of a
  combined panel card) declares the sources, collected values and processing steps; the map draws
  that declaration and checks it against what the last run actually used (its tool calls). A source
  the run used but the job did not declare is shown and flagged, never hidden.
- **Job details open** from the job in the Jobs view and from a panel's "from job '…'" line.
- **Tables, lists, calendars and status boards show the latest good run's snapshot.** The job reports
  the current state each time (e.g. "the 10 newest feedback items", "posts planned for the next four
  weeks"); nothing is merged across runs. Numbers keep their history per run for charts and
  comparisons.
- **Very bad / very good apply to number tiles and to the latest value of a chart series** only. Each
  such value stores which direction is better (higher or lower), so "churn ▼ 0.6 pt" reads as
  better. Tables, lists and status boards are never coloured.
- **Refresh and job states:** Refresh is off while the job or the project is paused; a paused job's
  panel shows "Job paused — Fix & retry", which opens the existing failure question (decision 144)
  rather than bypassing it. A refresh run does not move the job's schedule or its catch-up window,
  and its findings reach the inbox like any run's.
- **Stopped jobs and dropped values:** a panel whose job is stopped, or whose value a job change no
  longer reports, keeps its last data marked "job stopped" / "no longer reported" and is never
  coloured. A card that stops or changes a job lists the panels it affects; removing them is Cosmin's
  choice on that card.

## Open questions for later (SPEC §8)

- Push or menu-bar notifications when a panel turns very bad.
- Sharing or exporting a dashboard (image, link).

## Left to the builder

- Data model for panels, layout and limits; events; migration; how runs report rows/items/dated
  entries next to named numbers, and their size limits.
- The Waykeeper's tools (propose/change/remove a panel, read the dashboard) and the run Steward's
  reporting tool changes.
- The grid and drag/resize implementation on the Mac (keyboard-operable too), the phone layout, the
  chart library (or plain SVG) and the fireworks effect.
- The panel card's look and the "Needs a look" row's exact behaviour.
- The job map's drawing (the connecting lines between columns, highlight on hover/tap) and how a
  run's tool calls are matched to declared sources.
