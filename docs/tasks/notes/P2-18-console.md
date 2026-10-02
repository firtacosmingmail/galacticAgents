# P2-18 — Ops console extensions for the hierarchy

## What was built

A **Hierarchy** tab, now the console's default page (`apps/web/src/console/hierarchy/`). The Phase 1 agents console stays one click away as **Agents (dev)**: the free-form spawn form is still a development tool (decision 24). The snapshot counts and the event log stay below both tabs. Like everything else on the page, the tab is plain and functional; the real panel is Phase 2.5's.

- **`HierarchyConsole.tsx`**: the page layout. The Harmonizer's chat (the newest running Harmonizer, else the newest one), the cards, the inbox, the tree, and the selected agent's view. It takes an optional `api` (tests inject one); otherwise it builds one from the token.
- **`WorkTree.tsx`**:
  - `SummaryBar`: `summarize` counts from the folded world (`summaryOf`): open questions, questions waiting for the user, blocked items.
  - The project/task tree: top-level projects with their sub-projects nested, project tasks, and standalone (asteroid) tasks, each with its derived state, body, branch, pin marker and agents. Clicking an agent opens a Waykeeper's chat or a Steward's view. Archived work is hidden behind "show archived".
  - `Controls`: the decision 11b actions through `POST /api/control`. Pause/resume, stop, cancel, close, archive now, pin/unpin and reopen are offered as the item's state allows; the server decides, and a refusal is shown under the buttons. Edit changes a task's description or priority, or a project's name or permission policy (a preset, or `null` = back to the global default). Remote clients are floored server-side, P2-21.
- **`ProposalCards.tsx`**:
  - Open cards (`pending`/`edited`/`parked`), then rejected drafts, then the last five approved cards with their `carriedOut` outcome.
  - A work card shows the request type, size, body, workspace, the `initGit` consent, the promotion target and the rationale. Its actions are Approve; Edit (size, a free body of that size or "any free", name, workspace, the "git init this folder" consent, decision 27); and Reject with an optional reason.
  - A parked card shows the reason, `waitingFor`, the occupied bodies with their occupants and states (a completed occupant gets its controls, so "archive now" frees the body from the card), and the offers. Offering a downsize to a moon or an asteroid is a one-click edit.
  - A plan card (`meta.plan`) lists its tasks with state and priority. Each still-proposed task gets the task controls (edit description/priority, cancel = archived, decision 28). The card itself can only be approved or rejected with a reason, never edited (decision 35).
- **`QuestionInbox.tsx`**:
  - Questions for the user first, then the open questions supervisors hold, then up to 10 that supervisors answered from context.
  - Each card shows its kind, holder and origin context: the asking agent, task, project, and the last N events, folded.
  - A permission card shows the action and the tool call, with Allow / Refuse.
  - A clarification card shows its option buttons and a free-text answer.
  - Every answer carries the question's `version`. A `stale` refusal stays in a "Not sent: already answered by <who>: "<answer>"" banner, worded from the folded world, so the message outlives the card.
  - Questions that supervisors hold can still be answered by the user (an answer anywhere resolves everywhere).
  - A question that a supervisor answered is shown read-only with an **Override** box (see the decisions below).
- **`ChatBox.tsx`**: a chat with the Harmonizer or a Waykeeper. The messages sent to the brain (`message.sent`: the user's lines, its subordinates' reports, system notices) are interleaved by time with the brain's transcript text; "show tools and thinking" adds the other chunk kinds. Messages go out through `POST /api/agents/:id/send`, with an optional interrupt.
- **`StewardView.tsx`**: read-only status, task, caps, controls (pause/resume/stop through `/api/control` on the agent, and "Resume session" when it is interrupted) and the transcript. It has no message box. Its open questions are shown as cards: a clarification gives the answer box (decision 13), and a permission card gives only allow/refuse.
- **Store** (`state/store.ts`): `messages: Record<agentId, ChatMessage[]>`, folded from `message.sent` on the stream and backfilled from `GET /api/agents/:id/messages`. `mergeMessages` dedupes by `messageId` and keeps `seq` order. The messages are kept across a snapshot of the same log and dropped for a new log, like transcripts. They are **not** part of `world`, so the replay-vs-snapshot conformance test is unchanged: the snapshot does not carry them, and the inbox is runtime state.
- **API client** (`console/api.ts`): `answer(id, text, version?)`, `decide`, `control`, `messages`; `ApiError.code` carries the refusal code.

