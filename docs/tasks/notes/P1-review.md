# Phase 1 review (2026-10-01)

Reviewed at commit `a4b9ede` (phase marked done, clean tree). Verified on a fresh copy: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` (37 + 238 + 26, 1 skipped = the real-Claude target) all green. Every "reproduced" finding below was shown with a throwaway Vitest test against `composeRuntime` / `startTestApp` / the fake adapter / `fake-sdk.ts` (deleted afterwards); the rest are from reading the code. The real CLI was not available, so SDK-behaviour findings are marked as such.

Overall the phase is in good shape and the wave 2 review items have not regressed: the adapter boundary holds (nothing outside `src/adapters` imports the SDK), the one-terminal-event invariant is correct for every cap/finish ordering tried, the one-write rule holds in the domain commands, the status store has one implementation and rebuild == live fold, there is no XSS surface in the console, every `/api` body is zod-validated, and ~230 adversarial shell commands against the policy engine mostly came back `ask` as they should. The items below are what should change before Phase 2 puts brains and Stewards on top of it — the security ones first, because Phase 2 is the first time agents run unattended.

**Phase-closure caveat:** the exit criteria were verified in a cloud sandbox under an OAuth login, not on the dev machine. The entry criterion "Claude Code logged in with the subscription on the dev machine" and decision 17 are still unconfirmed: run the spike `auth tools`, `scripts/sdk-smoke.ts`, the real conformance suite and `scripts/sdk-restart-smoke.ts` once on the Mac before Phase 2 relies on them (R10 adds a macOS-specific reason).

## Must fix (security)

### R1 — Percent-encoded paths skip the bearer check on every `/api` route (reproduced)
`agent-routes.ts:52` checks `req.url.startsWith('/api/')` on the raw URL, but Fastify's router decodes the path. `GET /%61pi/runtimes` → 200 without a token (`/api/runtimes` → 401); `POST /%61pi/agents {cwd:'/etc'}` spawns. Any local process (and every tailnet peer in Phase 7) can spawn, stop and message agents. From a foreign web page, the body-less POSTs (stop/pause/interrupt/recover) go through as simple requests if the attacker knows an agent id. `dev-routes.ts:18` uses the same pattern.
Fix: register the routes in an encapsulated plugin with `prefix: '/api'` whose `onRequest` hook always authenticates (or key off `req.routeOptions.url`). Add an encoded-path test for `/api` and `/dev`.

### R2 — `POST /api/agents/:id/recover` starts a second session on a live agent, under a looser policy (reproduced)
`agent-routes.ts:133-149` → `AgentRuntime.resume` (`agent-runtime.ts:198`) check neither that the agent is `interrupted` nor that it is not live: on an agent in `waiting_for_input` the log gets a second `agent.spawned` and the first session is orphaned. The route also drops `meta.permissionPolicy` and `bare` (a `cautious` agent comes back under `default`) and skips the `pendingFor()` redelivery that startup recovery does.
Fix: one code path — the route calls the startup recovery for a single agent; 409 unless the status is `interrupted`.

### R3 — Permission engine: bypasses that return `allow`, and a gate that can fail open
Reproduced against `DEFAULT_PERMISSION_POLICY` (workspace = cwd = `/w/proj`):

| Input | Got | Cause (`domain/permissions.ts`) |
|---|---|---|
| `r""m -rf x`, `r'm' -rf x`, `r\m -rf x` | allow | quotes become spaces (`:429`), only a leading `\` is stripped (`:412`) — dequote words, or treat embedded quotes/backslashes as opaque → `ask` |
| `git -c alias.x='!rm -rf ~' x`, `git -c alias.x=push x`, `git config alias.p push && git p` | allow | `GIT_OPTS` skips `-c` (`:183`); treat `-c alias.*` and `git config … alias.`/`--global` as opaque |
| `echo x>/etc/x`, `echo x 2>/etc/x`, `exec 3<>/dev/tcp/h/80` | allow | redirections only recognised as a separate token (`:491`); split on `[0-9]*[<>]+&?`, flag `/dev/tcp`/`/dev/udp` as network |
| `sleep 1 &rm x` | allow | `splitCommand` (`:411`) does not split on a single `&` |
| `cat ~root/.ssh/id_rsa` | allow | `expandHome` (`:531`) handles only `~` and `~/`; `~name` resolves relative to cwd. Treat as unresolvable → outside |
| `git update-ref -d`, `git reflog expire --expire=now --all`, `git gc --prune=now`, `git filter-branch` | allow | missing from `DESTRUCTIVE_RULES` (`:208`) |
| Write/Edit to `.claude/settings*.json`, `.mcp.json`, `.git/hooks/*`, `.husky/*` | allow | Stewards load `settingSources: ['user','project','local']` (`claude-sdk-adapter.ts:259`), so a planted hook or MCP server runs outside the gate on the next spawn/resume. Classify these as `outside_workspace` (or a new `agent_config` action that always asks) |
| policy value not in `allow/ask/deny` (e.g. restored from `agent.meta`) | allow | `strictest()` (`:57`) compares `undefined > 0`. Unknown → `ask`; parse the policy with the protocol's zod schema in `createPermissionGate` |
| Write/Edit with no recognised path field | allow | `classifyPaths` returns `edit_workspace` when it finds no path (`:145`) → `ask` |

Gate robustness: `permission-gate.ts:33` and the `PreToolUse` hook (`claude-sdk-adapter.ts:524`) have no try/catch; if the hook throws, the CLI most likely treats it as non-blocking and runs the tool. Wrap both and return `deny` on any exception. Also assert at gate creation that cwd is inside the workspace (today a cwd outside it, or workspace `/`, makes every path check lexically "inside").
The gate is called twice for every `ask` (hook `:531`, then `canUseTool` `:580`), so `reserveToolCall` counts the call twice and the tool-call cap trips at half its value (reproduced). Keep `toolUseId → verdict` from the hook and reuse it; dedupe `agent.tool_call` by `toolUseId`.

Record two design points (TECHNOLOGY §8, SPEC §8 as an open question): the engine is lexical — symlinks inside the workspace and "write a script, then run it" (`Write x.sh` → `bash x.sh`, `npm test` after editing `package.json`) are allowed by design, so the policy table is a guard rail, not a sandbox; consider the OS sandbox (Claude Code sandbox / seatbelt) as the real boundary. At minimum treat heredoc/stdin to an interpreter (`python - <<EOF`, `sh <<`) as opaque. And `resolvePolicy` is a per-category override: a project `{destructive: 'allow'}` really loosens the global `ask`. If the global default is meant as a floor, the merge must be `strictest(global, project)`; either way write the intent into SPEC §7.

### R4 — Transcript redaction leaks split secrets (reproduced)
- `agent-runtime.ts:547` runs `redactEvent(raw)` before `transcripts.append(…, event.text)`. A first fragment long enough to match alone becomes `[redacted:anthropic-key]`, and the rest of the key arrives in the next chunk with nothing to anchor it: stored `key [redacted:anthropic-key]|4E5A1b2C…xyzAA done`. P1-27's tests drive the pipeline directly, so this slipped. Fix: hand the raw `agent.output` text to the pipeline (it redacts anyway) and add a test through the runtime.
- The boundary match looks at the last 512 chars of the previous chunk (`transcripts.ts:196`). A PEM private key is 1.7–3.2 KB: split at 900 chars it is stored in clear; the same for three or more chunks or a gap longer than `holdMs`. Make the private-key rule stateful: after a `BEGIN … PRIVATE KEY` with no `END`, mask until `END` (or N KB).
- `subscribe()` sends the held, still-mutable last chunk in the backlog (`transcripts.ts:305`); a later append moves a secret's head out of it, but the subscriber's cursor has passed that seq (reproduced: client got `export PASSWORD=hunt`, the row holds `export `). Leave the held chunk out of the backlog.
- Missed shapes: lower-case `password:` / `api_key = "…"` / `secret_key = '…'`, `DB_PASS=`, values under 8 chars, `Authorization: Basic`, PGP private key blocks, Slack `xapp-`/`xoxe-`, GitLab `glpat-`, Hugging Face `hf_`. Make the assignment rule case-insensitive and add `PASS|PWD|CREDENTIAL`.
- Decide and record (TECHNOLOGY §8): user-authored text — `message.sent.text`, `question.answered.answer`, `agent.meta.prompt` (in every snapshot via `agent.created`) — is never redacted, so a pasted key lives in the log forever and is broadcast.

## Must fix (correctness — an agent gets stuck, resumed against the user's will, or a message is lost)

### R5 — Stop and shutdown semantics
- **A stop in flight at shutdown becomes `interrupted` and is resumed** (reproduced). `stop()` logs `control.stop` and awaits the adapter (`agent-runtime.ts:343`); `shutdown()` (`:356`) sees no terminal event, logs `agent.interrupted`, drops the later `agent.stopped`, and `recover()` resumes an agent the user stopped. Same for a cap stop in progress. Ctrl-C during a stop is realistic (an SDK stop can take grace 10 s + term 5 s). Fix: a `stopRequested` flag on `Live`; shutdown gives those agents `agent.stopped` / `agent.failed(cap)`; `recover()` skips agents whose last control event is `control.stop`.
- **The shutdown deadline is shorter than one stop.** `shutdown()` stops agents one after another and the hard deadline is 15 s (`index.ts`), so with two working SDK agents `process.exit(1)` fires before `transcripts.dispose()` (the held chunk and the unflushed batch are lost) and before `supervisor.dispose()`. Log every `agent.interrupted` and flush transcripts first, then stop all with `Promise.allSettled`, deadline > `graceMs + termMs`.
- **`supervisor.stop()` can hang forever** (reproduced). Step 1 awaits `spec.interrupt` with no timeout (`supervisor.ts:524`); the SDK hook awaits `query.interrupt()`, a control request that never times out. A wedged CLI never reaches SIGTERM; `dispose()` and shutdown hang with it. Put the hook inside the grace window.
- **A failing `adapter.stop` leaves an unkillable agent** (`agent-runtime.ts:347`): no fallback terminal event (unlike `onCapHit` → `failForCap`), the concurrency slot stays taken, and the next start resumes it. On a throw, log `agent.failed(runtime)` and `end()`.
- **The SDK session wedges when the iterator throws after an interrupt** (reproduced with `fake-sdk.ts`): the catch at `claude-sdk-adapter.ts:411` ignores errors while `interrupting`, the CLI keeps running, no outcome ever arrives, later `send()`s go into an inbox nobody reads. Once the loop ends — by throw or normally — with the process still alive: `agent.failed` + `supervisor.stop()`.
- **Grandchildren outlive the CLI** (reproduced: `sleep` alive after `exited`). The group is signalled only on a requested stop (`supervisor.ts:458-484`), and `reconcile()` only kills when the leader is alive. Dev servers, watchers and background shells survive `finished` / `failed(crash)` — corner case 4. In `onExit` always SIGTERM → SIGKILL the group; in `reconcile` also probe `kill(-pid, 0)`. Check on the real CLI whether its Bash tool `setsid`s background jobs (they would escape the group entirely).

### R6 — The inbox loses or duplicates messages
- **Pause + resume right after a delivery drops the next message** (reproduced). A delivery does not clear `live.idle` (`agent-runtime.ts:335`, `inbox.ts:118-153`), so `resumed(true)` delivers mid-turn, the adapter rejects it, the inbox records `message.error` and never retries; the log says `message.sent`, recovery won't redeliver it. Clear `idle` in the deliver hook (better: the inbox owns idle/working), and put a rejected delivery back at the front of the queue.
- **A redelivered message is lost on the second restart** (reproduced: pending `[]` after shutdown → recover → shutdown → recover). `recover()` re-queues with fresh ids and logs no `message.sent` (`:423`), and `pendingFor` reads only the last interruption. Re-queue with the original `messageId` (and log synthesized answer messages).
- **A server crash mid-turn redelivers the message that started the turn** (reproduced; `:461`). The resumed SDK session already has it. Log `message.delivered` (or use the first agent event after delivery as the boundary) and redeliver only what was never delivered.
- `pendingFor` reads the whole log once per interrupted agent at every start (`:437`). Read once in `recover()` or start from the agent's last `agent.spawned` seq.

## Should fix now (Phase 2 builds on these)

### R7 — Question lifecycle
An interrupt that cancels an open question leaves the row `open` and the status record `idle` with `pendingQuestionId` set; after pause/resume `agent.resumed` restores `waiting_for_input` (reproduced). Rows also stay `open` after the agent stops/fails/finishes, and a resume re-asks under a new id (reproduced). Phase 2's holder routing and escalation will act on these zombie rows. Fix: close the agent's open questions in the same command as the terminal event (`question.cancelled`), and on an interrupt that withdraws the question; clear `pendingQuestionId` on `agent.idle`.

### R8 — `EventLog` publishes rolled-back events (reproduced)
While publishing, a subscriber runs command A that nests B; B's events go to `pending`; A throws and the transaction rolls back, but `pending` keeps B's events (`event-log.ts:402-407`). Subscribers received seqs `[1, 2]`, the database holds `[1]`, and seq 2 will be reused. The Phase 2 mailboxes are exactly such subscribers. Buffer per outermost command; append to `pending` only on its commit.

### R9 — SDK adapter mapping gaps
- `AskUserQuestion` handles only the first question and gives every question its answer (`claude-sdk-adapter.ts:631-651`, the `i === 0 ? answer : answer` ternary is a no-op; reproduced); `multiSelect` is ignored.
- `interrupt()` while paused sends no SIGCONT (`:707`), so the control request sits in a stopped CLI's pipe and `runtime.interrupt()` / `send({interrupt})` hang until a resume. SIGCONT first, or reject while paused.
- SIGSTOP pause: `agent.paused` is emitted when `session.process` is still undefined (nothing frozen); `session.paused` is never cleared after the stop hook's SIGCONT; the CLI's own tool timeouts keep counting while frozen. Record the trade-off in TECHNOLOGY §3.1.
- Needs the real CLI to confirm: `result` with `subtype:'success', is_error:true` (API/auth/prompt-too-long) is treated as a normal turn (`:470`); `costOf` drops `cache_read_input_tokens` / `cache_creation_input_tokens`; `rate_limit_event` is dropped, so an agent waiting on a subscription limit just looks stalled (worth an `agent.progress`); no check that `init.session_id` matches the resumed ref.

### R10 — `reconcile()` on macOS
`processName` (`supervisor.ts:296`) takes `out.split(/\s+/)[0]`; on macOS `comm` is the full path, so a CLI under a path with spaces never matches, the orphan is marked dead and left running, and `recover()` resumes the same session in a second CLI. And the bundled binary is named `claude`, so a recycled pid that now belongs to Cosmin's own interactive `claude` matches and its group gets SIGKILLed. Use `basename(out.trim())` and add a start-time check (`ps -o lstart= -p`, works on both OSes) against `row.startedAt`.

### R11 — Smaller runtime and stream issues
- A client that resumes by replay never learns about records removed by retention: `ws/session.ts:209` sends `statuses.all()` without `removed`, and the web store merges. Send a replacing status set after `caught_up` (`status{replace:true}`).
- `send()` during a cap stop commits `message.sent` and then `enqueue` throws (`:294`). Check the inbox state first.
- A cap hit before the spawn handle exists is never acted on (`:643`, `caps.ts:312`): `entry.hit` stays true, every later call is denied, the agent keeps running. Remember it and act once the handle arrives.
- A failed resume logs `agent.failed` after `agent.interrupted`; the status store (sink) keeps `interrupted`, so log and projection disagree. Log `agent.interrupted{reason}` instead.
- `pause()`/`resume()` write `control.*` and flip `live.paused` before the adapter call; an adapter error leaves them out of sync.
- `index.ts`: a signal during `recover()` or `listen()` is not handled; if `listen()` fails, the just-resumed agents run with no shutdown path.
- Transcript seqs are notified before the insert succeeds (`transcripts.ts:358`), so after a crash `MAX(seq)` restarts lower and reused seqs are filtered out by clients. Notify after the write, or keep a per-agent high-water mark.

## Decisions to record

- Spawn `cwd` is unvalidated (`agent-routes.ts:35`): any directory, any preset. Fine for a dev console, but Phase 2 should require a resolved path inside a project workspace (anything else only with `GALACTIC_DEV`). Record in TECHNOLOGY.
- The CLI receives `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` / AWS keys (`CLAUDE_PASS_ENV`), so every Bash child of the agent sees them. Needed, but write it in TECHNOLOGY §8.
- A long silent build looks `stalled` to the status store; decide a per-tool stall threshold or a heartbeat while a tool runs, before Phase 4 makes "stalled" visible.

## Conformance suite gaps

The suite is the bar for the ACP/PTY adapters (P1-13), and the fake SDK never calls `canUseTool` after a hook `allow`, never throws from its iterator and always resolves `interrupt()` — so R3's double gate, R5's wedges and R9's interrupt-while-paused cannot show up in CI. Add: a permission answered **deny** (tool not run, no `tool_call`) and a gate `deny`; one gate check and one `tool_call` per `toolUseId`; interrupt while paused and while a question is open; send while paused; an external kill → exactly one `agent.failed(crash)`; spawn failure (bad cwd); no process left in the group after stop/finish; two concurrent sessions without crossed events; resume from a missing/invalid ref. Teach `fake-sdk.ts` the three behaviours above.

## Hygiene

- Types outside `packages/protocol`: `RuntimesInfo` / `SpawnInput` (`web/console/api.ts:5-18`) mirror the server's `SpawnBody`; `SpawnBody.policy` hard-codes the preset names instead of deriving them from `PERMISSION_POLICY_PRESETS`; the ended-state set is declared in both `AgentsConsole.tsx:177` and `status-store.ts:71`; `CLOSE_UNAUTHORIZED` again in `web/client/client.ts:13`. Move REST body schemas and `ENDED_STATES` into the protocol.
- SDK adapter: `sessions` / `byAgent` never shrink (one leak per Steward over the server's life), and after a same-agent resume late events from the old session pass the terminal guard; stderr is reported twice (SDK `stderr` + supervisor `onStderr`); `adopt()` should reject a restart policy; stop always ends in SIGTERM because the inbox is closed only after `supervisor.stop` returns (close it from the interrupt hook so the CLI gets stdin EOF).
- Web console: `AgentPanel.send` clears the input even when the send failed; `unsubscribeTranscript` may `socket.send` while CONNECTING (`InvalidStateError`); `JSON.parse` in `onmessage` is outside a try; a snapshot with a new `logId` does not reset `transcripts`; 409 bodies return raw adapter error strings (possibly CLI stderr) — redact them.
- Policy false positives worth fixing while in there: `Agent` (the current subagent tool name) is unknown → `ask` while `Task` is always allowed (and verify with a test that subagent tool calls still reach `PreToolUse`); bare `git checkout <branch>` is destructive.
- The WS `Origin` check and the `/health` token hand-out ignore the port; harmless without CORS, fragile if it is ever added.

## Suggested tasks

Append to `PHASE_1_AGENT_RUNTIME.md` as P1-28 … (added 2026-10-01) and reopen the phase, or make them Phase 2 wave 0 so P2-01 starts on top of them:
- P1-28 `/api` and `/dev` auth via prefixed plugin + encoded-path tests (R1).
- P1-29 Single recovery path for `/recover`, 409 unless `interrupted` (R2).
- P1-30 Policy engine bypasses, fail-closed gate, one check per `toolUseId`, policy-merge decision in SPEC §7, lexical-engine note in TECHNOLOGY §8 (R3).
- P1-31 Redaction: raw text into the pipeline, stateful PEM rule, held chunk out of the backlog, new patterns, user-text decision (R4).
- P1-32 Stop/shutdown: `stopRequested`, parallel shutdown, interrupt-hook timeout, stop failure fallback, iterator-end handling, group kill on exit (R5).
- P1-33 Inbox: idle after delivery, requeue on reject, stable ids across restarts, `message.delivered` (R6).
- P1-34 Question lifecycle: `question.cancelled` on terminal/withdrawn (R7).
- P1-35 `EventLog` per-command event buffer (R8).
- P1-36 SDK mapping: multi-question `AskUserQuestion`, interrupt while paused, `is_error`, cache tokens, rate-limit progress (R9).
- P1-37 `reconcile()` start-time identity, macOS path handling (R10), then the dev-machine run from the caveat above.
- P1-38 Conformance additions + fake SDK behaviours (gaps section), R11 and hygiene.
