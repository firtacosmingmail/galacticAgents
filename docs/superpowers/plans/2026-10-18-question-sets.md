# Question Sets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brain (Harmonizer, Waykeeper) or a Steward can ask several clarification questions as one **set**; the user answers them on one step-through card (options + write-in, multi-select, skip, review, send all at once) with drafts saved on the server; supervisors may answer part of a set from context and pass the rest up, exactly as single questions work today.

**Architecture:** A set is **N ordinary question rows sharing `context.set = {id, index, total, title}`** — routing, escalation, orphan reassignment, holders, versions and the Steward adapter's per-question `answer()` keep working unchanged. New domain commands open, answer, draft and dismiss a set in one transaction each; answers carry a structured `detail` beside today's `answer` string (the string stays what brains and adapters read). Drafts are `question.drafted` events folded into `meta.draft` (precedent: `meta.answerId`, `meta.cancelledBy`) — no migration. The web groups rows by set into one inbox item / thread card rendered by a new `QuestionSetCard`.

**Tech Stack:** TypeScript, zod (`packages/protocol`), Fastify + better-sqlite3 (`apps/server`), React 19 + zustand (`apps/web`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-question-sets-and-phone-single-screen-design.md`, Part 1.

**Tickets** (append to `docs/tasks/PHASE_8_HARDENING.md`): **P8-19** question sets — protocol, domain, routes, brain tools (Tasks 1–4); **P8-20** Steward multi-question asks as one set (Task 5; depends on P8-19); **P8-21** the question-set card (Tasks 6–7; depends on P8-19; parallel with P8-20). Batch branch `p8-19-question-sets` from `main`; P8-20/P8-21 in worktrees branched from it.

## Global Constraints

- Clarification only. `openQuestionSet` refuses any permission content; a set never contains a permission question.
- Limits (`QUESTION_SET_LIMITS` in protocol): 2–10 questions per set, 0–8 options per question, title 1–120 chars. One question → use the single-question path (tools say so).
- The user's send must resolve **every** open row of the set the user holds (each answered or skipped); the asker receives Cosmin's answers in **one** transaction → one wake. Refuse a partial user send (`invalid`).
- A supervisor's answers in one call land in one transaction; the rows it did not answer move one living level up in the **same** transaction (Harmonizer → user). The asker is told who gave each answer.
- Skipped answer string (what brains/adapters read): exactly `(skipped by the user)`; `detail.skipped = true`.
- Answer string for a choice answer: choices joined with `, `; if `text` is also given, `"<choices> — <text>"`; text only → the text.
- Multi-select: `multiSelect: true` allows ≥1 choices; otherwise ≤1. Choices must be among the question's `options`.
- Drafts: only the user, only on open rows the user holds; saving a draft wakes no one and does **not** bump `version`; an answer or cancellation clears `meta.draft`. Last save wins per question.
- Set rows refuse the single-question tools and routes: `answer_question`, `escalate({questionId})`, `POST /api/questions/:id/answer`, `/dismiss` → `invalid` with "part of set <id>: answer or dismiss the set". A chat Reply to a set row never answers it (quote only).
- Dismissing dismisses every open row of the set (one transaction); the asker is told once per row as today's dismissal text.
- Inbox: a set the user holds counts as **one** waiting item, labelled "<n> questions".
- Supervisor-answered rows of a set are shown read-only on the user's card (review page, "answered by <supervisor>").
- Nothing outside `apps/server/src/adapters` imports a runtime SDK; every new type lives in `packages/protocol`.
- Docs in the same work: SPEC §7 decision **141** (amends 3's spirit for clarifications, 12, 26, 30, 52/55, 135, 139), §2.6 paragraph; TECHNOLOGY §5.3 (sets as grouped rows, drafts in `meta.draft`, why no migration) and the `:194`/`:221` splitting paragraphs; IMPLEMENTATION_PLAN Phase 8 list.

## Review Focus

1. **A row of the set is orphaned or reassigned** (its holder Waykeeper dies) — the rows move together because they share a holder; but if only some rows were already answered, the remainder must still render as one set on the new holder's side. → test in Task 2 (`orphaned set keeps its rows together`).
2. **A send races a supervisor answer** — Cosmin sends while the Harmonizer answered row 2 a second earlier: the send must be refused as `stale` for row 2 only if Cosmin's version is old; the card must re-open with row 2 shown as answered and the rest of his answers kept (drafts). → test in Task 2 and Task 6.
3. **Offline send** — a set sent while the stream is down queues like a single answer (P7-05) and is retried with the same `answerId`; a retry after success is `duplicate`, not `stale`. → test in Tasks 3 and 6.
4. **Steward interrupted mid-set** — some rows answered, then the Steward is interrupted: all its open rows are cancelled as today and the card disappears; no half tool result is sent. → test in Task 5.
5. **Two devices editing drafts** — phone saves row 1, laptop saves row 2: both drafts present on both; the card on each device resumes at the first row without an answer. → test in Task 6 (model) and Task 2 (domain).

---

### Task 1: Protocol — sets, details, drafts

**Files:**
- Create: `packages/protocol/src/question-set.ts` (+ export from `src/index.ts`)
- Modify: `packages/protocol/src/domain.ts:484-491` (`QuestionContext`), `src/events.ts` (`QuestionAnswered`, new `QuestionDrafted`, the `Event` union), `src/commands.ts` (inputs + `DomainCommands`), `src/rest.ts` (bodies), `src/world.ts` (reducer), `src/fixtures/events.ts`
- Test: `packages/protocol/src/question-set.test.ts`, extend `events.test.ts`, `rest.test.ts`, `world.test.ts`

**Interfaces — Produces:**
```ts
// question-set.ts
export const QUESTION_SET_LIMITS = { minQuestions: 2, maxQuestions: 10, maxOptions: 8, maxTitle: 120 } as const;
export const SKIPPED_ANSWER = '(skipped by the user)';
export const QuestionSetRef = z.object({ id: Id, index: z.number().int().nonnegative(), total: z.number().int().min(2).max(10), title: z.string().min(1).max(120) });
export const SetAnswer = z.object({ choices: z.array(z.string()).default([]), text: z.string().optional(), skipped: z.boolean().optional() });
export type SetAnswer = z.infer<typeof SetAnswer>;
export const SetQuestionInput = z.object({ text: z.string().min(1), options: z.array(z.string().min(1)).max(8).optional(), multiSelect: z.boolean().optional() });
export function renderSetAnswer(a: SetAnswer): string;              // rules in Global Constraints
export function checkSetAnswer(q: Pick<Question,'context'>, a: SetAnswer): string | undefined; // error text or undefined
export function setOf(q: Pick<Question,'context'>): QuestionSetRef | undefined;
export function questionSetRows(world: Pick<WorldState,'questions'>, setId: Id): Question[]; // sorted by index
export function draftOf(q: Question): SetAnswer | undefined;        // meta.draft, parsed
export function answerDetailOf(q: Question): SetAnswer | undefined; // meta.answerDetail, parsed
```
- `QuestionContext` gains `multiSelect?: boolean` and `set?: QuestionSetRef`.
- `QuestionAnswered` gains `detail?: SetAnswer` (folded into `meta.answerDetail`).
- New event `QuestionDrafted = { type: 'question.drafted', questionId: Id, draft: SetAnswer | null, by: Actor }` (folded into `meta.draft`; `null` clears; no version bump).
- `commands.ts`:
```ts
export interface OpenQuestionSetInput { originAgentId: Id; title: string; questions: SetQuestionInput[]; toUser?: boolean }
export interface AnswerQuestionSetInput { setId: Id; by: Actor; answers: { questionId: Id; version?: number; answer: SetAnswer }[]; answerId?: string; origin?: RequestOrigin }
export interface DraftQuestionInput { questionId: Id; draft: SetAnswer | null; by: Actor }
export interface DismissQuestionSetInput { setId: Id; by: Actor; origin?: RequestOrigin }
// DomainCommands:
openQuestionSet(input: OpenQuestionSetInput): Promise<CommandResult<Question[]>>;
answerQuestionSet(input: AnswerQuestionSetInput): Promise<CommandResult<Question[]>>;
draftQuestion(input: DraftQuestionInput): Promise<CommandResult<Question>>;
dismissQuestionSet(input: DismissQuestionSetInput): Promise<CommandResult<Question[]>>;
```
- `rest.ts`: `AnswerSetBody = { answers: {questionId, version?, answer: SetAnswer}[], answerId? }` (reply `AnswerResponse`), `DraftBody = { draft: SetAnswer | null }`, `DismissSetBody = {}` (reply `DismissResponse`).

- [ ] **Step 1: Failing tests** — `renderSetAnswer({choices:['Auth.js']})` → `'Auth.js'`; `({choices:['A','B'], text:'only panel'})` → `'A, B — only panel'`; `({text:'x'})` → `'x'`; `({skipped:true})` → `'(skipped by the user)'`. `checkSetAnswer`: a choice not in options → error; two choices without `multiSelect` → error; empty (no choices, no text, not skipped) → error. `QuestionSetRef` refuses `total: 11`. World reducer: `question.drafted` sets `meta.draft`, `null` removes it, version unchanged; `question.answered` with `detail` sets `meta.answerDetail` and removes `meta.draft`; `question.cancelled` removes `meta.draft`. `questionSetRows` sorts by index and ignores other sets.
- [ ] **Step 2: Run** `pnpm --filter @galactic/protocol test` — FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` (the new union member forces `switch` exhaustiveness elsewhere; add `question.drafted` as a no-op where the server's history/status/work-state derivers and web `replay-model.ts` switch on event types).
- [ ] **Step 5: Commit** `P8-19: protocol for question sets, answer details and drafts`.

---

### Task 2: Domain — open, answer, draft, dismiss a set

**Files:**
- Modify: `apps/server/src/domain/commands.ts` (four methods next to `openQuestion` `:648`), `apps/server/src/domain/questions.ts` (row projection of `question.drafted` / `detail`; `checkAnswer` refusal for set rows on the single path), `apps/server/src/domain/question-service.ts` (`openRouted` reused per row)
- Test: `apps/server/src/domain/question-sets.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 types.
- Produces: the four `DomainCommands` methods; ids `qs-<uuid>` for sets, `q-<uuid>` for rows; every row `meta.source = COMMAND_SOURCE` (+ `toUser`), same holder for all rows (`holderFor` once).

Behaviour:
- `openQuestionSet`: validates limits; emits one `question.opened` per row in index order, one transaction.
- `answerQuestionSet` by **user**: every open user-held row must be in `answers`; each `checkSetAnswer` ok and `version` fresh (else `stale` with today's "already answered by …"); rows a live session waits on (`this.agents.hasQuestion`) go through `answerThroughAdapter` one by one with `answer = renderSetAnswer(a)` and `detail`; all other rows are answered in **one** `run` emitting `question.answered` per row (`detail`, `holders`, `answerId` = `<answerId>:<index>`). Idempotent: all rows already recorded under the key → `{events: []}`.
- `answerQuestionSet` by **agent** (supervisor): every listed row must be held by that agent; the remaining open rows it holds are escalated (`escalateQuestion` per row) in the same `run`. `answers: []` = pass everything up.
- `draftQuestion`: user only, open user-held row of a set; emits `question.drafted`.
- `dismissQuestionSet`: each open row through today's `dismissWith` (adapter first for live rows), the log rows in one `run`.
- Single-question `answerQuestion` / `escalateQuestion` (agent-initiated) / `dismissQuestion` on a set row → `DomainError('invalid', 'part of set <id>: answer or dismiss the set')`. (Internal orphan reassignment is unaffected.)

- [ ] **Step 1: Failing tests** (real `EventLog` on an in-memory DB, as `questions.test.ts` does):
  - `opens a Waykeeper's set held by the Harmonizer` — 3 rows, same holder, shared `set.id`, indexes 0–2, one transaction (events contiguous).
  - `refuses 1 or 11 questions, 9 options, a permission kind`.
  - `the user's send answers every row in one transaction` — 3 `question.answered` with `detail`, contiguous seqs; skipped row's answer is `(skipped by the user)`.
  - `refuses a partial user send` (2 of 3) → `invalid`; nothing recorded.
  - `stale row refuses the whole send` (row 2 answered by the Harmonizer since the version Cosmin saw) → `stale`, nothing recorded.
  - `retry with the same answerId is duplicate`.
  - `the Harmonizer answers row 1 and passes 2–3 up` — row 1 answered by agent, rows 2–3 holder `user`, one transaction.
  - `Waykeeper then Harmonizer on a Steward's set` — Waykeeper answers row 0 and passes up; Harmonizer answers row 1 and passes up; user holds row 2 only.
  - `draft saves, does not bump version, clears on answer`; `an agent may not draft`.
  - `dismiss set cancels every open row`.
  - `single-question paths refuse a set row`.
  - `orphaned set keeps its rows together` (Review Focus 1).
- [ ] **Step 2: Run** `pnpm --filter server test -- question-sets` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, then `pnpm --filter server test -- questions question-service commands` — still PASS.
- [ ] **Step 5: Commit** `P8-19: domain commands for question sets`.

---

### Task 3: HTTP routes and the web API client

**Files:**
- Modify: `apps/server/src/http/agent-routes.ts` (next to `/api/questions/:id/answer` `:535` and `/dismiss` `:635`), `apps/server/src/runtime/reply-target.ts` (a set row is quoted, never answered), `apps/web/src/console/api.ts` (`:146`)
- Test: `apps/server/src/http/question-set-routes.test.ts` (new), extend `apps/server/src/http/reply-routes.test.ts`

**Interfaces — Produces:**
- `POST /api/question-sets/:id/answer` (`AnswerSetBody` → `AnswerResponse`), `POST /api/questions/:id/draft` (`DraftBody` → `{ok: true}`), `POST /api/question-sets/:id/dismiss` (→ `DismissResponse`). Errors map like the single routes (409 `stale`, 400 `invalid`).
- `api.answerSet(setId: string, answers: AnswerSetBody['answers'], answerId?: string): Promise<AnswerResponse>`; `api.draftQuestion(questionId: string, draft: SetAnswer | null): Promise<{ok: true}>`; `api.dismissSet(setId: string): Promise<DismissResponse>`.

- [ ] **Step 1: Failing tests** — 200 + rows answered; 409 `stale`; 400 partial; duplicate on retry; draft 200 and 400 for a non-set or agent-held row; dismiss 200; `POST /api/questions/:id/answer` on a set row → 400; replying to a set row sends the message and leaves the row open.
- [ ] **Step 2: Run** `pnpm --filter server test -- question-set-routes reply-routes` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `P8-19: routes and client for question sets`.

---

### Task 4: Brain tools, wake lines and prompts

**Files:**
- Modify: `apps/server/src/brains/common-tools.ts` (two tools, refusals in `answerQuestionTool`), `apps/server/src/brains/waykeeper/tools.ts` (`escalateTool` refusal; register `ask_questions`), `apps/server/src/brains/harmonizer/tools.ts` (register both), `apps/server/src/brains/wake.ts` (`question.opened` / `question.answered` describe), `apps/server/src/brains/harmonizer/prompt.ts` (`:40`), the Waykeeper prompt file
- Test: extend `common-tools.test.ts`, `wake.test.ts`, `runner.test.ts`; scripted fake LLM per `brains/testing`

**Interfaces — Produces:**
- `ask_questions({ title: string, questions: {text, options?, multiSelect?}[] })` — Harmonizer and Waykeeper; `endsTurn: true`; calls `openQuestionSet` with `originAgentId = brainId`; returns `{ setId, questionIds, holder }`. Description says: for 2–10 related questions (e.g. clarifications on a plan); one question → `ask_user` / `escalate`.
- `answer_question_set({ setId: string, answers: {questionId: string, answer: string}[] })` — supervisors (Harmonizer, Waykeeper); answers the listed rows it holds (as `{text: answer}` details), passes the rest one level up; returns `{ answered: Id[], passedUpTo: Actor | null }`. Description: answer only what the plan/context already settles (decision 12); never reword or drop questions; the rest goes up automatically.
- Wake text: `question.opened` of a set row → `… asked <qid> (question <i+1> of <n> in set <setId> "<title>", held by …): "<text>"`; `question.answered` of a set row → `… answered <qid> (question <i+1> of <n> in set <setId>): "<answer>"`.
- Harmonizer prompt: a Waykeeper's set arrives as N `question.opened` lines with one set id — answer what you can with `answer_question_set`, never re-ask it with `ask_user`.

- [ ] **Step 1: Failing tests** — tool opens a set and ends the turn; supervisor tool answers 1 and passes 2 up; refuses rows it does not hold; `answer_question` / `escalate` on a set row → tool error naming `answer_question_set`; wake lines as above; **one turn per delivery**: the user's send of a 3-row set to a Waykeeper-asked set produces exactly one runner turn whose prompt contains all three answer lines (runner test with the fake adapter).
- [ ] **Step 2: Run** `pnpm --filter server test -- common-tools wake runner` — FAIL.
- [ ] **Step 3: Implement.** If the runner test shows the mailbox starting a turn before all events of one transaction arrive, batch by the log's commit (dispatch after the transaction's last event) rather than adding a timer.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `P8-19: brain tools and wake lines for question sets`, then the P8-19 done commit after docs (SPEC 141, §2.6, TECHNOLOGY §5.3) and gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.

---

### Task 5 (P8-20): Steward multi-question asks become one set

**Files:**
- Modify: `apps/server/src/adapters/claude-sdk/claude-sdk-adapter.ts` (`askUserQuestion` `~:800`, module comment `:78`), `apps/server/src/adapters/acp/acp-adapter.ts` (form elicitation), the fake adapter in `apps/server/src/adapters/fake/`, `apps/server/src/adapters/conformance.ts`; server side `question-service.ts` `openRouted` path for `agent.needs_input` carrying `question.set`
- Test: `claude-sdk-adapter.test.ts`, `acp-adapter.test.ts`, conformance suite

**Interfaces:**
- Consumes: `QuestionSetRef`, `multiSelect` on `QuestionContext` (Task 1).
- Behaviour: with ≥2 questions the adapter generates `qs-<uuid>` and emits all N `agent.needs_input(clarification)` at once, each with `question.set = {id, index, total, title: 'Questions from the Steward'}` (ACP: the form's title when present), `options` from the labels, `multiSelect` from the tool; awaits all answers (`Promise.all`), then returns `answers[q.question] = answer`. One dismissed row → the whole call refused (`dismissedQuestion`) as today. Abort → `interruptedBeforeAnswer()`. One question → today's path unchanged.
- Server: `agent.needs_input` rows with `question.set` open as set rows (same holder routing); the user's set send goes through the adapter per row (Task 2 already).

- [ ] **Step 1: Failing tests** — 3-question `AskUserQuestion` emits 3 `needs_input` before any answer, sharing a set id; the tool result arrives only after the third answer, keyed by question text; multiSelect answer passes through as `"A, B"` without the old "(separate the labels with commas)" suffix; a dismissal refuses the call; interrupt mid-set returns interrupted and the server cancels all open rows (Review Focus 4); conformance: "multi-question ask is one set".
- [ ] **Step 2: Run** `pnpm --filter server test -- claude-sdk-adapter acp-adapter conformance` — FAIL.
- [ ] **Step 3: Implement.** Update `TECHNOLOGY.md` `:194` and `:221` (no more splitting).
- [ ] **Step 4: Run** — PASS; gates.
- [ ] **Step 5: Commit** `P8-20: Steward multi-question asks as one set` and the done commit.

---

### Task 6 (P8-21): The question-set card

**Files:**
- Create: `apps/web/src/panel/cards/question-set-model.ts`, `apps/web/src/panel/cards/QuestionSetCard.tsx` (export from `cards/index.ts`)
- Modify: `apps/web/src/panel/inbox-model.ts` (item kind, `waitingForUserCount`), `apps/web/src/panel/Inbox.tsx` (`:102-112`), `apps/web/src/state/conversation.ts` (`threadCards` `:186`), `apps/web/src/panel/chat/InlineCards.tsx`, `apps/web/src/client/answer-queue.ts` (a queued set send), the cards stylesheet beside `QuestionCard`
- Test: `question-set-model.test.ts`, `question-set-card.test.tsx` (jsdom + axe), extend `Inbox.test.tsx`, `conversation.test.ts`, `offline-answers.test.tsx`

**Interfaces:**
- Consumes: Task 1 helpers, Task 3 client methods.
- Produces:
  - `InboxItem` gains `{ kind: 'questionSet'; setId: Id; questions: Question[] }` (rows the user holds, ordered); `waitingForUserCount` counts a set once.
  - `ThreadCardItem` gains `{ kind: 'questionSet'; id: setId; at; setId }`, one per set shown in that thread (same `threadShowsQuestion` rule on any row).
  - `question-set-model.ts`: `pagesOf(rows: Question[]): { asking: Question[]; answeredBySupervisor: Question[] }`; `resumeIndex(rows, drafts): number` (first asking row without a draft, else the review page = `asking.length`); `canSend(asking, drafts): boolean` (every asking row has a valid draft or skipped); `toAnswers(asking, drafts): AnswerSetBody['answers']`.
  - `QuestionSetCard({ setId }: { setId: Id })` — `article.card.question.question-set`, header "<asker> · <title>" + "via <supervisor>" when routed + pill "<n> of <N>" / "Review"; progress dots (answered / skipped / current); per page: question text, option buttons (`aria-pressed`; multi-select toggles), "Or write your own answer…" input, Back / Skip / Next; review page lists every row (asking rows → tap to jump; supervisor rows read-only "answered by …"), **"Send N answers"** (N = non-skipped count), × dismiss (whole set, confirm like `DismissQuestion`). Drafts: local state seeded from `meta.draft`; saved via `api.draftQuestion` on Next/Back/Skip and 600 ms after typing stops; a stream update of `meta.draft` from another device replaces a row's local value unless that row is the one being edited.
  - Send uses the answer queue (`submitSetAnswer(setId, answers, answerId)`) so offline sends queue and retry with the same key; a `stale` refusal shows `StaleBanner` text for the row that changed and keeps the rest.
  - Reply on a set card focuses the card instead of quoting (P8-17 Reply action hidden for `questionSet` items).

- [ ] **Step 1: Failing tests:**
  - model: `resumeIndex` returns first undrafted row; all drafted → review index; `canSend` false with an empty row; `toAnswers` maps skipped.
  - card: steps through 3 questions; Back keeps the choice; Skip marks the dot skipped; review lists answers; "Send 2 answers" (one skipped) calls `api.answerSet` once with 3 entries; multi-select toggles two options; write-in alone is valid; drafts saved on Next (spy) and restored on remount (resumes at row 2); a supervisor-answered row is read-only on the review page with "answered by Harmonizer"; × dismisses the set; axe clean on a page and on review.
  - inbox: a 3-row set is one item, header count 1, label "3 questions"; thread: one card per set in the Waykeeper's thread.
  - offline: send while `streamDown` → queued; reconnect → sent once; a duplicate reply is success.
  - race (Review Focus 2): send refused `stale` for row 2 → banner names who answered; rows 1 and 3 keep their drafts; card now shows row 2 read-only.
- [ ] **Step 2: Run** `pnpm --filter web test -- question-set Inbox conversation offline-answers` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter web test` — PASS.
- [ ] **Step 5: Commit** `P8-21: the question-set card in the inbox and the chat`.

---

### Task 7 (P8-21): End-to-end, docs, board

**Files:**
- Create: `e2e/tests/12-question-sets.spec.ts`
- Modify: `docs/SPEC.md`, `docs/TECHNOLOGY.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/tasks/PHASE_8_HARDENING.md`, `docs/tasks/README.md`

- [ ] **Step 1: e2e** with the scripted fake LLM: a Waykeeper calls `ask_questions` with 3 questions; the Harmonizer answers question 1 with `answer_question_set`; the user sees one card "Waykeeper · … via Harmonizer" with 2 asking pages; answers one, reloads the page mid-way (draft kept), skips the other, sends; the Waykeeper's next turn prompt shows all three answers (1 from the Harmonizer earlier, 2 now in one turn). Run at desktop and 390×844.
- [ ] **Step 2: Run** `pnpm --filter e2e test -- 12-question-sets` — PASS.
- [ ] **Step 3: Docs** — SPEC decision 141 "**Several questions as one card**" with Cosmin's words ("I want to be able to answer each question one after the other, with options and a write in answer"; "the waykeeper should get all the answers when I finish"; "it should keep my answers so I can continue later"; "skip it and send the rest"; supervisor-first = option B, 2026-10-18) and the calls marked as Claude's (from the spec's "Calls Claude made").
- [ ] **Step 4: Gates** — `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` green.
- [ ] **Step 5: Commit** `P8-21: done — question-set card`; review notes `docs/tasks/notes/P8-19-review.md` per the batch flow.
