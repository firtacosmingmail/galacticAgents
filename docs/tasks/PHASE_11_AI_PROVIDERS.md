# Phase 11 — More AI providers (Codex and Antigravity Stewards)

**Current task:** P11-07 · **Task status:** P11-07 in progress; P11-06, P11-05, P11-04 and P11-03 done (2026-11-03); P11-01 and P11-02 done (2026-11-02)
**Phase status:** in progress (6/10 done) — on batch branch `p11-1-ai-providers`, cut from `phase-11` (phase-10 plus the providers spec and plan)

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

Stewards can run on Claude Code, OpenAI's Codex CLI or Google's Antigravity CLI (`agy`), chosen per task or job (a provider or an exact model) in plain words. Usage limits become one "switch or wait" question, and nothing is published without a publish approval of that exact content. The Harmonizer and Waykeepers stay on `claude-sdk`.

## Entry criteria

- Phase 10 done (jobs carry a `provider` field that this phase fills in); `phase-10` not yet merged into `main`, so this phase is cut from it.
- The design approved by Cosmin (2026-10-31).
- Codex CLI 0.166.0 and Antigravity CLI `agy` 1.4.12 installed and logged in on this Mac (subscription logins only).

## References

- Spec (authority for this phase): `docs/superpowers/specs/2026-10-31-more-ai-providers-design.md`.
- Plan: `docs/superpowers/plans/2026-10-31-more-ai-providers.md` (Global Constraints, Review Focus, Tasks 1–12).
- `SPEC.md` decisions 90, 109, 120 and the spend/permission rules; new decisions and one §8 question (Google's consumer terms for wrapping `agy`) are written in P11-04, P11-05 and P11-10.
- `TECHNOLOGY.md` §3 (adapter layer; new §3.6 Codex, §3.7 Antigravity), §5 (brain tools), §6 (protocol rules).
- Spike notes: `docs/tasks/notes/P11-01-provider-spikes.md` (protocol shapes, hook behaviour, the Ruling that fixes agy's mode).
- Code precedents: `apps/server/src/adapters/acp` (an adapter over a child process), `spend` questions (`publish` is modelled on them), the permission gate in `apps/server/src/runtime`.

## Design notes for implementation

- **A provider is the CLI.** `claude` → runtime `claude-sdk`, `chatgpt` → `codex`, `gemini` → `agy`. `gemini` may run the Claude/GPT models `agy models` lists only when named explicitly.
- **Codex** runs over `codex app-server` (JSON-RPC over stdio) with `approvalPolicy: "untrusted"`, sandbox `workspace-write`, network off; web search, MCP, plugins/apps and image generation disabled; never `acceptForSession`.
- **agy** runs headless with `--output-format stream-json`, never `--dangerously-skip-permissions`; its gate is Mission Control's PreToolUse hook, which answers `deny` whenever it cannot reach Mission Control. The P11-01 Ruling decides whether agy gets all tools or image-only mode.
- **No publishing on agy** (`canPublish: false`); `chatgpt` and `claude` may publish, each publish behind a `publish` question (`['Approve', 'Refuse']`, user only).
- **Limits** are one question: `Switch to <label>` per eligible model, or `Wait until it resets`; the wait is persisted on the question and survives a restart.
- Real CLI runs are local-only and env-gated (`GALACTIC_REAL_CODEX=1`, `GALACTIC_REAL_AGY=1`); CI uses scripted fake child processes replaying the P11-01 fixtures.
- Every limit and fixed text in the plan's Global Constraints binds every task.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 | P11-01 | Phase file and real-CLI spikes (plan Task 1). |
| 2 | P11-02 | Protocol and migration 0017 (Tasks 2–3). |
| 3 | P11-03 | Model resolution, catalogue, per-spawn model (Task 4). |
| 4 | P11-04, P11-05 | Codex adapter (Task 5); Antigravity adapter and hook bridge (Task 6). Parallel after P11-03. |
| 5 | P11-06 | Publish approvals (Task 7). |
| 6 | P11-07 | Usage limits (Task 8). |
| 7 | P11-08 | Brain tools and prompts (Task 9). |
| 8 | P11-09 | Web: Settings, cards, chips (Tasks 10–11). |
| 9 | P11-10 | End-to-end and phase exit (Task 12). |

All ten run in one batch branch, `p11-1-ai-providers`, in this order.

## Tasks

### P11-01 — Phase file and provider spikes
- **Status:** done (2026-11-02) · **Depends on:** — · **Parallel with:** —
- Plan Task 1: this file; real-CLI spikes of Codex (`app-server` message shapes, dynamic tools, late approval, sandbox network) and agy (hook delivery, fail mode, tool coverage, subagents, MCP, image, `/usage`); sanitized fixtures; the notes file with a **Ruling** line.
- **Acceptance:** `docs/tasks/notes/P11-01-provider-spikes.md` answers every question in the brief, each with its evidence or a recorded reason it was impossible; fixtures under `apps/server/src/adapters/{codex,agy}/fixtures/` contain no account ids, emails or tokens; `scripts/spikes/agy-hook-probe.mjs` re-runs the hook probes; the Ruling line is present.

### P11-02 — Protocol and storage
- **Status:** done (2026-11-02) · **Depends on:** P11-01 · **Parallel with:** —
- Plan Tasks 2–3: `providers.ts` (providers, models, usage, limits), `AgentRuntime` `codex`/`agy`, `QuestionKind` `publish`, limit fields, events, `Settings.providers`; migration 0017 and table mappers.
- **Acceptance:** every new type and event round-trips; `stewardRuntime` stays deprecated but present; migration 0017 rebuilds `questions` and `job_runs` with the widened CHECKs and a fresh and an upgraded database agree.

### P11-03 — Model resolution and catalogue
- **Status:** done (2026-11-03) · **Depends on:** P11-02 · **Parallel with:** —
- Plan Task 4: one resolver for the four Steward spawn sites, `ProviderCatalog.check`, `setProjectProvider`, per-spawn `model` kept across resume.
- **Acceptance:** loose model names match one listed model or are refused with the list; a spawn on a logged-out provider fails with the fix and does not crash the Waykeeper.

### P11-04 — The Codex adapter
- **Status:** done (2026-11-03) · **Depends on:** P11-03 · **Parallel with:** P11-05
- Plan Task 5: `codex-adapter.ts`, JSON-RPC layer, mapping, preflight, limits, fake agent replaying the fixtures, conformance tests.
- **Acceptance:** safe settings sent on `thread/start`; every approval request goes through the gate and is never answered `acceptForSession`; server tools served through `item/tool/call`; a usage-limit error ends the session with `reason: limit` and the reset time; the conformance suite passes; the real-CLI test passes or records why it was skipped.

### P11-05 — The Antigravity adapter and hook bridge
- **Status:** done (2026-11-03) · **Depends on:** P11-03 · **Parallel with:** P11-04
- Plan Task 6: `agy-adapter.ts`, fail-closed hook bridge and hook process, tool server, image copy, preflight, limits, fake agent, conformance tests; follows the P11-01 Ruling.
- **Acceptance:** unreachable or crashing bridge answers `deny`; `--dangerously-skip-permissions` never passed; a generated image lands in the worktree byte-equal; a quota error ends the session with `reason: limit`; `canPublish` is false.

### P11-06 — Publish approvals
- **Status:** done (2026-11-03) · **Depends on:** P11-04, P11-05 · **Parallel with:** —
- Plan Task 7: `publish` questions, the one-shot allowance armed by approval and bound to the content fingerprint.
- **Acceptance:** the edited text is what the follow-up run publishes; the allowance is refused when a file changed after approval; no brain, rule or remote auto-approve can decide a publish.

### P11-07 — Usage limits
- **Status:** in progress · **Depends on:** P11-06 · **Parallel with:** —
- Plan Task 8: the limit question (`Switch to <label>` / `Wait until it resets`), persisted wait, jobs.
- **Acceptance:** a restart while waiting still retries at the reset time; nothing switches without the user.

### P11-08 — Brain tools and prompts
- **Status:** todo · **Depends on:** P11-07 · **Parallel with:** —
- Plan Task 9: `providerNote`, `check_model`, `set_project_provider`, prompts and relays that carry providers.
- **Acceptance:** an unavailable provider or model is refused with the list before any card is made.

### P11-09 — Web: Settings, cards, chips
- **Status:** todo · **Depends on:** P11-08 · **Parallel with:** —
- Plan Tasks 10–11: Settings providers section, `PublishCard`, `UsageLimitCard`, provider chips, satellite mark.
- **Acceptance:** fixed actions per card, edited text sent on Approve, usage windows shown, axe clean, phone width without horizontal scroll.

### P11-10 — End-to-end and phase exit
- **Status:** todo · **Depends on:** P11-09 · **Parallel with:** —
- Plan Task 12: dev-harness fake `codex`/`agy` Stewards, `e2e/tests/14-ai-providers.spec.ts`, docs, exit criteria.
- **Acceptance:** the e2e flow passes; the full gates are green.

## Exit criteria

- Every task done; the full gates (`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm e2e`) green on the batch branch.
- The plan's Review Focus items (limit wait across a restart, edited publish text, file changed after approval, loose model names, logged-out provider) each covered by a test.
- SPEC, TECHNOLOGY and IMPLEMENTATION_PLAN consistent with what was built.
