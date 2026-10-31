# More AI Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stewards can run on Claude Code, OpenAI's Codex CLI or Google's Antigravity CLI, chosen per task or job (provider or exact model) in plain words; usage limits become one "switch or wait" question; nothing is published without a publish approval of that exact content.

**Architecture:** Two new adapters (`codex` over `codex app-server` JSON-RPC, `agy` over stream-json plus a PreToolUse hook bridge) behind the existing `AgentAdapter` interface; a per-spawn `model` threaded from task/job/project/settings through one resolver into `SpawnOptions`; a `publish` question kind modelled on `spend` whose approval arms a one-shot allowance in the permission gate; a limit outcome (`agent.failed` reason `limit`) turned by the runtime into one user question and a persisted retry. The Harmonizer and Waykeepers stay on Claude.

**Tech Stack:** TypeScript, Node 22, Fastify + ws, SQLite (better-sqlite3), zod, Vitest, React 19 + R3F, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-31-more-ai-providers-design.md` (approved 2026-10-31). Research reports: `.superpowers/brainstorm/providers/codex-research.md`, `agy-research.md` (git-ignored, in the main checkout).

**Where to work:** branch `phase-11` from `main` once Cosmin has merged `phase-10` into `main`; if he has not, branch `phase-11` from `phase-10`. Batch branch `p11-1-ai-providers`, worktree `../GalacticAgents-p11`, `pnpm install --frozen-lockfile`. Paths below are as of `phase-10` (21058dc). `P` = `packages/protocol/src`, `S` = `apps/server/src`, `W` = `apps/web/src`.

## Global Constraints

- Providers are `claude` (Claude Code, runtime `claude-sdk`), `chatgpt` (Codex CLI `codex`, runtime `codex`), `gemini` (Antigravity CLI `agy`, runtime `agy`). A provider is the CLI: `gemini` may also run the Claude/GPT models `agy models` lists, but only when the model is named explicitly; "Opus"/"Sonnet"/"Haiku" resolve to `claude`, "GPT…" names to `chatgpt`.
- Subscription logins only; never read or copy `~/.codex/auth.json` or Antigravity credentials; no API keys.
- The Harmonizer and Waykeepers always run on `claude-sdk`; only `role: 'steward'` spawns may use `codex` or `agy`.
- Provider named, no model → the provider's default model (Settings `providers.<p>.model`, else the CLI's own default). Exact model named → that model, checked against the provider's model list before any card is made.
- `gemini` (agy) is never given a publishing step or a publishing follow-up run in this phase (`canPublish: false`); `chatgpt` and `claude` may publish.
- Codex runs with `approvalPolicy: "untrusted"`, sandbox `workspace-write` with network off, and web search, MCP servers, plugins/apps and image generation disabled; never answer `acceptForSession` or send execpolicy/network amendments.
- agy runs headless with `--output-format stream-json`, never `--dangerously-skip-permissions`, never a workspace `.agents/hooks.json`; its gate is Mission Control's hook, and a hook that cannot reach Mission Control answers `deny`.
- Publish approvals: kind `publish`, actions exactly `['Approve', 'Refuse']` (text editable before Approve), user only, never decided by the policy table, a job's unattended rules or "Allow similar", never answered by a brain, remote only under decision 90's rules (as `spend`).
- Limit question: fixed options `Switch to <label>` (one per eligible model) and `Wait until it resets`; nothing switches without the user.
- Adapter boundary (TECHNOLOGY §3): nothing outside `S/adapters` speaks to a CLI; types in `P`; schema changes in migration `0017`; one transaction per command (domain write + event).
- Commits `P11-nn: <imperative summary>`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Gates: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. Focused tests: `npx vitest run <path>` inside the package directory.
- Real CLI runs are local-only and env-gated (`GALACTIC_REAL_CODEX=1`, `GALACTIC_REAL_AGY=1`); CI tests use scripted fake child processes.

## Review Focus

1. **A restart while a step waits for its limit reset** — the retry must still happen at the reset time (the wait is persisted on the question, not held in memory). Test: Task 8 `limit wait survives a restart`.
2. **Cosmin edits the text on a publish card** — the follow-up run must publish the edited text and the allowance must be bound to the edited content's fingerprint, not the draft's. Test: Task 7 `edited publish text is what the follow-up carries`.
3. **A file changes between approval and the outward call** — the allowance must not fire; the call asks with an ordinary permission card. Test: Task 7 `allowance refused when a file changed`.
4. **Loose model names** ("Gemini 3.8 Flash", "opus", "GPT 5.6 terra") — matched case- and separator-insensitively to one listed model, or refused with the list of available models. Test: Task 4 `model names match loosely or refuse with the list`.
5. **A provider's CLI logged out or removed after its card was approved** — the spawn fails with a fixable reason (`not_logged_in` / `not_installed` and the fix), the task does not crash the Waykeeper, and Settings shows the same problem. Test: Task 4 `spawn on a logged-out provider fails with the fix`.

---

### Task 1: Phase file and provider spikes (P11-01)

Prove, on this Mac, the exact protocol shapes the adapters depend on, and record sanitized transcripts the fake child processes replay. This task spends a little subscription quota; nothing it runs touches the network beyond the CLIs' own model calls, and every run happens in a fresh temp directory.

**Files:**
- Create: `docs/tasks/PHASE_11_AI_PROVIDERS.md` (phase file: purpose, references, design notes, execution order, tickets P11-01…P11-10 matching this plan's tasks, exit criteria)
- Modify: `docs/tasks/README.md` (Phase 11 row), `docs/IMPLEMENTATION_PLAN.md` (Phase 11 section)
- Create: `docs/tasks/notes/P11-01-provider-spikes.md`
- Create: `apps/server/src/adapters/codex/fixtures/*.jsonl`, `apps/server/src/adapters/agy/fixtures/*.jsonl` (sanitized transcripts: no account ids, emails, tokens)
- Create: `scripts/spikes/agy-hook-probe.mjs` (the probe hook; kept for re-running after CLI updates)

**Interfaces:**
- Produces (in the notes file, each with the evidence that settled it):
  - Codex: the exact `initialize`/`thread/start`/`turn/start` params for the Global Constraints settings; the dynamic-tool registration and `item/tool/call` request/response shapes; whether a 10-minute-late approval answer is still honoured; whether `curl https://example.com` is blocked in the sandbox; the limit error shape if obtainable from docs/source.
  - agy: whether hooks can be passed per session through `--settings` (preferred) or only through `~/.gemini/config/hooks.json`; the hook's behaviour on timeout and on crash/non-zero exit (**fail closed or open**); which tools reach the hook (shell, file edit, `generate_image`, browser, MCP tools); whether hooks fire inside its subagents (the `image-generator`); whether an MCP server can be passed per session; one headless `generate_image` run and where the file lands; the `/usage` JSON shape.
  - A **Ruling** line: if the agy hook fails open on timeout or crash, or any tool bypasses it, agy runs in image-only mode (every tool except `generate_image` and reading the worktree is denied by the hook's static fallback, and an agy Steward gets no other tools) — Task 6 implements whichever the notes record.

- [ ] **Step 1: Claim** — create the phase file with P11-01 `in progress`, the README row, the IMPLEMENTATION_PLAN section; commit `P11-01: start provider spikes`.
- [ ] **Step 2: Codex probes** — `codex app-server generate-ts --out <tmp>` and record the relevant request types; run the probes listed above in `/private/tmp/claude-501/p11-codex-*`; save transcripts as `codex/fixtures/{turn-ok,approval-command,approval-file,dynamic-tool,late-approval}.jsonl`.
- [ ] **Step 3: agy probes** — with `scripts/spikes/agy-hook-probe.mjs` as hook (logs stdin, answers per an env var, can sleep past its timeout or exit 1), run the probes listed above in `/private/tmp/claude-501/p11-agy-*`; save `agy/fixtures/{turn-ok,hook-allow,hook-deny,image,usage}.jsonl`.
- [ ] **Step 4: Write the notes file** with the answers, the evidence, and the Ruling line.
- [ ] **Step 5: Commit** — `P11-01: done — Codex and Antigravity protocol shapes recorded`; set P11-01 `done (<date>)` in the phase file in the same commit.

---

### Task 2: Protocol — providers, models, publish, limits (P11-02)

**Files:**
- Create: `P/providers.ts`, `P/providers.test.ts`
- Modify: `P/enums.ts` (`AgentRuntime`, `QuestionKind`), `P/adapter.ts`, `P/commands.ts`, `P/domain.ts`, `P/long-term.ts`, `P/long-term-questions.ts`, `P/events.ts`, `P/panel.ts`, `P/world.ts`, `P/fixtures/domain.ts`, `P/fixtures/events.ts`, `P/index.ts`, `P/dev.ts`
- Test: `P/providers.test.ts`, `P/long-term.test.ts`, `P/panel.test.ts`, `P/events.test.ts`

**Interfaces:**
- Produces (exact names; later tasks rely on them):
  - `P/enums.ts`: `AgentRuntime = z.enum(['claude-sdk','fake','acp','pty','codex','agy'])`; `QuestionKind = z.enum(['clarification','permission','spend','publish'])`.
  - `P/providers.ts`:
    - `Provider = z.enum(['claude','chatgpt','gemini'])`
    - `PROVIDER_RUNTIME: Record<Provider, AgentRuntime> = { claude: 'claude-sdk', chatgpt: 'codex', gemini: 'agy' }`
    - `PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }`
    - `ModelChoice = z.object({ provider: Provider, model: z.string().min(1).max(100).optional() })`
    - `ModelCapability = z.enum(['text','image'])`
    - `ModelInfo = z.object({ id: z.string(), label: z.string(), isDefault: z.boolean().default(false), capabilities: z.array(ModelCapability).min(1), family: z.enum(['claude','gpt','gemini','other']) })`
    - `UsageWindow = z.object({ label: z.string(), remainingFraction: z.number().min(0).max(1), resetsAt: z.string().datetime().optional() })`
    - `ProviderUsage = z.object({ plan: z.string().optional(), windows: z.array(UsageWindow) })`
    - `modelChoiceLabel(choice: ModelChoice, models?: ModelInfo[]): string` — `"ChatGPT"`, `"ChatGPT · gpt-5.6-terra"`, and for a `gemini` model whose family is `claude`/`gpt`: `"<label> through Antigravity"`.
    - `normalizeModelName(name: string): string` — lower-case, spaces/underscores/dots between letters and digits collapsed to `-` (`"Gemini 3.8 Flash"` → `"gemini-3.8-flash"`; digits keep their dot).
    - `UsageLimitContext = z.object({ provider: Provider, model: z.string().optional(), resetsAt: z.string().datetime().optional(), taskId: Id.optional(), jobId: Id.optional(), runId: Id.optional(), switchTo: z.array(ModelChoice).max(12) })`
    - `LIMIT_WAIT = 'Wait until it resets'`; `limitSwitchOption(choice: ModelChoice, models?: ModelInfo[]): string` = `` `Switch to ${modelChoiceLabel(choice, models)}` ``.
  - `P/long-term-questions.ts`: `PublishFile = z.object({ path: z.string().min(1).max(500), sha256: z.string().regex(/^[0-9a-f]{64}$/) })`; `PublishContext = z.object({ platform: z.string().min(1).max(80), account: z.string().min(1).max(120), text: z.string().max(8000), files: z.array(PublishFile).max(10), fingerprint: z.string().regex(/^[0-9a-f]{64}$/), jobId: Id.optional(), runId: Id.optional(), taskId: Id.optional() })`; `PUBLISH_ACTIONS = ['Approve','Refuse'] as const`; `publishFingerprint(input: {platform, account, text, files}, sha256: (s: string) => string): string` — the hasher applied to `JSON.stringify([platform, account, text, files.map(f => [f.path, f.sha256])])`; the server passes `node:crypto`, the web never computes it.
  - `P/domain.ts`: `QuestionContext` gains `publish?: PublishContext` and `usageLimit?: UsageLimitContext`; `Task` gains `provider?: Provider`, `model?: string`, `publishes?: boolean`, `makesImages?: boolean`; `Project` gains `defaultProvider?: Provider`; `Agent.meta` documents `model?: string`, `provider?: Provider`.
  - `P/long-term.ts`: `Job` gains `model: z.string().optional()`, `followUpProvider: Provider.optional()`, `followUpModel: z.string().optional()`, `limitQuestionId: Id.optional()`; `JobDraft` picks them too; `provider` becomes `Provider.default('claude')`; `FollowUp.kind` adds `'publish'` with optional `publish: PublishContext`; `JobRunOutcome` adds `'limited'`; `isJobOwned(q)` also true for `kind === 'publish' && q.context.publish?.jobId` and for `q.context.usageLimit?.jobId`.
  - `P/events.ts`: `AgentFailed.reason` adds `'limit'` and the event gains `resetsAt: z.string().datetime().optional()`; `TaskChanges`, `JobChanges`, project changes accept the new fields.
  - `P/adapter.ts`: `SpawnOptions` gains `model?: string`; `AgentAdapter` gains optional `models?(): Promise<ModelInfo[]>`, `usage?(): Promise<ProviderUsage | undefined>`, and readonly `canPublish?: boolean` (absent = false).
  - `P/commands.ts`: `SpawnAgentInput` gains `model?: string`; `PlanTaskInput` and `CreateTaskInput` gain `provider?`, `model?`, `publishes?`, `makesImages?`; `RequestPublishInput = { originAgentId: Id; platform: string; account: string; text: string; files?: string[]; runId?: Id }`; `DomainCommands.requestPublish(input): Promise<CommandResult<{ questionId: Id }>>`; `SetProjectProviderInput = { projectId: Id; provider: Provider | null; by: Actor }`; `DomainCommands.setProjectProvider(input)`.
  - `P/panel.ts`: `RuntimePreflight` gains `provider?: Provider`, `models?: ModelInfo[]`, `usage?: ProviderUsage`; `Settings` gains `defaultProvider?: Provider` and `providers?: Partial<Record<Provider, { model?: string }>>` (and loses `stewardRuntime`); `SettingsPatch` likewise (`providers.<p>.model: string | null`); `QUESTION_TITLES.publish = 'Publish approval needed'`; `notificationOf` maps `publish` like `spend` (notification kind `'permission'`).

- [ ] **Step 1: Write the failing tests** in `P/providers.test.ts`:

```ts
test('provider maps to its runtime', () => {
  expect(PROVIDER_RUNTIME).toEqual({ claude: 'claude-sdk', chatgpt: 'codex', gemini: 'agy' });
});
test('labels a choice', () => {
  const models = [{ id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6', isDefault: false, capabilities: ['text'], family: 'claude' }];
  expect(modelChoiceLabel({ provider: 'chatgpt' })).toBe('ChatGPT');
  expect(modelChoiceLabel({ provider: 'chatgpt', model: 'gpt-5.6-terra' })).toBe('ChatGPT · gpt-5.6-terra');
  expect(modelChoiceLabel({ provider: 'gemini', model: 'claude-opus-4-6-thinking' }, models)).toBe('Claude Opus 4.6 through Antigravity');
});
test('normalizes model names', () => {
  expect(normalizeModelName('Gemini 3.8 Flash')).toBe('gemini-3.8-flash');
  expect(normalizeModelName('GPT_5.6 Terra')).toBe('gpt-5.6-terra');
});
test('publish fingerprint changes with the text and with a file hash', () => {
  const h = (s: string) => createHash('sha256').update(s).digest('hex');
  const base = { platform: 'LinkedIn', account: '@app', text: 'Hi', files: [{ path: 'a.png', sha256: 'a'.repeat(64) }] };
  const f = publishFingerprint(base, h);
  expect(publishFingerprint({ ...base, text: 'Hi!' }, h)).not.toBe(f);
  expect(publishFingerprint({ ...base, files: [{ path: 'a.png', sha256: 'b'.repeat(64) }] }, h)).not.toBe(f);
  expect(publishFingerprint({ ...base }, h)).toBe(f);
});
```

and in `P/panel.test.ts`: `QUESTION_TITLES.publish === 'Publish approval needed'` and a `question.opened` of kind `publish` yields a notification of kind `'permission'`; in `P/long-term.test.ts`: `isJobOwned` true for a publish question with `context.publish.jobId` and for a usage-limit question with `context.usageLimit.jobId`; `JobRunOutcome.parse('limited')` passes.

- [ ] **Step 2: Run** `npx vitest run src/providers.test.ts src/panel.test.ts src/long-term.test.ts` in `packages/protocol` — Expected: FAIL (missing exports).
- [ ] **Step 3: Implement** the Produces list; add fixtures for every changed event in `P/fixtures/events.ts` and fold the new task/job/project fields in `P/world.ts`; remove `stewardRuntime` from `Settings`/`SettingName`/`SettingsPatch`; extend the `Record<QuestionKind, …>` maps (`QUESTION_TITLES`, `P/dev.ts`).
- [ ] **Step 4: Run** `pnpm --filter @galactic/protocol test` — Expected: PASS (including `events.test.ts` fixture coverage). Then `pnpm --filter @galactic/protocol build && pnpm typecheck` — Expected: errors only in server/web code that later tasks change; record them in the report, do not fix them here except where a type rename breaks an import (then fix minimally).
- [ ] **Step 5: Commit** — `P11-02: protocol for providers, models, publish approvals and usage limits`.

---

### Task 3: Migration 0017 and table mappers (P11-02)

**Files:**
- Create: `S/db/migrations/0017_ai_providers.sql`
- Modify: `S/db/tables.ts` (tasks, projects, jobs, questions mappers and patch columns), `S/db/map-export.ts`, `S/db/map-import.ts`
- Test: `S/db/providers-tables.test.ts` (new), `S/db/db.test.ts`

**Interfaces:**
- Consumes: Task 2's `Task`, `Project`, `Job`, `QuestionKind`, `JobRunOutcome`.
- Produces: columns `tasks.provider TEXT NULL CHECK (provider IN ('claude','chatgpt','gemini'))`, `tasks.model TEXT NULL`, `tasks.publishes INTEGER NOT NULL DEFAULT 0`, `tasks.makes_images INTEGER NOT NULL DEFAULT 0`; `projects.default_provider TEXT NULL` (same CHECK); `jobs.model TEXT NULL`, `jobs.follow_up_provider TEXT NULL`, `jobs.follow_up_model TEXT NULL`, `jobs.limit_question_id TEXT NULL`; `questions.kind` CHECK adds `'publish'`; `job_runs.outcome` CHECK adds `'limited'`. The two CHECK changes rebuild their tables exactly as 0016 did (`-- migrate: foreign_keys=off`, copy, drop, rename, recreate every index the table had).

- [ ] **Step 1: Write the failing tests** in `S/db/providers-tables.test.ts`: a task round-trips `provider: 'gemini', model: 'gemini-3.8-flash-low', publishes: false, makesImages: true`; a project round-trips `defaultProvider: 'chatgpt'`; a job round-trips `model`, `followUpProvider: 'chatgpt'`, `followUpModel`, `limitQuestionId`; inserting a question of kind `publish` and a job run with outcome `limited` succeeds; inserting a task with `provider: 'openai'` throws `/CHECK constraint failed/`; after migrating a database seeded at version 16 with one question and one job run, both rows and their indexes are still there (`PRAGMA index_list`). In `S/db/db.test.ts` bump the expected latest version to 17. Map export/import: a project exported and imported keeps the new fields.
- [ ] **Step 2: Run** `npx vitest run src/db/providers-tables.test.ts src/db/db.test.ts` in `apps/server` — Expected: FAIL.
- [ ] **Step 3: Implement** the migration and mappers (booleans as 0/1; absent provider/model as NULL).
- [ ] **Step 4: Run** the same command — Expected: PASS; then `npx vitest run src/db` — Expected: PASS.
- [ ] **Step 5: Commit** — `P11-02: migration 0017 — provider and model columns, publish and limited`. Mark P11-02 done in the phase file.

---

### Task 4: Model resolution, catalogue and per-spawn model (P11-03)

Replace decision 109's single `stewardRuntime` with one resolver used by all four Steward spawn sites; thread `model` into `SpawnOptions` and keep it across resume.

**Files:**
- Create: `S/runtime/steward-choice.ts`, `S/runtime/steward-choice.test.ts`, `S/runtime/provider-catalog.ts`, `S/runtime/provider-catalog.test.ts`
- Modify: `S/runtime/agent-runtime.ts` (`SpawnRequest.model`, `createAgent` meta `{model, provider}`, `start()` passes `model` into `open(...)`, `resume()`/`recoverOne` read it back from `agent.meta`), `S/domain/commands.ts` (`spawnAgent` passes `model`; refuse a non-steward role on `codex`/`agy` with `'brains run on Claude Code'`; `setProjectProvider`), `S/domain/projects.ts`, `S/brains/waykeeper/tools.ts` (`stewardRuntimeOf` removed), `S/brains/harmonizer/tools.ts` (`spawn_steward`), `S/runtime/job-scheduler.ts` (`startIfDue`), `S/runtime/compose.ts` (options `stewardRuntime` → `catalog`), `S/index.ts`, `S/config/config.ts`, `S/config/settings.ts`, `S/adapters/claude-sdk/claude-sdk-adapter.ts` (`buildOptions` prefers `opts.model`; `models()` returns the static list below; `canPublish = true`), `S/adapters/fake/fake-adapter.ts` (`models()` for tests), `S/runtime/tool-runtimes.ts`
- Test: the two new test files, `S/config/settings.test.ts`, `S/adapters/claude-sdk/claude-sdk-adapter.test.ts`, `S/runtime/agent-runtime.test.ts` (resume keeps model)

**Interfaces:**
- Consumes: Task 2 (`Provider`, `PROVIDER_RUNTIME`, `ModelChoice`, `ModelInfo`, `normalizeModelName`, `SpawnOptions.model`, `SpawnAgentInput.model`), Task 3 columns.
- Produces:
  - `S/runtime/provider-catalog.ts`: `class ProviderCatalog { constructor(opts: { adapters: () => AgentAdapter[]; settings: () => { defaultProvider?: Provider; providers?: Partial<Record<Provider, { model?: string }>> }; ttlMs?: number }); models(provider: Provider): Promise<ModelInfo[]>; usage(provider: Provider): Promise<ProviderUsage | undefined>; available(provider: Provider): boolean; defaultModel(provider: Provider): Promise<string | undefined>; check(choice: ModelChoice, need?: { images?: boolean; publishes?: boolean }): Promise<{ ok: true; choice: Required<Pick<ModelChoice,'provider'>> & { model?: string }; label: string } | { ok: false; reason: string }> }` — model lists cached `ttlMs` (default 5 min). `check` resolves a loose name with `normalizeModelName` against `id` and `label`; refusals (exact copy): `` `${label} is not set up on this Mac: ${problem}` `` (adapter missing or preflight not ok), `` `${PROVIDER_LABEL[p]} has no model "${name}". Available: ${ids.join(', ')}` ``, `` `${label} cannot make images` `` (no `image` capability), `` `${label} cannot publish: GalacticAgents cannot hold its actions back yet` `` (adapter `canPublish` not true).
  - Claude's static list: `[{id:'opus',label:'Opus',family:'claude',capabilities:['text']},{id:'sonnet',label:'Sonnet',…},{id:'haiku',label:'Haiku',…}]`, `isDefault` on none (Claude Code's default applies).
  - `S/runtime/steward-choice.ts`: `resolveStewardChoice(input: { task?: Pick<Task,'provider'|'model'>; job?: Pick<Job,'provider'|'model'|'followUpProvider'|'followUpModel'>; followUp?: boolean; project?: Pick<Project,'defaultProvider'>; defaultProvider?: Provider; defaultModel: (p: Provider) => string | undefined }): { provider: Provider; runtime: AgentRuntime; model?: string }` — precedence: follow-up's `followUpProvider/followUpModel` (when `followUp`) → task → job → project `defaultProvider` → Settings `defaultProvider` → `'claude'`; model falls back to `defaultModel(provider)` only when the chosen layer named no model.
  - Config upgrade (in `S/config/config.ts` load): a stored `stewardRuntime` of `claude-sdk` becomes `defaultProvider: 'claude'`, `codex` → `'chatgpt'`, `agy` → `'gemini'`; `acp`/`pty`/`fake` are dropped with one warning line `stewardRuntime "<v>" is no longer a setting; Stewards use the project's provider`; the key is removed on the next write. `GALACTIC_STEWARD_RUNTIME` stays as a dev override of the runtime for tests (`fake`).
  - `TOOL_RUNTIMES` becomes `new Set(['claude-sdk','fake','codex','agy'])` (Tasks 5–6 serve them).

- [ ] **Step 1: Write the failing tests**:
  - `steward-choice.test.ts`: `follow-up uses its own provider` (job `{provider:'gemini', followUpProvider:'chatgpt'}`, `followUp: true` → `{provider:'chatgpt', runtime:'codex'}`); `task beats job beats project beats settings`; `named provider without model takes the default model` (`defaultModel: p => p==='gemini' ? 'gemini-3.8-flash-high' : undefined`); `nothing named means claude`.
  - `provider-catalog.test.ts` with fake adapters exposing `models()`: `model names match loosely or refuse with the list` (`'Gemini 3.8 Flash High'` → `gemini-3.8-flash-high`; `'opus'` → claude `opus`; `'gpt-9'` → reason `ChatGPT has no model "gpt-9". Available: gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna`); `images need an image model` (chatgpt + `images:true` → `ChatGPT cannot make images`); `agy cannot publish` (gemini + `publishes:true` → `… cannot publish: GalacticAgents cannot hold its actions back yet`); `spawn on a logged-out provider fails with the fix` (adapter preflight `{ok:false, problems:[{code:'not_logged_in', message:'Codex is not logged in', fix:'Run codex login'}]}` → `check` reason contains `Codex is not logged in` and `spawnAgent` for a task with `provider:'chatgpt'` returns `{ok:false}` with that reason and no Waykeeper crash).
  - `claude-sdk-adapter.test.ts`: a spawn with `model: 'sonnet'` passes `model: 'sonnet'` to the fake SDK query even when the adapter-wide model is `opus`.
  - `agent-runtime.test.ts`: `resume keeps the spawn model` (spawn with `model:'m1'`, dispose runtime, recover → the adapter's `resumeSession` received `opts.model === 'm1'`).
  - `settings.test.ts`: config with `stewardRuntime: 'codex'` loads as `defaultProvider: 'chatgpt'` and no `stewardRuntime`; `acp` is dropped with the warning; `providers.gemini.model` patch persists and `null` clears it.
- [ ] **Step 2: Run** `npx vitest run src/runtime/steward-choice.test.ts src/runtime/provider-catalog.test.ts src/config/settings.test.ts src/adapters/claude-sdk/claude-sdk-adapter.test.ts src/runtime/agent-runtime.test.ts` in `apps/server` — Expected: FAIL.
- [ ] **Step 3: Implement** the Produces list; the four spawn sites (Waykeeper `spawn_steward`, Harmonizer `spawn_steward`, `JobScheduler.startIfDue`, and `commands.spawnAgent`'s default) call `resolveStewardChoice` and pass `runtime` + `model`; brains keep `claude-sdk`.
- [ ] **Step 4: Run** the same command — Expected: PASS; then `pnpm --filter @galactic/server test` — Expected: PASS (fix call sites the removed `stewardRuntime` broke; the existing Steward-runtime tests become choice tests).
- [ ] **Step 5: Docs and commit** — SPEC decision 109 amended ("replaced by per-task providers, decision 146"), TECHNOLOGY §3 gains "§3.5 Providers and models" (catalogue, resolver, precedence, config upgrade). Commit `P11-03: one resolver for a Steward's provider and model; per-spawn model kept across resume`. Mark P11-03 done.

---

### Task 5: The Codex adapter (P11-04)

**Files:**
- Create: `S/adapters/codex/codex-adapter.ts`, `rpc.ts` (JSON-RPC 2.0 over stdio: requests, notifications, server requests), `mapping.ts` (approval requests → `ToolCall`; events → `AgentEvent`), `preflight.ts`, `limits.ts`, `fake-codex-agent.mjs` (replays Task 1's fixtures by scenario), `codex-adapter.test.ts`, `codex.conformance.test.ts`, `codex-real.conformance.test.ts` (env `GALACTIC_REAL_CODEX=1`)
- Modify: `S/index.ts` (register `new CodexAdapter({ supervisor, command: config.codex?.command ?? 'codex' })` when `codex` is on PATH or configured), `S/config/config.ts` (`codex?: { command?: string }`), `S/runtime/compose.ts` (`STALL_THRESHOLDS_MS.codex = 5 * 60_000`, `.agy = 5 * 60_000`), `S/adapters/README.md` ("The Codex adapter" section)
- Test: as created

**Interfaces:**
- Consumes: Task 1 notes (exact message shapes), Task 2 (`SpawnOptions.model`, `ModelInfo`, `ProviderUsage`, `AgentFailed.reason 'limit'`), Task 4 (`TOOL_RUNTIMES` includes `codex`).
- Produces: `class CodexAdapter implements AgentAdapter { readonly runtime = 'codex'; readonly canPublish = true; constructor(opts: { supervisor: ProcessSupervisor; command?: string; env?: Record<string,string> }) }` with `spawn`, `send`, `answer`, `interrupt`, `pause`, `resume`, `stop`, `resumeSession` (session ref `codex:<threadId>`), `preflight()`, `models()` (from `model/list`; `capabilities: ['text']`; `isDefault` from the list), `usage()` (from `account/rateLimits/read` + `account/read` plan).
- Mapping (pins the gate): `item/commandExecution/requestApproval` → `{toolName:'Bash', input:{command}}`; `item/fileChange/requestApproval` → `{toolName:'Edit', input:{file_path, …}}` per changed path (all must allow, else decline); `item/permissions/requestApproval` → `{toolName:'codex:permissions', input}` (the policy's `unclassified` entry decides); `mcpServer/elicitation/request` → decline always (MCP is off); `item/tool/call` for a name in `opts.tools` → run the `ToolDefinition.handler` and reply with its JSON (a bare server-tool name, so the gate's `isServerTool` allows it); gate verdict `allow` → `accept`, `deny` → `decline`, `ask` → `agent.needs_input(permission)` and answer when `answer()` arrives (no timeout).
- Limits: an `error` with `codexErrorInfo: 'usageLimitExceeded'` (or the Task 1 shape) → read `account/rateLimits/read`, emit `agent.failed{reason:'limit', error:'ChatGPT usage limit reached', resetsAt}` as the one terminal event.

- [ ] **Step 1: Write the failing tests** in `codex-adapter.test.ts` (driving `fake-codex-agent.mjs`): `starts with the safe settings` (the fake records `thread/start` params: `approvalPolicy === 'untrusted'`, sandbox `workspace-write`, `networkAccess === false`; config overrides disable `web_search`, `mcp_servers`, `apps`/plugins and `image_generation`); `command approval asks the gate` (gate `ask` → one `agent.needs_input` with `toolCall.toolName === 'Bash'`, `answer(q,'allow')` → fake receives `accept`); `deny declines`; `never accepts for the session` (no reply ever contains `acceptForSession`); `serves a server tool` (fake calls `item/tool/call` `request_publish` → handler ran with the input, reply carries its JSON); `elicitation is declined`; `usage limit ends with reason limit and the reset time` (`resetsAt` equals the fake's `resetsAt` as ISO); `model passed through` (`spawn({model:'gpt-5.6-terra'})` → `turn/start.model`); `preflight logged out` (fake `login status` exits 1 → problem `not_logged_in` with fix `Run codex login in Terminal`); `preflight warns on an unknown version` (a version outside `KNOWN_CODEX_VERSIONS = '>=0.166 <0.200'` → a `warning` problem `check_failed` "Codex <v> has not been tested with GalacticAgents"; the same pattern for agy in Task 6 with `>=1.4 <2.0`). `codex.conformance.test.ts` calls `describeAdapterConformance({ name: 'codex', runtime: 'codex', metered: false, resumable: true, toolCalls: true, … })` against the fake.
- [ ] **Step 2: Run** `npx vitest run src/adapters/codex` in `apps/server` — Expected: FAIL.
- [ ] **Step 3: Implement** following the ACP adapter's structure (process via `ProcessSupervisor`, `lib/event-queue.ts`, one terminal event per session) and the README rules.
- [ ] **Step 4: Run** `npx vitest run src/adapters/codex` — Expected: PASS; locally, once: `GALACTIC_REAL_CODEX=1 npx vitest run src/adapters/codex/codex-real.conformance.test.ts` — Expected: PASS or a recorded skip reason in the report (quota/plan).
- [ ] **Step 5: Docs and commit** — README section, SPEC decision 120 amended (Codex and Antigravity Stewards get the server's tools), TECHNOLOGY §3.6 "Codex". Commit `P11-04: Codex adapter over app-server with every action gated`. Mark P11-04 done.

---

### Task 6: The Antigravity adapter and its hook bridge (P11-05)

**Files:**
- Create: `S/adapters/agy/agy-adapter.ts`, `hook-bridge.ts` (server side: per-session secret, pending decisions), `galactic-agy-hook.mjs` (the hook process `agy` runs: reads the tool call from stdin, POSTs it to Mission Control, prints the decision; on any error prints `{"decision":"deny"}`), `tool-server.ts` (a local MCP server over stdio or HTTP exposing `opts.tools`, the only MCP server enabled for the session), `images.ts` (copies new files from `~/.gemini/antigravity-cli/brain/<conversation_id>/` into `<cwd>/generated-images/` before the turn's end is reported), `preflight.ts`, `limits.ts`, `fake-agy.mjs`, `agy-adapter.test.ts`, `hook-bridge.test.ts`, `agy.conformance.test.ts`, `agy-real.conformance.test.ts` (env `GALACTIC_REAL_AGY=1`)
- Create: `S/http/agy-hook-routes.ts` (`POST /api/agy-hook` — loopback only, header `x-galactic-hook: <session secret>`, long-poll up to the hook timeout)
- Modify: `S/index.ts`, `S/app.ts` (route), `S/config/config.ts` (`agy?: { command?: string }`), `S/adapters/README.md`
- Test: as created

**Interfaces:**
- Consumes: Task 1 notes and Ruling (hook delivery: `--settings` or the managed global entry; image-only mode if the hook fails open), Task 2, Task 4.
- Produces: `class AgyAdapter implements AgentAdapter { readonly runtime = 'agy'; readonly canPublish = false; constructor(opts: { supervisor: ProcessSupervisor; command?: string; hookUrl: () => string; bridge: HookBridge; home?: string }) }`; session ref `agy:<conversationId>`; `models()` from `agy models` (capabilities: `['text','image']` for `gemini-*` ids, `['text']` otherwise; `family` from the id prefix); `usage()` from `agy -p "/usage" --output-format json` (`remaining_fraction`, `reset_time` per bucket → `UsageWindow`).
  - `class HookBridge { register(sessionSecret: string, decide: (call: ToolCall) => Promise<'allow' | 'deny'>): void; unregister(sessionSecret: string): void; handle(secret: string, body: unknown): Promise<{ decision: 'allow' | 'deny'; reason?: string }> }` — unknown secret → `deny`; `decide` runs the spawn's gate: `allow` → allow, `deny` → deny, `ask` → `agent.needs_input(permission)` and resolve on `answer()`.
  - Hook timeout set to the maximum Task 1 found accepted (no shorter than 24 h); the hook never answers `auto_approve`/`ask`/`force_ask`.
  - Global-entry case only (if `--settings` cannot carry hooks): Mission Control adds one entry tagged `"galactic": true` to `~/.gemini/config/hooks.json` at adapter start and removes only that entry on dispose; when no Mission Control session secret matches, the hook answers `deny` only for runs Mission Control started (env `GALACTIC_AGY_SECRET` present) and passes through otherwise, so Cosmin's own `agy` use is unaffected.

- [ ] **Step 1: Write the failing tests**: `hook-bridge.test.ts`: `unknown secret is denied`; `gate allow and deny pass through`; `ask waits for the answer` (no resolution until `answer()`; then allow); `bridge unreachable means deny` (spawn `galactic-agy-hook.mjs` with a dead URL → stdout `{"decision":"deny"}`, exit 0); `crashing bridge means deny` (server returns 500 → deny). `agy-adapter.test.ts` with `fake-agy.mjs`: `never skips permissions` (argv lacks `--dangerously-skip-permissions`, has `--output-format stream-json`); `model passed through`; `server tool through the tool server` (fake calls `request_publish` via MCP → handler ran); `generated image copied into the worktree` (fake writes `brain/<id>/img1.png` → after the turn `<cwd>/generated-images/img1.png` exists, byte-equal); `limit ends with reason limit` (fake exits 3 with an `AGY_ERROR` quota line → `agent.failed{reason:'limit', resetsAt}` from `/usage`); `canPublish is false`. If Task 1 ruled image-only mode: `image-only mode denies other tools` (hook given `run_command` → deny without asking). `agy.conformance.test.ts` against the fake.
- [ ] **Step 2: Run** `npx vitest run src/adapters/agy src/http/agy-hook-routes.test.ts` in `apps/server` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the same — Expected: PASS; locally once `GALACTIC_REAL_AGY=1 npx vitest run src/adapters/agy/agy-real.conformance.test.ts` (includes one `generate_image`) — Expected: PASS or a recorded skip reason.
- [ ] **Step 5: Docs and commit** — README "The Antigravity adapter", TECHNOLOGY §3.7 (hook bridge, fail-closed rule, image copy), SPEC §8 open question "Google's consumer terms for wrapping `agy`" (Cosmin chose to use it, 2026-10-31). Commit `P11-05: Antigravity adapter with a fail-closed hook bridge and image copy`. Mark P11-05 done.

---

### Task 7: Publish approvals (P11-06)

**Files:**
- Create: `S/domain/publish.ts`, `S/domain/publish.test.ts`, `S/runtime/publish-allowance.ts`, `S/runtime/publish-allowance.test.ts`
- Modify: `S/brains/job-tools.ts` (`request_publish` tool for every Steward; `report_finding` kind `reply` no longer offered — replies are `request_publish` in a job run), `S/domain/commands.ts` (`requestPublish`), `S/domain/questions.ts` (`checkHolder`, `checkFixedAnswer`, `escalateQuestion`: `publish` like `spend`), `S/domain/question-service.ts` (`holderFor('publish')` = user), `S/domain/findings.ts` (`applyJobAnswer` dispatches `publish`; legacy `Send` unchanged), `S/runtime/permission-gate.ts` (option `allowOnce?: (call: ToolCall, verdict: GateVerdict) => boolean`, consulted after the policy says `ask` and before rules), `S/runtime/agent-runtime.ts` (`rulesOf` skips unattended rules for a publishing run; gate gets `allowOnce` from the allowance store), `S/runtime/job-scheduler.ts` (a `publish` follow-up runs on `resolveStewardChoice({…, followUp: true})` and is refused to start on a provider whose adapter `canPublish` is not true — the run fails with `"<label> cannot publish"`), `S/brains/common-tools.ts`, `S/brains/waykeeper/tools.ts`, `S/brains/wake.ts` (brains never answer or escalate `publish`), `S/http/agent-routes.ts` (`publish` joins `permission`/`spend` in the agent-peer check), `S/brains/steward-prompt.ts` (`publishEtiquette(canAsk)`), `S/brains/job-prompt.ts` (follow-up text for `publish`)
- Test: as created, plus `S/brains/job-tools.test.ts`, `S/http/agent-routes.test.ts`, `S/http/remote-access.test.ts`, `S/runtime/job-scheduler.test.ts`

**Interfaces:**
- Consumes: Task 2 (`PublishContext`, `PUBLISH_ACTIONS`, `publishFingerprint`, `FollowUp.kind 'publish'`, `RequestPublishInput`), Task 4 (`resolveStewardChoice`, adapter `canPublish`).
- Produces:
  - `requestPublish(ctx, input: RequestPublishInput, routing, deps: { readFile: (abs: string) => Buffer; worktreeOf: (agentId: Id) => string }): CommandResult<{ questionId: Id }>` — files are worktree-relative, must exist inside the worktree (else `refused: "<path> is not in the task's folder"`), hashed; opens `kind:'publish'`, holder user, `context.text = \`Publish to ${platform} (${account})\``, `options: [...PUBLISH_ACTIONS]`, `context.publish`, `meta: { toUser: true, …(run ? { jobOwned: true } : {}) }`. A task Steward whose task is not `publishes` is refused: `"this task is not a publishing step; ask your Waykeeper"`. A task Steward on agy is refused: `"Gemini cannot publish"`. A job run Steward may ask on any provider (it only queues the follow-up; the follow-up's provider is checked when it starts).
  - Answer `Approve` with `detail.text` edited → the stored `context.publish` gets the edited `text` and a recomputed `fingerprint` (event `question.answered` carries the detail as today); job-owned → `queueFollowUp(ctx, job, { questionId, kind: 'publish', publish })`; task Steward → `PublishRelay` (like `SpendRelay`) messages the live asker `Publish approval for <platform>: approved|refused` and `PublishAllowanceStore.arm(agentId, publish)`.
  - `class PublishAllowanceStore { arm(agentId: Id, publish: PublishContext, worktree: string): void; check(agentId: Id, call: ToolCall, categories: PermissionAction[]): 'allow' | 'none'; disarm(agentId: Id): void }` — `check` returns `allow` once, for the first call whose policy verdict is `ask` with category `network`, when every file's current sha256 still matches; a mismatch disarms and returns `none` (the call then asks normally). Armed allowances expire after 30 minutes and on the agent's end.
  - Publishing run = a job follow-up with `kind:'publish'`, or a Steward of a task with `publishes: true`: `rulesOf` returns the project rules only (no unattended job rules).

- [ ] **Step 1: Write the failing tests**:
  - `publish.test.ts`: `opens a user-only publish question with the content`; `refuses a file outside the worktree`; `refuses a non-publishing task`; `refuses a Gemini task Steward`; `a Gemini job run may ask` (job-owned question opened); `a brain cannot answer it` (`answer_question` via the brain harness → refused); `edited publish text is what the follow-up carries` (job run Steward asks, user answers `Approve` with `detail.text: 'Edited'` → `job.followUps[0].publish.text === 'Edited'` and its fingerprint equals `publishFingerprint` of the edited content); `refuse queues nothing`; `legacy Send findings still queue a send`.
  - `publish-allowance.test.ts`: `allows exactly one network ask after approval`; `allowance refused when a file changed` (rewrite the file after arming → `none` and disarmed); `expires after 30 minutes`; `never turns a deny into allow`.
  - `job-scheduler.test.ts`: `publish follow-up runs on the follow-up provider without unattended rules` (job `{provider:'gemini', followUpProvider:'chatgpt', unattendedRules:[network rule]}` → spawn runtime `codex`, gate rules exclude the unattended rule); `publish follow-up refused on Gemini` (no followUpProvider, job provider gemini → run fails with `Gemini cannot publish`, job pauses with one failure question).
  - Routes: `agent process cannot answer publish` (403 `agent_peer`); remote client may answer publish exactly when it may answer spend.
- [ ] **Step 2: Run** `npx vitest run src/domain/publish.test.ts src/runtime/publish-allowance.test.ts src/runtime/job-scheduler.test.ts src/http/agent-routes.test.ts src/http/remote-access.test.ts src/brains/job-tools.test.ts` in `apps/server` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the same — Expected: PASS; then `pnpm --filter @galactic/server test` — Expected: PASS.
- [ ] **Step 5: Docs and commit** — SPEC decision 147 "Publish approvals" (behaviour above; folds Phase 10's send: new replies are publish approvals, waiting Send findings answered the old way; agy excluded), decision 144/145 cross-references. Commit `P11-06: publish approvals bound to their content, with a one-shot allowance`. Mark P11-06 done.

---

### Task 8: Usage limits — one question, switch or wait (P11-07)

**Files:**
- Create: `S/runtime/usage-limits.ts`, `S/runtime/usage-limits.test.ts`
- Modify: `S/adapters/claude-sdk/claude-sdk-adapter.ts` (a `rate_limit_event` with `status: 'rejected'`, or an error result naming the usage limit → `agent.failed{reason:'limit', error:'Claude usage limit reached', resetsAt}`), `S/runtime/work-state-deriver.ts` and `S/domain/work-states.ts` (an agent failed with reason `limit` derives its task `paused`, not `failed`), `S/runtime/job-scheduler.ts` (`agent.failed` reason `limit` → `endJobRun(outcome:'limited')`, job stays `active`, `limitQuestionId` set; `startIfDue` skips a job with `limitQuestionId`), `S/domain/job-runs.ts` (`limited` never pauses the job or opens a failure question), `S/runtime/compose.ts` (wire `UsageLimits`)
- Test: as created, plus `S/adapters/claude-sdk/claude-sdk-adapter.test.ts`, `S/runtime/job-scheduler.test.ts`, `S/domain/work-states.test.ts`

**Interfaces:**
- Consumes: Task 2 (`UsageLimitContext`, `LIMIT_WAIT`, `limitSwitchOption`, `AgentFailed.reason 'limit'`), Task 4 (`ProviderCatalog`, `resolveStewardChoice`), Tasks 5–6 (adapters emit `reason:'limit'`).
- Produces: `class UsageLimits { constructor(opts: { log; commands; catalog: ProviderCatalog; now?: () => number; tickMs?: number }); onEvent(e: Event): void; tick(): Promise<void>; dispose(): void }`:
  - On `agent.failed{reason:'limit'}` of a Steward: open ONE question (`kind:'clarification'`, holder user, `meta:{toUser:true, jobOwned: !!jobId}`) with `context.text = \`${label} usage limit reached${resetsAt ? \` — resets ${resetsAt}\` : ''}. Switch to another model or wait?\``, `context.usageLimit` (`switchTo` = models from every available provider whose `check(choice, need)` passes for the step's `makesImages`/`publishes` and whose `usage()` shows no window at 0, excluding the stopped model; at most 12), `options = [...switchTo.map(limitSwitchOption), LIMIT_WAIT]`. A second limit on the same task while one is open opens nothing.
  - Answer `Switch to …`: task step → `task.updated{provider, model}` and a new Steward spawned on the task (supervisor = the previous Steward's supervisor) with the Steward prompt plus `handover`: `"An earlier attempt on <label> stopped at its usage limit. Its work so far is in this folder; its last report: <last progress summary or 'none'>. Continue from there."`; job run → the next run of that job only uses the chosen model (the choice is stored on the limit question's `meta.switchTo`; `startIfDue` reads it from `job.limitQuestionId`'s question when it starts that run, then clears `limitQuestionId`), job due now; the job's own provider is unchanged (a lasting change is a job change card).
  - Answer `Wait until it resets`: the question's `meta.retryAt = resetsAt ?? now + 60 min`; `tick()` (every 60 s, and once at start so restarts pick it up) finds answered wait questions with `retryAt <= now` and not yet retried: task → resume the stopped session when the adapter can (`resumeSession`), else spawn as for a switch on the same model; job → `limitQuestionId` cleared and the job due now; marks `meta.retriedAt`.
  - Brains never answer a usage-limit question (`answer_question` refuses `context.usageLimit` like `jobFailure`).

- [ ] **Step 1: Write the failing tests** in `usage-limits.test.ts` (fake adapter scenario `fail{reason:'limit'}` with `resetsAt`): `one question with eligible models` (an image task on gemini limited → options contain no ChatGPT model and end with `Wait until it resets`); `a second limit opens nothing`; `switch updates the task and starts a Steward with the handover`; `wait retries at the reset time` (advance `now` past `resetsAt`, `tick()` → a Steward runs on the same model); `limit wait survives a restart` (answer wait, dispose, new `UsageLimits` on the same log, advance time, `tick()` → retried once, not twice); `no reset time waits an hour`. `job-scheduler.test.ts`: `a limited run does not pause the job` (outcome `limited`, state `active`, no failure question, no new run until the limit question is answered). `work-states.test.ts`: `a limited Steward leaves its task paused`. `claude-sdk-adapter.test.ts`: `rejected rate limit ends with reason limit` (fake SDK emits `rate_limit_event{status:'rejected', resetsAt: 1793000000}` → `agent.failed{reason:'limit', resetsAt:'2026-…Z'}`).
- [ ] **Step 2: Run** `npx vitest run src/runtime/usage-limits.test.ts src/runtime/job-scheduler.test.ts src/domain/work-states.test.ts src/adapters/claude-sdk/claude-sdk-adapter.test.ts` in `apps/server` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the same — Expected: PASS; then `pnpm --filter @galactic/server test` — Expected: PASS.
- [ ] **Step 5: Docs and commit** — SPEC decision 148 "Usage limits"; TECHNOLOGY §3.5 limit detection per adapter. Commit `P11-07: a usage limit pauses the step and asks to switch or wait`. Mark P11-07 done.

---

### Task 9: Brain tools and prompts carry providers (P11-08)

**Files:**
- Modify: `S/brains/harmonizer/tools.ts` (`propose`/`propose_long_term` gain `providerNote?: string` (≤ 500 chars, stored as `meta.providerNote`, shown on the card); new tools `check_model {provider, model?, images?, publishes?}` → `catalog.check` result, and `set_project_provider {projectId, provider | null}` → `commands.setProjectProvider`; `relay_to_waykeeper` and `spawn_waykeeper` include the approved proposal's `providerNote` in the Waykeeper's message), `S/brains/harmonizer/prompt.ts`, `S/brains/waykeeper/tools.ts` (`plan_tasks` and `create_task` task props `provider`, `model`, `makesImages`, `publishes`; every task checked with `catalog.check(choice, {images: makesImages, publishes})` before `proposePlan` — a refusal returns `{error, message: <reason>}` and creates nothing), `S/brains/waykeeper/job-tools.ts` (`DRAFT_PROPERTIES` gain `model`, `followUpProvider`, `followUpModel`; checked the same way, `followUp` checked with `publishes: true`), `S/brains/waykeeper/prompt.ts`, `S/domain/proposals.ts` (`DRAFT_FIELDS` and `proposeJob` carry the new fields; `proposePlan` stores them on the tasks)
- Test: `S/brains/harmonizer/proposal-flow.test.ts`, `S/brains/waykeeper/job-tools.test.ts`, `S/brains/waykeeper/providers.test.ts` (new)

**Interfaces:**
- Consumes: Task 4 (`ProviderCatalog.check`, `setProjectProvider`), Task 2 inputs, Task 7 (`publishes` meaning).
- Produces: prompt lines (exact copy to add):
  - Harmonizer: `"When the user names an AI for part of the work (\"use Gemini for the images\", \"ChatGPT publishes\"), call check_model for each, tell the user at once if one is refused, and put what they said in providerNote. Gemini (Antigravity) never publishes. \"Opus\", \"Sonnet\", \"Haiku\" are Claude; GPT models are ChatGPT; Antigravity's Claude or GPT models only when the user says \"through Antigravity\"."`
  - Waykeeper: `"The approved request may carry a provider note. Give each task the provider and model it names (provider alone means its default model), mark image-making tasks makesImages and publishing tasks publishes, and leave the rest to the project default. A publishing task never goes to Gemini."`

- [ ] **Step 1: Write the failing tests** with the scripted brain harness: `providers.test.ts`: `plan carries provider and model per task` (`plan_tasks` with `[{description:'Make images', provider:'gemini', makesImages:true}, {description:'Publish', provider:'chatgpt', publishes:true, blockedBy:[1]}]` → proposed tasks have those fields); `plan with an unknown model creates nothing` (result `error` with `ChatGPT has no model "gpt-9"…`, no tasks or proposal); `publishing task on Gemini is refused`. `job-tools.test.ts`: `job card carries follow-up provider` and `follow-up on Gemini is refused`. `proposal-flow.test.ts`: `provider note travels to the Waykeeper` (approve a proposal with `providerNote` → the Waykeeper's first message contains it); `check_model reports a refusal`; `set_project_provider changes the default`.
- [ ] **Step 2: Run** `npx vitest run src/brains` in `apps/server` — Expected: FAIL in the new tests.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npx vitest run src/brains` — Expected: PASS.
- [ ] **Step 5: Docs and commit** — SPEC decision 146 "AI providers per step" (Cosmin's decisions and Claude's calls from the spec, including the follow-up provider and project default); Commit `P11-08: Harmonizer and Waykeeper carry providers and models into plans and jobs`. Mark P11-08 done.

---

### Task 10: Web — Settings providers section (P11-09)

**Files:**
- Modify: `W/panel/settings/PreflightCheck.tsx` (`RUNTIME_NAMES` adds `codex: 'Codex (ChatGPT)'`, `agy: 'Antigravity (Gemini)'`; `RuntimeRow` shows plan, version, and usage windows `"<label>: <n>% left · resets <relative time>"`), `W/panel/settings/sections.tsx` (remove `STEWARD_RUNTIME`; add `PROVIDERS` section: default provider radio (only providers whose preflight is ok, plus the current value) and per provider a default-model select from `preflight.models` with "CLI default" as empty), `W/panel/settings/SettingsPage.tsx`, `W/panel/settings/settings-model.ts`, `W/console/api.ts` if the preflight type changed
- Test: `W/panel/settings/providers-section.test.tsx` (new), existing settings tests updated

**Interfaces:**
- Consumes: Task 2 (`RuntimePreflight.models/usage/provider`, `Settings.defaultProvider/providers`, `SettingsPatch`).

- [ ] **Step 1: Write the failing tests**: `lists each provider with its login state and limits` (preflight fixture: codex ok with usage window 0.42 → text `42% left`); `default model select saves providers.chatgpt.model` (patch body `{providers:{chatgpt:{model:'gpt-5.6-terra'}}}`); `CLI default clears it` (`model: null`); `default provider offers only providers that are set up`; `no Steward runtime section any more`; phone width 320 px renders without horizontal overflow (existing settings layout test pattern).
- [ ] **Step 2: Run** `npx vitest run src/panel/settings` in `apps/web` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** — `P11-09: Settings show each AI provider, its limits and default model`.

---

### Task 11: Web — publish card, limit card, provider chips, satellite mark (P11-09)

**Files:**
- Create: `W/panel/cards/PublishCard.tsx` (`PublishDetails`: badge `↗`, platform, account, text, images shown via the existing deliverable file route by worktree path, "from job … / task …"; `PublishActions`: textarea pre-filled with the text, Approve (primary) sending `onAnswer('Approve', {choices:['Approve'], text})`, Refuse `.danger`), `W/panel/cards/UsageLimitCard.tsx` (details: provider/model, reset time; actions: one button per option)
- Modify: `W/panel/cards/QuestionCard.tsx` (dispatch `publish` and `context.usageLimit`), `W/panel/cards/index.ts`, `W/app.css` (tokens `--publish: #c2571a; --publish-bg: #24140b;` and `.question-publish`, `.publish-badge`, dark/light as the spend tokens), `W/panel/cards/DismissQuestion.tsx` (dismissing a publish = refuse copy), `W/panel/inbox-model.ts`, `W/scene/beacons/beacon-look.ts` and `beacon-model.ts` (`publish` ranks with permission/spend; symbol `↗`, colour `--publish`), `W/panel/notifications/notifier.ts`, `W/panel/status/status-model.ts` (`byKind.publish`), `W/panel/history/HistoryPage.tsx` (filter), `W/panel/cards/ProposalCard.tsx` (`PlanCard` task rows: chip `modelChoiceLabel(...)` plus `images` / `publishes` tags; `WorkCard` shows `providerNote`), `W/panel/cards/JobCard.tsx` (rows `provider`, `model`, `follow-up provider`; `jobChanges` includes them), `W/panel/jobs/jobs-model.ts` (`providerText` uses `PROVIDER_LABEL`), `W/panel/status/StatusViews.tsx` (`TaskStatusFacts` fact `model` from the running agent's `meta.provider/model`), `W/scene/satellites/satellite-model.ts` (`SatelliteSpec.provider`), `W/scene/satellites/look.ts` (a small provider ring tint: claude none, chatgpt `#10a37f`, gemini `#4285f4`), `W/scene/satellites/Satellites.tsx` (`sameSatellites` compares `provider`)
- Test: `W/panel/cards/publish-cards.test.tsx` (new), `W/panel/cards/job-cards.test.tsx`, `W/scene/satellites/satellite-model.test.ts`, `W/scene/beacons/beacon-model.test.ts`, `W/panel/inbox-model` tests

**Interfaces:**
- Consumes: Task 2 (`PublishContext`, `UsageLimitContext`, `PROVIDER_LABEL`, `modelChoiceLabel`), Task 7/8 question shapes.

- [ ] **Step 1: Write the failing tests**: `publish card shows platform, account, text and images`; `approve sends the edited text` (`onAnswer` called with `('Approve', {choices:['Approve'], text:'Edited'})`); `refuse is a danger button`; `publish ranks first in the inbox with permission and spend`; `limit card offers each option as a button`; `plan card shows each task's model chip` (`Gemini`, `ChatGPT · gpt-5.6-terra`, tag `publishes`); `job card shows the follow-up provider`; `satellite carries its provider` (`satelliteList` spec `provider === 'chatgpt'` for an agent with runtime `codex`); `publish beacon uses the publish glyph`; phone width 320 px: publish card actions reachable without horizontal scroll.
- [ ] **Step 2: Run** `npx vitest run src/panel/cards src/scene/satellites src/scene/beacons src/panel/inbox-model.test.ts` in `apps/web` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the same, then `pnpm --filter @galactic/web test` — Expected: PASS.
- [ ] **Step 5: Commit** — `P11-09: publish and limit cards, provider chips and satellite marks`. Mark P11-09 done.

---

### Task 12: End-to-end and phase exit (P11-10)

**Files:**
- Create: `e2e/tests/14-ai-providers.spec.ts`; dev harness additions in `S/runtime/harness-jobs.ts` / `S/http/dev-routes.ts` / `P/dev.ts` to run a fake Steward reported as `codex` or `agy` (the fake adapter registered under those runtime names in dev harness mode only)
- Modify: `docs/SPEC.md` (§8: "Can Codex make images on a ChatGPT plan?", "Do Codex approvals wait for hours?"; check decisions 146–148 and amendments 109/120 read consistently), `docs/TECHNOLOGY.md` §3, `docs/IMPLEMENTATION_PLAN.md`, `docs/tasks/PHASE_11_AI_PROVIDERS.md` (exit criteria verified), `docs/tasks/README.md`, `README.md` (row), `docs/tasks/notes/P11-review.md`
- Test: `e2e/tests/14-ai-providers.spec.ts`

- [ ] **Step 1: Write the failing e2e test**: (a) a plan with an image task on Gemini and a publishing task on ChatGPT shows both chips on the plan card; approving it starts the image Steward, whose satellite carries the Gemini mark; (b) the publishing Steward's `request_publish` opens a publish card; editing the text and approving relays "approved" to the Steward; (c) a fake limit on the image Steward opens one limit card without ChatGPT among the options; choosing Wait then advancing the harness clock retries it; (d) at 320 and 390 px wide the publish and limit cards are usable.
- [ ] **Step 2: Run** `pnpm e2e -- 14-ai-providers` — Expected: FAIL.
- [ ] **Step 3: Implement** the harness hooks.
- [ ] **Step 4: Run** `pnpm e2e` — Expected: all specs PASS; then the full gates `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` — Expected: exit 0.
- [ ] **Step 5: Phase exit and commit** — verify each exit criterion in the phase file, record `Phase status: done (<date>)`, README row; commit `P11-10: done — AI providers end to end; Phase 11 exit criteria met`.
