# Question sets and the one-screen phone layout — design

Date: 2026-10-18 · Status: approved by Cosmin (2026-10-18)

Two independent improvements, brainstormed together. They ship as separate
Phase 8 tasks (next free IDs from P8-18) and can be built in either order.

---

## Part 1 — The question-set card

### Intent

When the Harmonizer or a Waykeeper needs several answers at once (typically
clarifications on a plan), today they put every question in one `ask_user` /
`escalate` text and Cosmin writes one long chat reply covering each. It is
easy to lose track of which answer belongs to which question, and the brain
has to parse free prose. The goal: those questions arrive as **one card** that
walks through them one at a time, each with options and a write-in answer.

### What Cosmin decided

- **Step through, one question per page.** The card shows one question at a
  time, with a progress bar and an "n of N" pill. Each question shows its
  options as buttons and always a free-text "write your own answer" box.
  Controls: **Back**, **Skip**, **Next**.
- **Review page at the end.** After the last question, a review page lists
  every question with its answer (skipped ones marked "skipped"). Any row can
  be tapped to jump back to that question. The send button reads
  "Send N answers".
- **All answers at once.** The asking brain receives nothing until Cosmin
  presses send; then it receives every answer together, in one wake.
- **Skip and send the rest.** A question may be skipped; the set can be sent
  with skipped questions. The brain is told explicitly which were skipped.
- **Answers are kept.** Leaving mid-set and coming back later resumes where
  Cosmin left off, with the answers given so far intact.

### Behaviour confirmed in playback (proposed by Claude, accepted by Cosmin)

- **Drafts live on the server**, so a set started on the phone can be finished
  on the laptop. (A browser-local draft is not enough.)
- **Placement is the same as single questions today**: the card appears in the
  inbox (Waiting) and inline in the asking brain's chat thread
  (decisions 52/55); answering in one place resolves both.
- **Clarification only.** Permission questions keep their own Allow/Refuse
  card and policy path — an LLM never decides them (SPEC §2.6). A set never
  contains a permission question.
- **Multi-select per question.** A question may allow several options to be
  picked. This replaces the "separate the labels with commas" workaround.
- **Stewards too.** When a Steward's `AskUserQuestion` (Agent SDK) or an ACP
  elicitation form carries several questions, it becomes one set card instead
  of being split into separate questions asked one after another
  (`TECHNOLOGY.md` §… on splitting, `claude-sdk-adapter.ts` ~:78, :800-810).
  The Steward's session still blocks until the set is sent, and receives the
  answers as its tool result.
- **Supervisor first, exactly as today (Cosmin chose this over "sets always
  reach Cosmin").** A Waykeeper's set routes to its supervisor (normally the
  Harmonizer, decision 26) like a single question; a project Steward's set
  goes to its Waykeeper first, then on up. At each level the supervisor may
  answer any of the questions from context:
  - **All answered** → the answers go straight back to the asker; Cosmin sees
    no card, only the logged supervisor answers (as for single questions).
  - **Some answered** → those answers go back to the asker **at once**, and
    the remaining questions move up; at the top they reach Cosmin as one set
    card.
  - **None answered** → the whole set moves up unchanged.
  So the "everything at once" rule is per answerer: Cosmin's answers arrive
  together when he presses send; a supervisor's answers arrive together when
  the supervisor answers. The asker may therefore receive a set in up to one
  delivery per answerer. Every supervisor answer is a real, logged answer
  event at the moment it is given (as today), and the asker is told who gave
  each answer.

### Goals

- One card per batch of related questions, answerable step by step on a phone.
- The brain gets structured answers: per question, the chosen option(s), the
  written text, or "skipped".
- One wake per delivery (per answerer), never one per question.
- Works in the inbox and chat on desktop and phone, offline-queued like
  today's answers (P7-05).

### Non-goals

- Changing how single questions look or work. A brain asking one question
  still uses today's card.
- Batching permission questions.
- Conditional questions (question 3 depends on the answer to question 2).
  A brain that needs that asks a second set.
- Letting Stewards' questions reach Cosmin without the existing supervision
  rules.

### Anti-goals (it fails even if it technically works when…)

- Cosmin loses answers already given (refresh, device switch, reconnect,
  server restart).
- The brain is woken per question, or receives Cosmin's answers piecemeal
  before he presses send.
- Which answer belongs to which question is ambiguous to the brain.
- A permission decision sneaks into a set.

### Constraints (from the repo)

- Domain mutation + event insert in one transaction; questions are a
  projection over the event log. A schema change needs a migration;
  speculative fields go in `meta`.
- Types belong in `packages/protocol` (zod); nothing outside
  `apps/server/src/adapters` imports a runtime SDK.
- Brain ask tools end the turn (`endsTurn: true`); answers arrive as a mailbox
  wake (`brains/wake.ts`). Stewards block in their adapter session.
- Today's `QuestionContext.options` is `string[]` and `question.answered.answer`
  is a single string; the UI always shows a free-text box beside options.
- Reply-to-message (P8-17, decision 139): a reply to an open clarification
  answers it. For a set, the conservative behaviour is that a chat reply does
  **not** answer the set (the card is the way to answer it) — Claude's call.
- Dismiss (decision 135) and "allow similar" (decision 138) exist for single
  questions.
- Record the new behaviour as SPEC §7 decisions and the protocol/storage
  design in `TECHNOLOGY.md` in the same commits (repo rule).

### Calls Claude made (Cosmin can overrule)

- **A forwarded set is the asker's set, not a new one.** The card carries the
  asker's name with the route, e.g. "Waykeeper · galactic-web, via
  Harmonizer", and appears in the inbox and in the asker's chat thread.
  Supervisors may answer questions but may not reword, merge or drop them.
  (This replaces today's single-question habit of the Harmonizer re-asking in
  its own words with `ask_user`.)
