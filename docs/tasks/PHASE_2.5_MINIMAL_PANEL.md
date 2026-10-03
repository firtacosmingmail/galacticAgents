# Phase 2.5 — Minimal side panel

**Current task:** P25-09, P25-10 (wave 4, branch `p25-wave4-dogfood`) · **Task status:** in progress
**Phase status:** in progress (8/10 done) — on branch `phase-2.5`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

A daily-usable product before any 3D (SPEC decision 19): the spec's side panel in plain React — chat with the Harmonizer and Waykeepers, managed-agents cards, question inbox, proposal cards, notifications and settings. This *is* "list mode"; Phase 5 polishes it and Phase 7 makes it mobile-friendly. The ops console survives as a hidden debug view.

## Entry criteria

- Phase 2 exit criteria met.

## References

- `IMPLEMENTATION_PLAN.md` → Phase 2.5.
- `SPEC.md` §2.4 (who the user talks to), §4.2 (panel), §4.3 (requests), §4.4 (states), §4.5 (notifications), §4.6 (setup and settings); decisions 11b, 13.
- `TECHNOLOGY.md` §2.1 (UI chrome is ordinary React outside the canvas), §6.3 (WS protocol).

## Design notes for implementation

- **Conversation partners:** Harmonizer (default) and Waykeepers only. Stewards get a read-only view; the message box appears only while the Steward holds an open clarification question for the user.
- **Everything is derived from the event stream** already flowing to the client; the panel needs a few extra server endpoints (conversation history, settings, preflight) — build those first.
- **"Blocked on user" is the loudest state** everywhere: badges, ordering, notifications.
- Selection model (`harmonizer | waykeeper:<id> | steward:<id>`) is shared with the scene later; keep it in the store now.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 (parallel) | P25-01, P25-02 | Server endpoints and the app shell/selection model. |
| 2 (parallel) | P25-03, P25-04, P25-05, P25-06 | Chat, managed agents, Steward view, inbox/cards — independent UI pieces on the shell. |
| 3 (parallel) | P25-07, P25-08 | Notifications and settings/preflight. |
| 4 | P25-09, P25-10 | Dogfood week and fixes; the history view (added) alongside. |

## Tasks

### P25-01 — Server endpoints for the panel
- **Status:** done (2026-10-02) · **Depends on:** P2-18 · **Parallel with:** P25-02
- REST/WS additions: conversation history per brain (messages with `sender`, paged), Steward transcript (from P1-06), settings read/write (projects root, default permission policy, retention, caps, quality tier), runtime preflight (Claude installed, logged in, version), notification events feed.
- **Acceptance:** endpoints typed in `packages/protocol`; tests for history paging and settings validation.

### P25-02 — Panel app shell and selection model
- **Status:** done (2026-10-02) · **Depends on:** P0-09, P2-15 · **Parallel with:** P25-01
- Layout: left navigation (Harmonizer, projects → Waykeepers, asteroid tasks), main conversation area, right column for managed agents/inbox; selection state in the store; routing; "list mode" is the only mode for now; ops console reachable at `/debug`.
- **Acceptance:** navigating between Harmonizer, a Waykeeper and a Steward changes the selection and the main area.

### P25-03 — Chat with the Harmonizer and Waykeepers
- **Status:** done (2026-10-03) · **Depends on:** P25-01, P25-02 · **Parallel with:** P25-04, P25-05, P25-06
- Message list from history + live events; composer sending to the selected brain (enqueued as a mailbox event); inline rendering of proposals, task-plan cards and status reports posted by the brain; "Harmonizer" always one click away.
- **Acceptance:** a request typed here produces a proposal card in the same thread; a Waykeeper conversation shows its plan card.

### P25-04 — Managed agents cards and control actions
- **Status:** done (2026-10-03) · **Depends on:** P25-02, P2-14 · **Parallel with:** P25-03, P25-05, P25-06
- For the Harmonizer: Waykeepers + asteroid Stewards; for a Waykeeper: its Stewards. Cards show state, activity one-liner, cost-so-far, caps usage, open-question badge; actions: pause/resume, stop/cancel, open (select), close/archive/pin/reopen where applicable.
- **Acceptance:** every control action in `SPEC.md` §4.3 is reachable from a card.

### P25-05 — Steward read-only view
- **Status:** done (2026-10-03) · **Depends on:** P25-02, P1-06 · **Parallel with:** P25-03, P25-04, P25-06
- Status header, current activity, live transcript with tool calls and thought process, worktree/branch info, open question (if any); **message box only while an open clarification question for the user exists**, sending the answer through the question service; stop/pause available.
- **Acceptance:** with no open question the view has no composer; with one, the answer resolves it and the composer disappears.

### P25-06 — Question inbox, proposal and plan cards
- **Status:** done (2026-10-03) · **Depends on:** P25-02, P2-09, P2-03 · **Parallel with:** P25-03, P25-04, P25-05
- Inbox listing every open question (kind badge, holder, origin agent, task/body, context, "open agent" link); inline answer; permission cards show the requested action and allow/deny; proposal cards (approve / edit size, body, workspace inline / reject) and task-plan cards (approve / edit / reject); parked proposals shown with the occupied-planets explanation and downsizing/closure offers; supervisor-answered questions visible read-only with `answeredBy`.
- **Acceptance:** answering in the inbox resolves the question in the chat thread too; "already answered by …" shown on a stale answer.

### P25-07 — Desktop notifications
- **Status:** done (2026-10-03) · **Depends on:** P25-01 · **Parallel with:** P25-08
- Browser Notification API (permission requested on a user gesture); triggers per `SPEC.md` §4.5: question/permission opened for the user, task/project finished or failed, work interrupted by a restart, refusal for lack of space; click focuses the relevant item; per-type toggles in settings.
- **Acceptance:** each trigger produces one notification; no duplicates on reconnect.

### P25-08 — Settings page and first-run preflight
- **Status:** done (2026-10-03) · **Depends on:** P25-01 · **Parallel with:** P25-07
- First-run wizard: preflight (runtime installed / logged in) with fixable error messages, projects root picker, default permission policy editor (table from `SPEC.md` §3.6), retention period, caps, quality tier; the same as a settings page afterwards; token display/QR placeholder for Phase 7.
- **Acceptance:** a fresh install walks through the wizard and lands in the panel; invalid settings are rejected with messages.

### P25-09 — Dogfood run and fixes
- **Status:** in progress · **Depends on:** P25-03 … P25-08 · **Parallel with:** —
- Use the panel for a real small project for a few days without opening `/debug`; log friction in `docs/tasks/notes/P25-09-dogfood.md`; fix the blocking items; feed spec changes back into SPEC.md.
- **Acceptance:** exit criteria below met; notes committed.

### P25-10 — History view (added 2026-10-03)
- **Status:** in progress · **Depends on:** P25-01, P25-02 · **Parallel with:** P25-09
- Found while preparing the dogfood run: SPEC §4.2 asks for "a history view of archived work and past questions", and the panel has only the cards' "show archived work" and the inbox's last ten supervisor answers. A `/history` page in the panel's frame: archived and finished projects and tasks (with reopen / unpin, and a link to their agents' transcripts), and past questions (answered, cancelled, withdrawn — who answered, the answer, when), searchable by text and paged over REST.
- **Acceptance:** archived work can be found and reopened, and any past question with its answer can be found, from the panel alone.

## Exit criteria (from the plan)

Everything in `SPEC.md` §4.2–4.3 that does not require the scene is doable from the panel; you can run a real project for a day without opening the ops console.
