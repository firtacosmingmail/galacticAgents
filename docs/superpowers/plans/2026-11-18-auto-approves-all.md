# Auto approves everything; sends and spends need a grant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Auto, approve and log every request a Steward's gate asks about (asteroid Stewards and publishing runs included), except marks and sends/spends; a send or spend goes through only under a grant Cosmin gave in his own words, his words in the task, or his Allow once.

**Architecture:** The approval watch (`apps/server/src/runtime/approval-watch.ts`) gets a new Auto path: marks → local-only categories approved without a model → the request judge in a new `grants` mode (sends/spends? which grant? which quote?). A held send/spend opens a user-held permission question carrying `sendPermission` context (card with Allow once / Don't allow and a reply box); the Waykeeper (Harmonizer for an asteroid) reads Cosmin's reply and calls `answer_send_permission`, which the server checks against the reply's text before creating a grant. Grants are event-sourced on the project, or on a new standalone scope for asteroids.

**Tech Stack:** TypeScript, zod (`packages/protocol`), Node/Fastify + SQLite (`apps/server`), React (`apps/web`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-auto-approves-all-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- Branch `agent-auto-grants`; commits `P13-nn: <imperative summary>`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- "Only what fits the task" (`mode: 'task'`) does not change: its judge, hard rules, quotes and push rules stay byte-for-byte in behaviour; its existing tests must pass unchanged.
- The gate does not change (policy table, "Allow similar", symlink refusal, launch flags + scope watch). A `deny` stays a deny.
- A grant's `endsAt`, removal, project end, and the verbatim-words check are code, never the model. `endsAt` must be in the future and at most 90 days ahead.
- Decision 7: the model never allows a send/spend on its own. `answer_send_permission` with `allow` is accepted only after a user reply to that question; `deny` and asking again are always accepted.
- Every held call is answered exactly once: approve, deny, or withdrawn.
- Redaction (`redactSecrets` / `redactValue`) on everything logged, shown, or sent to the model.
- Schema changes get a migration (next: `0022_…`); protocol types live only in `packages/protocol`.
- Gates before asking to merge: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.

## Rulings made while planning (deviations from the spec's letter)

- **Ruling 1 — no `ask_send_permission` tool.** The held call opens the user-held permission question at once (card with the judge's summary, the call, Allow once / Don't allow, reply box); the Waykeeper is woken by it and may add a chat message, but no tool is needed to ask. Asking again on an unclear reply is a normal chat message. Why: the card must exist anyway (buttons, no-Waykeeper case §4.4.8), and one path is simpler than two. Cost if wrong: one extra tool later.
- **Ruling 2 — standalone storage.** Standalone grants and marks live in a new one-row table `standalone_approvals`; the standalone Auto switch is a setting `standaloneAuto` in `Settings` (config.json), so the existing settings origin rule (`autoApproveRemote`) guards turning it on.

## Review Focus

1. A grant whose `endsAt` passed between the judge call and the verdict → the call is held, not approved (Task 4 test `grant expired while judged holds`).
2. The Waykeeper calls `answer_send_permission(allow)` before Cosmin replied, or with words not in his reply → refused, call stays held (Task 6 tests).
3. A publishing run's `request_publish` in Auto with no grant → the grant question shows the content like the publish card; nothing is posted (Task 7 test).
4. The Steward is stopped while its send is held → question withdrawn, no grant, no answer sent twice (Task 5 test `stop withdraws held send`).
5. Auto turned off while a held send's question is open → the open question stays (not re-judged); a later `answer_send_permission(allow)` still answers only that call and creates the grant (paused) (Task 6 test).

---

### Task 1 (P13-23): Protocol shapes, events, projection, migration, board

**Files:**
- Modify: `packages/protocol/src/waykeeper-approvals.ts`, `packages/protocol/src/domain.ts` (Project), `packages/protocol/src/events.ts`, `packages/protocol/src/world.ts`, `packages/protocol/src/panel.ts` (Settings, SettingName), `packages/protocol/src/commands.ts`
- Create: `apps/server/src/db/migrations/0022_send_grants.sql`; Modify: `apps/server/src/db/tables.ts`
- Modify: `docs/tasks/PHASE_13_WAYKEEPER_APPROVALS.md` (add P13-23…P13-31, execution rows 15–23, claim P13-23), `docs/tasks/README.md`
- Test: `packages/protocol/src/waykeeper-approvals.test.ts`, `packages/protocol/src/world.test.ts`, `apps/server/src/db/db.test.ts`

**Interfaces — Produces:**
- `SendGrant = z.object({ id: Id, projectId: Id.optional() /* absent = standalone */, words: z.string().min(1).max(2000), summary: z.string().min(1).max(200), createdAt: Timestamp, endsAt: Timestamp.optional(), createdBy: Actor, origin: RequestOrigin, questionId: Id })`
- `SEND_GRANT_MAX_DAYS = 90`; `isGrantLive(g: SendGrant, now: number): boolean` (`endsAt` absent or `now < endsAt`).
- `SendPermissionContext = z.object({ summary: z.string(), parts: z.array(CommandPart), grants: z.array(SendGrant) /* existing, did not cover */, publish: PublishContext.optional() })`, added to `QuestionContext` as `sendPermission?`.
- `RequestJudgeInput.mode` gains `'grants'`; `RequestJudgeInput.grants?: SendGrant[]`; `RequestVerdict` gains `grantId?: Id`, `summary?: string`.
- `RecordedApproval`/`permission.decided` gain optional `grantId?: Id` and `allowedBy?: 'grant' | 'task_words' | 'allow_once' | 'auto'` (log label).
- `ApprovalMark.projectId` becomes optional (absent = standalone).
- Events: `send_grant.added { grant }`, `send_grant.removed { grantId, projectId?, by, reason }`, `standalone_mark.*` is **not** new — `approval_mark.added/removed` carry `projectId?`.
- `Project.sendGrants?: SendGrant[]`; world `standalone: { approvalMarks: ApprovalMark[], sendGrants: SendGrant[], recordedApprovals: RecordedApproval[] }`.
- `Settings.standaloneAuto?: boolean`; `SettingName` gains `'standaloneAuto'`.
- `DomainCommands`: `removeSendGrant({ grantId, by, origin })`, `answerSendPermission({ questionId, agentId, decision: 'allow'|'deny', grant?: { words, summary, endsAt? } })`.

- [ ] **Step 1: Failing tests** — `SendGrant` parses with and without `projectId`/`endsAt`; empty `words` fails; `isGrantLive` false at `now === endsAt`; world: `send_grant.added` appends to the project (or `standalone` when no `projectId`), `send_grant.removed` drops it; a mark without `projectId` lands in `standalone.approvalMarks`; `Settings` parses `standaloneAuto: true`; db round-trips `sendGrants` and the standalone row.
- [ ] **Step 2: Run** `pnpm --filter @galactic/protocol test` → FAIL (missing exports).
- [ ] **Step 3: Implement** the shapes above; migration adds `projects.send_grants TEXT` and table `standalone_approvals(id TEXT PRIMARY KEY CHECK (id = 'standalone'), approval_marks TEXT, send_grants TEXT, recorded_approvals TEXT)`, following `0021_approval_marks.sql` and the `approval_marks` mapping in `tables.ts`.
- [ ] **Step 4: Run** `pnpm build && pnpm --filter @galactic/protocol test && pnpm --filter server test -- db` → PASS.
- [ ] **Step 5: Commit** `P13-23: grants, send-permission context and standalone scope in the protocol`.

### Task 2 (P13-24): Domain — grants and the standalone scope

**Files:**
- Create: `apps/server/src/domain/send-grants.ts`; Modify: `apps/server/src/domain/waykeeper-approvals.ts` (marks without project), `apps/server/src/domain/commands.ts`, `apps/server/src/domain/projects.ts` (end grants with the project), `apps/server/src/config/settings.ts` (`standaloneAuto` origin rule = same as turning a project's Auto on)
- Test: `apps/server/src/domain/send-grants.test.ts`

**Interfaces — Consumes:** Task 1. **Produces:**
- `addSendGrant(ctx, input: Omit<SendGrant,'id'|'createdAt'>, now: number): SendGrant` — throws `DomainError('invalid')` when `endsAt <= now` or `endsAt > now + 90 days`.
- `removeSendGrant(ctx, grantId, by: Actor, reason: string): SendGrant` — `by.type` must be `'user'`; a brain → `DomainError('forbidden')`.
- `liveGrants(tables, scope: { projectId?: Id }, now: number): SendGrant[]`.
- `endSendGrants(ctx, projectId, reason)` called where `endStandingApprovals` is called.
- `standaloneAutoOn(settings): boolean`.

- [ ] **Step 1: Failing tests** — add/remove round trip (project and standalone); `endsAt` in the past and 91 days ahead rejected, 90 days accepted; brain actor cannot remove; closing a project ends its grants with reason `project closed`; `liveGrants` drops expired and removed; a remote settings write turning `standaloneAuto` on without `autoApproveRemote` is refused, turning it off is accepted.
- [ ] **Step 2: Run** `pnpm --filter server test -- send-grants` → FAIL.
- [ ] **Step 3: Implement.** Mark commands accept a missing `projectId` (standalone marks, scope `{worktree}`/`{scratch}` expansion unchanged).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `P13-24: grants and standalone marks in the domain`.

### Task 3 (P13-25): The request judge's `grants` mode

**Files:** Modify `apps/server/src/adapters/claude-sdk/request-judge.ts`; Test `apps/server/src/adapters/claude-sdk/request-judge.test.ts`

**Interfaces — Consumes:** `RequestJudgeInput{mode:'grants', grants, userWords}`. **Produces:** `RequestVerdict` with `sendsOrSpends` (required in `grants` mode), optional `grantId`, `quote`, `summary`, `kind`, `reason`; `verdict` is `'approve'` when not a send/spend or covered, `'forward'` otherwise.

- [ ] **Step 1: Failing tests** — the `grants` prompt contains the send/spend definition from §4.2.3 (reuse the existing paragraph's text), says a git push to a branch and a PR are not sends, says "when unsure, sendsOrSpends is true", lists each grant as `id`, `summary`, Cosmin's words, end time; validation: missing `sendsOrSpends` in `grants` mode → malformed (`undefined`); a `grantId` not among the input's grants → malformed; `summary` cut to 200 chars and redacted.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** a separate system prompt constant for `grants` mode (do not edit the `task`/`auto` prompts).
- [ ] **Step 4: Run** → PASS; existing `request-judge` tests unchanged.
- [ ] **Step 5: Commit** `P13-25: the request judge's grants mode`.

### Task 4 (P13-26): The approval watch's new Auto path

**Files:** Modify `apps/server/src/runtime/approval-watch.ts`; Test `apps/server/src/runtime/approval-watch.test.ts` (new `describe('Auto approves everything (P13-26)')`)

**Interfaces — Consumes:** Tasks 1–3. **Produces:** `ApprovalWatchCall` gains `grants: () => SendGrant[]` (live, read at call and after the verdict) and `hold: (context: SendPermissionContext) => void`; `WaykeeperApproval` gains `allowedBy` and `grantId?`. `LOCAL_ONLY_CATEGORIES: ReadonlySet<PermissionAction>` exported (start with `read_workspace`, `edit_workspace`, `destructive`, `outside_workspace` file reads/writes; anything else goes to the judge).

Order in Auto (`call.auto()` true): marks → (all parts' categories ⊆ `LOCAL_ONLY_CATEGORIES` and no opaque part → approve, `allowedBy:'auto'`, no judge) → judge `grants` mode → not a send/spend → approve `'auto'`; a valid `quote` found by `quoteFound` → approve `'task_words'`; `grantId` live at verdict time → approve `'grant'`; else `hold`. Judge failure/none/malformed → `hold` with `summary: 'The check could not tell whether this sends or spends.'`. Hard rules, guarded writes, push-to-main and quote-for-push checks are **skipped** in Auto. Switch/Auto turned off or mark added while judged → forward as today.

- [ ] **Step 1: Failing tests:** `rm -rf /etc/x` in Auto approved without the judge (judge spy not called); `git push origin main` approved (judge says not a send); unreadable code approved; `curl -X POST …/chat.postMessage` with no grant → `hold` called with the judge's summary; same with a live grant id → approved, `grantId` logged; `grant expired while judged holds` (grant live at call, `endsAt` passed when verdict arrives); task-words quote approved with `allowedBy:'task_words'`; judge timeout → hold; a mark still forwards; `mode:'task'` test file passes unchanged.
- [ ] **Step 2: Run** `pnpm --filter server test -- approval-watch` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `P13-26: Auto approves everything except marks and sends without a grant`.

### Task 5 (P13-27): Runtime — no bypass paths; holding a send

**Files:** Modify `apps/server/src/runtime/agent-runtime.ts` (`watchApproval`, `approvalsOn`, new `approvalScopeOf`), `apps/server/src/domain/question-service.ts` (open a `sendPermission` question); Test `apps/server/src/runtime/auto-grants.test.ts`

**Interfaces — Consumes:** Task 4. **Produces:** `approvalScopeOf(agent): { projectId?: Id; auto: boolean; deciderId?: Id } | undefined` — a project Steward → its project (decider: its Waykeeper); an asteroid Steward (task without project) → standalone, `auto = settings.standaloneAuto`, decider: the Harmonizer; anything else → `undefined`. A held send opens `agent.needs_input` + a user-held permission question with `context.sendPermission` (Task 1) in one transaction. Allow once / Don't allow on that card answer the adapter through the existing permission answer path, logged with `allowedBy:'allow_once'`.

- [ ] **Step 1: Failing tests:** a publishing-run Steward on an Auto project gets the watch (no plain card for a `network` ask) — while on a non-Auto project it still skips (decision 147 unchanged); an asteroid Steward with `standaloneAuto` gets Auto, logged with `decidedBy` the Harmonizer and recorded in `standalone.recordedApprovals`; with it off → plain card as today; `misplacedCwd` or no Waykeeper with a held send → plain card with `sendPermission` context and no decider; `stop withdraws held send` (question cancelled, adapter answered at most once); Allow once logs `allowedBy:'allow_once'` and creates no grant.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `watchApproval` drop the `isPublishingRun` early return only when Auto is on for the scope.
- [ ] **Step 4: Run** → PASS; `pnpm --filter server test` green.
- [ ] **Step 5: Commit** `P13-27: Auto covers asteroids and publishing runs; a send without a grant is held`.

### Task 6 (P13-28): The Waykeeper's `answer_send_permission`

**Files:** Modify `apps/server/src/brains/waykeeper/tools.ts`, `apps/server/src/brains/harmonizer/tools.ts` (same tool, standalone scope), `apps/server/src/brains/wake.ts` (a `sendPermission` question wakes its decider; a user reply to it says "this decides it through answer_send_permission"), `apps/server/src/brains/waykeeper/prompt.ts` + harmonizer prompt; `apps/server/src/domain/send-grants.ts` (`answerSendPermission`); Test `apps/server/src/brains/waykeeper/send-permission.test.ts`

**Interfaces — Produces:** tool `answer_send_permission { questionId, decision: 'allow'|'deny', grant?: { words, summary, endsAt? } }`; server rules:
- the question must be open, carry `sendPermission`, and belong to the brain's scope (its project / standalone for the Harmonizer);
- `allow` requires at least one `message.sent` from the user with `replyTo.id === questionId` (or a user chat message to that brain while the question is open); `grant.words` must pass `quoteFound(words, [those replies' texts])`; else `DomainError('invalid', …)` and nothing changes;
- `allow` + grant → `send_grant.added` (origin = the reply's origin), then the held call approved (`allowedBy:'grant'`); `allow` alone → approved once; `deny` → adapter denied, Steward told "Cosmin did not allow this: <his reply>";
- after a grant is added, other held send questions in the same scope are re-checked (Task 4 judge path) before staying open.
- Prompt lines: read Cosmin's reply; turn "today" into local midnight, "this week" into end of Sunday, a date into end of that day; never invent an end; unclear → ask in chat, do not answer.

- [ ] **Step 1: Failing tests:** allow before any reply → refused; words not in the reply → refused; reply "yes, only today for Instagram" + grant words "only today for Instagram" with `endsAt` midnight → grant created, call approved; deny → Steward told; a second held send covered by the new grant is approved without a new question; Harmonizer answers a standalone question, a Waykeeper of another project cannot; auto turned off while the question was open → allow still answers that call, grant created (shown paused); the wake line for the reply no longer says "only the user's buttons decide" for `sendPermission` questions.
- [ ] **Step 2–4: Run → FAIL, implement, run → PASS.**
- [ ] **Step 5: Commit** `P13-28: the Waykeeper turns Cosmin's reply into a grant`.

### Task 7 (P13-29): `request_publish` in Auto

**Files:** Modify `apps/server/src/domain/publish.ts`, `apps/server/src/runtime/publish-allowance.ts` (arm from a grant), the `request_publish` handler; Test `apps/server/src/runtime/publish-auto.test.ts`

**Interfaces:** in Auto, `request_publish` runs the `grants` judge with the platform, account, text and file names/hashes as the request; covered (`grantId` live, or task-words quote) → the allowance is armed as if the card were approved, logged with text and file hashes; not covered → a `sendPermission` question with `publish` context (card shows the content as `PublishCard` does). Outside Auto: unchanged.

- [ ] **Step 1: Failing tests:** covered publish arms the allowance and opens no publish card; uncovered → `sendPermission` question with `publish`, nothing armed; non-Auto project → publish card as today.
- [ ] **Step 2–4: Run → FAIL, implement, run → PASS.**
- [ ] **Step 5: Commit** `P13-29: a grant covers a publish in Auto`.

### Task 8 (P13-30): Web — grants, the send card, standalone settings, log labels

**Files:** Create `apps/web/src/panel/status/SendGrants.tsx`, `apps/web/src/panel/cards/SendPermissionCard.tsx`; Modify `apps/web/src/panel/status/StatusViews.tsx` (grants next to marks), `ApprovalsLog.tsx` (labels), `apps/web/src/panel/cards/index.ts`/`QuestionCard.tsx` routing, `apps/web/src/panel/settings/sections.tsx` (Standalone tasks: Auto switch, grants, marks, log), `apps/web/src/console/api.ts` (`removeSendGrant`); server route in `apps/server/src/http/agent-routes.ts` (`DELETE /projects/:id/send-grants/:grantId`, `DELETE /standalone/send-grants/:grantId`).
**Tests:** `send-grants.test.tsx`, `send-permission-card.test.tsx`, `approvals-log.test.tsx` additions.

Copy (exact): grant row `"<summary>" · "<words>" · ends <local time>` or `no end`; `used <n>×`; button `Remove`; paused badge `paused (Auto is off)`; card title `<summary>`; card hint `Reply with how far to allow it (only today, this campaign, these ads), or use the buttons.`; buttons `Allow once`, `Don't allow`; log labels: `under grant: <summary>`, `allowed by your words in the task`, `allowed once by you`; a phone-made grant shows `from the phone`.

- [ ] **Step 1: Failing tests** for each copy line above, Remove calls the API, the card renders `publish` content like `PublishCard`, settings section hidden when the server sends no `standaloneAuto`.
- [ ] **Step 2–4: Run** `pnpm --filter web test` → FAIL, implement, → PASS.
- [ ] **Step 5: Commit** `P13-30: grants, the send card and standalone Auto in the panel`.

### Task 9 (P13-31): Docs and the board

**Files:** `docs/SPEC.md` (decision 164 "Auto approves everything; sends and spends need a grant", amending 147, 154, 158, 161 for Auto), `docs/TECHNOLOGY.md` (approval watch Auto path, grants store, `answer_send_permission`), `docs/IMPLEMENTATION_PLAN.md`, `docs/tasks/PHASE_13_WAYKEEPER_APPROVALS.md` (P13-23…31 done with dates, Current task —), `docs/tasks/README.md`.

- [ ] **Step 1:** Write the docs; check the three docs agree (CLAUDE.md rule).
- [ ] **Step 2:** Full gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` → all green.
- [ ] **Step 3: Commit** `P13-31: done — Auto approves everything; sends and spends need a grant (decision 164)`.
