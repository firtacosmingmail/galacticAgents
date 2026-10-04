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
