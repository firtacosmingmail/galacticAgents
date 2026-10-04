# P5-02 — Status views

SPEC §4.3: "Ask for the status of anything: the whole system, a project, a task or an agent."
Acceptance: answerable without an LLM call.

## 1. Gap audit (before this task, 2026-10-04)

What the panel already says about status, all of it computed from the client world (the folded
event log plus the server's status records, TECHNOLOGY §4) — no LLM call anywhere:

| Where | What it shows | Scope |
|---|---|---|
| Top bar (decision 58, 67) | "N waiting for you" (`waitingForUserCount`: user-held questions + cards waiting for a decision) | system |
| Navigation (P25-02, decisions 69, 75) | the Harmonizer's agent state and "N for you"; every project and task row with its derived work state (P2-15), blocked rows first and amber; project rows "N active, M in total" Stewards; closed work behind "Show closed" | project, task |
| Managed-agents cards (decision 56) | per managed agent: agent state ("blocked on you" first), activity line, cost so far, wall clock and tool calls against their caps, open-question count; work-only cards for queued work | agent (one level down) |
| Dock bar (decision 71) | the selected agent's state pill, its current activity, "blocked on you" for a Steward | agent |
| Steward view (decision 57) | state, activity, task / project / body / supervisor, worktree, branch, cost, tool calls and wall clock against caps, progress, open questions with their cards, transcript | agent, task (partly) |
| Inbox (decision 58) | every open question with kind and holder, waiting cards, parked cards, supervisor answers | questions |
| Scene (decisions 66, 68, 72, 74) | body labels with work name and state, satellites coloured by agent state, amber beacons for user-held questions, legend | everything, visually |
| Harmonizer's `report_status` tool (P2-08) | system / project / task / agent JSON: projects with states, standalone tasks, live agents, pending proposals, open questions | everything, **but only through an LLM turn** |
| `summarize` (protocol, P2-15) | open questions, user questions, blocked tasks/projects counts — computed, used only for the nav's "N for you" | system |

What "ask for the status of anything" still lacked without asking the Harmonizer:

- **The whole system at once.** No place adds things up: how many projects / tasks are in each
  state, how many agents are working / waiting / stalled / paused, what is failed or interrupted
  and needs a decision, how many open questions of each kind and who holds them.
- **Totals.** Cost exists per agent only (a card, the Steward view); no total for the system, for
  a project (its Waykeeper plus its Stewards), or for a task across its respawned Stewards.
- **Caps usage at the system level.** Per-agent caps show on cards; the global caps (live Stewards
  vs the concurrency cap, spawns in the last hour, a Waykeeper's Stewards vs its per-Waykeeper
  cap) and "agents close to a cap" are nowhere.
- **One list of what needs attention**, blocked-on-you first, each entry selecting its agent. The
  navigation sorts blocked rows first but only within each level, and hides nested rows.
- **A project at a glance.** The Waykeeper's conversation shows a chat; its tasks are a nested nav
  list and the cards (hidable). Tasks by state, each task's Steward state and cost, its open
  questions, its sub-projects and the Steward cap are not in one view.
- **A task beyond its current Steward.** The Steward view is the newest Steward's: how many
  Stewards the task has had, their total cost, the task's priority and how long it has been in
  its state, and how long since the agent last did anything are missing.
- The task-state history (every transition) lives in the event log; the client keeps only its
  last 200 events, so a complete history is the history view's job (P5-03, `/api/history/events`)
  and is not rebuilt here.

## 2. What was built

All of it in `apps/web/src/panel/status/`; computed in the browser from the client world (the
folded log and the server's status records) and the settings' caps. No new server endpoint, no
protocol change, no LLM call.

- **`status-model.ts`** (pure):
  - `systemStatus(world, {now, caps})`: projects and tasks counted by work state (in
    `WORK_STATE_ORDER`, blocked on you first, archived last); agents with a status record by
    state (waiting for input first) and the live Harmonizer / Waykeepers / Stewards; a
    **needs-attention** list — blocked on you, failed, interrupted, stalled, close to a cap (80 %
    of tool calls or of the running wall clock), in that order and oldest first within each —
    whose entries carry the selection of their agent (decision 53's newest live, else newest); a
    user-held question whose work is not (yet) `blocked_on_user` — the Harmonizer's own
    `ask_user`, a question that arrives before the projection — is listed by its agent so nothing
    blocked on the user is missed; open questions by kind and by holder; decision 58's "waiting
    for you" number and the cards to decide; cost total, "active today" (records whose last event
    is after local midnight), brains vs Stewards; caps: live Stewards against
    `maxConcurrentAgents` (decision 43: Stewards only) and spawns in the last hour against
    `maxSpawnsPerHour`.
  - `projectStatus(world, projectId, …)`: its tasks by state, its task rows (blocked first —
    including a task whose Steward has a user-held question before the derived state says so —
    then by state, oldest first; archived tasks only counted), each with its Steward's state, how
    many Stewards it had and their summed cost; "N active, M in total" (P4-09's `stewardCount`);
    live Stewards against `maxStewardsPerWaykeeper`; its attention list (also a Waykeeper's own
    question for the user); questions; cost of its Waykeepers and its tasks' Stewards (a
    sub-project counts on its own); its sub-projects; its parent.
  - `taskStatus(world, taskId, …)`: what the Steward header lacked — priority, last change of the
    task, how many Stewards it had, their total cost, its open questions by kind, how long the
    Steward has been silent.
  - `formatCostTotal` ("$1.00 + 4,000 tokens": tokens only for agents without a dollar figure,
    so nothing counts twice), `nearCap`, `narrativeRequest`.
- **`StatusViews.tsx`**: `SystemStatusView`, `ProjectStatusView`, `TaskStatusFacts`,
  `DockViewToggle`, `BrainDock`, `AskNarrative`. Blocked rows have the amber left edge and the
  panel's `Beacon`; the amber chip is used only for "blocked on you" (an agent "waiting for input" may wait on
  its supervisor, so it is not amber).
  Every work and agent name is a `NavLink` that selects its agent (and fits P5-01's selection
  store: it only calls `navigate`).
- **`dock-view.ts`**: the per-browser "Chat | Status" choice (`galactic.panel.dock.view`), one for
  both brains.
- **Mounts** (minimal edits to shared files): `Panel.tsx` wraps the brain's `Conversation` in
  `BrainDock` and adds `DockViewToggle` to the dock bar for the Harmonizer and Waykeepers;
  `StewardPanelView.tsx` renders `TaskStatusFacts` under its header. The conversation stays
  mounted under the status view (collapsed, invisible, `inert`, `aria-hidden` — as when the dock is
  minimised), so its scroll position, live thread and draft survive the switch.
- **"Ask the Harmonizer for a narrative status"**: a secondary button at the bottom of the system
  and project views; one click sends one ordinary chat message to the running Harmonizer (which
  answers with its `report_status` tool), switches the dock back to Chat and selects the
  Harmonizer, where the answer arrives. Disabled when no Harmonizer runs.

Choices worth knowing:

- **Placement:** a Chat | Status switch in the dock bar rather than a block above the chat: the
  status view gets the whole dock, the chat keeps all of its height when shown, and the choice is
  remembered per device like the dock's other preferences (decision 71).
- **The Steward view gets no switch:** it is already the agent's status (decision 57); only the
  task facts it lacked were added.
- **Costs are honest about retention:** the server drops ended status records after 24 h / 500
  (P1-16), so the totals cover the agents it still reports, and the view says so. An all-time
  cost needs a server-side sum over the log (left for Phase 8's dollar budgets).
- **Task state history** is not rebuilt from the client's last 200 events; the history view
  (P5-03) reads it from the server.

## 3. Proposed SPEC decision

| # | Question | Decision |
|---|---|---|
| 80 | Status views | **Computed, never asked; blocked on you first** (2026-10-04, P5-02; §4.2, §4.3, §4.4, decisions 43, 53, 56, 57, 58, 69, 71): the status of the whole system, a project, a task or an agent is shown by the panel without an LLM call, from the derived states, the status records and the settings' caps. The dock bar of the Harmonizer and of a Waykeeper has a "Chat \| Status" switch, remembered per browser; the conversation stays as it was behind it. The Harmonizer's status is the system's: projects and tasks by state, agents by state, a "needs attention" list (blocked on you, then failed, interrupted, stalled, close to a cap; oldest first within each; every entry selects its agent), open questions by kind and holder, the "waiting for you" number of decision 58, cost (total, active today, brains and Stewards — over the agents the server still reports) and the caps in use (live Stewards against the concurrency cap, spawns in the last hour). A Waykeeper's status is its project's: its tasks blocked first with each task's Steward state and cost, "N active, M in total" and its live Stewards against the per-Waykeeper cap, its questions, its cost, its sub-projects. The Steward view stays the agent's and task's status (decision 57), adding the task's priority, its last change, how many Stewards it has had and their total cost, its open questions by kind and how long the Steward has been silent. "Blocked on you" leads every list and is the only amber. A secondary "Ask the Harmonizer for a narrative status" button sends one chat message to the Harmonizer and opens its chat — the only LLM path. |

## 4. Tests

- `apps/web/src/panel/status/status-model.test.ts` (19): system counts by state and their order;
  agents by state and live counts; the attention order (blocked → failed → interrupted → stalled →
  cap, oldest first) with its selections; archived work left out; question counts by kind and
  holder; the waiting number; cost sums (dollars, token-only agents, today, by role); caps with
  and without settings; an empty world; the project's task rows blocked first (including a task
  blocked by a question before its state), respawned Stewards (newest live opens, costs summed),
  its attention list, its cap, questions, cost, sub-projects and parent; task facts; cost
  formatting; never counting tokens next to dollars; near-cap only for live agents; the narrative
  request's words.
- `apps/web/src/panel/status/status-views.test.tsx` (8): the system view renders blocked first
  with the beacon, amber chip, question counts, cost and the settings' caps; an attention link
  selects its agent (URL too); the project view's rows blocked first and their links; the
  narrative button sends exactly one message to the Harmonizer, then selects it and switches to
  Chat; the task facts; in the full app, the switch shows the system status and back while the
  chat stays mounted (`inert`, `aria-hidden`, composer present), the choice is remembered per
  browser and a Waykeeper shows its project; a Steward has no switch and shows the task facts.
