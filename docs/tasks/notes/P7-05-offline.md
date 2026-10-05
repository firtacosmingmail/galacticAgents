# P7-05 — Offline answer reconciliation

Design: TECHNOLOGY §6.3 ("Offline answers (P7-05)"); IMPLEMENTATION_PLAN corner cases 23, 27, 28; SPEC §2.6 (first answer wins), decisions 7/12 (question kinds, supervisor answers), 90 (remote clients may answer).

## What was built

**Server (idempotency; the stale check already existed).**
- `POST /api/questions/:id/answer` already refused a stale `version` and a closed question with 409 `stale` and "already answered by …" (P2-01/P2-18; tests in `console-routes.test.ts`). A retry after a lost acknowledgement was refused the same way, because every user answer is `{type: 'user'}` — the page could not tell its own earlier answer from another device's.
- New: `AnswerBody.answerId?` (client idempotency key, ≤ 100 chars), `AnswerResponse {ok, duplicate?}`, `QuestionAnswered.answerId?`, `AnswerQuestionInput.answerId?`. The answer stores it on the row as `meta.answerId` (`ANSWER_ID`, `answerIdOf`, `isRecordedAnswer` in `domain/questions.ts`); no migration (the `meta` JSON column). The web reducer folds it the same way, so the conformance tests still compare equal.
- `Commands.answerQuestion`: an answer already recorded under the same `answerId` returns `{value, events: []}` before any check (the route answers `200 {ok: true, duplicate: true}`); a retry while the first copy is still being handed to a live session's adapter waits for it (`answering` map keyed `<questionId> <answerId>`), instead of "already being answered". `AgentRuntime.answer(…, answerId?)` records it on the delivered answer.

