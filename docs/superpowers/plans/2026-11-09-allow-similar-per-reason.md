# "Allow similar" per reason — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The permission card's "Allow similar" chooser shows the asking command and one tickable, generalised row per reason it asks (outside folder, site, command prefix, category) — no "exactly this" — and a later call passes without a card only when every reason it asks is covered.

**Architecture:** The permission engine attaches structured **findings** (action + path/host/segment) to its existing classification; a new pure **coverage** function replaces `matchingRule` and checks every asked finding against the project's rules; `similarOptions` drafts one row per uncovered finding group; `allowSimilar` stores one rule per ticked row and allows the call once. The web chooser becomes a tick list.

**Tech Stack:** TypeScript, zod (`packages/protocol`), Fastify, Vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-11-09-allow-similar-per-reason-design.md` (amends SPEC decision 138; read both).

## Global Constraints

- Branch `agent-allow-similar-reasons` (from `agent-waykeeper-approvals`), worktree `/Users/firtacosmin/Documents/work/projects/GalacticAgents-allow-similar`. Tasks are **Phase 14** (`docs/tasks/PHASE_14_ALLOW_SIMILAR.md`, ids `P14-01…06`); commits `P14-0N: <imperative>`, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run `pnpm build` before tests (packages are consumed built). Gates: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` — each run separately; `rtk proxy <cmd>` gives raw output.
- Types belong in `packages/protocol`; nothing redeclares them. The engine (`domain/permissions.ts`, `domain/permission-rules.ts`) stays pure and lexical; real paths only through the existing `RealPath` seam.
- Never covered by any rule (decisions 49, 138, unchanged): a push; what `neverByRule` refuses (guarded writes: agent/git config, deliverables, shell start-up files, login items, `~/.ssh`, other homes); what the table denies; a call with `unclassified` (opaque) — except a stored legacy exact rule made from that very call.
- A folder rule never names `/`, the home folder, or anything above the home folder. A host rule matches the host or a subdomain on a label boundary only (`h === host || h.endsWith('.' + host)`).
- Prefix and category rules never cover an `outside_workspace` finding.
- Stored legacy rules (`scope: 'exact'`, `prefix`+`folder` from file tools) keep matching as today. No new exact rules are drafted.
- Job unattended rules (`unattendedRuleRefusal`, decision 144) accept exactly the shapes they accept today and refuse the new `folder`/`site` scopes.

## Review Focus

1. `cd /tmp/pr83; rm -rf x` after a `/tmp/pr83/` folder rule: the `rm` must still ask (`destructive`), the card listing only the destructive reason.
2. A site rule for `github.com` against `https://github.com.evil.net/…`, `https://evilgithub.com/`, `https://github.io/`: must ask. Each pinned in Task 3.
3. A command whose network commands are not host-visible (`npm install`, `git fetch origin`) must offer no site row and never be covered by a site rule.
4. A folder row for a path directly under the home folder (`~/x`) must offer `~/x/` but no widen step to `~` — and nothing for `/tmp` widened to `/`.
5. Partial coverage: a call with one covered and one uncovered reason must ask, and the card text, the Waykeeper judge and the chooser must see only the uncovered reason.

---

### Task 1: Protocol shapes and the phase board

**Files:**
- Modify: `packages/protocol/src/domain.ts` (`PermissionRuleScope`, `PermissionRuleMatch`)
- Modify: `packages/protocol/src/rest.ts` (`SimilarOption`, `SimilarPreviewResponse`, `AllowSimilarBody`, `AllowSimilarResponse`)
- Modify: `packages/protocol/src/commands.ts` (`AllowSimilarInput`)
- Modify: `packages/protocol/src/events.ts` (`PermissionDecided`)
- Test: the protocol package's existing schema tests (add cases beside the current `PermissionRule` / `PermissionDecided` ones)
- Create: `docs/tasks/PHASE_14_ALLOW_SIMILAR.md`; Modify: `docs/tasks/README.md`, `docs/IMPLEMENTATION_PLAN.md` (Phase 14 section after Phase 13)

