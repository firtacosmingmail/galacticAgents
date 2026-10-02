# P25-03 — Chat with the Harmonizer and Waykeepers

## What was built

The panel's main area for a brain is now its own chat, `panel/chat/Conversation.tsx`. It replaces P2-18's `ChatBox` there; `/debug` still uses `ChatBox`, unchanged.

- **The thread** is the history from `GET /api/agents/:id/conversation` merged with the live stream: `message.sent` (the store's `messages`) and the brain's `text` transcript chunks (the store's `transcripts`). Every line carries the server's stable id (`m:<messageId>`, `r:<agentId>:<chunkSeq>`), so the merge is a dedup by id, in the server's order (`at`, messages before replies, `seq`/`chunkSeq`).
  - **Paging back:** a "Load earlier messages" button, and scrolling near the top. The scroll position is kept while older lines are prepended, and the view follows the bottom while the user is there.
  - **The seam:** the transcript stream is subscribed only after the first page arrives, from that page's `lastSeq`. `conversationSince(agentId)` is read by the session's `transcriptSince`, which takes the max with the store's last chunk. A reply still buffered when the page was read therefore arrives live, and nothing is replayed from 0.
  - **Snapshot catch-up:** when `snapshots` changes, the thread pages forward with `after=<newest history cursor>` (200 per page, up to 20 pages) until `hasMore` is false. Reopening a chat read earlier does the same, so there is no gap in the middle.
  - **Capped buffers:** live lines are absorbed into the slice, so dropping old entries from `messages` or `transcripts` never removes a line the thread showed.
  - **Another `logId`** drops every thread.
  - **On unmount** the chat drops the agent's transcript buffer. That buffer now starts at `lastSeq`, and the ops console's `ChatBox` must be able to resubscribe from its start.
- **Line kinds:**
  - The user's lines sit on the right. A sent line shows as "sending…" until its `message.sent` (matched by the returned `messageId`) arrives.
  - The brain's replies sit on the left.
  - A **status report** is a `message.sent` from another agent, typically a Waykeeper's or a Steward's `report_status` or completion line. It is set apart and has a link that selects the sender.
  - System notices are small and centred.
  - While the brain is `working`, "X is working: <activity>" is shown.
- **Composer:** a textarea; Enter sends and Shift+Enter starts a new line. There is an "interrupt" toggle. It calls `POST /api/agents/:id/send`, which enqueues a mailbox event for the brain. It is disabled once the agent has ended.
- **Cards in the thread** (decision 52, placed by `createdAt`) come from `threadCards(world, agent)`:
  - **Waykeeper:** its project's plan cards (`meta.plan.projectId`, so a successor Waykeeper owns them too) and its promotion requests (`fromProjectId`).
  - **Harmonizer:** every other card.
  - **Questions:** they go to the thread of the brain that asked, or of the asking Steward's current supervisor by role and project (after the review fix; so a replacement Waykeeper takes it over), so asteroid Stewards' questions go to the Harmonizer.
  - **Cards older than the oldest loaded line** stay hidden until that history is paged in.
- **Harmonizer one click away:** the shell's first nav row and the "← Harmonizer" link in the main header. The real-server test clicks the link.

## Shared component (after the merge)

`panel/chat/InlineCards.tsx` exports `ThreadCard({kind: 'proposal' | 'question', id})`: a `<div class="thread-card" data-card={id}>` wrapper around P25-06's `ProposalView` / `QuestionView`. The thread no longer folds decided cards itself; the shared views show their compact forms (approved card, answered card, "Withdrawn: …"), a rejected card stays full. The chat tests query the shared labels (`proposal <requestText>`, `plan <requestText>`).

## Decisions (recorded as SPEC decisions 54 and 55, TECHNOLOGY §6.3 "The chat" and the §7 vocabulary; the text below is the original proposal)

- **SPEC §7, decision N — A brain's turn prompts are not conversation (P25-03, refines 52).** The runner's per-turn digest ("Since your last turn: …" plus the current state) is logged as a `message.sent` from the system, like any message. It is marked `turn: true` and is not part of the conversation: neither the panel's chat nor `GET /api/agents/:id/conversation` shows it. Other system messages, such as a recovery notice, are still conversation lines. Turn prompts logged before this change are not marked and still show.
- **SPEC §7, decision N+1 — Where a card shows in the chat (P25-03).** A plan card and a Waykeeper's promotion request show in the conversation with that project's Waykeeper. Every other card (work cards, the Harmonizer's promotion and closure cards) shows in the Harmonizer's conversation. A question shows in the conversation of the brain that asked it, or, for a Steward's question, of the Steward's supervisor. A card is the same card in the thread and in the inbox: answering it in one place resolves it in both. Once decided, it folds to one line in the thread.
- **TECHNOLOGY §6.3, append to "Panel endpoints (P25-01)":**

  > **The chat (P25-03).** The client keeps its threads in their own store (`state/conversation.ts`), a REST-filled cache beside the stream-derived `useAppStore`. It merges the history pages with the live `message.sent` and `text` chunks by entry id. The transcript is subscribed after the first page, from its `lastSeq` (the session's `transcriptSince` takes the max of the buffer's last chunk and the open chat's `lastSeq`). After a snapshot catch-up, or when a chat is reopened, the thread pages forward from its newest history cursor. `message.sent.turn` marks a brain's turn prompt; the conversation endpoint's SQL leaves those out (`json_extract(payload,'$.turn') IS NULL`, still served by migration 0007's partial index).

- **TECHNOLOGY §7 (protocol vocabulary):** `MessageSent.turn?: true` and `ChatMessage.turn?: true`.

## Shared files touched (small, additive)

- `packages/protocol/src/events.ts`: the optional `turn` on `MessageSent`.
- `packages/protocol/src/rest.ts`: the optional `turn` on `ChatMessage`.
- `apps/server/src/runtime/agent-runtime.ts`: `send()` records `turn: true` for a turn message (one line).
- `apps/server/src/runtime/history.ts`: one `AND json_extract(payload, '$.turn') IS NULL` in the messages query, plus the doc comment.
- `apps/web/src/state/store.ts`: the `message.sent` fold copies `turn` (one line).
- `apps/web/src/client/session.ts`: `transcriptSince` takes the max with `conversationSince`.
- `apps/web/src/console/api.ts`: a `conversation(agentId, query)` method. It will conflict trivially with P25-05's `transcript()`.
- `apps/web/src/panel/Panel.tsx`: the main area renders `<Conversation>` instead of `ChatBox` (import and one JSX line).
- New files: `state/conversation.ts`, `panel/chat/{Conversation,InlineCards}.tsx`, `panel/chat/chat.css`.

## Deferred

- **Markdown rendering** of the brain's replies. Text is shown as is (`pre-wrap`, no HTML).
- **No cap on a thread's entries.** It holds only messages and text replies, for the page's life. It could be capped with a "reload" marker if long sessions grow it.
- **"Show tools and thinking"** in the brain chat. The transcript endpoint has them; the ops console keeps its toggle.
- **A brain's previous Harmonizer sessions** (an old Harmonizer agent row): the chat shows the current Harmonizer's conversation only.
- **Old unmarked turn prompts** still show (see the decision). A one-off migration could mark them by their opening line if dogfooding finds them in the way.
- **Search** in a conversation (SPEC §4.2 history view): later.

## Tests

- `apps/web/src/state/conversation.test.ts` (8):
  - Merge: dedup, order, and the history copy wins.
  - Live entries.
  - Paging: newest page then back to the start, with no duplicates or gaps and the right cursors.
  - Catch-up after a snapshot and on reopen, with `liveFrom`.
  - Another log; a failed read.
  - Card routing: Waykeeper, Harmonizer, Steward.
  - Card placement, with older cards held back.
- `apps/web/src/panel/chat/Conversation.test.tsx` (6):
  - History and live merged across the `lastSeq` seam. The subscription is opened after the page, with `since = lastSeq`. Duplicates are absorbed, tool chunks hidden, turn prompts hidden.
  - Paging back.
  - Snapshot catch-up.
  - The composer: Enter sends to the selected Waykeeper; "sending…" until the `message.sent` arrives.
  - The Harmonizer's work card inline between the request and the reply, approved from the thread.
  - A Waykeeper's plan card and a Steward's status report, without the Harmonizer's card; the plan folds once approved.
- `apps/web/src/panel/chat/chat-run.test.tsx` (1, acceptance, real server):
  - Setup: the composed runtime behind Fastify, the real Harmonizer and Waykeeper definitions with P2-07 scripts, the transcript fed from `conversationSince`.
  - A request typed in the panel produces the proposal card in the same thread, after the request, with the brain's reply.
  - Approved inline: the Waykeeper's thread shows its plan card and reply.
  - Back to the Harmonizer in one click: the history is reread without duplicates.
- `apps/server/src/http/panel-routes.test.ts` (+1): turn prompts are left out of a page and out of paging.
- `apps/server/src/brains/runner.test.ts` (+assertions): a turn message carries `turn: true`; the user's lines do not.
- Totals: protocol 61, server 828 (+1 skipped), web 80.
