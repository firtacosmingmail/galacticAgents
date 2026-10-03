# P25-06 — Question inbox, proposal and plan cards

## What was built

- **Shared cards, `apps/web/src/panel/cards/`.** P2-18's question, proposal and plan cards moved here, so the panel's inbox, the chat thread (P25-03), the Steward view and the ops console all render the same components.
  - The console's `QuestionInbox.tsx` and `ProposalCards.tsx` keep only their lists and render the shared cards. `/debug` behaves as before, and its 16 component tests and the exit run pass unchanged.
  - `QuestionInbox.tsx` re-exports `QuestionCard` and `OriginContext`, and `ProposalCards.tsx` re-exports `ProposalCard` and `TRUST_HINTS`. Existing imports, such as `StewardView`'s, keep working.
- **What the cards add over P2-18:**
  - The origin line names the body as well (`· on Luna`).
  - With links on, the origin agent and a plan's Waykeeper carry an **"open agent"** link. It is a real `<a href>` that navigates in place through the store's `navigate`, so it uses the same selection as the navigation (decision 53).
  - A question card shows its own stale banner when no `onStale` handler is given.
  - An approved proposal renders read-only, with its `carriedOut` outcome.
  - `QuestionView` and `ProposalView` render a question or a card by id, in whatever state the store holds it.
- **The panel inbox, `panel/Inbox.tsx` and `panel/inbox-model.ts`.** It replaces the right column's `QuestionInbox` and `ProposalCards`. `inboxModel(world)` is pure. The groups, in order:
  1. **Waiting for you**: open questions the user holds and `pending`/`edited` cards. Permissions come first (a Steward is stopped on a tool call), then clarifications, then cards, each group oldest first. A beacon gives the count, and these cards carry the amber edge.
  2. **Parked — no free body**: the occupied bodies and their occupants, plus the offers. Downsizing is one click. Close early works through the completed occupant's controls on the card.
  3. **Held by supervisors**: still answerable by the user.
  4. **Answered by supervisors**: the last 10, newest first, read-only with `answeredBy` and the Override (decision 48).
  5. **Rejected cards**: collapsed.

  Stale refusals stay at the top as "Not sent: already answered by <who>: "<answer>"" until dismissed. They are worded from the folded world.
- `Panel.tsx` wraps its content in `CardLinksContext.Provider value={true}`, so every card inside the panel, P25-03's thread included, gets the "open agent" links.

## Card API (for P25-03 and the others)

Import everything from `apps/web/src/panel/cards/index.js`. Every card needs `ApiContext` (from `console/hierarchy/shared.js`) above it; the panel provides it. The cards read the store only, so the same question or card renders the same everywhere and updates when the stream brings the change.

| Export | Props | Use |
| --- | --- | --- |
| `QuestionView` | `{ questionId: Id }` | **For a chat thread.** It renders the open card, the answered card (with Override when a supervisor answered), or "Withdrawn: …". A stale refusal stays above it as a banner, even after the card turns into the answered one. It renders nothing for an unknown id. |
| `ProposalView` | `{ proposalId: Id }` | **For a chat thread.** It renders the work card, the plan card, or the read-only approved card. It renders nothing for an unknown id. |
| `QuestionCard` | `{ question: Question; onStale?: (questionId, message) => void }` | An open question. Answers carry `question.version`. Without `onStale`, the card shows its own banner. |
| `AnsweredQuestionCard` | `{ question: Question }` | Read-only. The Override box appears only when `answeredBy` is an agent. |
| `ProposalCard` | `{ proposal: Proposal }` | It dispatches by state and by `meta.plan`. `WorkCard` and `PlanCard` are exported too. |
| `OriginContext` | `{ question }` | The "from … · task … · project … · on <body>" line, with the last events. |
| `StaleBanner`, `staleLine(world, questionId, message)` | | The "Not sent: …" banner and its wording. |
| `AgentRef` | `{ agentId }` | The agent's label, plus an "open agent" link when `CardLinksContext` is true. |
| `CardLinksContext` | boolean context, default `false` | The panel sets it to `true`. `/debug` leaves it unset. |
| `OPEN_PROPOSAL_STATES`, `TRUST_HINTS`, `carriedOutLine`, `selectionFor` | | Helpers. |