- **Questions a supervisor already answered are shown read-only** on Cosmin's
  card — on the review page, marked "answered by Harmonizer" (or Waykeeper) —
  for context. They have already been delivered, so Cosmin cannot change them
  there; if one is wrong he tells the asker in chat.
- **A chat reply does not answer a set**; Reply on a set card opens the card
  instead.
- **Dismissing a set** dismisses the whole set (the brain is told, as for a
  dismissed question). No per-question dismiss — Skip covers that.
- **Draft saving does not wake anyone.** Saving progress is a draft update
  only; the single "send" is the only user-facing answer event.
- **Inbox count** treats a set as one waiting item, labelled with the number
  of questions ("4 questions").

### Left to the builder

- Data model: a new `question_sets` grouping (set id on each question vs one
  question row carrying a `questions[]` context vs a new aggregate), the
  event names, and how drafts are stored and emitted (one draft event per
  change, debounced; or a separate draft table outside the event log —
  decide against the "one transaction" rule and say why in TECHNOLOGY).
- Option shape: whether options gain ids/descriptions and a `multiSelect` flag.
- Tool surface: a new `ask_user_set` / extended `ask_user({questions:[…]})`
  for the Harmonizer, the matching Waykeeper `escalate` shape, and the
  supervisor's "answer some, pass the rest up" tool (the Harmonizer has no
  `escalate` today; it needs a way to forward the remainder to Cosmin).
- Whether a Steward (which blocks) gets a partial tool result when a
  supervisor answers some questions, or the adapter holds the result until
  every question in the set is resolved (sent by Cosmin or answered by a
  supervisor). Holding is the conservative default.
- Two devices editing the same draft: latest save wins per question.
- The wake line format the brain sees for a sent set.
- Limits (max questions per set, max options) and validation.
- Steward adapter mapping (Agent SDK `AskUserQuestion`, ACP elicitation) to a
  set and back to the tool result.
- Visual details within the step-through layout (mockup:
  `.superpowers/brainstorm/…/question-set-card.html`, option A).

---

## Part 2 — One screen at a time on phones

### Intent

On a phone today, the inbox and managed-agent cards scroll in the top part of
the screen while the conversation is docked in the bottom ~45% (resizable).
Both are cramped. Cosmin wants **one main screen at a time**: the chat with
the selected brain (Harmonizer or a Waykeeper), or the inbox, or the managed
agents.

### What Cosmin decided

- **Inbox button in the top bar**, with a notification dot while anything is
  waiting. Pressing it shows the inbox **full screen**; closing it (✕) returns
  to the chat.
- **The chat keeps the unsent text** in the composer while the inbox (or the
  agents view) is open.
- **Managed agents get the same treatment**: a top-bar button opens them as a
  full-screen view, closed the same way.
- **Phone only.** Desktop keeps the inbox in the side panel.
- **When the 3D scene is shown**, keep today's way of displaying the chat
  (scene on top, docked conversation below).

### Behaviour confirmed in playback (proposed by Claude, accepted by Cosmin)

- "Phone" = the compact-top-bar breakpoint (`COMPACT_TOP_BAR_QUERY`,
  ≤760px). The stacked tablet layout (761–1100px) is unchanged.
- The default phone screen is the chat filling the space below the top bar,
  with no dock handle and no list above it. Switching brains still goes
  through the ☰ Agents sheet (P8-15) and "← Harmonizer".
- The Inbox button replaces the current "N waiting for you" text in the
  compact top bar (which today scrolls to the inbox via `revealInbox`).
- With the scene shown, the Inbox and Agents buttons still open their
  full-screen views; the inbox and agent cards are no longer in the list
  under the scene.
- Questions are answered inside the full-screen inbox; it does not navigate
  to the asking brain's chat.

Mockup: `.superpowers/brainstorm/…/mobile-single-screen.html`.

### Goals

- On a phone, the chat uses the whole screen below the top bar.
- The inbox is one tap away and visibly signals waiting items.
- Nothing typed is lost when switching views.

### Non-goals

- Changes to desktop or tablet layouts.
- A bottom tab bar or swipe navigation between views.
- Redesigning the inbox or agent cards themselves.

### Anti-goals

- The composer draft is lost on switching views or rotating the phone.
- A waiting question is invisible (no dot) because the inbox is hidden.
- The page scrolls as a whole (decision 71: the page never scrolls).

### Constraints

- Layout lives in `apps/web/src/panel/Panel.tsx`, `panel.css`,
  `use-media-query.ts`, `TopBar.tsx` / `CompactTopBar`, `nav-sheet.tsx`,
  `dock-state.ts`.
- Phone default is list mode (decision 94); the scene is opt-in.
- Existing decisions touched: 67 (compact top bar), 71 (docked conversation),
  75 (hidable inbox), 94, 117 (nav sheet). Record the new layout as a SPEC §7
  decision that amends them.

### Calls Claude made (Cosmin can overrule)

- **The dot shows when at least one item is in "Waiting for you"**; held-by-
  supervisor items do not light it. A count next to the icon is fine if it
  fits.
- **Android/browser back closes the full-screen view** (back to chat) rather
  than leaving the app.
- **The open view is not remembered across reloads**; a reload lands on the
  chat. The composer draft survives a reload only if it already does today.
- **Opening a push notification for a question** lands on the inbox view.

### Left to the builder

- Icons, button order in the top bar, transition animation.
- Whether the views are routes, state in the panel, or overlays — as long as
  the composer is not unmounted (or its draft is held outside it).
- How the managed-agents view reuses `SideColumn`'s components.
