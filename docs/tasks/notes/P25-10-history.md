# P25-10 — History view

SPEC §4.2 asks for "a history view of archived work and past questions". Before this task the panel had only the cards' "show archived work" and the inbox's last ten supervisor answers.

## What was built

### Why REST and not the client world

The snapshot carries every row of every table today, archived work and resolved questions included (`EventLog.snapshot()`), and retention archives work but deletes nothing. So the client could fold the history itself. It reads over REST anyway, for three reasons:

- the history grows without bound, and the snapshot will have to shed it some day (the scene does not need archived work);
- search should run where the rows are;
- the task asks for paging.

A row shows the stream's current copy of its item when the client has one, so a Reopen or a Pin shows at once, before any refetch.

### Server

| File | What |
| --- | --- |
| `packages/protocol/src/panel.ts` (appended section) | `HistoryWorkState` (`completed` · `failed` · `archived`), `HistoryQuestionStatus` (`answered` · `cancelled`), `HistoryWorkQuery`, `HistoryWorkItem` (`{kind: 'project', item: Project}` or `{kind: 'task', item: Task}`, plus `cursor`, the same shape as the cards' `CardWork`), `HistoryWorkResponse`, `HistoryQuestionsQuery`, `HistoryQuestion` (`{question, reason?, cursor}`), `HistoryQuestionsResponse`. Search text is trimmed, at most 200 characters, and blank means no search. `state` is a comma list. |
| `apps/server/src/db/migrations/0008_history_indexes.sql` | Three partial indexes, each holding exactly one list's rows in its order: `projects(updated_at, id)` and `tasks(updated_at, id)` `WHERE state IN ('completed', 'failed', 'archived')`, and `questions(updated_at, id)` `WHERE status IN ('answered', 'cancelled')`. |
| `apps/server/src/runtime/history-view.ts` (new) | `HistoryView.work(q)` and `HistoryView.questions(q)`. |
| `apps/server/src/http/panel-routes.ts` | `GET /api/history/work?before=&q=&kind=&state=&limit=` and `GET /api/history/questions?before=&q=&kind=&status=&limit=`. Both are bearer-guarded in the panel scope and zod-validated: 400 `invalid_query` for a bad query, or for a cursor that is not one of ours or belongs to the other list. |

How the reads work:

- **Order.** Newest first by (`updated_at`, `id`): when the work last changed (finished, archived, pinned) or the question was answered or cancelled.
- **Cursor.** Opaque to clients: `<updatedAt>~p<id>`, `~t<id>` or `~q<id>`.
- **Merging work.** Projects and tasks are each read up to `limit + 1` rows past the cursor. They are merged in JS by (`updated_at`, kind `t` before `p`, `id`), all descending, the same scheme as the conversation endpoint. Each table gets the right bound: strictly older in (at, id) for its own kind; at the cursor's instant only when its kind letter sorts below the cursor's.
- **Indexes.** The queries repeat each partial-index term verbatim and name the index with `INDEXED BY`. Without statistics, SQLite otherwise picks `questions_status` and sorts (the query-plan test caught this). With the index named, a query that can no longer use it fails loudly instead of turning into a scan. Extra filters are written `+state` / `+kind` / `+status`.
- **Search.** `LIKE … ESCAPE '\'`, with `%`, `_` and `\` taken literally. It is case-insensitive for ASCII. Work searches a project's name and a task's description; questions search `context.text` and the answer. A search walks the same ordered index until the page is full.
- **Rows.** Rows come back as the domain tables hold them, and each row is fetched with `Table.get`, which validates it.
- **Cancel reason.** A cancelled question gets the `reason` of its latest `question.cancelled`; the row does not keep it. It is read once per page over the indexed `events.type`, for that page's ids.
- **Redaction parity.** Rows come back exactly as the stream's snapshot carries them. Agent text was redacted when it was logged: question text, options and tool calls go through `redactEvent` on `agent.needs_input`. User-written text (answers) is not redacted (TECHNOLOGY §8). The conversation endpoint does the same, and a test checks that each returned question equals its snapshot row.

### Web

| File | What |
| --- | --- |
| `apps/web/src/state/selection.ts` | New `Route` `'history'`; `pathFor` / `locationFromPath` handle `/history` (a trailing slash is accepted; `/history/x` falls back to the panel, as with `/settings`). |
| `apps/web/src/App.tsx` | `history` renders the `Panel`, as `settings` does. |
| `apps/web/src/panel/Panel.tsx` | `route === 'history'` → `<HistoryPage />` in the panel's frame, not behind the first-run gate (like `/settings`). A **History** link in the top bar, before Settings, keeps the selection. |
| `apps/web/src/console/api.ts` | `historyWork(filter)` and `historyQuestions(query)`, plus a small `queryString` helper (lists joined by commas). |
| `apps/web/src/panel/history/usePaged.ts` (new) | One paged list: the newest page when the filters change, `more()` with the last cursor (deduplicated by id), `reload()`. A late reply for old filters is dropped. Lint-clean under the React-hooks refs and set-state-in-effect rules (state is keyed by the filters it was read for, not reset inside an effect). |
| `apps/web/src/panel/history/HistoryPage.tsx` (new) | The `/history` page. |
| `apps/web/src/panel/history/history.css` (new) | On the panel's tokens. One column, 920 px at most; works on narrow screens. |

What the page shows:

- **Header and search.** "History" with "← Back to the panel". One search box drives both lists: typing searches after 300 ms, and Enter searches at once.
- **Work.** Finished and archived projects and tasks, filtered by kind and state. Each row shows:
  - kind, state pill, a pinned tag and the name;
  - the project (for a task) or the parent project (for a sub-project), the body, and the created and last-change dates;
  - links to its agents, newest first. The newest is "Steward view" (`/steward/<id>`) or "Waykeeper chat" (`/waykeeper/<id>`); older ones are "earlier steward view (Oct 1)" (decision 53);
  - the controls the cards' `workActions` would offer, limited to **Reopen**, **Pin / Unpin** and **Archive now**. They go through `POST /api/control`; archive asks inline first, as on the cards, and a refusal is shown on the row.
- **Past questions.** Filtered by kind and by answered / withdrawn. Each row shows:
  - the kind and an "answered" or "withdrawn" tag;
  - the question text;
  - "asked by" with the shared `AgentRef` "open agent" link, and the tool name for a permission;
  - when it was asked;
  - for an answered question: who answered (`actorLabel`: you, Harmonizer, Waykeeper · …), when, and the answer as a quote;
  - for a withdrawn question: when, and "Why: <reason>".
- **Paging.** Each list has "Show older" while `hasMore`, plus Refresh.

## Proposed SPEC text (product)

**SPEC §7, new decision — The history view (2026-10-03, P25-10; §4.2, decisions 4, 11b, 53).** The history view lives at `/history`, in the panel's frame, reached from the top bar. It has two lists, newest first:

- **Finished and archived work.** Projects and tasks that are completed, failed (including cancelled) or archived, with their state, project, body and dates. Each offers reopen, pin / unpin and archive now (for finished work not yet archived) as on the managed-agents cards, plus links to the agents that ran it: the Steward view or the Waykeeper chat, newest first.
- **Past questions.** Answered and withdrawn questions, with their kind, the agent that asked (an "open agent" link), who answered, the answer and when; a withdrawn question shows why.

One search box searches project names, task descriptions, question texts and answers. Work can be filtered by kind and state, questions by kind and by answered / withdrawn. Older items load on demand. A row shows the item's current state, so reopening work shows at once. Open questions stay in the inbox; the history lists only what is resolved.

**SPEC decision 53, append:** "The history view lives at `/history`, in the panel's frame (P25-10)."

**SPEC §4.2, the "history view" bullet, optionally append:** "(`/history`, decision <n>)".

## Proposed TECHNOLOGY text (technical; §6.3 "Panel endpoints", new bullet)

- `GET /api/history/work?before=&q=&kind=&state=&limit=` and `GET /api/history/questions?before=&q=&kind=&status=&limit=` (P25-10, `runtime/history-view.ts`):
  - **What they return.** Finished and archived projects and tasks (`state IN ('completed', 'failed', 'archived')`) and answered or cancelled questions, as the domain tables hold them. A cancelled question also gets the `reason` of its last `question.cancelled`.
  - **Order and paging.** Newest first by (`updated_at`, `id`), paged back by an opaque cursor `<updatedAt>~p|t|q<id>`. Work merges the two tables by (`updated_at`, `t` before `p`, `id`), like the conversation endpoint.
  - **Indexes.** Each list reads a partial index of migration 0008, `(updated_at, id) WHERE <the list's term>`, named with `INDEXED BY` and with the term repeated verbatim, so a page without a search reads only its rows. A search is a `LIKE … ESCAPE '\'` substring match (case-insensitive for ASCII) on the project name, task description, question text or answer.
  - **Redaction.** Text comes back as the stream carries it: agent text was redacted when logged, user text is not (§8).
  - **Client.** The client renders the stream's current copy of a row's item when it has one.

## Shared files touched (all additive)

- `packages/protocol/src/panel.ts`: imports (`HostKind`, `Project`, `Task`; `Question` is now a value import, not a type import) and a new `// --- history (P25-10)` section at the end.
- `packages/protocol/src/panel.test.ts`: a new `describe` at the end, plus imports.
- `apps/server/src/http/panel-routes.ts`: imports, the header comment, and the two routes before `/api/notifications`.
- `apps/web/src/state/selection.ts`: the `'history'` route in `Route`, `pathFor` and `locationFromPath`.
- `apps/web/src/state/selection.test.ts`: two assertions.
- `apps/web/src/App.tsx`: one condition.
- `apps/web/src/panel/Panel.tsx`: an import, the route branch and the top-bar link.
- `apps/web/src/console/api.ts`: two methods, the `HistoryWorkFilter` type and the `queryString` helper.

New files: `apps/server/src/db/migrations/0008_history_indexes.sql`, `apps/server/src/runtime/history-view.ts`, `apps/server/src/http/history-routes.test.ts`, `apps/web/src/panel/history/{HistoryPage.tsx, usePaged.ts, history.css, history.test.tsx}`, this file.

Not touched: the phase file, `docs/tasks/README.md`, `SPEC.md`, `TECHNOLOGY.md` (the coordinator records the decisions above).

## Deferred

- **Filters in the URL.** The search and filters are not in the URL (`/history?q=…`), so a reload resets them. Easy to add to `locationFromPath` if the dogfood run wants it.
- **Live appearance.** Work that finishes, or a question answered while the page is open, appears on Refresh or on a filter change, not by itself. Rows already shown do follow the stream.
- **Ordering.** The history orders by `updated_at`, so pinning old work brings it to the top. A dedicated "finished at" column would need a migration plus a backfill from the log; retention already derives its clock from the log.
- **Proposals.** Rejected and decided proposals, and moved work (`moved`), are not in the history. SPEC §4.2 names work and questions only.
- **Search.** No full-text index (FTS5): a `LIKE` substring scan over the ordered partial index is enough at single-user scale. Non-ASCII search is case-sensitive (SQLite `LIKE`).
- **Permission answers.** A past permission question shows its raw answer (e.g. `allow`), not the policy row it was matched against.

## Tests

- **Protocol** (`panel.test.ts`, +3): query parsing (kind, comma-list states, trimmed or blank search, length bound, rejected `in_progress` / `open`) and the typed response.
- **Server** (`http/history-routes.test.ts`, 8 tests):
  - work and questions newest first, never open work or open questions, with who answered and the cancel reason;
  - paging at limits 1, 2, 3, 7 and 50 (work) and 1, 2, 4, 5 and 200 (questions), compared with the full expected order, with ties within a table and across the two tables at one instant: no gaps, no duplicates;
  - search on names, descriptions, question text and answers, with `%` and `_` taken literally; the kind, state and status filters;
  - 400 for a bad filter, a bad cursor or the other list's cursor; 401 without the token or with a wrong one;
  - redaction parity: each returned question equals its snapshot row;
  - query plans: every statement (newest page, both cursor kinds, with every filter) uses the `*_history` index with no `TEMP B-TREE`.
- **Web** (`panel/history/history.test.tsx`, 5 tests through `<App/>`):
  - the top-bar link opens `/history` (`aria-current`) and the back link returns to `/`;
  - the `/history` deep link: search finds the archived task, its body is shown, "Steward view" links to `/steward/<id>`, Reopen sends `{task, reopen}`, and the stream's `task.state_changed` updates the row and removes Reopen;
  - "Show older" pages with the last cursor; Unpin sends `pin: false`; Archive now confirms first; "Waykeeper chat" links to `/waykeeper/<id>`;
  - search finds a past question with its kind, "answered", the answer and who answered, and "open agent" opens the asking Steward;
  - the withdrawn filter shows the reason.
- **Selection** (`selection.test.ts`): `/history` round-trips and `/history/` is accepted.
- **Gates.** All run from the repo root and all green: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`. Counts: protocol 64, server 841 (+1 skipped), web 196.
