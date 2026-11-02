# More AI providers: ChatGPT and Gemini next to Claude — design

Date: 2026-10-31 · Status: approved by Cosmin (2026-10-31)

Second of the three projects brainstormed on 2026-10-23/24 (1: long-term projects and recurring
jobs, done in Phase 10; 3: the configurable dashboard, later). Phase 10 left a `provider` field on
every job (default `claude`) and ran everything on Claude.

## Intent

Most of Cosmin's recurring jobs will be content creation. Different models are good at different
parts of that work, and he wants to say so in plain words and have it stick:

> "Use Gemini for generating the images for this campaign, and use ChatGPT to publish the content
> on the platforms."

He pays for subscriptions, not API keys, so each provider is reached through its own command-line
tool, logged in with his plan.

## What Cosmin decided

- **Name the provider per piece of work, in plain words, to the Harmonizer.** The example above is
  the shape: one campaign, its steps on different providers.
- **Subscriptions, through each provider's command-line tool:** Claude through Claude Code (as
  today), ChatGPT through OpenAI's **Codex CLI** (`codex`), Gemini through Google's **Antigravity
  CLI** (`agy`). No API keys.
- **Provider or exact model.** "Use Gemini" runs that provider's default model; "use
  gemini-3.8-flash-low" (an exact model) runs that model. The same for ChatGPT.
- **The Harmonizer and the Waykeepers stay on Claude.** Only Stewards (the agents doing the work)
  run on other providers.
- **A usage limit hit asks him.** When a provider's plan limit stops a step, he is told the limit
  was hit and asked whether to switch, and to which model. Nothing switches without him.
- **Nothing is published without asking him first.** This is the one thing that would make him
  wince if it shipped working.
- **Use `agy` despite the terms-of-service doubt** (below, under Risks): his call, made knowing it.
- **Codex does not generate images without an API call** (his finding). Image steps go to Gemini.
- **A model runs in its own maker's CLI** (2026-10-31, after the builder check): "use Opus" runs in
  Claude Code, "use GPT…" in Codex. Antigravity also offers Claude and GPT models on Google's quota;
  those run only when he says so ("Opus through Antigravity"), and like every Antigravity run they
  never get a publishing step.
- **The limit question may offer Antigravity's Claude and GPT models too** (their quota is
  separate), e.g. Claude's limit hit → "Opus through Antigravity"; a step switched there loses
  publishing.

## Calls Claude made (Cosmin can overrule)

- **A step is a task.** The Waykeeper's plan already splits work into tasks, one Steward each, so
  "Gemini for the images, ChatGPT to publish" becomes tasks with a provider each (make the images —
  Gemini; write the posts — Claude; publish — ChatGPT), ordered by their dependencies, all on the
  one plan card. A step nobody named runs on the project's default.
- **A job keeps one provider for its runs, and its follow-up runs may name another.** A recurring
  campaign job runs on Gemini (it makes the images and drafts); the approved send that follows
  (Phase 10's follow-up run carrying an approved send) runs on the provider named for publishing —
  ChatGPT in the example. Both are on the job's card. Splitting one job run across providers is out
  of scope; a routine that needs more becomes several jobs.
- **Defaults.** Each project has a default provider (Claude unless changed; the Harmonizer sets it
  from what Cosmin says, e.g. "this project runs on ChatGPT"). Each provider has a default model,
  chosen in Settings. The same plain-words rule applies to Claude ("use Sonnet").
- **A name nobody recognises is caught before the card.** If Cosmin names a model the provider's
  CLI does not offer, or a provider whose CLI is missing or logged out, the Harmonizer says so
  before proposing; a card never carries a model that cannot run.
- **What carries over.** What Cosmin tells the Harmonizer travels with the proposal to the
  Waykeeper, which plans with it; it also lands on any job set up from that work. It is shown,
  never hidden: the plan card shows each task's provider and model, the job card the job's and its
  follow-up's, the task's status view the model actually running.
- **Steps hand over through files.** Each task works in its worktree (decision 14) and merges like
  any task; a later step reads what an earlier one merged (the images the Gemini step made are in
  the project when the ChatGPT step publishes). Files a CLI writes outside the worktree (Antigravity
  keeps generated images in its own folder) are copied into the worktree by Mission Control before
  the step ends.
- **The limit question.** One inbox question per stopped step: the step, the provider and model,
  "usage limit reached", the reset time when the CLI reports one, and the choices **switch to…**
  (only providers and models that can do that step and are not themselves out of limit — an image
  step offers no ChatGPT model) or **wait until it resets** (the step then retries at the reset
  time). While it waits, the step is paused, not failed; a job run in this state does not count as
  a failed run and does not pause the job. Switching restarts the step on the new model from its
  worktree as it stands, with a short handover of what the earlier attempt did (a session cannot
  move between providers).
- **Usage is visible, never budgeted.** Settings shows, per provider: installed and logged in or
  not (with the fix), the plan when the CLI says it, the default model, and what is left of the
  plan's limits with the reset time. Tokens are recorded per run as today. No dollar budget for
  subscriptions.
- **In the scene** a Steward's satellite carries a small mark of its provider; nothing else changes.

### Calls made after the builder check

- **Codex and Antigravity Stewards get the server's tools** (report a finding, report the run,
  request a spend, request a publish, declare a deliverable), served by Mission Control itself and
  nothing else: Codex through the app-server's dynamic tools (`item/tool/call`), Antigravity through
  one local tool server Mission Control runs for that session, the only one enabled, its calls still
  passing the hook. Other tool servers, plugins and web search stay off on both. This amends
  decision 120 (a Steward on another runtime had no server tools) for these two adapters.