**Interfaces — Produces:**
- `PermissionRuleScope = z.enum(['exact','prefix','category','folder','site'])`.
- `PermissionRuleMatch` gains `{ kind: 'host', host: string }` (lower-case hostname, min 1) and the `folder` variant gains `access: z.literal('any').optional()` — `'any'` = made from a command (reads and writes); absent = a file tool's group as today.
- `SimilarOption` (one row) becomes:
  ```ts
  { key: string;                       // stable row key, e.g. 'folder:/tmp/pr83', 'site:github.com', 'prefix', 'category'
    kind: 'folder' | 'site' | 'prefix' | 'category';
    available: boolean;
    label?: string; preview?: string; digest?: string;
    covers?: string[];                  // the shown parts of the call this row would cover
    widen?: { label: string; preview: string; digest: string }[];  // folder only, narrowest→widest
    reason?: string }                   // why not available
  ```
- `SimilarPreviewResponse` adds `call: string` (the command, or `<tool> <subject>` for other tools), `asking: string[]` (the uncovered reasons' shown parts), `notRememberable: { part: string; reason: string }[]`, `callDigest: string`; keeps `questionId, projectId?, projectName?, refused?, options, allowed`.
- `AllowSimilarBody = { digests: string[] (1..20, each 1..128), callDigest: string, version?, answerId? }`.
- `AllowSimilarResponse = { ok: true, rules?: PermissionRule[], ruleNotStored?: string }`.
- `AllowSimilarInput = { questionId, digests: string[], callDigest: string, by, origin?, version?, answerId? }`.
- `PermissionDecided` adds `ruleIds: z.array(Id).min(1).optional()`; `ruleId` stays (old events, and set to `ruleIds[0]` when written).

- [ ] **Step 1:** Claim: create the Phase 14 file (Purpose from the spec's Why; References: the spec, SPEC 138/144, this plan; Execution order one wave per task P14-01…06 in order; task entries with Status/Depends on/acceptance = each task's tests), add the README row and the IMPLEMENTATION_PLAN Phase 14 section; set P14-01 `in progress`. Commit `P14-01: start protocol shapes for per-reason rules`.
- [ ] **Step 2:** Write failing schema tests: a rule `{scope:'site', match:{kind:'host',host:'github.com'}}` parses; `{scope:'folder', match:{kind:'folder',folder:'/tmp/x',access:'any'}}` parses; `AllowSimilarBody` with `digests: []` fails; `PermissionDecided` with `ruleIds: ['r-1','r-2']` parses and with only `ruleId` still parses.
- [ ] **Step 3:** Run `pnpm --filter @galactic/protocol test` — expect the new cases to fail.
- [ ] **Step 4:** Implement the shapes above; update the doc comments (decision 138 amended, P14).
- [ ] **Step 5:** `pnpm build && pnpm --filter @galactic/protocol test && pnpm typecheck` — pass. To keep the repo compiling between tasks, Task 1 only **adds**: the new `SimilarOption`, `SimilarPreviewResponse`, `AllowSimilarBody` and `AllowSimilarInput` fields are optional and the old ones (`scope`, `digest` on the option, the body and the input) stay. Task 4 makes the new fields required and removes the old ones on the server; Task 5 on the web.
- [ ] **Step 6:** Commit `P14-01: protocol shapes for per-reason "Allow similar"`.

### Task 2: Structured findings in the permission engine

**Files:**
- Modify: `apps/server/src/domain/permissions.ts` (`Classification`, `classifyCommand` ~L1240–1320, the file-tool classifier ~L330–366, WebFetch handling near `NETWORK_TOOLS`)
- Create: `apps/server/src/domain/hosts.ts` (host extraction)
- Test: `apps/server/src/domain/permissions.test.ts` (or a new `permission-findings.test.ts`), `apps/server/src/domain/hosts.test.ts`

**Interfaces — Produces:**
```ts
export interface Finding {
  action: PermissionAction;
  /** The shown part (the simple command's text, or `<tool> <path>`), as in today's reason lines. */
  part: string;
  /** The reason line, exactly as pushed to `reasons`. */
  reason: string;
  /** Index of the simple command in the line (commands only). */
  segment?: number;
  /** outside_workspace: the resolved path it reaches (absent when it cannot be told). */
  path?: string;
  /** network: the hosts visible in this part; absent or [] = not host-coverable. */
  hosts?: string[];
  /** The simple command's words and whether it redirects to a file (commands only). */
  words?: string[]; redirects?: boolean;
}
// Classification gains: findings: Finding[]  (every action added has ≥1 finding)
```
`hosts.ts`: `export function hostsOfCommand(words: readonly string[]): string[] | undefined` — `undefined` when the command's network destinations are not all visible; and `export function hostOfUrl(url: string): string | undefined` (lower-cased `new URL().hostname`, `undefined` for a non-http(s) URL or a parse failure).

- [ ] **Step 1:** Write failing tests (`hosts.test.ts`):
  - `hostsOfCommand(['curl','-s','https://API.GitHub.com/x'])` → `['api.github.com']`
  - `hostsOfCommand(['gh','pr','view','83'])` → `['github.com']`; with a `--hostname` flag or a `GH_HOST=` assignment word → `undefined`
  - `hostsOfCommand(['git','clone','https://gitlab.com/a/b'])` → `['gitlab.com']`; `['git','fetch','origin']` → `undefined`
  - `hostsOfCommand(['npm','install'])` → `undefined`; `['wget','http://example.org/a']` → `['example.org']`; `['curl','--config','f']` (no URL) → `undefined`
  - Host-visible programs: `curl`, `wget`, `http`/`https` (httpie), `gh`, and `git` with `clone|fetch|ls-remote|pull` **and** a URL argument; anything else → `undefined`.
- [ ] **Step 2:** Write failing engine tests (workspace `/w`, cwd `/w`):
  - `cd /tmp/pr83; ls` → `findings` has an `outside_workspace` finding with `path: '/tmp/pr83'` (from `cd`), `segment: 0`.
  - `cat /tmp/pr83/a.txt` → `outside_workspace` finding `path: '/tmp/pr83/a.txt'`.
  - `echo x > /tmp/out/f` → `outside_workspace` finding `path: '/tmp/out/f'`, `redirects: true`.
  - `cd $X` → `outside_workspace` finding without `path`.
  - `gh pr view 83` → `network` finding `hosts: ['github.com']`; `npm install` → `network` finding with no `hosts`.
  - `rm -rf /tmp/pr83/x` → a `destructive` finding and an `outside_workspace` finding.
  - Read tool on `/tmp/a/b.txt` → `outside_workspace` finding `path: '/tmp/a/b.txt'`; WebFetch `https://docs.rs/x` → `network` finding `hosts: ['docs.rs']`.
  - Invariant test over a table of ~15 commands: every action in `actions` has ≥1 finding with that action, and `reasons` is unchanged from today (compare with the strings the existing tests expect).
- [ ] **Step 3:** Run the two test files — expect failures.
- [ ] **Step 4:** Implement: a local `note(action, reason, extra)` in `classifyCommand` that does `actions.add`, `reasons.push` and `findings.push` together; use it at every existing `actions.add` site (rule patterns per simple command — attach `hostsOfCommand(simple.words)` to `network` findings; outside paths; unresolvable paths; guarded targets; `cd` targets with the resolved `cwd` as `path`). Same in the file-tool classifier (one finding per outside path, `part: '<tool> <path>'`) and for WebFetch (`hostOfUrl(input.url)`). Opaque/unclassified results carry the findings seen so far.
- [ ] **Step 5:** Run the engine's whole test folder (`pnpm --filter @galactic/server exec vitest run src/domain`) — pass, existing reason-string tests unchanged.
- [ ] **Step 6:** Commit `P14-02: structured findings and visible hosts in the permission engine`.

### Task 3: Coverage — every asked reason must be covered

**Files:**
- Modify: `apps/server/src/domain/permission-rules.ts` (replace `matchingRule` with `coverage`; keep `matchesScope` for legacy rules)
- Modify: `apps/server/src/runtime/permission-gate.ts` (~L219–231 and the `ask` branch), `apps/server/src/runtime/agent-runtime.ts` (~L749, ~L2040–2061, ~L2302–2327: `ruleIds`)
- Test: `apps/server/src/domain/permission-rules.test.ts`, `apps/server/src/runtime/permission-gate.test.ts`

**Interfaces — Consumes:** `Finding`, `Classification.findings` (Task 2); rule shapes (Task 1).
**Produces:**
```ts
export interface Coverage {
  /** Every asked finding covered: the call is allowed. */
  allowed: boolean;
  /** Rules that covered at least one finding (all of them when `allowed`). */
  ruleIds: Id[];
  /** Asked findings no rule covers (empty when `allowed`). */
  uncovered: Finding[];
}
export function coverage(rules: readonly PermissionRule[], input: RuleInput, c: Classification): Coverage;
```
Gate: `GateDecision.ruleIds?: Id[]` replaces `ruleId`; `onRuleAllow(call, ruleIds, action)`; on `ask`, the verdict's `reasons` are the uncovered findings' `reason`s plus reasons that belong to no finding, and when some rules covered part of it a muted line `already allowed by: <labels>` is appended last.

Rules of coverage (asked findings = findings whose `action` is in `askingOf(policy, c).categories`):
- `c.alwaysAllow` → not called. `neverByRule(c)` or any `push` finding asked → `allowed: false`, nothing covered.
- `asking.unclassified` → only a legacy exact rule with `unclassified` covering the whole call (today's `matchesScope`) — else `allowed: false`.
- A **legacy exact** rule that matches the call (today's test, including its category subset check) covers every finding.
- A **legacy file-tool folder** rule (`scope: 'prefix'`, `match.kind: 'folder'`, no `access`) covers every finding of a file-tool call when today's `matchesScope` is true and the categories subset holds.
- **folder** (`match.access === 'any'`): covers an `outside_workspace` finding with a `path` whose real path is under `match.folder`, from a command or from a file tool (both groups; a guarded write is already `neverByRule`).
- **site** (`match.kind === 'host'`): covers a `network` finding whose `hosts` is non-empty and every host is the rule's host or a subdomain of it.
- **prefix** (`match.kind === 'words'`): covers a non-`outside_workspace` finding of a command segment whose `words` start with the rule's words (`commandMatchesPrefix(words.join(' '), rule.match.words)`), with `redirects` false, `prefixRefusal(words) === undefined`, and the finding's action in `rule.categories`.
- **category**: covers a non-`outside_workspace` finding whose action is in `rule.categories`.
- A rule whose `categories` include `push` covers nothing (as today).

- [ ] **Step 1:** Write failing `coverage` tests (policy: outside/network/destructive ask; workspace `/w`):
  - folder `/tmp/pr83` (access any): `cd /tmp/pr83; ls` → allowed, `ruleIds` = [it]; `cd /tmp/pr83; rm -rf x` → not allowed, uncovered = the destructive finding only; `cat /tmp/pr8/x` → not allowed; `cat /tmp/pr83/../etc/passwd` → not allowed (resolved path).
  - site `github.com`: `gh pr view 1` allowed; `curl https://api.github.com/x` allowed; `curl https://github.com.evil.net/` , `curl https://evilgithub.com/`, `curl https://github.io/` → not allowed; `npm install` → not allowed.
  - folder + site together: `cd /tmp/pr83; gh pr view 83` → allowed with both ids; with only the folder rule → uncovered = the github finding.
  - prefix `npm run` made for `run_workspace`/whatever the fixture policy asks: `npm run build` allowed; `npm run build; curl https://x.io` → uncovered = the curl network finding; `npm run build > /tmp/o` → not allowed.
  - category `network` never covers `cat /tmp/x`'s outside finding.
  - an opaque call (`bash -c "…"`) → not allowed by folder/site/prefix/category; allowed by a legacy exact `unclassified` rule made from it.
  - `git push` with a site rule → not allowed.
  - legacy exact rule still allows its exact command.
- [ ] **Step 2:** Gate tests: a partially covered call returns `ask` whose `reasons` contain only the uncovered reason plus `already allowed by: …`; a fully covered call returns `allow` with `ruleIds`; `permission.decided` carries `ruleIds` and `ruleId === ruleIds[0]`.
- [ ] **Step 3:** Run — fail. **Step 4:** Implement `coverage`, switch the gate and the runtime to it, remove `matchingRule` (update its other test usages). **Step 5:** Run `src/domain src/runtime` tests — pass. Waykeeper-approval tests (`approval-watch`) must stay green: they see the trimmed `ask`.
- [ ] **Step 6:** Commit `P14-03: a call passes only when every reason it asks is covered`.

### Task 4: Drafting rows and answering with ticks

**Files:**
- Modify: `apps/server/src/domain/permission-rules.ts` (`similarOptions`, `draftDigest`, new `callDigest`, `unattendedRuleRefusal`)
- Modify: `apps/server/src/domain/commands.ts` (`similarFor` ~L1230, `similarPreview` ~L1274, `allowSimilar` ~L1308), `apps/server/src/domain/project-rules.ts` (`checkRuleAllowed` unchanged; `addPermissionRule` used once per draft)
- Modify: `apps/server/src/http/agent-routes.ts` (~L686–720: new body/response)
- Test: `apps/server/src/domain/permission-rules.test.ts`, `apps/server/src/http/allow-similar-routes.test.ts`

**Interfaces — Produces:** `similarOptions(input: RuleInput & { rules?: readonly PermissionRule[] }): SimilarOptions` where `SimilarOptions = { refused?: string; call: string; asking: string[]; notRememberable: {part:string;reason:string}[]; rows: Row[] }` and `Row = { key, kind, available: true, draft: RuleDraft, covers: string[], widen?: RuleDraft[] } | { key, kind, available: false, reason: string }`. `callDigest(call: ToolCall): string` (sha256 of stable JSON of tool name + input, 32 hex). `commands.allowSimilar(input: AllowSimilarInput)` → `CommandResult<{ rules?: PermissionRule[]; ruleNotStored?: string }>`.

Drafting (from `coverage(...).uncovered` of the call against the project's current rules — already-covered reasons get no row):
- **folder rows**: group uncovered `outside_workspace` findings that have a `path` by their folder (a file's folder for a non-`cd` path that is not an existing directory under `RealPath`; the path itself for `cd`/a directory). One row per distinct folder; a folder under another drafted folder merges into it. `widen`: each parent upward while it is neither `/` nor the home folder nor above home. A folder that is `/`, home or above → `available: false`, reason `too broad (the root or the home folder)`. Draft: `scope: 'folder'`, `tool: call.toolName`, `match: {kind:'folder', folder, access:'any'}`, `categories: ['outside_workspace']`, `label: '<~folder>/…'`, preview: `Any command or file tool reading or writing under <~folder> (symlinks followed) — a delete, a push, or a write to git or agent configuration there still asks.`
- **site rows**: one per distinct host among uncovered `network` findings with `hosts`; `scope:'site'`, `tool:'*'`, `match:{kind:'host',host}`, `categories:['network']`, label `host`, preview `Any address on <host> or its subdomains (<host>, *.<host>), from any tool — not other sites, never a push.`
- **prefix row**: as today's prefix draft when the uncovered findings include non-outside, non-network-with-hosts findings of commands and `proposePrefix` gives words; else `available:false` with today's reason.
- **category row**: as today, for the uncovered findings' non-outside categories; `available:false` when only outside findings remain.
- **notRememberable**: an uncovered finding with no row — outside without `path` (`cannot tell where it points`), network without hosts when no prefix/category row covers it, guarded, push, opaque.
- No exact row, ever. `refused` as today for the whole-request refusals.

Answering: verify `callDigest(question.context.toolCall) === input.callDigest` and each digest is a row's or a widen step's digest (else `stale` 409); `digests` non-empty; then answer allow and store one rule per digest in one transaction (no session waiting) or answer then store (session waiting), `ruleNotStored: 'allowed once; the rules were not stored: …'` on failure — today's two paths, pluralised.

`unattendedRuleRefusal`: refuse `scope` `folder`/`site` and `match.kind` `host`/folder-with-`access` with `"<scope> rules are for the permission card only"`.

- [ ] **Step 1:** Failing tests: `cd /tmp/pr83; GH_TOKEN=$(gh auth token) gh pr view 83` → rows `folder:/tmp/pr83` (widen `/tmp`), `site:github.com`, no exact row; `covers` of the folder row = `['cd /tmp/pr83']`. `cat ~/notes/a` → folder `~/notes`, no widen. `ls /tmp` → folder `/tmp`, no widen (parent is `/`). With a stored folder rule `/tmp/pr83`, the same call's preview has only the site row and `asking` without the cd. `bash -c "x"` → no rows, `notRememberable` has the opaque part. Route: `allow-similar` with two digests stores two rules, answers allow, returns `rules.length === 2`; a wrong `callDigest` → 409; an unknown digest → 409; empty `digests` → 400; remote origin without `autoApproveRemote` → refused as today. `unattendedRuleRefusal` refuses a site rule.
- [ ] **Step 2:** Run — fail. **Step 3:** Implement. **Step 4:** Run `src/domain src/http` — pass. **Step 5:** Commit `P14-04: one tickable row per reason; "Allow and remember ticked"`.

### Task 5: The chooser on the card, the rule list

**Files:**
- Modify: `apps/web/src/panel/cards/AllowSimilar.tsx` (rewrite the chooser), `apps/web/src/console/api.ts` (~L202–227: `similarPreview` unchanged path; `allowSimilar(questionId, digests, callDigest, version)`), `apps/web/src/panel/status/PermissionRules.tsx` (`SCOPE` gains `folder: 'folder'`, `site: 'site'`), `apps/web/src/app.css` (row styles)
- Test: the existing `AllowSimilar` tests (find them with `grep -rl AllowSimilar apps/web/src --include=*.test.tsx`)

- [ ] **Step 1:** Failing tests: the chooser shows the `call` text with the `asking` parts marked (`<mark>`), one checkbox per available row (unchecked at first), unavailable rows and `notRememberable` parts as text without a checkbox; "Allow and remember ticked" disabled until one box is ticked; a folder row with `widen` shows a select of its levels and ticking sends the chosen level's digest; pressing sends `allowSimilar(q.id, [digests…], callDigest, q.version)`; a `ruleNotStored` reply shows "allowed once; the rules were not stored"; "Allow once" still answers allow; the rule list labels a `site` rule and a `folder` rule.
- [ ] **Step 2:** Run `pnpm --filter @galactic/web test` — fail. **Step 3:** Implement (keep the existing "who may make rules" gate and Escape/Cancel behaviour). **Step 4:** Pass. **Step 5:** Commit `P14-05: the chooser ticks one row per reason`.

### Task 6: Docs, board, gates

**Files:** `docs/SPEC.md` (decision 138 amended: per-reason rows, no exact drafts, folder/site kinds, coverage, multi-rule answers; decision 144: the new kinds are card-only), `docs/TECHNOLOGY.md` (the permission section: findings, `coverage`, host visibility list), `docs/IMPLEMENTATION_PLAN.md`, `docs/tasks/PHASE_14_ALLOW_SIMILAR.md`, `docs/tasks/README.md`.

- [ ] **Step 1:** Write the amendments (date 2026-11-09, Cosmin's words from the spec).
- [ ] **Step 2:** Run every gate separately; all green.
- [ ] **Step 3:** Mark P14-01…06 done with dates, phase status, README row. Commit `P14-06: done — "Allow similar" per reason (decision 138 amended)`.
