# Phase 11 review (P11-01 – P11-10)

Reviews of the batch branch `p11-1-ai-providers` (cut from `phase-11`), task by task (plan Tasks
1–12), 2026-11-02 – 2026-11-03 — Cosmin's More AI providers: Stewards on Codex and Antigravity,
publish approvals, usage-limit questions (SPEC decisions 146–148). Each task had a review by a
fresh reviewer; every Critical and Important finding was fixed on the branch and re-reviewed clean.
The batch's final review is the controller's, after P11-10.

## Fixed

- **Settings (P11-02).** `Settings.providers` used an exhaustive `z.record(Provider)`; it is a
  partial record now, so a patch names one provider.
- **Spawn preflight (P11-03).** A spawn was blocked on uncertain preflight codes and on bare
  spawns; only `not_installed` and `not_logged_in` block (`not_subscription` and a failed check
  go ahead as the Harmonizer's do).
- **Codex gating (P11-04).** No structured ask tool outside plan mode (ruling R6: the adapter's
  own `ask_user`), user MCP servers and `node_repl` running ungated (rulings R5, R7: Mission
  Control's own `CODEX_HOME`, R9), `dynamicTools` on resume, network permission requests judged by
  the policy's network category (R8), a limit seen while the process exits.
- **Antigravity gating (P11-05).** Mapping failed open on missing arguments; the workspace agy
  config was checked only at spawn; `auto_approve` is what the hook answers when the gate allows
  (R10); the real-CLI policy-deny case is skipped with a reason (R11); agy's MCP call deadline
  (about 180 s) made `ask_user` defer after 150 s (R12); the image copy no longer follows
  symlinks; a tool-server pass is bound to the exact tool and arguments.
- **Publish (P11-06).** An interrupted publish follow-up was re-run on its old approval (R13: a
  fresh question instead); a cleared text box published the original (R14); the allowance was
  narrowed to calls carrying the approved content, with a 12-character floor and values only
  (R15).
- **Usage limits (P11-07).** A Claude limit offered other Claude models (R17); the startup tick
  ran before recovery; a refused re-spawn was retried every minute without telling anyone (R18:
  the task fails with the reason); "Context limit reached" matched the limit regex.
- **Brain tools (P11-08).** The provider note missed the Waykeeper's planning turn and the
  standalone, project-task and long-term cards (R19); `followUpModel` was checked against Claude
  (R20); a publishing or image step with no provider anywhere went unchecked (R21); a Gemini job
  without a follow-up provider is allowed, its card saying so (R22).
- **Settings page (P11-09).** The first-run "needs attention" and `PreflightResponse.ok`
  depended on every provider (R23: the brains' runtime only); models and usage were asked of
  runtimes that were not ready, one after the other.
- **Cards (P11-09).** An unedited Approve sent the text; the publish card showed file names only
  (R24: an authenticated route serves the question's own files by index, checked against the
  approved hash).

## Added in P11-10

- The development harness registers fakes for the `codex` and `agy` runtimes (R4), scripts a
  Steward's publish request or usage limit, and moves the usage-limit clock; the e2e spec
  `14-ai-providers.spec.ts` drives a plan with Gemini and ChatGPT tasks, an edited publish approval
  and a limit waited out, and the publish and limit cards at 390 and 320 px.
- The scene probe lists the non-Claude satellites (`data-satellite-providers`), so the provider
  mark is testable without pixels.
- Docs pass: decisions 109, 120, 146–148 read against TECHNOLOGY §3.5–3.8 and the adapters README
  (the README's list of adapters lacked `agy`; decision 108 now says ACP and terminal runtimes
  leave the Settings); two §8 questions added ("Can Codex make images on a ChatGPT plan?", "Do
  Codex approvals wait for hours?"); "Google's consumer terms for wrapping `agy`" was already there.

## Left open (minor, deferred)

- **Publish files by symlink (P11-09 review, to triage first).** The request-time `hashedFile`
  (`domain/publish.ts`) checks a path by its text and follows symlinks, so a Steward could register
  a file outside its folder through a symlink; `publish-files.ts` has a parent-folder swap race.
  The approval's fingerprint still binds what is published, and the card shows what was
  registered, but the folder rule is weaker than it reads.
- An ended job run's Steward folder ignores `meta.cwd` in the publish-files route (404/409); no
  HTTP happy-path test for that route.
- A second `ask_user` in the same agy run overwrites the first's deferred answer (a stale inbox
  card); an answer arriving while paused with no process waits until resume.
- Commands Codex runs without asking (`cat`) bypass the tool-call cap; a `CODEX_HOME` pointing at
  the managed home would link `auth.json` to itself; token refresh over the auth symlink is
  unobserved (R9).
- Usage limits: an `updateTask` throw in the switch path is not routed through the refusal; an
  open limit question lingers after its task closes; a free-text answer is refused rather than
  explained; a change card moving a job to Gemini without a follow-up provider fails only at run
  time (R22's card text says so).
- Web: no `.pill.kind-publish` style; publish tokens have no light/dark split (as `spend`); the
  satellite mark is a 30 % tint blend, not a ring; the 320 px unit test is a CSS proxy (the e2e
  spec now measures real cards at 390 and 320 px); the not-ready preflight test does not
  instrument `agy.usage`.
- Real CLI runs were skipped or partial where quota or a login was missing (the Codex plan was
  Free; one agy image run costs about 18 % of the weekly Gemini bucket): see the P11-01 notes.

## Controller's rulings (ledger)

Copied from the controller's ledger so they outlive the working folder; each states its reason and
its cost if wrong.

- Ruling R1: T2 keeps Settings/SettingsPatch.stewardRuntime (marked deprecated); T4 stops the server reading it (config upgrade); T10 removes it from protocol and web — so every task leaves the gates green — cost if wrong: one extra small edit.
- Ruling R2: every task must leave `pnpm typecheck` and `pnpm test` green; minimal fixes in other packages forced by its type changes (e.g. `publish: 0` in a Record<QuestionKind>) are in scope, behaviour for those places stays for the owning task — cost if wrong: slightly wider task diffs.
- Ruling R3: T4 adds FakeAdapter options `runtime?: AgentRuntime`, `canPublish?: boolean`, `models?: ModelInfo[]`, `usage?: ProviderUsage` (tests/dev only) — cost if wrong: test-helper rework.
- Ruling R4: in dev-harness mode only, a FakeAdapter registered as codex/agy replaces the real adapter of that runtime (later registration wins, with a log line) — cost if wrong: harness wiring change.
- Ruling R5: Codex's built-in node_repl MCP tool `js` (no approval under untrusted, cannot be disabled) is accepted as residual risk because it runs inside the network-off sandbox with no file/require access (probe evidence in P11-01 notes); Task 5 must try to disable it via config and, if impossible, record it in the adapter README and TECHNOLOGY — cost if wrong: a gating gap if a future Codex version gives `js` network or file access (the version-range warning flags upgrades).
- Ruling R6: the Codex adapter registers its own dynamic tool (e.g. `ask_user` {question, options?}) that becomes agent.needs_input(kind clarification) and blocks until answered; the Steward prompt for codex names it — why: decision-level requirement that Stewards ask clarifications through the inbox; conformance `ask` must pass — cost if wrong: one adapter tool to rename/remove.
- Ruling R7: Codex Stewards run with a Mission-Control-owned CODEX_HOME (under the Galactic data dir) whose config.toml MC writes (no MCP servers, the safe settings) and whose auth.json is a symlink to the user's ~/.codex/auth.json — MC never reads or copies it; verify in one real run that node_repl and user MCP servers are gone and login still works; if Codex replaces the symlink with a file, or the isolation breaks login, fall back to R5-style acceptance and document — why: user-configured MCP tools run ungated otherwise (anti-goal: a non-Claude agent acting while MC is not holding it) — cost if wrong: credential-adjacent symlink handling to revisit; Cosmin to be told in the final report.
- Ruling R8: Codex `item/permissions/requestApproval` for network is judged by the policy's network category, not `unclassified` — why: global constraint "network off", the trusted preset allows unclassified — cost if wrong: one extra question in trusted projects.
- Ruling R9: if Codex ever replaces the managed auth.json symlink with a regular file, the adapter removes it unread and relinks (logged) — why: MC must never hold a credential copy — cost if wrong: if Codex rotated the refresh token into that file, Cosmin has to run `codex login` again.
- Ruling R10: the hook answers agy `auto_approve` exactly when Mission Control's gate said allow (a plain `allow` does not run the tool, per P11-01); `ask`/`force_ask` never sent — why: the brief's "never auto_approve" meant the hook never approves on its own; the decision stays Mission Control's — cost if wrong: none expected.
- Ruling R11: the real-CLI policy-deny conformance case is skipped for agy with a recorded reason (after a deny Gemini explores outside the workspace and each read correctly asks); no permission widening for agy's brain/ folder — cost if wrong: one uncovered real case.
- Ruling R12: agy's MCP tools/call timeout is unknown: probe it once (an ask_user left unanswered ≥10 min); if agy cuts the call off sooner, ask_user must not depend on a long-held MCP call (e.g. return at once and deliver the answer as the Steward's next turn while the question stays open) — cost if wrong: a Gemini Steward's question could be lost on a long wait.
- Ruling R13 (I1): an interrupted publish follow-up is never re-run on the old approval; it is dropped from the queue and a fresh publish question with the same content opens, saying the earlier attempt was interrupted and may already have posted — why: anti-goal "nothing published without asking" — cost if wrong: one extra card after a restart.
- Ruling R14 (I2): Approve with a blank edited text is refused ("the text is empty") unless the publish has files, in which case it publishes the files with empty text — cost if wrong: the user retypes.
- Ruling R15 (I3, plan vs spec — spec wins): the allowance lets a call through only when its input contains the approved text (verbatim, JSON-escaped or URL-encoded) or, for a files-only publish, one of the approved file paths; otherwise the call asks with an ordinary permission card — why: spec says "to the approved destination"/"asks again if the text changed" — cost if wrong: an occasional extra permission card when a tool encodes text differently.
- Ruling R16: Claude limit detection covers Stewards only; a brain hitting its limit behaves as today (progress line, failed turn, idle) — why: spec "the Harmonizer and Waykeepers stay as today" — cost if wrong: brains could get a clearer failure state later.
- Ruling R17 (I1): the switch list excludes every model of the provider that hit its limit (one subscription), except agy models of another family when agy's usage reports that family's bucket with remaining > 0 — cost if wrong: one fewer option.
- Ruling R18 (I3): a re-spawn refused after a limit (budget, placement, missing supervisor) is not retried; the task is set failed with reason "could not restart after the usage limit: <reason>" so the user and the Waykeeper see it — cost if wrong: the user restarts the task by hand.
- Ruling R19 (I2): project_task cards relay the note once to the project's Waykeeper with the approved task; standalone_task cards take structured provider/model (checked, stored on the standalone task) and refuse providerNote; long-term conversion cards refuse providerNote — cost if wrong: a card field to adjust.
- Ruling R20 (I3): followUpModel requires followUpProvider (refused otherwise) on create and change cards — cost if wrong: the Waykeeper names the provider explicitly.
- Ruling R21 (I4): when a makesImages/publishes task resolves to no named provider, the check runs on the effective provider (Settings default, else claude) and refuses with a message telling the Waykeeper to name one — cost if wrong: an extra refusal round.
- Ruling R22 (I5): a Gemini job with no followUpProvider stays allowed (many jobs never publish); its card must say plainly that publishing is not possible ("Publishes with: nobody — Gemini cannot publish"), shown by the job card in Task 11; the run-time refusal (decision 147) stays — cost if wrong: Cosmin may prefer refusing such cards.
- Ruling R23: PreflightResponse.ok (and the first-run wizard's "needs attention") depends only on claude-sdk (the brains' runtime); a missing or logged-out Codex/Antigravity shows its problem on its own row only — why: optional providers must not nag a user who never set them up — cost if wrong: a less prominent warning. To be applied in the Task 10 fix round.
- Ruling R24: the publish card must show the images (spec: "images shown") — add an authenticated route serving only files listed in that publish question's context, by index, from the asker's worktree (realpath inside it, no symlinks), refusing when the file's sha256 no longer matches the approved fingerprint; the card shows thumbnails — cost if wrong: one new read-only route to maintain. Applied in the Task 11 fix round.