- **One card per publish, and it guards the real call.** A publishing step, and a job's follow-up
  run that publishes, runs without the job's unattended rules: every outward call of that run asks,
  as the policy table does by default. Approving the publish card lets that run's next outward call
  to the approved destination through once (the approval records the content's fingerprint; if the
  text or a file changed since, the call asks again with a fresh card). So Cosmin sees one card per
  publish, and a Steward that skips the request still meets a permission card, never a silent post.
- **The limit flow covers every Steward, Claude's included** (a third detector, for Claude Code).
  The Harmonizer and Waykeepers stay as today: a limit there shows as their failure state.
- **Per-task providers replace decision 109's single "Steward runtime" setting.** A value already
  set there becomes the projects' default provider on upgrade; the ACP adapter stays in the code as
  a generic route but is not offered as a provider. The jobs table's `provider` column keeps its
  meaning, now with a model beside it.
- **Send findings already waiting stay as they are** and are answered the old way; new ones are
  publish approvals. The Steward supplies the platform and account when it raises one (both
  required), checked to be non-empty, shown on the card.

## Publishing: always asked, never decided by anything else

Cosmin's anti-goal makes this the core of the project, for every provider including Claude.

- **A publish approval** is its own question kind (working name `publish`), shaped like the money
  approval (decision 145): it shows exactly what goes out — the text, the attached files (images
  shown), the platform and the account — and offers **Approve** and **Refuse**; for text, **Edit**
  first, as Phase 10's draft-reply findings already do. The approval is bound to that exact content:
  if anything changes, it asks again. Never decided by the policy table, a job's unattended rules or
  "Allow similar" (decision 138); never answered by a supervisor; from the phone only under the
  remote rules (decision 90). It has its own colour and badge, distinct from permission and spend.
- **Phase 10's send** (an approved draft reply carried out by a follow-up run) becomes a publish
  approval; one kind, not two.
- **GalacticAgents cannot tell by itself that a command publishes.** As with money (decision 145),
  the Steward's instructions make it ask with a publish request, and the permission gate is the
  backstop: every outward action of a Steward still reaches the policy table, which asks by default
  for network access.
- **A provider that cannot be held back cannot publish.** Publishing steps go only to a provider
  whose every action Mission Control can stop until Cosmin answers. Today that is Claude and Codex.
  Antigravity may make images and drafts in the project but is never given a publishing step until
  its gate is shown to fail closed (below); the Harmonizer says so if asked.

## What the research found (2026-10-31, on this Mac)

Reports: `.superpowers/brainstorm/providers/codex-research.md` and `agy-research.md` (copies of the
scratch reports; git-ignored).

**Codex CLI 0.166.0** — fully gateable.
- Integration surface: `codex app-server` (JSON-RPC over stdio; `codex app-server generate-ts`
  prints typed bindings). `codex exec --json` has no approval callback.
