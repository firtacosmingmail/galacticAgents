# P8-08 — PTY adapter for arbitrary CLIs

Branch `p8-08-pty`, from `p8-wave4-pty-desktop` (d807c3b). 2026-10-06. TECHNOLOGY §3.3 (updated
with what was built), `apps/server/src/adapters/README.md` ("The PTY adapter").

## What was built

- **`apps/server/src/adapters/pty/`** — the `pty` runtime: any command-line agent run under a
  pseudo-terminal and read like a person reads its screen.
  - `pty-adapter.ts`: the `AgentAdapter` (one CLI per session, through the supervisor).
  - `pty-child.ts`: the only module importing `node-pty` (loaded at the first spawn): the PTY as
    the `ChildProcess` subset the supervisor watches; `ensureSpawnHelper()`.
  - `terminal-text.ts`: raw terminal output → lines (escapes stripped, `\r` redraws collapsed,
    backspace applied), split escape sequences handled.
  - `detect.ts`: the cursor's line → idle / permission / clarification (built-in and configured
    patterns).
  - `preflight.ts`: the command on the `PATH`, `node-pty` loading, its helper executable.
  - `fake-pty-agent.sh` (+ `fake-agent.ts`): the scripted terminal agent (bash) for the tests.
- **Supervisor:** `ProcessSpec.fork` — a hook that forks the child instead of
  `child_process.spawn`, after the launch intent and with the full environment (allow-list, agent
  marker, launch id). Everything else (PID row, stop sequence, group reaping, P8-11 intents) is
  unchanged and applies to the PTY.
- **Protocol:** `agent.output` / `TranscriptChunk` kind `terminal`; `PTY_TERMINAL_SIZE` (120×32);
  `AgentAdapter.input?(sessionId, text)`; `TerminalInputBody`.
- **Transcripts:** the `terminal` stream keeps its own boundary carry and private-key state, so the
  raw and the stripped forms interleaved still redact a secret split over two chunks (tested).