Accessible names, for tests:
- Cards are `article`s labelled `"<kind> question <text>"`, `"answered question <text>"`, `"proposal <requestText>"` or `"plan <requestText>"`.
- Inputs are labelled `answer`, `override`, `reason` and `edit card`.
- Links are labelled `open <agent label>`.

## Acceptance (`apps/web/src/panel/Inbox.test.tsx`, 10 tests, `<App/>` over the fake socket)

- **Answering in the inbox resolves the question in the chat thread too.** A second tree renders `<QuestionView questionId>`, as P25-03's thread would. The user answers in the inbox, and the POST carries `version: 3`. The stream then brings `question.answered`. After that:
  - the store has the question answered;
  - the inbox says "Nothing waits for you.";
  - the thread shows "you answered: “yes”", with no answer box;
  - the top bar no longer counts it.

  The reverse direction (answer in the thread, the inbox empties) is a second test.
- **"Already answered by …" on a stale answer.** Both the inbox and the thread POST the answer and receive a 409 `stale`. The stream then says the Waykeeper answered. Both places show "Not sent: already answered by Waykeeper · Auth refactor: "yes"". The thread's card becomes the read-only answered card with Override.
- **Other tests:**
  - the ordering (permission, then clarification, then cards, then parked, held and answered);
  - the card details and "open agent", which selects the Steward and sets the URL;
  - permission allow/refuse;
  - supervisor-held and supervisor-answered questions, with Override;
  - a work card's approve, inline edit (workspace, git init, trust level) and reject with a reason;
  - a parked card's occupied bodies and its downsize offer;
  - a plan card's approve, its task controls, and the read-only view after `proposal.approved`, both in the inbox and in a thread.

## Decisions (recorded as SPEC decision 58 — with a fifth, folded group, rejected cards — and TECHNOLOGY §6.3 "Shared cards", which corrects the claim below: the Steward view renders its clarification box itself, with the shared stale line; the text below is the original proposal)

- **SPEC §4.2 addition, inbox order (decision N):** the inbox lists, in this order:
  1. what blocks on the user: permission questions, then clarifications they hold, then the cards waiting for their decision (work and plan), each oldest first;
  2. parked cards;
  3. questions supervisors hold;
  4. the last ten questions supervisors answered, newest first.

  Every card names its origin agent with an "open agent" link that selects it. A refused stale answer stays at the top as "Not sent: already answered by …" until dismissed.
- **TECHNOLOGY §2.1 / §6.3 note:** question and proposal cards are store-driven components keyed by id (`QuestionView` and `ProposalView`). Every place that shows a question (inbox, chat thread, Steward view) renders the same component over `world.questions`. So an answer anywhere resolves everywhere, with no client-side coordination: `question.answered` on the stream is the only signal.

## Shared files touched

- `apps/web/src/panel/Panel.tsx`: the imports, the `CardLinksContext` provider around the layout, and `<Inbox />` in place of `<QuestionInbox /><ProposalCards />` in `SideColumn`.
- `apps/web/src/console/hierarchy/QuestionInbox.tsx` and `ProposalCards.tsx`: reduced to their lists, plus the re-exports.
- No edits to `state/store.ts`, `packages/protocol` or the server routes.

## Deferred

- The deny label: the permission card still reads **Refuse** and sends `no`, as on `/debug`; the console's tests pin it.
- `task_on_planet` stays a text offer, as in P2-18. A by-hand **Park** button is still not offered.
- Selecting a proposed project with no agent, so its card opens from the navigation (P25-02's deferral), is not done.
- Card styling is P2-18's, plus `panel/inbox.css`. A visual redesign is left to Phase 5.
