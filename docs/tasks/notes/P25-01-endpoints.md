# P25-01 — Server endpoints for the panel

## What was built

The side panel's REST surface. It lives in one new encapsulated, bearer-guarded scope (`apps/server/src/http/panel-routes.ts`), registered by `buildApp` whenever a log is given. All the shapes are zod schemas in the new `packages/protocol/src/panel.ts`, exported from the package index.

| Route | Query / body → reply | Errors |
| --- | --- | --- |
| `GET /api/agents/:id/conversation` | `ConversationQuery {before?, after?, limit=50 (1–200)}` → `ConversationResponse {entries: ConversationEntry[] (oldest first), hasMore}` | 400 `invalid_query` (bad cursor, both cursors, bad limit); 404; 401 |
| `GET /api/agents/:id/transcript` | `TranscriptQuery {before?, after?, limit, kinds?=text,tool,thinking}` → `TranscriptResponse {chunks (oldest first), hasMore, lastSeq}` | 400; 404; 401 |
| `GET /api/settings` | → `SettingsResponse {settings, envOverrides, restartRequired}` | 401 |
| `PATCH /api/settings` | `SettingsPatch` (strict, any subset) → `SettingsResponse` (+ `floored` when the patch touched the policy) | 400 `invalid_body` (zod issues), 400 `invalid` (with a message: relative or `/` projects root, the file would be invalid), 409 `env_override`, 500 `internal` |
| `GET /api/preflight[?refresh=1]` | → `PreflightResponse {ok, runtimes: RuntimePreflight[], checkedAt}` (cached 30 s; concurrent callers share one run) | 401 |
| `GET /api/notifications` | `NotificationsQuery {after?, limit}` → `NotificationsResponse {notifications (oldest first), seq, hasMore}` | 400; 401 |

`GET /api/agents/:id/messages` (P2-18) is unchanged; the console still uses it. P25-03 should move to `/conversation`, and once nothing reads `/messages` it can be dropped.

### Conversation (`runtime/history.ts`)

- **Contents.** Every `message.sent` to the agent: the user's lines, its subordinates' reports, and system notices such as the recovery line. Also every non-blank `text` chunk of its own transcript, which is how a brain's replies reach the user today. The SDK adapter runs with `includePartialMessages: false`, so one chunk is one whole assistant text block.
- **What is left out.** Thinking and tool chunks: the transcript endpoint has them. Proposal, plan and question cards: they are in the world snapshot (`createdAt`, `Proposal.meta`, `Question.originAgentId`), and the chat places them by time.
- **Ordering.** Entries are merged by (`at`, messages before replies at the same instant, `seq`/`chunkSeq`). Both SQL reads order on that same key, so the order is total and stable.
- **Cursor.** The cursor is that position (`<at>~m<seq>` / `<at>~r<chunkSeq>`), and it is opaque to clients. Without a cursor you get the newest page. `before` pages back (scrolling up) and `after` pages forward (catch-up).
- **Stable ids for dedup.** A message's id is `m:<messageId>` and matches the stream's `message.sent.messageId`. A reply's id is `r:<agentId>:<chunkSeq>` and matches the `transcript` stream's `seq`. A client can therefore merge the history with the live stream.
- **Buffered replies.** A reply still buffered in the pipeline (≤ 250 ms hold) is not in a page yet. It arrives on the transcript stream.
- **Indexes.** Messages use the `(type, agentId)` index (migration 0006). Replies use the `transcript_chunks(agent_id, seq)` primary key with a `json_extract(kind)` filter. No migration was needed.

### Transcript

- The agent's persisted chunks, paged by per-agent `seq`.
- `after` is the same number `transcript.subscribe{since}` takes. A Steward view can backfill the newest page by REST, then subscribe with `since = lastSeq of that page`.

### Settings (`config/settings.ts`, `SettingsService`)

The settings are persisted in `config.json`: the file is read fresh, the changed keys are merged, the result is validated with `ConfigFile`, then written to a temporary file with mode 0600 and renamed. The token and every other key are kept.

