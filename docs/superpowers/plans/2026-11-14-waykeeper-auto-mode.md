# Waykeeper Auto Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third setting of a project's Waykeeper approvals, **Auto**, that approves every Steward request except pushes, sends, spends, deletes outside the worktree/scratch folder, guarded writes, unparseable commands and what Cosmin marked "Ask me next time"; plus a per-category log of every Waykeeper approval with the marking button.

**Architecture:** The switch gains an `auto` flag on the existing `waykeeper_approvals.set` event and project row. The approval watch (`runtime/approval-watch.ts`) keeps its hard rules, adds a deterministic marks check (`domain/approval-marks.ts`) before and after the judge, and in Auto calls the same one-shot judge with an Auto prompt that answers only "does this send or spend?". Approvals log their command parts and cwd on `permission.decided`, so the web groups them by category and the server derives a mark from a logged approval by its `seq`.

**Tech Stack:** TypeScript, zod (`packages/protocol`), Fastify + SQLite (`apps/server`), React 19 (`apps/web`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-waykeeper-auto-mode-design.md` (builds on `docs/superpowers/specs/2026-11-09-waykeeper-approvals-design.md`).

## Global Constraints

- Branch `agent-waykeeper-approvals-fixes`; commits prefixed with the task id (`P13-13: …`); ticket flow of `/CLAUDE.md` (claim → implement → done) in `docs/tasks/PHASE_13_WAYKEEPER_APPROVALS.md`.
- Gates before asking to merge: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.
- The permission gate (`domain/permissions.ts`, `runtime/permission-gate.ts`) is not changed: Auto acts only where the gate asks.
- Every failure (no judge, error, 20 s timeout, malformed answer, a throw) forwards to Cosmin.
- Turning approvals on, or turning Auto on, is Mac-only (`mayWriteRules(origin)`), user-only, never by an agent (`notFromAnAgent`). Turning down (Auto → task, or off), adding a mark and removing a mark work from anywhere, user-only.
- "Ask me next time" exists only for approvals younger than **10 days** (`APPROVAL_MARK_DAYS = 10`), enforced by the server as well as hidden by the web.
- Marks and the Auto flag end with the project, like standing approvals (`endStandingApprovals`).
- Nothing outside `apps/server/src/adapters` imports the SDK; shared types live in `packages/protocol`; any schema change has a migration.

## Review Focus

1. Auto turned on from the phone (remote origin) → refused with `remote_control`; Auto → task from the phone → allowed. Test in Task 1.
2. A mark requested by `seq` for an approval older than 10 days, a non-Waykeeper decision, or another project's event → refused by the server even though the web hides the button. Test in Task 4.
3. In Auto, a judge answer that approves without a boolean `sendsOrSpends` → malformed → forwarded; one that says `sendsOrSpends: true` without a found quote → forwarded. Test in Task 4.
4. A mark made from `rm -rf node_modules` (relative, from the worktree) catches `rm -rf /abs/worktree/node_modules/.cache` and a delete inside an `sh -c` body. Test in Task 2.
5. The project closes → its marks are removed with `approval_mark.removed` events and the Auto flag goes with the switch's row state. Test in Task 1.

---

### Task 1 (P13-13): Protocol, storage and domain commands

**Files:**
- Modify: `packages/protocol/src/waykeeper-approvals.ts` (ApprovalMark, categories, labels)
- Modify: `packages/protocol/src/domain.ts:208-219` (Project fields)
- Modify: `packages/protocol/src/events.ts:415-439, 463-469` (events)
- Modify: `packages/protocol/src/world.ts:421-` (fold), `packages/protocol/src/fixtures/events.ts`
- Modify: `packages/protocol/src/commands.ts:372-385, 737-741`, `packages/protocol/src/rest.ts:268-273`
- Create: `apps/server/src/db/migrations/0021_approval_marks.sql`
- Modify: `apps/server/src/db/tables.ts:158,182`
- Modify: `apps/server/src/domain/waykeeper-approvals.ts`, `apps/server/src/domain/commands.ts:1521-1555`, `apps/server/src/runtime/history-events.ts:296`
- Test: `packages/protocol/src/waykeeper-approvals.test.ts`, `apps/server/src/domain/waykeeper-approvals.test.ts`, `apps/server/src/domain/commands.test.ts` (or the existing P13 command test file)

**Interfaces:**
- Produces (protocol):
  - `ApprovalMarkMatch` = zod discriminated union on `kind`:
    `{kind:'folder', category: PermissionAction, paths: string[] (min 1)}` |
    `{kind:'site', host: string}` | `{kind:'prefix', words: string[] (1..20)}` | `{kind:'tool', toolName: string}`.
  - `ApprovalMark` = `{ id: Id, projectId: Id, match: ApprovalMarkMatch, example: string (max 300), createdBy: Actor, createdAt: Timestamp, origin: RequestOrigin, fromSeq: number (int, positive) }`.
  - `APPROVAL_MARK_DAYS = 10`, `MAX_APPROVAL_MARKS = 200`.
  - `type ApprovalLogCategory = 'push' | 'delete' | 'outside' | 'network' | 'unreadable' | 'edit' | 'run' | 'read'`; `APPROVAL_LOG_ORDER: readonly ApprovalLogCategory[]` in that order.
  - `approvalLogCategory(e: { action?: PermissionAction; parts?: CommandPart[] }): ApprovalLogCategory` — the first of `APPROVAL_LOG_ORDER` that applies over all parts' categories (`push`→push, `destructive`→delete, `outside_workspace`→outside, `network`→network, any part with `opaque`→unreadable, `edit_workspace`→edit, `run_workspace`→run, `read_workspace`→read); without `parts`, from `action` alone; nothing → `'run'`.
  - `markLabel(match: ApprovalMarkMatch): string` — `deletes in <paths joined ", ">` (folder+destructive), `<category words> in <paths>` (other folder), `calls to <host>`, `<words joined " "> …`, `the tool <toolName>`.
  - `Project.waykeeperAuto: z.literal(true).optional()`; `Project.approvalMarks: z.array(ApprovalMark).optional()`.
  - `WaykeeperApprovalsSet` gains `auto: z.boolean().optional()` (absent = false).
  - `ApprovalMarkAdded = { type: 'approval_mark.added', mark: ApprovalMark }`; `ApprovalMarkRemoved = { type: 'approval_mark.removed', projectId, markId, by: Actor, reason: string }`.
  - `PermissionDecided` gains `parts: z.array(CommandPart).optional()` and `cwd: z.string().optional()`.
  - `SetWaykeeperApprovalsInput.auto?: boolean`. (The mark command inputs and `DomainCommands` methods come in Task 4.)
  - REST: `WaykeeperApprovalsBody = { on: boolean, auto?: boolean }`; `ApprovalMarkBody = { seq: number }`; `ApprovalMarkResponse = { ok: true, mark: ApprovalMark }`.
- Produces (server domain, `waykeeper-approvals.ts`):
  - `setWaykeeperApprovals(ctx, projectId, on, by, auto = false)`: row `waykeeperApprovals: true` and `waykeeperAuto: true` only when `on && auto`; event carries `auto` only when true.
  - `addApprovalMark(ctx, projectId, match, made: { example, fromSeq, by, origin }): ApprovalMark` — refused (`invalid`) for an ended project or when `MAX_APPROVAL_MARKS` reached; a mark with an equal `match` (JSON-equal) already present is returned as is, no event.
  - `removeApprovalMark(ctx, projectId, markId, by, reason): ApprovalMark` — `not_found` when absent.
  - `endStandingApprovals` also removes every mark (`removeApprovalMark` as the system, same reason wording) and drops `waykeeperAuto`.
- Storage: `0021_approval_marks.sql` adds `approval_marks TEXT` (JSON array, NULL = none). `waykeeper_approvals` stays INTEGER: `1` = on, `2` = on + Auto (tables.ts maps both ways; `2` → `{waykeeperApprovals: true, waykeeperAuto: true}`).

- [ ] **Step 1: Write failing tests**
  - protocol: `approvalLogCategory({ parts: [{text:'rm -rf x',categories:['destructive']}, {text:'gh pr view',categories:['network']}] })` → `'delete'`; `{ parts: [{text:'python -c x',categories:['run_workspace'],opaque:'inline_code'}] }` → `'unreadable'`; `{ action: 'network' }` → `'network'`; `{}` → `'run'`; `{ parts:[{text:'git push',categories:['push']}] }` → `'push'`.
  - protocol: `markLabel({kind:'folder',category:'destructive',paths:['/w/node_modules']})` → `'deletes in /w/node_modules'`; `markLabel({kind:'site',host:'api.posthog.com'})` → `'calls to api.posthog.com'`; `markLabel({kind:'prefix',words:['pnpm','test']})` → `'pnpm test …'`.
  - protocol world fold: `waykeeper_approvals.set {on:true, auto:true}` → project has `waykeeperAuto: true`; then `{on:true}` → no `waykeeperAuto`; `approval_mark.added` appends, `approval_mark.removed` drops.
  - server domain: `setWaykeeperApprovals(..., true, user, true)` then reading the row from SQLite gives `waykeeperAuto: true` (round-trip through `waykeeper_approvals = 2`).
  - server domain: `addApprovalMark` twice with the same match → one mark, one event; on a completed project → `invalid`.
  - server domain (Review Focus 5): closing the project (state → `completed`) emits `approval_mark.removed` for each mark with reason `the project was closed`, and the row has no `approvalMarks` and no `waykeeperAuto`.
  - commands (Review Focus 1): `setWaykeeperApprovals({on:true, auto:true, origin:'remote'})` rejects `remote_control`; with the project already in Auto, `setWaykeeperApprovals({on:true, auto:false, origin:'remote'})` succeeds; `by: {type:'agent'}` rejects `invalid`.
- [ ] **Step 2: Run** `pnpm --filter @galactic/protocol test` and `pnpm --filter @galactic/server exec vitest run src/domain/waykeeper-approvals.test.ts` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** the protocol additions, fixtures (every new event in `fixtures/events.ts`), the migration, tables mapping, domain functions, `commands.ts` (`setWaykeeperApprovals` passes `auto` and refuses a remote origin when `on && (auto || the project's switch is off)`), and `history-events.ts` (the two mark events belong to their project).
- [ ] **Step 4: Run** the same commands plus `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `P13-13: auto flag, approval marks and approval parts in the protocol and storage`.

### Task 2 (P13-14): Marks — deriving and matching

**Files:**
- Create: `apps/server/src/domain/approval-marks.ts`
- Modify: `apps/server/src/domain/permission-rules.ts:1068` (export `onSite`)
- Test: `apps/server/src/domain/approval-marks.test.ts`

**Interfaces:**
- Consumes: `ApprovalMarkMatch`, `CommandPart` (Task 1); `partsOfCall` (`command-parts.ts`), `classifyToolCall`, `pathsInCommand`, `resolvePath`, `isInsideWorkspace` (`permissions.ts`), `onSite`, `commandMatchesPrefix`-style word matching, `proposePrefix` (`permission-rules.ts`).
- Produces:
  - `markFromApproval(a: { toolCall: ToolCall; parts?: CommandPart[]; action?: PermissionAction }, ctx: PolicyContext): ApprovalMarkMatch` — `ctx.cwd` is the approval's `cwd` (or the workspace).
    1. Not Bash: a file tool with a path (`file_path`/`path`/`notebook_path`) → `folder` with the category the gate gives it (`classifyToolCall`'s first action) and the resolved path; `WebFetch` → `site` with the URL's host; otherwise → `tool` with `toolName`.
    2. Bash: the part (from `parts`, else `partsOfCall`) whose categories give the log category (`approvalLogCategory` on that part alone equals the whole call's). Its category `destructive`, `outside_workspace`, `edit_workspace` or `read_workspace` with placeable paths (`pathsInCommand(part.text).paths`, minus options) → `folder` with that category and every path resolved (`resolvePath(p, ctx, ctx.cwd)`); `network` with a visible host (classification findings' `hosts`) → `site`; else → `prefix` with `proposePrefix(part.text)` or, when that is undefined, all of the part's words.
  - `markCovers(match: ApprovalMarkMatch, req: { toolCall: ToolCall; parts: CommandPart[]; ctx: PolicyContext }): boolean` — any part (or the non-Bash call itself) implies the mark:
    - `folder`: the part has `match.category` and one of its paths is equal to or inside one of `match.paths` (`isInsideWorkspace(p, { ...ctx, workspace: markPath })`), or one of its paths cannot be placed (`unresolvable`, or a variable the line does not set) — fail toward asking. A file tool: same test on its path and category.
    - `site`: a visible host of the part (classification findings' `hosts`) is `onSite(host, match.host)`. A part with no visible host does not match.
    - `prefix`: the part's words start with `match.words`.
    - `tool`: `toolCall.toolName === match.toolName`.

- [ ] **Step 1: Write failing tests** (ctx `{workspace:'/w', cwd:'/w/.worktrees/t1', home:'/Users/me'}`):
  - `markFromApproval({toolCall: bash('rm -rf node_modules')}, ctx)` → `{kind:'folder', category:'destructive', paths:['/w/.worktrees/t1/node_modules']}`.
  - covers: `rm -rf node_modules/.cache` ✓; `rm node_modules/x` ✓; `rm -rf /w/.worktrees/t1/node_modules/.cache` ✓ (Review Focus 4); `sh -c 'rm -rf node_modules/a'` ✓ (Review Focus 4); `rm -rf dist` ✗; `echo hi > node_modules/x` (edit) ✗; `rm -rf $X` ✓ (cannot place).
  - `markFromApproval(bash('curl https://api.posthog.com/api/x'))` → `{kind:'site', host:'api.posthog.com'}`; covers `curl https://api.posthog.com/other` ✓, `curl https://eu.api.posthog.com/` ✓, `curl https://posthog.com/` ✗.
  - `markFromApproval(bash('pnpm test'))` → `{kind:'prefix', words:['pnpm','test']}`; covers `pnpm test --watch` ✓, `cd x && pnpm test` ✓, `pnpm build` ✗.
  - `markFromApproval({toolCall:{toolName:'mcp__slack__post_message', input:{text:'hi'}}})` → `{kind:'tool', toolName:'mcp__slack__post_message'}`; covers the same tool with other input ✓, `mcp__slack__read` ✗.
  - `markFromApproval({toolCall:{toolName:'Edit', input:{file_path:'/w/.worktrees/t1/src/a.ts'}}})` → folder `edit_workspace` `['/w/.worktrees/t1/src/a.ts']`; covers an Edit of the same file ✓, of `src/b.ts` ✗.
- [ ] **Step 2: Run** `pnpm --filter @galactic/server exec vitest run src/domain/approval-marks.test.ts` — FAIL.
- [ ] **Step 3: Implement** `approval-marks.ts`; export `onSite` from `permission-rules.ts`.
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `P13-14: derive an approval mark from an approval and match later requests`.

### Task 3 (P13-15): The Auto judge

**Files:**
- Modify: `packages/protocol/src/waykeeper-approvals.ts:96-125` (`RequestJudgeInput`, `RequestVerdict`)
- Modify: `apps/server/src/adapters/claude-sdk/request-judge.ts`
- Modify: `apps/server/src/runtime/fake-request-judge.ts`
- Test: `apps/server/src/adapters/claude-sdk/request-judge.test.ts`, `apps/server/src/runtime/fake-request-judge.test.ts`

**Interfaces:**
- Produces: `RequestJudgeInput.mode: 'task' | 'auto'` (required; the watch always sets it); `RequestVerdict.sendsOrSpends?: boolean`.
- `createSdkRequestJudge` uses `AUTO_SYSTEM_PROMPT` when `input.mode === 'auto'`, else the existing `SYSTEM_PROMPT`. In Auto the parsed answer must carry a boolean `sendsOrSpends`, else the verdict is the existing unreadable-answer forward.
- `AUTO_SYSTEM_PROMPT` content (wording is the builder's; these points are fixed): same UNTRUSTED DATA paragraph; "Cosmin turned on Auto: approve everything except a part that **sends** (messages, emails, chat posts, comments, replies, form submissions, anything delivering content to people or an outside service on his behalf, by any means — curl, an MCP tool, a script) or **spends** (ads, purchases, paid API calls, starting paid cloud resources)"; set `sendsOrSpends` true when any part does; approve such a request only with a verbatim quote from `userWords` (same quote rules and `PICKED_OPTION_PREFIX` text as today); a push follows the same quote rule; when unsure whether something sends or spends, forward; still return `kind`, `failingPart`, `similarTo`. Examples: approve `gh pr view 12`, `curl https://api.example.com/items`, `pnpm test`, `rm -rf build`; forward `curl -X POST https://slack.com/api/chat.postMessage …`, `mcp__gmail__send_email`, `curl -X POST https://graph.facebook.com/…/ads`.
- Reply JSON adds `"sendsOrSpends": true | false`.

- [ ] **Step 1: Write failing tests**: with a scripted SDK, `mode:'auto'` sends a system prompt containing `sends` and `spends` and not the task-mode text "read versus write against the purpose"; an Auto answer without `sendsOrSpends` → `verdict:'forward'` with the unreadable reason; `{verdict:'approve', sendsOrSpends:false, …}` passes through with `sendsOrSpends:false`; `mode:'task'` keeps the old prompt and does not require the field.
- [ ] **Step 2: Run** `pnpm --filter @galactic/server exec vitest run src/adapters/claude-sdk/request-judge.test.ts` — FAIL.
- [ ] **Step 3: Implement**; the fake judge passes `sendsOrSpends` through from its script.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` (every `RequestJudgeInput` literal in tests gets `mode:'task'`).
- [ ] **Step 5: Commit** `P13-15: the Auto judge prompt and its sends-or-spends answer`.

### Task 4 (P13-16): The watch, the runtime and the routes

**Files:**
- Modify: `apps/server/src/runtime/approval-watch.ts`
- Modify: `apps/server/src/runtime/agent-runtime.ts:2248-2400` (`approvalsOn`, `watchApproval`, `permissionDecided`)
- Modify: `apps/server/src/domain/commands.ts` (`addApprovalMark`, `removeApprovalMark`), `apps/server/src/domain/waykeeper-approvals.ts`
- Modify: `apps/server/src/http/agent-routes.ts:769-800`
- Test: `apps/server/src/runtime/approval-watch.test.ts`, the runtime's P13 test file (`agent-runtime*.test.ts` that covers `watchApproval`), `apps/server/src/http/agent-routes*.test.ts` covering the P13 routes

**Interfaces:**
- Consumes: Tasks 1–3.
- `ApprovalWatchCall` gains `auto: () => boolean` and `marks: () => readonly ApprovalMark[]`. `WaykeeperApproval` gains `parts: CommandPart[]` (the redacted `shown` parts).
- In `decide`, in this order:
  1. hard rules (unchanged — `opaque: 'unreadable'` still forwards in Auto);
  2. **marks**: the first mark whose `markCovers(mark.match, {toolCall, parts, ctx})` → forward `You asked to be asked: <markLabel> (from “<example>”).` with `failingPart` = the first covering part's index, kind `unjudged`; a throw reading marks → forward "the project's marks could not be read";
  3. `mode = call.auto() ? 'auto' : 'task'` into `input.mode`;
  4. after an `approve` verdict: switch off → forward (as today); `mode === 'auto' && !call.auto()` → forward `Auto mode was turned off while the request was judged.`; marks re-checked (a mark added meanwhile forwards); quote needed when `callNeedsQuote || (mode === 'auto' && verdict.sendsOrSpends === true)` — message for a send: `A send or a spend needs the user's own words asking for it. The judge said: …`; a forward with `sendsOrSpends: true` never offers `similar` (like a push).
  5. `validVerdict` in Auto requires `typeof sendsOrSpends === 'boolean'` (Review Focus 3).
- Runtime: `approvalsOn` unchanged; `auto: () => project.waykeeperAuto === true` read fresh; `marks: () => project.approvalMarks ?? []` read fresh; `approve` passes `parts: d.parts` and `cwd` (the Steward's `live.spec.cwd`) into `permissionDecided`, which writes them on the event (`parts` texts already redacted).
- Protocol: `AddApprovalMarkInput = { projectId, seq: number, by, origin? }`; `RemoveApprovalMarkInput = { projectId, markId, by, origin? }`; `DomainCommands.addApprovalMark(input): Promise<CommandResult<ApprovalMark>>`, `removeApprovalMark(input): Promise<CommandResult<ApprovalMark>>`.
- Commands: `addApprovalMark({projectId, seq, by, origin})` — user only; reads the event at `seq` (`log.eventsSince(seq - 1, 1)`), refuses (`invalid`) unless it is a `permission.decided` with `isWaykeeperApproval`, its agent's task (or agent) belongs to `projectId`, and its `at` is within `APPROVAL_MARK_DAYS` of the clock; derives the match with `markFromApproval(event, ctx)` where `ctx = { workspace: project.workspace, cwd: event.cwd ?? project.workspace, home: os.homedir() }`; `example` = the redacted one-line request (`precedentOf`-style, ≤300 chars); calls `addApprovalMark` in a transaction. `removeApprovalMark` — user only, from anywhere.
- Routes: `PUT /api/projects/:id/waykeeper-approvals` passes `auto`; `POST /api/projects/:id/approval-marks` body `ApprovalMarkBody` → `ApprovalMarkResponse`; `DELETE /api/projects/:id/approval-marks/:markId` → `WaykeeperApprovalsResponse`; all behind `notFromAnAgent(opts.rulesPeer, 'rules', …)`.

- [ ] **Step 1: Write failing tests**
  - watch: a call covered by a mark forwards with reason starting `You asked to be asked:` and the judge is **not** called (fake judge records calls), in task mode and in Auto.
  - watch: Auto passes `mode:'auto'` to the judge; `{verdict:'approve', sendsOrSpends:false}` approves and `approve` receives `parts`; `{verdict:'approve', sendsOrSpends:true}` with no quote forwards with `A send or a spend needs the user's own words`; with a quote found in `userWords` approves with `quote`; an Auto answer missing `sendsOrSpends` forwards (Review Focus 3).
  - watch: Auto turned off between the call and the verdict (`auto` returns false on second read) → forwards `Auto mode was turned off while the request was judged.`
  - watch: in Auto, `opaque:'unreadable'` part (`echo ${(f)x}`-style zsh line) still forwards without the judge.
  - runtime: a Waykeeper approval's `permission.decided` carries `parts` and `cwd`.
  - commands/routes (Review Focus 2): POST a mark for a Waykeeper approval 2 days old → 200 with the derived mark and an `approval_mark.added` event; for one 11 days old (clock advanced) → 400 `invalid`; for a `permission.decided` without `waykeeperApproval` → 400; for another project's event → 400; from a remote client → 200 (allowed from anywhere); DELETE removes it.
- [ ] **Step 2: Run** the three test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then `pnpm --filter @galactic/server test` — PASS.
- [ ] **Step 5: Commit** `P13-16: Auto mode and approval marks in the approval watch, the runtime and the routes`.

### Task 5 (P13-17): The web: switch, log by category, marks

**Files:**
- Modify: `apps/web/src/console/api.ts:246` (`setWaykeeperApprovals(projectId, on, auto?)`, `addApprovalMark(projectId, seq)`, `removeApprovalMark(projectId, markId)`)
- Modify: `apps/web/src/panel/status/StandingApprovals.tsx` (switch, "Always asks me" list; `WaykeeperApprovalsList` replaced)
- Create: `apps/web/src/panel/status/ApprovalsLog.tsx`
- Test: `apps/web/src/panel/status/standing-approvals.test.tsx`, `apps/web/src/panel/status/approvals-log.test.tsx`

**Interfaces:**
- Consumes: `approvalLogCategory`, `APPROVAL_LOG_ORDER`, `APPROVAL_MARK_DAYS`, `markLabel`, `ApprovalMark`, `Project.waykeeperAuto`, `Project.approvalMarks` (Task 1); `stewardName`/`taskShortName` for "Vega · Prospect list" (existing `agentLabel` if it already gives that).
- Switch: three radio buttons in a group labelled "Waykeeper approves Stewards' requests": `Off`, `Only what fits the task`, `Auto: everything except pushing, sending, spending and deletes outside the project`. Off → `setWaykeeperApprovals(id, false)`; task → `(id, true, false)`; Auto → `(id, true, true)`.
- "Always asks me (n)" list under the switch (only when n > 0): `markLabel(m.match)`, `from “<example>”`, `added <when>`, Remove → `removeApprovalMark`.
- `ApprovalsLog` ("Approved by the Waykeeper"): reads the history as today's `readApprovals` (keeping `seq`, `at`, `agentId`, request line, reason, quote, plus `category = approvalLogCategory(event)`); one collapsible row per category with entries, in `APPROVAL_LOG_ORDER`, title `<Category name> · <count>` (names: Pushes you asked for, Deletes, Outside the project, Network, Unreadable scripts, Edits, Run commands, Reads); closed by default; inside, newest first: `<code>` request, Steward label, time, reason (muted). An entry whose `at` is within `APPROVAL_MARK_DAYS` days of now shows **Ask me next time** → `addApprovalMark(projectId, seq)`; on success the button becomes "Marked"; an error shows with `ErrorLine`.

- [ ] **Step 1: Write failing tests**
  - switch: project with `waykeeperAuto: true` shows the Auto radio checked; clicking "Only what fits the task" calls `setWaykeeperApprovals('p', true, false)`; Off calls `('p', false)`.
  - log: history with a delete approval (parts destructive), two network approvals and one old event without `parts` (`action:'run_workspace'`) renders groups `Deletes · 1`, `Network · 2`, `Run commands · 1` in that order, all closed; opening Network lists both, newest first.
  - log: an entry 3 days old has "Ask me next time" and clicking it calls `addApprovalMark('p', <seq>)`; an entry 11 days old has no such button (clock pinned with `vi.setSystemTime`).
  - marks: a project with one mark lists `deletes in /w/node_modules` and Remove calls `removeApprovalMark('p', id)`.
- [ ] **Step 2: Run** `pnpm --filter @galactic/web exec vitest run src/panel/status` — FAIL.
- [ ] **Step 3: Implement**, styling with the panel's existing classes (`permission-rules`, `pill`, `muted`, `secondary`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `P13-17: the three-way switch, the approvals log by category and the Ask me next time marks`.

### Task 6 (P13-18): Docs and gates

**Files:**
- Modify: `docs/SPEC.md` (decision 159 after 158), `docs/TECHNOLOGY.md` §3.10 (bullet "Auto mode and approval marks (P13-13–P13-17, SPEC decision 159)"), `docs/IMPLEMENTATION_PLAN.md` (Phase 13 item 10), `docs/tasks/PHASE_13_WAYKEEPER_APPROVALS.md`, `docs/tasks/README.md`
- Create: `docs/tasks/notes/P13-13-18-review.md` (after the final review)

- [ ] **Step 1:** SPEC decision 159 "Waykeeper auto mode": the text of the design's §5, Cosmin's quotes from its §1, amends 154; lists the fixed exclusions, the quote rule for sends/spends, the log by category, marks (what each kind catches, 10 days, end with the project, from anywhere).
- [ ] **Step 2:** TECHNOLOGY: the `auto` flag (`waykeeper_approvals` = 2), `ApprovalMark` and its events, `markFromApproval`/`markCovers`, the watch's order (hard rules → marks → judge → re-checks), `RequestJudgeInput.mode`/`sendsOrSpends`, `permission.decided.parts/cwd`, the routes.
- [ ] **Step 3:** Mark P13-13…P13-18 done in the phase file, header and README row (Phase 13 18/18).
- [ ] **Step 4:** Run the gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` — all exit 0.
- [ ] **Step 5: Commit** `P13-18: done — Waykeeper auto mode documented`.