- Every command and file change raises a server request (`item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
  `mcpServer/elicitation/request`) answered `accept`/`decline`/`cancel`; a 13-second late answer
  was waited for; no documented timeout. Never send `acceptForSession` or policy amendments.
- Settings to use: approval policy `untrusted`, sandbox `workspace-write` with network off; web
  search, MCP servers, plugins and image generation disabled (they bypass the shell gate).
- Resume: `thread/resume`; working folder from `thread/start {cwd}`; extra folders as writable
  roots. Models from `model/list` (now gpt-6-luna default, gpt-5.6-terra, gpt-5.6-luna; efforts).
  Tokens from `thread/tokenUsage/updated`.
- Limits: `account/rateLimits/read` and `account/rateLimits/updated` (used %, window, `resetsAt`);
  a hit is an `error` with `codexErrorInfo: "usageLimitExceeded"` then a failed turn (not observed).
- Login: `codex login status`; `account/read` gives the plan. **Cosmin's Codex login reports the
  Free plan** (one 30-day window) — he may need to log in with his paid account.

**Antigravity CLI (`agy`) 1.4.12** — gateable only through a hook.
- Integration surface: `agy -p … --output-format stream-json` (or `--input-format stream-json` for
  one long session), `--conversation <id>` to resume, `--model`, `--add-dir`. No protocol for an
  outside approver: unattended, a tool needing permission is refused at once.
- The gate: a global PreToolUse command hook (`~/.gemini/config/hooks.json`) receives each tool
  call and answers `allow`/`deny`/…; its timeout is configurable, so it can wait on Mission
  Control's answer. A workspace `hooks.json` must not be used (the agent can write it).
- Unknown and to be proven first: whether a hook that times out or crashes blocks the call (fail
  closed) or lets it through; whether every tool (browser, plugin tools) passes through the hook;
  whether hooks fire inside its subagents. `--sandbox` covers terminal commands only.
- Images: a built-in `generate_image` tool (an `image-generator` subagent); files land in
  `~/.gemini/antigravity-cli/brain/<conversation_id>/`. Not yet run headless.
- Models (`agy models`): gemini-3.8-flash-high (default), -medium, -low, plus Claude and GPT
  models it also offers. Limits: `agy -p "/usage" --output-format json` costs no turn and gives
  weekly buckets with `remaining_fraction` and `reset_time`; a hit exits 3 with an `AGY_ERROR` line
  (from the changelog, not observed). No login command: a successful `/usage` is the check.

## Goals

- Cosmin names a provider or a model per step or per job in plain words; the plan or job card
  shows it; the step runs there.
- Codex and Antigravity Stewards are ordinary Stewards: same worktrees, questions, caps, inbox,
  restart and resume.
- A usage limit becomes one question with a choice of model; nothing switches silently.
- Nothing is published without a publish approval of that exact content.

## Non-goals

- The Harmonizer or Waykeepers on other providers.
- API-key providers, per-call billing, dollar budgets for subscriptions.
- Choosing a model automatically (by cost, by speed, on a limit hit).
- Splitting one job run across providers.
- The dashboard (project 3).

## Anti-goals (it fails even if it technically works when…)

- Anything is published, posted or sent without Cosmin approving that exact content.
- A non-Claude agent acts while Mission Control is not holding it (an "allow everything" mode, its
  own approvals answered by itself, a workspace hook the agent rewrote).
- A step quietly moves to another model, or a card says one model and another runs.
- A limit hit floods the inbox, fails a recurring job, or loses the step's work.

## Constraints (from the repo)

- The adapter boundary: nothing outside `apps/server/src/adapters` speaks to a runtime; each
  runtime is one adapter folder, passing the existing conformance suite; a session is owned by one
  transport (TECHNOLOGY §3).
- Decisions 7 and 138: permissions are the policy's or the user's, never an LLM's.
- Decision 145 (money approvals) is the model for publish approvals.
- Hard caps (decision 18) apply to every Steward whatever its provider.
- Restart = stop then resume from saved sessions: each adapter must resume its own sessions.
- Types in `packages/protocol`; schema changes need a migration; speculative fields in `meta`.

## Risks

- **Antigravity's terms.** A forum thread says Google's consumer-plan terms do not support wrapping
  `agy` in another application; no Google answer. Worst case, trouble with Cosmin's Google account.
  He chose to use it anyway. Record in SPEC §8.
- **The Antigravity gate is unproven.** Building it starts with a spike that shows the hook fails
  closed on timeout and crash and covers every tool; if it does not, Antigravity is limited to
  image generation in a run where every other tool is denied, and the design says so.
- **CLIs change under us.** Codex's app-server is labelled experimental; both CLIs update often.
  Settings shows the versions; the adapters check them at start and say plainly when a version is
  not one they know.

## Open questions for later (SPEC §8)

- Can Codex generate images on a ChatGPT plan without an API key? Community sources say yes; not
  tested; kept off.
- Do Codex approvals wait for hours? Seconds were tested.

## Left to the builder

- The two adapters' internals (app-server client; `agy` process plus hook bridge), how the hook
  reaches Mission Control and authenticates, and the conformance additions.
- Where the provider and model live (task, job, follow-up, project default, Settings) — tables,
  events, migration.
- The Harmonizer's and Waykeeper's tool changes to carry provider and model, and the checks against
  each CLI's model list.
- The `publish` question kind, its card and the Steward tool that raises it; folding Phase 10's send
  into it.
- The limit detection per adapter, the paused step, the retry at reset, the handover on a switch.
- Settings rows per provider; the satellite's provider mark.