**Web.**
- `apps/web/src/client/answer-queue.ts`: one zustand store (`useAnswerQueue`), one entry per question (`queued` → `sending` → `sent` | `not_sent{reason: stale|withdrawn|gone|refused}`). `submitAnswer(api, question, text)` is the only answer path of the panel's cards; `startAnswerQueue(token, api)` is wired in `startSession`; `clearAnswerQueue` in `forgetToken`.
  - Queued when the stream is `disconnected` / `connecting` / `catching_up`, when `navigator.onLine === false`, or when the send gets no reply (fetch rejects, or a non-JSON body such as a proxy's 502 page). A server refusal (an `ApiError`) on a direct send is thrown as before, so the existing stale banner and error lines are unchanged.
  - Sent on the transition to `live` (the client sets it only after the snapshot or `caught_up` was applied, so the page already holds what happened meanwhile), on the window's `online` event, and when another tab changes the stored queue; oldest first, one at a time. A network failure re-queues and retries after 5 s with the same `answerId`; a 401 keeps it for the next session.
  - Persistence: `localStorage['galactic.answers.queue'] = {v: 1, scope, entries}`. `scope` is an FNV-1a fingerprint of the token, never the token; the text of the answer and of the question are stored (both already on the server and in the page). An entry caught mid-send by a reload comes back `queued`. A session with another token clears the queue when it goes live (not before: a mistyped QR token falls back to the saved one without losing anything); forgetting the token clears it. "Sent" notices are page-only. Every storage access in try/catch.
- `apps/web/src/panel/cards/QueuedAnswer.tsx`: `QueuedAnswerBox` (in place of a card's answer controls: "queued — Your answer “…” will send when reconnected" + **Cancel queued answer**, which puts the focus back on the answer field / first button), `AnswerNotice` ("Sent: …" or "Not sent: … — <why>" with **dismiss**, and **Send again** at the question's current version when the question is still open), `OfflineAnswers` (the inbox's list of outcomes and of queued answers whose card is not on screen — including a reload before the snapshot), `AnswerQueueAnnouncer` (one polite visually hidden live region next to `WaitingAnnouncer`: queued, cancelled, sent, not sent and why), `OfflineDecisionNote` / `useStreamDown`.
- Wired into `QuestionCard` / `QuestionView` (inbox, chat threads, ops console hierarchy), `ClarificationComposer` and `StewardPanelView` (its own questions' outcomes), `Inbox`, `Panel`. Styles in `app.css`: static borders, nothing animates (reduced motion has nothing to turn off).
- "Who" in "already answered by …" comes from the folded world after the catch-up: the row's `answeredBy` user with a different `meta.answerId` → "you on another device or tab"; an agent → its label + "(its supervisor, from context)"; `system` → "the permission policy" for a permission, else "the system". Before the world arrives (a reload while offline) the server's message is mapped to the same words.
- **Card decisions are not queued** (decided here; proposed SPEC text below): proposals carry no version, so a queued approve/reject could not detect that the card changed or was decided elsewhere, and an approval starts work. While the stream is down the proposal and plan cards disable their decision buttons and say "Offline: decisions on cards are not queued — they wait for the connection. Answers to questions are queued." The service worker is not used.

## Tests

- Server `console-routes.test.ts` (+4): duplicate retry is `ok, duplicate` and logs nothing; another `answerId` is 409 `stale` "already answered by the user"; a stale version with a fresh `answerId` is still refused, a withdrawn question is 409 non-stale; a retry while the adapter still takes the first copy waits for it (live fake session), then a further retry is a duplicate.
- Web `client/answer-queue.test.ts` (18): queued while offline, persisted without the token; send only after the catch-up (the replayed event is applied when the request leaves); oldest first, one at a time; survives a reload; mid-send entry re-queued with the same `answerId`; token change clears (only once the new session is live), forget clears; cancel; lost acknowledgement → same `answerId` resent, `duplicate` resolves it; network failure keeps it queued; `navigator.onLine` false + `online` event; another tab's queue read in and sent; wording for another device, a supervisor, the permission policy, an escalated question, withdrawn / unknown, before the world arrives; 401 keeps it queued.
- Web `panel/offline-answers.test.tsx` (7, App over the fake socket): queued state on the card, live region, axe (no serious/critical), Cancel with focus back to the field; the send after `caught_up` and "Sent"; "Not sent: … already answered by you on another device or tab: “no”" with dismiss (axe again); an escalation while offline → "changed while you were offline (now held by Harmonizer)", **Send again** sends version 4 with a new `answerId`; proposal cards disabled with the note while down; the Steward composer's queued state and Cancel focus; a stored queue sent by the next page.
- Existing answer-body assertions (inbox, conformance §4.2/§4.3, hierarchy console) now expect `answerId: expect.any(String)`.

## Airplane-mode check (headless Chrome, CDP)

`docs/tasks/notes/P7-05-airplane.mjs` (Node 22, no dependencies). Real server from the production build on `127.0.0.1:47851` (`GALACTIC_HOME` in a scratch dir, `GALACTIC_DEV=1`, `GALACTIC_HARMONIZER=off`, `GALACTIC_TOKEN=p705-test-token`, `GALACTIC_WEB_DIR=apps/web/dist`); Chrome headless on CDP port 9547 with a scratch profile; harness Steward questions (`/dev/harness/scenario`, `/dev/harness/agents/:id/question`). Each tab in its own browser context (own storage). **25/25 checks passed** (2026-10-05):

1. Tab A offline (`Network.emulateNetworkConditions offline`): answer Q1 → card shows "queued … will send when reconnected", announced, nothing on the server, queue stored without the token; back online → "Sent: your answer …", the server's row has the answer and `meta.answerId`, the card leaves the waiting list.
2. Stale: tab A offline answers Q2 ("from the phone"); tab B (another context, online) answers Q2 through its card ("from the laptop"); tab A online → "Not sent: your answer “from the phone” … — already answered by you on another device or tab: “from the laptop”"; the server kept the laptop's answer.
3. Tab A offline answers Q3, reloads while offline (the service worker serves the shell): the queued answer is listed before any world arrives; online → sent, on the server.

Findings: Chrome's offline emulation does **not** close an open WebSocket (the bar stayed "live"), so queueing on `navigator.onLine === false` and flushing on `online` were added; on a real phone the socket does die and the reconnect path applies. The first runs failed because leftover tabs of earlier runs shared the default profile's storage and, being live, sent the offline tab's queue (correct per "one queue per browser", wrong for the test): the script now closes old pages and uses isolated contexts.

## Decision 96 (now in SPEC §7)

**96. Answers given offline are queued; card decisions are not.** An answer the user gives while the connection is down (or whose send got no reply) is kept on that device with the question's version and sent when the connection is back, after the page has caught up; the user sees it as queued ("will send when reconnected") and can cancel it until then. If someone answered first (the user on another device, a supervisor from context, the permission policy) or the question changed or was withdrawn, the queued answer is not sent and the page says so and by whom; for a question that only changed hands, the user may send it again. Retrying an answer the server already recorded is harmless (it is recognised, not refused). Decisions on cards (approve, edit, reject, park) need the connection and are never queued: offline, cards say so and wait. The queue belongs to the device and the token; it survives a reload or app restart and is cleared when the token changes or is forgotten.

## Phone checklist (fold into P7-06)

Prerequisites: P7-02's Tailscale Serve; the PWA installed (P7-01); a harness or real question held by the user.

1. Open the app on the phone, see a question in the inbox. Turn on **airplane mode**; the bar goes to disconnected within a few seconds.
2. Answer the question (a clarification by typing, a permission by Allow). The card shows "queued — Your answer … will send when reconnected" with **Cancel queued answer**. VoiceOver/TalkBack announces "Answer queued…".
3. Cancel it: the answer controls come back with focus on them. Answer again.
4. Force-quit the PWA (or reload) while still in airplane mode; reopen: the inbox lists the queued answer (the world comes later).
5. Turn airplane mode off: once the bar is live the answer is sent; "Sent: your answer …" appears, the question leaves the inbox, the Mac shows it answered.
6. Stale: airplane mode on, answer another question on the phone; on the Mac answer the same question differently; airplane mode off: the phone shows "Not sent: … — already answered by you on another device or tab: “<Mac's answer>”"; the Mac's answer stands.
7. A proposal card while offline: its buttons are disabled with "Offline: decisions on cards are not queued"; they work again once live.
8. Forget the token (settings) with something queued: the queue is gone after re-pairing.

## Left / follow-ups

- Same-browser tabs share one queue: a live tab sends what an offline tab queued (idempotent, by design). Different browsers/devices each keep their own.
- "Sent" notices disappear after 15 s or on dismiss and are not persisted; a "Not sent" notice stays until dismissed (persisted).
- The ops console's dev-only Agents console and scene harness keep their direct `api.answer` calls (not queued).
