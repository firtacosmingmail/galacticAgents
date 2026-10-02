# P25-05 — Steward read-only view

## What was built

The panel's main area now shows a Steward through `apps/web/src/panel/steward/StewardPanelView.tsx`. P2-18's `console/hierarchy/StewardView.tsx` is unchanged and still used by `/debug`.

- **Status header**:
  - The loud amber "blocked on you" beacon (`Beacon` from `Navigation.tsx`) shows while the user holds one of the Steward's open questions, or while its task is `blocked_on_user`. `AgentState` has no `blocked_on_user` value, so this is derived.
  - Then the agent state pill and the task state, the current activity on a line of its own, and a facts grid: task, project (or "standalone task (asteroid)"), body (name and kind), "reports to" (a link to the supervisor), worktree path, branch, cost (`$` and tokens), tool calls used / limit, wall clock used / limit, and progress.
  - The wall clock runs on from `startedAt` for a live agent, as the `StatusRecord` docs say. It is computed at render time, with no ticking timer.
- **Controls**: Pause/Resume, Stop, and Resume session (only for an interrupted agent).
  - Stop needs a second click ("Confirm stop" / "Keep it running").
  - All of them go through `POST /api/control` with target `{kind:'agent'}`. Resume session uses `/recover`, as P2-18 does.
- **Open question**: shown prominently in a highlighted box above the transcript.
  - A permission question reuses P2-18's `QuestionCard`, which offers Allow / Refuse and no free text (decision 48).
  - A clarification gets a summary card: the text, the holder, the origin context, and "answering anywhere resolves it everywhere".
- **Composer** (`ClarificationComposer.tsx`): rendered **only while the Steward has an open clarification**, the oldest one.
  - It has the option buttons, a textarea (Ctrl/⌘+Enter sends) and a "Send answer" button.
  - It calls `POST /api/questions/:id/answer` with the question's `version`.
  - On a 409 `stale` the view keeps a "Not sent: already answered by … : "…"" line, built from the folded world. The line stays after the composer is gone and can be dismissed.
  - With no open clarification the view shows a read-only note instead and has no textbox.
- **Transcript** (`TranscriptLog.tsx`):
  - Text, tool calls (monospace) and thinking (a collapsed, dimmed `<details>`).
  - The view follows the live stream while the reader is at the bottom.
  - Scrolling to the top, or the "Load earlier" button, reads the page before the oldest chunk held, and keeps the reader's place.
- **Backfill/live seam** (`useStewardTranscript.ts`):
  1. `GET /api/agents/:id/transcript?limit=100` reads the newest page.
  2. The page is merged into the store's `transcripts[agentId]`.
  3. Only then does `transcript.subscribe` go out. The session's existing `transcriptSince` sends the newest `seq` held, which is ≥ the page's chunks.
  4. If the server persisted more chunks after the page read, the stream backlog delivers them. Buffered chunks arrive with the next flush, as `lastSeq` is meant to guarantee.
  - Overlaps are deduplicated by `seq`.
  - A failed page still subscribes, so the view goes live anyway.
  - The page is read again when the log changes.

## State

- **`state/transcript-view.ts`** (new slice):
  - `transcriptViews: Record<Id, {status, hasMore, loadingOlder, error?}>`.
  - `setTranscriptView`.
  - `addTranscriptPage(agentId, chunks, 'newest' | 'older')`.
  - The pure `mergeChunks`. A `newest` page drops held chunks older than itself: they came from an earlier visit and may leave a hole.
- **Chunks**: they stay in the existing `transcripts` map, so the live reducer and the session's `since` work unchanged.

## Decisions

- **Following decision 48 over the task text.** The task says "only while an open clarification question *for the user* exists". Decision 48 (and SPEC §2.4's "answering anywhere") offers the answer box for any open clarification of the Steward, including one a supervisor holds. The view follows decision 48 and says who holds it. Proposed SPEC text, **decision N — The Steward view (P25-05)**: "The Steward view shows its status (blocked on you first), current activity, task, project, body, worktree and branch, cost and caps, and its transcript with tool calls and collapsed thinking, backfilled over REST and then live. It has a message box only while the Steward has an open clarification (held by the user or a supervisor); the box answers that question with its version and disappears once it is answered. A permission request shows allow / refuse only. Pause, resume and stop act on the agent; stop asks for confirmation."
- **Subscribe after the page.** Subscribing first would replay the whole transcript from `seq` 0. The `since` is the newest held `seq` (≥ the page's `lastSeq` in practice), never a value past an unseen persisted chunk.

## Shared files touched (small, additive)

- `apps/web/src/state/store.ts`: `AppState extends TranscriptViewSlice`, `...createTranscriptViewSlice(set)`, and `transcriptViews: {}` cleared in `reset()` and on a log change.
- `apps/web/src/panel/Panel.tsx`: the Steward branch renders `StewardPanelView` instead of `StewardView` (2 import lines, 1 JSX line).
- `apps/web/src/console/api.ts`: a new `transcript(agentId, {before, after, limit})` method and a type import.
- No protocol or server changes.

## Deferred

- **The 2,000-chunk cap** (`MAX_TRANSCRIPT`): live appends trim the oldest chunks, which can drop pages read by scrolling back in a very long session. They can be read again by scrolling.
- **A live-ticking wall clock** (it updates on every status change only).
- **Opening more than one open clarification** at a time: the composer answers the oldest. The others are listed and answerable in the inbox.
- **Virtualised rendering** for very long transcripts.

## Tests

- `apps/web/src/panel/steward/StewardPanelView.test.tsx` (6):
  - No composer without an open question, and the header facts are shown.
  - The composer answers with the version, then disappears on `question.answered`.
  - A stale answer shows "already answered by Waykeeper · …".
  - A permission card has allow / refuse only and no textbox.
  - The backfill/live seam: no subscribe before the page, then `since` 13; overlapping and buffered live chunks are shown once, in order; "Load earlier" reads `before=11`.
  - Pause and confirmed stop go through `/api/control`.
- `apps/web/src/state/transcript-view.test.ts` (3): merge and dedup, hole avoidance, and the slice with live chunks and `reset`.
- Totals: web 74, server 827 (+1 skipped), protocol 61.
