# P8-17 review (reply to a message in the chat)

Independent review of `p8-chat-replies` against `main`, 2026-10-14: the acceptance criteria and
Cosmin's answers, security of the quote and of the answer path, the double-notification fix,
idempotency, the protocol boundary, the web (a11y, phone, motion, paging) and the docs. No
blocker. Fixes on the same branch, with tests.

## Checked and sound

- **Permissions are never decided by a reply** (decision 7). Only a `clarification` enters the
  answer path in `POST /api/agents/:id/send`; a permission request is quoted, the turn prompt says
  the reply does not decide it, and the route test proves the question stays open with no
  `question.answered`.
- **The quote comes from the log only.** `SendBody.replyTo` is a `ReplyRef` (kind, id, version,
  answerId): zod strips any client text. `resolveReplyTarget` reads the message by
  `agentId` + `messageId` (turn prompts refused), the reply chunk by the agent's own id (another
  agent's `r:` id refused), cards by the same `threadShowsQuestion` / `threadShowsProposal` rules
  the panel uses. Everything quoted was already readable in that chat by any client that can send
  there (remote clients included, decision 90); the quote is redacted and capped at 2,000.
- **No new reach for an agent's process.** The send route had no peer guard before; through
  `replyTo` it can now answer a clarification, which `POST /api/questions/:id/answer` already
  allows from anywhere. A permission is not answerable through `replyTo`, so the `answersPeer`
  speed bump is not bypassed.
- **`question.answered.repliedIn`.** Only the brain whose chat it was skips the answer line (it
  reads the reply's own line instead); earlier holders and the asker still wake. The rule is in
  `WAKE_RULES`, so `requeue` (resume) applies it the same way. Both new fields are optional
  fields of the event JSON: no table, projection or migration; export/import validates them with
  the same schemas; `message.sent` is not replayed into tables.
- Protocol boundary: the new types live in `packages/protocol/src/reply.ts`; no SDK import
  outside the adapters. `threadCards` now uses the protocol's rules (same behaviour, tests kept).
- Web: Reply buttons have names ("Reply to Harmonizer: …"), are revealed on focus, always shown
  and 44 px on touch; quote blocks are buttons with a full name; lines and cards take focus
  (`tabIndex=-1`) when jumped to; axe clean in the jsdom tests; the opacity transition is off
  under reduced motion and `scrollIntoView` is not smooth then; slash completion and ↑ history
  keep working with a quote open (test).

## Findings (fixed)

- **R1 (medium) — answer recorded, message refused.** The clarification was answered before
  `runtime.send`, which refuses a stopping or gone agent: the asking agent had the answer, the
  chat had no line, the user saw an error, and the chat's brain never heard of it (`repliedIn`
  silenced its `question.answered` line). Now `AgentRuntime.sendRefusal` is checked before the
  answer (409 `rejected`, nothing answered). A stop that begins during an adapter answer is the
  remaining window; the retry (R2) completes it.
- **R2 (medium) — a retry logged the line twice.** A retry with the same `answerId` (a lost
  acknowledgement) was a duplicate answer but a second `message.sent` and a second supersede. The
  send is now idempotent on `answerId`: when the answer was recorded under it, the route returns
  the chat's message that answered the question (`answeredReplyOf`), or sends it if the first
  try's message failed. The panel used to drop `version`/`answerId` once the card showed answered,
  so its retry became a plain reply; it now keeps them when the row's `meta.answerId` is the
  draft's. Known limit: two tries in flight at the same moment can both log the message.
- **R3 (medium) — the jump could hammer the server.** `loadOlder` keeps `hasOlder` on a failed
  page, so a failing history made the jump fire up to 40 requests back to back, then say "no
  longer in the history". A page that fails or moves no cursor now ends the search after one
  request, without the "no longer" note (the thread shows the history error).
- **R4 (low) — jump and highlight after unmount.** The paging loop went on after the chat closed
  (another agent selected) and its `setMissing` ran on an unmounted component; the highlight
  timers were not cleared and a second jump's highlight could be cut short by the first's timer.
  The loop stops when the chat unmounts; one highlight timer, cleared on unmount and replaced on a
  new jump.
- **R5 (low) — a reply redelivered after a restart lost its quote.** A Steward or free-form agent
  received `(replying to …)` before the text, but a message still queued at a shutdown was
  redelivered from the log's text alone. Recovery now prefixes the quote again.

Tests: `reply-routes.test.ts` (retry returns the same message, one `message.sent`, one
`question.answered`; a stopped chat agent answers nothing), `recovery.test.ts` (redelivered reply
keeps its quote), `reply.test.tsx` (a failing page is one request and no "no longer" note; a
retry after the answer was recorded sends the same `version`/`answerId`). TECHNOLOGY's replies
paragraph updated.

## For Cosmin to confirm

- A retry of a reply that answered a clarification, after its message failed (the chat agent
  stopped), sends the message once the agent runs again — or returns 409 again while it does not.
  The question stays answered either way (the asking agent got it). Acceptable?