## Routes (all bearer-guarded, `apps/server/src/http/agent-routes.ts`)

| Route | Body / reply | Errors |
| --- | --- | --- |
| `POST /api/proposals/:id/decide` (new) | `ProposalDecisionBody`: `{decision:'approve'}` · `{decision:'edit', changes:{kind?, proposedBody?, workspace?, initGit?}}` (strict) · `{decision:'reject', reason?}` · `{decision:'park', reason}` → `DecideResponse {ok, state, seq}` (`state` may be `parked`) | 400 bad body / `invalid` (shape mismatch, editing a plan); 404 unknown card; 409 `invalid_transition`/`conflict`; 500 non-domain errors |
| `POST /api/questions/:id/answer` (extended) | `AnswerBody {answer, version?}`. With the command surface it is `DomainCommands.answerQuestion` (first answer wins, version check), so questions no live session waits on (a Harmonizer's `ask_user`, a closure question) are answerable too | 409 `{error:'stale', message:"… already answered by …"}`; 404; 400; other refusals 409 `rejected` |
| `GET /api/agents/:id/messages` (new) | `MessagesResponse {messages: ChatMessage[]}`: the agent's `message.sent` events from the log, oldest first, last 200, text redacted | 404 unknown agent |
| `POST /api/control` (unchanged) | it now shares the error mapping (`refuse`) with the decide route | — |

No policy is written by the decide route: an approved project starts on the global default, and its table is edited through `/api/control`, where `originOf(req)` floors it (P2-21). So the route does not pass `originOf`.

## Shared files touched (small, additive)

- `packages/protocol/src/rest.ts`: `AnswerBody.version`, `AnswerRefusal`, `ProposalDecisionBody`, `DecideResponse`, `ChatMessage`, `MessagesResponse`. Tests are in `rest.test.ts`.
- `apps/server/src/lib.ts`: exports `waykeeperDefinition` and the P2-07 harness (`brainHarness`, `firstTurn`, `BrainHarness`, `BrainScript`, types) for the web end-to-end test.
- `apps/server/src/http/agent-routes.ts`: the routes above. `app.ts` and `index.ts` are untouched (`commands` were already passed).
- `apps/web/src/App.tsx` (tabs), `App.test.tsx` (two `getByText` calls became `getAllByText`, because the tree now shows the same names), `app.css`.

## Acceptance: the exit run driven from the page

`apps/web/src/console/hierarchy/exit-run.test.tsx` renders the console against the real server surface:

- The composed runtime from the P2-07 harness: event log, commands, runtime, status store, and workspaces on a temp folder with real git.
- The real Fastify routes, through `inject`, as a local client.
- The real Harmonizer and Waykeeper definitions driven by scripts.
- Fake-adapter Stewards.

The page is fed the way the session feeds it: the snapshot, every committed event, status diffs and transcript chunks.

Every user step is a keystroke or a click on the page:

1. The request typed to the Harmonizer's chat. The Harmonizer runs `find_related_work` and `propose`.
2. The sizing card: the user edits the workspace, then approves. The project lands on a planet; the Harmonizer starts the Waykeeper.
3. The Waykeeper's plan card: approved once, which spawns two Stewards, each in its own worktree.
4. Reader Steward's clarification: answered by the Waykeeper from context. It shows read-only in the inbox ("Waykeeper · CSV to Parquet answered: …").
5. Writer Steward's clarification: escalated by the Waykeeper to the Harmonizer, which relays it with `ask_user`. The user answers inline, and the Harmonizer answers the original question.
6. Writer's permission request (destructive `rm -rf out`): the card shows the action and the call; the user allows it.
7. Both Stewards commit and finish. The Waykeeper merges and closes both tasks, then requests closure. The Harmonizer asks "Anything else on CSV to Parquet?". The user clicks "Close CSV to Parquet", and the Harmonizer closes the project.

The test then checks the following:

- The tree shows the completed project and its two completed tasks.
- The workspace's base branch holds both Stewards' files.
- No question is open, and the summary shows 0.
- The Harmonizer's chat carries the Waykeeper's closure report.

The run takes about 2.5 s. The component tests (`HierarchyConsole.test.tsx`, 16) cover each part separately: tree and controls, cards (edit/approve/reject, parked offers, plan cards), inbox (version, stale banner, permission, supervisor-held, override), chats (history, live, transcript interleaving, send) and the Steward view.

**Not covered by the test; the P2-19 manual run must check these:**

- Real Claude brains reading the page's cards and questions, and the real Claude Steward permission flow.
- Whether the real Harmonizer relays an escalated question with `ask_user`, or the user answers the Harmonizer-held question directly from "Held by supervisors". Both work on the page.
- The page over the real WebSocket session (the test feeds the store directly).
- The `kill -9` drill and resume (P2-16): after a restart the chat history comes back from `GET /api/agents/:id/messages`, and the transcript from the transcript stream.
- Layout readability with several projects.

## Decisions (proposed text, ready to paste)

- **SPEC §7, decision N — Override of a supervisor’s answer**: the user overrides a clarification that a supervisor answered from context (decision 12) by telling that supervisor. The inbox's Override sends `Override of your answer to question <id> ("<text>"): <what the user wants>` to the answering Harmonizer or Waykeeper, which passes it on to its Steward (`tell_steward`) — the user still never chats with a Steward (decision 13). The answered question itself stays answered: an answer is final, and the log keeps both.
- **SPEC §2.4 clarification:** the Steward view offers an answer box for any open clarification of that Steward, held by the user or by a supervisor (answering anywhere resolves everywhere, as in the inbox), and shows its open permission card with allow/refuse only.
- **TECHNOLOGY §6.3 addition — chat history:** the chat boxes fold `message.sent` from the stream into a per-agent list beside `world`, not in it: the snapshot does not carry messages, and the conformance test keeps comparing the tables only. After a reload or a snapshot catch-up, the page backfills from `GET /api/agents/:id/messages` (the log's `message.sent` events, the last 200), deduplicated by `messageId`. This is the second REST read the page makes beside `/api/runtimes`; the stream stays the source of everything else.
- **TECHNOLOGY §2.2 (REST surface):** add `POST /api/proposals/:id/decide`, the `version` of `POST /api/questions/:id/answer` (409 `stale`), and `GET /api/agents/:id/messages` as in the table above.

## Findings for others

- **Brain runner race (for P2-16, `brains/runner.ts`):** a brain's first turn can start before `BrainRunner.spawn()` has set its agent id. A tool call made in that first turn is then refused with "the brain has not been spawned yet". The fake adapter at speed 0 hits this every time for a Waykeeper started by `spawn_waykeeper`. A real model is slower, but a fast first reply could still hit it. The exit-run test retries `plan_tasks` until it is accepted. The runner should set its id, or queue tool calls, before the first turn's tool calls are handled.

## Deferred

- Parking a card by hand from the page (the route supports `park`; the UI offers no button).
- `task_on_planet` and `close_early` offers are shown as text (close-early works through the occupant's controls on the card).
- A history view of archived work, promotion links and "moved to …" markers (Phase 2.5 / 4).
- Pagination of the chat history beyond the last 200 messages.