| Setting | `config.json` key | Applied |
| --- | --- | --- |
| projects root | `projectsRoot` | **restart** (the workspace service and the Harmonizer's cwd hold it) |
| default permission policy | `defaultPermissionPolicy` (absent = SPEC table) | live: the next tool call of every agent on the default |
| retention | `retentionDays` | live: the next hourly sweep |
| caps | `caps.{maxConcurrentAgents, maxStewardsPerWaykeeper, maxSpawnsPerHour, maxSpawnsPerHourPerBrain, maxWallClockMs, maxToolCalls}` | live: the next spawn and the next agent; running agents keep their caps; a lowered cap stops nobody |
| quality tier | `qualityTier` (`high` / `balanced` / `mobile`, default `high`) | stored; Phase 3 reads it |
| Stewards load `~/.claude` | `stewardsLoadUserSettings` (default `true`) | **restart** (the Claude adapter's `stewardSettingSources`; `false` = `['project', 'local']`) |

- **Restart-only settings.** `restartRequired` lists the restart-only settings whose saved value differs from the running one.
- **Environment overrides.** `envOverrides` lists the settings an environment variable decided at startup: `GALACTIC_PROJECTS_ROOT`, `GALACTIC_RETENTION_DAYS`, `GALACTIC_MAX_*` (any of them locks `caps`). A patch of one of them is refused with 409 `env_override` and a message saying which variable to unset, because the environment would shadow the file at the next start.

### Preflight

- **New adapter method.** `AgentAdapter.preflight?(): Promise<RuntimePreflight>` is optional and must never throw.
- **Claude adapter** (`adapters/claude-sdk/preflight.ts`): runs `claude --version` and `claude auth status` (JSON; parsed even when the command exits non-zero) with a 10 s timeout. It reads the Agent SDK version from the SDK package. It reports `installed`, `version`, `sdkVersion`, `loggedIn`, `authMethod`, `subscriptionType` and `apiProvider`. The email and the org are deliberately not passed on.
- **Problem codes**, each with a `fix`: `not_installed`, `not_logged_in`, `auth_unreadable`, `sdk_missing`, `check_failed` (errors); `not_subscription` (a warning: an API-key or cloud login bills that account, decision 17).
- **Fake adapter:** always ok. An adapter without the method is reported ok.

### Notifications

- **One pure function for both feeds.** `notificationOf(envelope, lookup?)` in the protocol is the only classifier. The server feed reads the log through it. A client folding the live stream calls the same function, so the REST backfill and the stream give the same ids. That is the dedup.
- **What notifies** (SPEC §4.5):
  - `question.opened` held by the user, and `question.escalated` / `question.reassigned` to the user. These give kind `question` or `permission`, and the id is `question:<id>`, the same however often the question reaches the user.
  - A task or project `*.state_changed` into `completed` / `failed`: `task:<id>:<state>:<seq>`.
  - `agent.interrupted`: `interrupted:<agentId>:<seq>`, with the agent's role.
  - `proposal.parked` with `waitingFor` (parked for lack of a body, not by a decision): `no_space:<proposalId>:<seq>`.
- **The SQL scan** reads only the notifying shapes: an indexed `type` filter plus the payload fields that decide. Its result is checked against the function.
- **No new WS message.** The stream already carries every event, so P25-07 folds `notificationOf` over it and uses `GET /api/notifications?after=<seq>` for what happened while the page was closed.

## Decisions (proposed text, ready to paste)

**SPEC §7, decision 50 — The configurable global default (2026-10-02, P25-01; refines 22, 37).** The global default permission table is a setting (`defaultPermissionPolicy`), edited on the settings page. A category it leaves out keeps the §3.6 table's value, and "reset" returns to that table. A change applies to the next tool call of every agent whose project has no table of its own, like a project's table (decision 31); an open card is not re-evaluated. Because the default is the floor of every remote policy write (decision 37), a remote client may only tighten it: its write is floored at the current default unless the server is configured with `autoApproveRemote`, and a reset from a remote client is floored too. A local user may loosen it.

**SPEC §7, decision 51 — Settings (2026-10-02, P25-01).** The settings page edits the projects root, the default permission table, the retention period, the caps (wall-clock and tool calls per agent, concurrent Stewards, Stewards per Waykeeper, spawns per hour in all and per brain), the quality tier, and whether Stewards load the user's own Claude Code settings. All of them persist in `config.json`. Everything applies at once except the projects root and the Stewards' settings sources, which apply at the next start (the page says "restart to apply"). Running agents keep the caps they started with. A setting fixed by an environment variable is shown read-only.

**SPEC §7, decision 52 — The conversation (2026-10-02, P25-01).** A conversation with an agent is the messages sent to it (the user's, its subordinates' reports, the system's notices) and the text it writes, in time order. Its thinking and tool calls belong to the transcript. Cards (proposals, plans, questions) are placed in the conversation by the time they were created.

**SPEC §4.6, add after the list:** "The settings page shows which runtime is installed and logged in (auth method, subscription, versions); a login that is not a subscription is a warning, not an error."

**TECHNOLOGY §6.3, append after "Chat history (P2-18)":**

> **Panel endpoints (P25-01).** All in `http/panel-routes.ts`, typed in `packages/protocol/src/panel.ts`:
>
> - `GET /api/agents/:id/conversation`: `message.sent` to the agent merged with its `text` transcript chunks by (`at`, messages first, `seq`), paged by an opaque cursor in both directions, newest page by default.
> - `GET /api/agents/:id/transcript`: chunks by `seq`, with `before`/`after`/`kinds`; `after` is `transcript.subscribe`'s `since`.
> - `GET`/`PATCH /api/settings`: `SettingsService`, an atomic `config.json` write, live where possible, `envOverrides` read-only (409), `restartRequired`.
> - `GET /api/preflight`: each adapter's optional `preflight()`; the Claude adapter reads `claude --version` and `claude auth status`.
> - `GET /api/notifications?after=`: the log through the protocol's pure `notificationOf`, which the client also folds over the live stream, so ids match and dedup across reconnects is by id.

**TECHNOLOGY §8, append to "Remote clients (P2-04)":** "The global default table is a setting (P25-01). It lives in `domain/permissions.ts` (`globalDefaultPolicy` / `setGlobalDefaultPolicy`, process-wide, set at startup from `config.json` and by `PATCH /api/settings`), and every merge (`resolvePolicy`) and floor (`noLooserThan`) reads it. A remote `PATCH /api/settings` of it goes through `policyForWrite` against the current default, so it can only tighten (reply `floored: true`)."

**SPEC §8 (update the 2026-10-02 row on `stewardSettingSources`):** "Now a setting (`stewardsLoadUserSettings`, default `true`, applies at the next start, P25-01); the open question is only the default."

**New SPEC §8 open question:** "Should a remote client (Phase 7) be allowed to change settings other than the policy — raise caps, move the projects root? Today it can (only the policy is floored). Decide before Phase 7; conservative option: settings writes local-only except the quality tier."

## Shared files touched (small, additive)

- `packages/protocol/src/index.ts`: one `export * from './panel.js'` line.
- `packages/protocol/src/adapter.ts`: the optional `preflight?()` on `AgentAdapter`, and a type import.
- `apps/server/src/app.ts`: the `settings?` option and the `registerPanelRoutes` call.
- `apps/server/src/index.ts`: sets the global default at startup, builds the `SettingsService`, passes `stewardSettingSources`.
- No change to `apps/server/src/lib.ts` or `apps/web/**`.

Server internals changed:

- `config/config.ts`: new file keys; `ServerConfig.caps.defaults`, `defaultPermissionPolicy?`, `qualityTier?`, `stewardsLoadUserSettings?`, `envOverrides?`.
- `domain/permissions.ts`: the settable global default.
- `runtime/agent-runtime.ts`: `policyOf` reads the global default.
- `runtime/caps.ts`: `CapsEnforcer.update`.
- `runtime/archival.ts`: `retentionMs` is mutable.
- `adapters/*`: `preflight()`.

## Deferred

- **Remote settings writes** beyond the policy floor: see the open question above.
- **The Harmonizer's prompt** (`projectsRoot` in `HarmonizerDeps`) and `Workspaces.projectsRoot` keep the root they started with, which is why the projects root needs a restart. A live switch needs the workspace service to re-canonicalise it, and recovery to tolerate old projects outside it.
- **The status store's `defaultCaps`** (shown for an agent row without caps) is not updated live. Rows store their caps at spawn, so nothing visible changes.
- **Search across conversations** and a "history view" endpoint for archived work and past questions (SPEC §4.2): the snapshot holds archived rows today; a paged archive endpoint can come with P5.
- **Transcript retention** (Phase 8) and a stored high-water mark: unchanged.
- **The conversation's reply scan** filters `kind` with `json_extract` over an agent's rows. That is fine at today's sizes; a `kind` column (migration) is the fix if a brain's transcript grows to hundreds of thousands of chunks.

## Tests

- `packages/protocol/src/panel.test.ts` (7): the query schemas (coercion, bounds, exclusive cursors, kinds), the settings and patch validation, and `notificationOf` for every kind, including the dedup ids.
- `apps/server/src/http/panel-routes.test.ts` (10):
  - Conversation: merge and order with a same-instant tie, paging back to the start without duplicates, paging forward, bad cursors (400), 404, 401.
  - Transcript: paging and kinds.
  - Notifications: the feed, `after` paging, no repeats.
  - Settings: read; invalid values refused with messages and nothing written; caps, retention and tier applied live with the token kept and mode 0600; the global default set live, floored for a remote client, reset; restart-only settings; env-locked settings refused.
  - Preflight: ordering, cache, refresh, 401.
- `apps/server/src/adapters/claude-sdk/preflight.test.ts` (5): a subscription login ok and the email not passed on; not installed; logged out with a non-zero exit; API-key warning; unreadable status; SDK missing; the real SDK version found.
- `apps/server/src/domain/global-default.test.ts` (2): merges and floors follow the configured default; `CapsEnforcer.update`.
- `apps/server/src/config/config.test.ts` (+1): the new file keys, `envOverrides`, an invalid tier refused.