- **Runtime:** `AgentRuntime.typeInto()` (the user's typing, logged `message.sent` +
  `message.delivered`); `recoverAgent()` (the user's action) restarts afresh from the first prompt
  an agent whose runtime has no `resumeSession`; startup recovery still leaves it interrupted.
- **REST:** `POST /api/agents/:id/terminal` (local only, always); `POST /api/agents/:id/recover`
  now restarts a PTY agent.
- **Config / registration:** `pty: {command, args?, passEnv?, idlePattern?, questionPatterns?,
quietMs?, idleAfterMs?}` in `config.json`, or `GALACTIC_PTY_COMMAND` (whitespace-split or a JSON
  array, like ACP); `index.ts` registers `PtyAdapter` only then. The existing `stewardRuntime`
  setting and the ops console's per-spawn runtime choice (`GET /api/runtimes`) pick it up with no
  change; the settings page names it "Terminal agent" and states the caveat.
- **Web:** `panel/steward/TerminalView.tsx` — xterm.js at 120×32, read-only (`disableStdin`),
  loaded lazily, scrolled sideways on a narrow panel; replayed from the oldest chunk when an older
  page lands. For a PTY Steward the panel shows the terminal, the text transcript folded below,
  "Type into its terminal" (the Mac's own browser only) while it runs, and "Restart from its first
  prompt" when interrupted. Raw `terminal` chunks are kept out of the text transcript, the ops
  console's transcripts and the chat boxes.

## Packages

| Package          | Version | License | Where      | Notes                                                                                                                                                                                                                    |
| ---------------- | ------- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node-pty`       | 1.1.0   | MIT     | server     | Native; prebuilt for darwin-arm64/x64 and win32, compiled at install on Linux. Its install script is allowed (`pnpm.onlyBuiltDependencies: ["esbuild", "node-pty"]`): it picks the prebuild, or runs `node-gyp rebuild`. |
| `@xterm/xterm`   | 6.0.0   | MIT     | web        | The terminal view; a lazily loaded chunk.                                                                                                                                                                                |
| `@xterm/addon-fit` | —     | MIT     | not added  | The PTY's size is fixed (the CLI lays out for 120×32); fitting the view to the panel would misplace every cursor move. The view scrolls instead.                                                                         |

Checked on this Mac (Node 22.14, arm64): the prebuild loads; forks are session leaders
(`pgid = pid`, own controlling tty); the output is all delivered before the exit event.
**`node-pty` 1.1.0's macOS `spawn-helper` is published without the execute bit** and its install
script does not add it, so every spawn fails "posix_spawnp failed". The 1.2 betas fix it; the
stable 1.1.0 is kept and the adapter adds the execute bits before loading (`ensureSpawnHelper`:
`mode | 0o111`, owner, group and others like an installed binary — on a file the user owns; it
cannot change one it does not), the preflight reporting a helper it cannot fix.

## Design decisions

1. **Permission rule (decision 112).** A terminal agent's actions are invisible: no
   structured tool call ever reaches the permission table. So the session as a whole is put to the
   gate — `{toolName: 'pty:session', input: {command, cwd}}`, a tool the policy engine does not
   know, `reserve: false` — before every spawn and every message; only `allow` runs it. That is the
   table's own `unclassified` rule (decision 49): the `trusted` preset, or a custom table with
   `unclassified: allow`, and a push mentioned in the command line still asks. A remote client's
   projects are floored at the global default (decision 37), so they never qualify. Chosen over a
   new per-project opt-in flag: it reuses a decision the user already makes knowingly ("trusted"
   says "anything it cannot classify"), needs no schema, and the gate stays the one place
   permissions are decided.
2. **Question detection** (changed by the review: every question is now a permission unless
   `pty.clarificationPatterns` matched it — see Review fixes 4). After `quietMs` (750 ms) of silence the cursor's line (a prompt has no
   newline) is read: `idlePattern` → `agent.idle`; a yes/no confirmation (`[y/N]`, `(yes/no)`,
   "Continue? / Proceed? / Are you sure / Do you want to / Allow / Overwrite / Delete / Remove /
   Install / Run / Push … ?") → **permission**-kind with **no tool call**, so the runtime cannot
   decide it by the table and no brain may answer it: only the user (and "allow" types the
   prompt's yes token, anything else its no); any other `…?` → **clarification** (the supervisor
   may answer from context, as for any Steward), the answer typed. Configured `questionPatterns`
   come first, but one that matches a yes/no confirmation is still a permission (conservative).
   A question the CLI moved on from (complete lines followed it) is answered, nothing typed, and
   the transcript says so. One question at a time.
3. **Turns.** The first prompt is typed once the CLI is ready (idle prompt, or quiet; ≤ 15 s).
   Messages and answers are typed as one line + Enter (newlines → spaces; since the review every
   other control character is dropped and long lines go through a file — see below). Without
   `idlePattern` a turn ends only by `idleAfterMs` (if set) or the exit; silence otherwise makes it `stalled`
   (status store, 2 min for PTY).
4. **Transcript forms (decided).** Raw bytes (escapes kept, UTF-8 decoded by node-pty) as
   `terminal` chunks, batched ≈100 ms / 8 KB, for the xterm view only; the stripped text as `text`
   blocks (≤ 60 lines, flushed on quiet, questions, turn ends, pause, exit) for conversation,
   history and search. Both are redacted by the pipeline. Cost: about twice the rows for a PTY
   agent; retention compacts both. A secret drawn with an escape sequence _inside_ it would be
   caught in the text form but could survive in the raw form — no known CLI does that; noted.
5. **User input.** Read-only by default. A line can be typed (`POST /api/agents/:id/terminal`)
   only from the Mac's own browser — refused for a remote client **even with
   `autoApproveRemote`** (decision 113) — and is logged as the user's message
   (`message.sent` with `origin: local`, then `message.delivered`). Single keystrokes are not
   offered: one event per line keeps the log readable.
6. **No resume, restart instead.** `resumeSession` absent. Startup recovery leaves a PTY agent
   `interrupted` and flags it (`recovery.needs_attention`); the user's "Restart from its first
   prompt" starts it afresh in the same worktree (decision 114).
7. **Ends.** Exit 0 → `agent.finished` (last five lines as result); non-zero → `agent.failed
(runtime, "exited with code N: <last line>")`; signal → `agent.failed(crash)`. No cost.
8. **Brains and `bare` refused**, as for ACP.

## SPEC §7 decisions (recorded as 112–114; the texts below are as first proposed — §7 is current, see the review fixes)

> **decision 112 — Terminal agents run only where the table trusts what it cannot see**
> (P8-08; decisions 5, 7, 49, 109): a terminal agent (a command-line tool driven through a
> terminal, `pty.command`) does its work with no tool calls GalacticAgents can see, so its permission
> table can judge nothing it does. It runs only in projects whose table allows what it cannot
> classify — the "trusted" preset (or a custom table saying so); elsewhere its Steward fails to
> start with the reason, and a running one takes no further message once the table changes. Its
> yes/no prompts ("Delete …? [y/N]", "Continue?") always come to the user as permission cards —
> never answered by a supervisor or by the table; its other questions are clarifications its
> supervisor may answer. The settings page says this where the Steward runtime is chosen.

> **decision 113 — Typing into a terminal agent is the Mac's alone** (P8-08; decision
> 90): the panel can type a line into a terminal agent's terminal (for a prompt the server did not
> recognise); it is logged as the user's message. Only the Mac's own browser may do it — a remote
> client never, even with `autoApproveRemote`: a keyboard on an agent no table can judge is a
> shell. The terminal view itself is read-only everywhere.

> **decision 114 — A terminal agent interrupted by a restart starts again from its task**
> (P8-08; decisions 8, 101, 109): a terminal session cannot be re-attached, so after a restart the
> agent stays interrupted and the user is told; its "Restart from its first prompt" action starts
> it afresh from its original instructions in the same worktree. The server never does that on
> its own.

## Conformance

`describeAdapterConformance` against `fake-pty-agent.sh` under a real PTY
(`pty/pty.conformance.test.ts`, in CI): **19 passed, 2 skipped**. New target options (also usable by
future runtimes): `toolCalls: false` (no `agent.tool_call` / `toolCall` expected; permission cases
check `permissionEvidence` — "deleted build" present after allow, absent after deny), `spawnPolicy`
(trusted), and the optional cases `policyDeny` and `toolCalls` (skipped with reasons). Green:
spawn → output → finished; clarification answered; permission allow/deny; pause/resume; interrupt
with three queued messages (gamma, alpha, beta) → four idles; echo; stop from working / waiting /
paused / idle / after finish; interrupt while paused; interrupt with a question open (cancelled);
send while paused; external SIGKILL → one `failed(crash)`; bad cwd → refused; two sessions; stall
→ recovery. Resume cases not run (`resumable: false`); `metered: false`.

The end-to-end shell-script run (the acceptance's "a shell-script agent runs end to end"):
`scenario:permission` — spawn → output → the `[y/N]` prompt detected → permission question → answer
`allow` → `y` typed → "deleted build" → exit 0 → `agent.finished` — is the conformance permission
case and `pty-adapter.test.ts`; the clarification variant (`scenario:asks`) likewise.

The fixture needs bash (a trapped Ctrl-C does not end a plain `read`; `read -t 1` polls), so an
interrupt during a `read` takes up to a second.

## Tests

- `pty/pty.conformance.test.ts`: 19 + 2 skipped.
- `pty/pty-adapter.test.ts`: 11 — trust rule (ask and deny refuse, nothing forked, the probe's
  call), raw + stripped output and result, non-zero exit, supervisor bookkeeping (PID row, agent
  marker, `pgid = pid`, passEnv only, `GALACTIC_*` refused), permission without a tool call (allow
  → y, refuse → n), a question moved on from, user input (and refused while paused), `idleAfterMs`,
  send re-checks the table, brains/bare refused, helpers.
- `pty/terminal-text.test.ts` 4, `pty/detect.test.ts` 6.
- `runtime/transcripts.test.ts` +1 (interleaved terminal/text streams redact a split key).
- `http/terminal-routes.test.ts` 3 (typing local vs remote with `autoApproveRemote`, logged
  message; no terminal → 409; restart after a restart).
- `config/config.test.ts` +1. Web: `panel/steward/TerminalView.test.tsx` 4.
- Totals after the change: protocol 99, server 1327 + 4 skipped, web 1675.

## Left / follow-ups

- No real CLI was run (none with network credentials, per the brief). Worth trying locally with a
  real tool (aider, an old-style REPL agent) to tune the default patterns and `quietMs`.
- Full-screen TUIs (cursor-addressed redraws) come out as text in arrival order: the terminal view
  is right, but the stripped text and the prompt detection are line-oriented. A headless terminal
  emulator (`@xterm/headless`) on the server would read the real screen; not needed for the
  line-oriented CLIs this targets.
- `node-pty` 1.2 (stable) would drop the `spawn-helper` chmod workaround.
- The fake PTY agent is not copied into `dist/` (like the fake ACP agent).
- Decisions 112–114 are recorded in SPEC §7.

## Review fixes (2026-10-06, branch `p8-wave4-review-fixes`)

1. **Control characters.** `oneLine()` drops C0 but TAB, DEL and C1 (so ESC and every escape
   sequence it would start) after turning newlines into spaces, on every typed path: the first
   prompt, messages, clarification answers, the user's `/terminal` line. The route refuses them
   first (`TerminalInputBody` refine on `TERMINAL_CONTROL_CHARS`, 400 with a readable `message`).
   Tests: `detect.test.ts` (^C, ^U, ESC[31m, DEL, CSI), `pty-adapter.test.ts` (all four paths
   against the fixture), `terminal-routes.test.ts` (400, nothing logged), `rest.test.ts`.
2. **Long lines** (macOS `MAX_CANON` 1024). Chosen: a file. A first prompt or message over 1000
   bytes is written to `<cwd>/.galactic/pty/<session>-<n>.txt` (dir 0700, file 0600, `wx`; the
   `.galactic/` exclusion already covers it) and `Read your instructions from <path>` is typed;
   files are removed when the session ends. `{promptFile}` in `pty.args` passes the first prompt
   that way on the command line (nothing typed; the gate judges the unexpanded command line).
   `{prompt}` (the text as an argument) was **not** added: arguments land in the launch-intent rows
   (P8-11) and in `ps`. Answers and the user's line are typed raw (they answer a prompt) with a
   transcript warning over 1000 bytes. Tests: 3 000-byte first prompt and 2 012-byte message read
   back whole by the fixture, file and dir modes, removal at stop; `{promptFile}`; the warning.
3. **Typing while idle** opens a turn in the adapter (`phase = 'turn'`), and `typeInto` marks the
   agent busy (`idle = false`, `inbox.working()`), so a queued message waits for the turn's end.
   Tests: a second `agent.idle` after typing (adapter); inbox `working` right after the route, and
   the queued message echoed after the typed one (route).
4. **Fail closed.** Every detected question is a permission unless a `pty.clarificationPatterns`
   regex matched it (a yes/no confirmation stays a permission even then). New built-in yes/no
   shapes: aider's `(Y)es/(N)o … [Yes]:` (tokens `y`/`n`), `yes/no [no]:` and `[Yes]/[No]`
   (`yes`/`no`). A free-form permission: allow presses Enter, anything else interrupts (Ctrl-C);
   the card says a worded answer is typed from the Mac. `pty.questionPatterns` are permission
   shapes only (`kind: 'clarification'` is refused by the config with a pointer to
   `clarificationPatterns`). The fixture's free-form questions are listed in
   `FAKE_PTY_CLARIFICATIONS` for the conformance suite.
5. **Tightening the table.** A `send()` or a clarification `answer()` the gate refuses ends the
   agent: `agent.failed(runtime, "the project's permission table no longer allows terminal
   agents")`, the process stopped through the supervisor; the call throws the same reason (the
   inbox then sees the agent ended and stops retrying). A permission answer is the user's own and
   is not re-checked. SPEC 112 reworded to match. A command line mentioning a push gets its own
   refusal reason (decision 49).
6. **Redaction.** `typeInto` logs `redactSecrets(text)`; the echo on the terminal was already
   redacted by the transcript pipeline. The input's help says the line is logged and not to type
   passwords. Test: an `hf_…` token absent from the log and the transcript.

Nits: SPEC 90/114 say the phone may restart a terminal agent from its first prompt (the recover
route), the gate re-checked at spawn; spinner redraws (`\r` only, no newline) are held up to 1 s
per raw batch (`redrawFlushMs`; test: 20 frames → ≤ 6 rows); the terminal view keeps the last
512 KB (trimmed to half, "Earlier output trimmed") and opens OSC 8 links through an explicit
`linkHandler` (http(s) only, confirm, `noopener,noreferrer`); TECHNOLOGY §3.3 and the adapters
README say the Steward's role instructions are typed ahead of the task (the CLI does not get a
system prompt).
