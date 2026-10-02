# P25-04 — Managed agents cards and control actions

## What was built

The right column's "Managed agents" section (P25-02 left it as a list of links) is now a list of cards (`apps/web/src/panel/`):

- **`agent-cards-model.ts`** (pure, no React):
  - `managedCards(world, supervisor, {showArchived})` decides which agents get a card:
    - **Harmonizer:** the Waykeepers of top-level projects and the Stewards of standalone (asteroid) tasks (decision 6).
    - **Waykeeper:** the Stewards of its project's tasks and the Waykeepers of its sub-projects (decision 32).
    - Agents are matched by role and project, never by `supervisorId`. A replacement Waykeeper therefore sees the Stewards of the Waykeeper it replaced.
    - Every live agent gets a card. Work with no live agent keeps its newest agent's card, so stopped, finished or failed work can still be resumed, closed, archived or reopened.
    - Archived work is hidden unless "show archived work" is ticked, which is where archived work is reopened.
  - Card order: blocked on user first, then live agents, then ended ones, oldest first within each group.
  - A card is **blocked on user** when its work's state is `blocked_on_user` or when the user holds one of the agent's open questions.
  - `agentActions(status)` and `workActions(work)` decide which buttons a card offers. The work actions follow the same rules as the ops console's `Controls` (P2-18). The server still decides every action.
  - `wallClockUsed` extrapolates the wall clock from `startedAt` while the agent works (TECHNOLOGY §4). The clock is frozen while the agent is paused or ended, and never shows less than the server reported.
  - `formatCost` shows dollars if the runtime reports them, otherwise tokens, otherwise "—".
- **`AgentCards.tsx`** (`ManagedAgentCards`, `AgentCard`). Each card shows:
  - the agent's state pill;
  - the amber **"blocked on you"** beacon and an amber left edge (the Beacon from Navigation, the only amber on the page);
  - an "N open questions" badge, counting the agent's own open questions whatever their holder;
  - the agent's name as a link (**open** = select, through the store's `navigate`);
  - the activity one-liner (truncated, with the full text in the tooltip);
  - its task or project with that item's state, priority and pin;
  - cost so far;
  - wall clock and tool calls as used / limit, each with a thin meter that turns red at 80 %. The meter ticks once a second, and only while something is running.
- **Two action rows per card**, all sent through `POST /api/control`:
  - **agent:** Pause or Resume, and Stop. "Resume session" (`/api/agents/:id/recover`) appears when the agent is interrupted.
  - **task / project:** Pause or Resume, Stop, Cancel, Close, Archive now, Pin or Unpin, Reopen and Edit, each offered only when the state allows it. Edit reuses P2-18's `EditForm`: a task's description and priority, or a project's name and trust level (decision 49).
- **Inline confirm** for Stop (agent and work), Cancel, Close and Archive now: a small "…? [Yes, stop] [Keep]" strip on the card. Nothing is sent until it is accepted.
- **Refusals** (409 and the others) show on the card's own error line, in the server's words, via `useAction` and `ErrorLine`.
- **`agent-cards.css`**: styles for the cards, built on the panel's tokens.

## Decisions (proposed text, ready to paste)

- **SPEC §4.2 addition: managed-agents cards (decision N).**
  - Each card shows the agent's state, the activity one-liner, cost so far, wall-clock and tool-call usage against their caps, and a badge with the number of open questions. "Blocked on you" is the loudest state and sorts first.
  - A card offers the agent's own controls (pause/resume, stop) and its work's controls: the task's for a Steward, the project's for a Waykeeper. Those are pause/resume, stop, cancel, close, archive now, pin, reopen and edit (a task's description or priority; a project's name or trust level).
  - Stop, cancel, close and archive ask for an inline confirmation first.
  - A refusal is shown on the card.
  - The Harmonizer's cards are its top-level projects' Waykeepers and the asteroid Stewards. A Waykeeper's cards are its project's Stewards and its sub-projects' Waykeepers.
  - Work with no running agent keeps its newest agent's card until it is archived; "show archived work" brings archived work back so it can be reopened.
- **Cancelling an agent:** the server treats an agent-level cancel as a stop. So the card offers Stop on the agent and Cancel only on its work, where cancel means something different from stop (decision 28: `failed` by the user, versus `paused`).
- **Close is confirmed as well**, though the brief listed only stop, cancel and archive as destructive. Closing stops the item's agents (decisions 11 and 36), so it is treated the same way.

## Shared files touched (minimal, additive)

- `apps/web/src/panel/Panel.tsx`: imports `ManagedAgentCards` and renders it in place of the links list for a Harmonizer or Waykeeper selection. The Steward's "Reports to" link is unchanged. `managedAgents` stays exported but is no longer used by the panel; its comment says so.
- `apps/web/src/console/hierarchy/WorkTree.tsx`: `EditForm` and `EditChanges` are now exported. The behaviour is unchanged, and `/debug` is untouched.
- No changes to `state/store.ts`, `packages/protocol` or the server.

## Tests

- `AgentCards.test.tsx` (32): a table-driven test with 22 rows, one per SPEC §4.3 control action as a card offers it. It covers:
  - agent pause, resume and stop, and pausing a Waykeeper;
  - task pause, resume, stop, cancel, close, archive, pin, unpin, reopen, and reopen of archived work;
  - project pause, resume, stop, cancel, close, archive, pin and reopen.

  Each row checks the exact `ControlBody` sent, and that destructive actions send nothing before the confirm. Further cases cover:
  - task edit (description and priority) and project trust-level edit;
  - open (selection);
  - "Resume session";
  - Keep;
  - an inline 409;
  - the card's figures;
  - blocked-first ordering;
  - a Waykeeper's cards, including a sub-project Waykeeper;
  - the stopped-agent card and the archived toggle.
- `agent-cards-roundtrip.test.tsx` (2) runs against the real composed runtime, the fake adapter and the real Fastify routes through `inject`, with the store fed by the log and status subscriptions:
  - It pauses and resumes a task from the card, and the Steward really pauses and resumes. Cancel then needs the confirm, after which the task is failed, the Steward is stopped, and the card offers Reopen and Archive now.
  - A real server 409 ("task … is failed") is shown inline.
- `agent-cards-model.test.ts` (2): the wall-clock extrapolation, durations and cost.
- Totals: web 101, server 827 (+1 skipped), protocol 61.

## Deferred

- A per-card "last event" line next to the activity summary (TECHNOLOGY §4.5's "a lying summary is visible"). The status record carries no raw last event, only `currentActivity`.
- Progress (`status.progress`) on the card. P25-05's Steward view shows it.
- Cards for work that has no agent at all: approved tasks waiting for a Steward, and proposed tasks. These are reachable through the navigation and the plan cards (P25-06).
- Dollar budgets per project (Phase 8). Only the cost so far is shown.
- Keyboard shortcuts and focus handling for the confirm strip. Tab and Enter work.
