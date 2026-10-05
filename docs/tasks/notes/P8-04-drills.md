# P8-04 — Crash recovery drills (drill log)

Branch `p8-04-drills`, from `p8-wave1-drills-retention-budgets` (2db7b57). Run on 2026-10-05 on
Cosmin's Mac (Apple Silicon, macOS 26.6, Node 22.14, git 2.54). Every drill uses the fake adapter
and the scripted fake LLM (`brains/testing`), a temporary data directory (`$TMPDIR/galactic-*`,
deleted afterwards), its own `HOME` and git configuration — never real Claude, never
`~/.galactic`, never ports 5173/4321. Every process a drill starts is recorded by pid or process
group and only those are killed.

## Summary

| #  | Drill | Where | Outcome | Fix |
| -- | ----- | ----- | ------- | --- |
| 1  | `kill -9` mid-project | `kill-restart.test.ts` | **Pass** first time: no drift, every agent resumed once (supervisors first), questions where the rules put them, card pending, "recovered: 5 resumed, 0 need attention", the killed run's process groups killed at start, the escaped process left to its Steward and swept when it ends | — |
| 1b | `kill -9` at any moment of the first life | `kill-anytime.test.ts` | **Finding F3**: an agent created but never started (kill between its row and its `agent.spawned`) was left with no state forever. One unexplained orphan (R3) | F3 fixed |
| 2  | "Reboot" (server and every process group it left die at once) | `kill-restart.test.ts`, `worktree-crash.test.ts` | **Pass** for the recovery; reconcile refuses a recycled pid from the previous boot. **Finding F4**: a worktree whose `git worktree add` the power cut short is handed to the Steward half checked out | F4 fixed |
| 3  | Network loss during a Steward run | `network.test.ts` | **Finding F1**: a silent Steward shows `stalled` but nothing is logged, so its supervisor is never told. Error turn, CLI crash and cap paths pass. **Finding F5** (side): brains are stopped by the per-agent wall-clock cap | F1 fixed; F5 → P8-10 |
| 4  | Disk full on write | `disk-full.test.ts` | One write rule **holds** (a refused command leaves nothing). **Finding F2**: agent events the runtime cannot write are dropped while it acts on them — a Steward that finished on a full disk stays "starting" forever, its supervisor never hears; a chat line to a brain is swallowed (HTTP 200, never logged) | F2 fixed; UI surface → P8-09 |

All drills run in `pnpm test` (≈ 6 s for the drill files together, the two real-process drills
≈ 1.5 s each). `pnpm drills` runs the same files plus 25 seeded random kills (≈ 40 s);
`GALACTIC_DRILLS=<n>`, `GALACTIC_DRILLS_SEED=<seed>` and `GALACTIC_DRILLS_WINDOW=<from>-<to>` (ms
after the start) replay or focus them.

## How the drills are built

- `apps/server/src/test/drills/drill-world.ts` — the world: `bootDrill(dirs, db)` composes the
  runtime over a SQLite file with real git worktrees, the fake adapter and scripted brains, and
  registers the brain definitions as `index.ts` does; `firstLife()` builds the hierarchy below.
- `drill-server.ts` — the server the drills kill: a child process (`node --import tsx`) that boots
  the world with a `ProcessSupervisor` whose PID table is in the same database (as `index.ts`),
  builds the first life, gives the two Stewards **stand-in CLIs** (`stand-in-cli.mjs`: a leader
  in its own process group, a child that stays in the group, and for S1 an escaped `setsid`
  process in its worktree carrying the agent marker; S2's leader exits on stdin EOF like a CLI
  reading its conversation from the server), writes `ready.json` and prints `DRILL READY`.
- The second life boots **in the test process** over the same file, in `index.ts`'s order:
  `supervisor.reconcile()`, compose, `defineBrains`, `recover()`, `startHarmonizer`,
  `announceRecovery`, `PromotionFlow.start()`.
- `drill-checks.ts` — `logDrift(log)`: the "no data loss" check. It folds the event log
  (agents and session refs, project/task states, question status/holder/version, card states)
  and compares it with the tables both ways; any row without its creating event, any entity the
  log created without a row, any state the log does not explain is a line of drift.

The first life (drills 1 and 2): the Harmonizer with an `ask_user` question open; project
**Notes** with its Waykeeper W1 and two Stewards — S1 mid-work (a 4-minute scenario) and S2
waiting for its clarification (held by W1); a card waiting for the user; project **Docs** with
Waykeeper W2 in the middle of its planning turn (the scripted model is "thinking": the turn never
ends before the kill).

## Drill 1 — `kill -9` mid-project

**Steps.** Start the drill server; wait for `DRILL READY`; `SIGKILL` the server's pid; wait for
S2's stand-in leader to exit on EOF; boot the second life; check; then stop S1 as the user.

**Expected** (SPEC §5 resilience, decisions 8, 21, 44–47, 76; corner cases 3, 4).

**Observed** (pass on the first run, unchanged since):

- `logDrift` right after the crash, before recovery writes anything: empty. SQLite in WAL mode
  lost nothing committed to a process kill; no half-applied command.
- `reconcile()`: orphans `[S1, S2]` (S1's leader alive and recognised: same boot, name, start
  time → its group killed; S2's leader gone after EOF but its group alive → the group killed),
  dead `[]`. Both group children gone within 5 s. The escaped process in S1's worktree is not in
  the group and is **left running** (decision 76: an interrupted agent is not swept; it comes
  back).
- Recovery: resumed `[HQ, W1, W2, S1, S2]`, need attention `[]`. One `agent.spawned` per agent
  after the restart, in the order HQ, then W1/W2, then S1/S2 (supervisors first). The boot-time
  `startHarmonizer` finds the resumed one (`status: running`): one Harmonizer.
- S2's old question is `cancelled` and S2 asks again; the new question is held by W1 (resumed
  first), not climbed to the user. The Harmonizer's `ask_user` question is still open
  (decision 45). The card is still `pending`. W2's resumed turn makes its plan: exactly one plan
  card (no second card for the interrupted planning).
- The Harmonizer says "recovered: 5 resumed, 0 need attention" in its chat.
- No agent row added; `logDrift` still empty after recovery's writes.
- Decision 76 end to end: `processes.list(S1)` lists the escaped process (`why: worktree` —
  marked, in the worktree, started in S1's session of the killed run); stopping S1 sweeps it
  (`agent.processes_stopped{sweep: agent_ended, by: system}`), gone within a few seconds.

### 1b — killed at any moment

`kill-anytime.test.ts` kills the drill server after a delay instead of at `DRILL READY`, so the
kill lands while brains call tools, Stewards are spawned, worktrees made, questions and cards
created, stand-ins launched. The next life must hold invariants whatever was under way: no drift
(before and after recovery), every agent the kill left live is resumed or reported, each spawned
once, recovery creates no agent (the boot start adds a Harmonizer only when none came back), at
most one Harmonizer, one live Steward per task and one live Waykeeper per project, **every agent
row has a state**, and no stand-in leader or group child survives `reconcile()`.

Runs (seeded): 40 over 0.3–2.3 s (seed 8404), 40 + 80 focused on 0.98–1.12 s (seeds 1 and 77,
the stand-in launch), 25 more via `pnpm drills`. The kills landed at every stage of the build:
seq 5 (only the Harmonizer), 15/17/22 (Waykeeper, tasks, Stewards being spawned), 43 (before the
Docs Waykeeper's planning turn), 52 (all of it, stand-ins starting or running).

**Finding F3 — an agent created but never started is left in limbo.** Seed 1, run 28 (killed at
1008 ms): 3 agent rows, 2 live. `AgentRuntime.spawn` writes the row (`agent.created`) and only
logs `agent.spawned` once the adapter's session exists — for the real Claude CLI that is the
seconds the CLI takes to start. A kill in between left a row with **no status record**: recovery
iterates status records, so it never saw it; the agent stayed neither running nor ended forever
(the task kept a Steward that would never work; the panel had no state to show).
**Fix:** `recover()` reads from the log which agents were created but never spawned nor ended
(only when the log still has their `agent.created`), logs `agent.interrupted{reason: "server
restarted before the agent started"}` for them, and they come back like the rest: a brain through
its runner with a fresh, re-seeded session (it has no session to resume); a Steward starts fresh
from its own saved first prompt on its own row (`reopenOne`: no session ref and never spawned →
`meta.prompt`). Regression: `never-started.test.ts` (both fail without the fix).

**R3 — one orphan, not reproduced.** Seed 8404, run 7 (killed at 1049 ms, while S1's stand-in
was starting): S1's stand-in leader and its group child were found alive after the run, parent
`launchd`, and the second life's `reconcile()` had not killed them; its pid file was written
after the drill had looked for it (the temp directory's removal then failed with ENOTEMPTY). I
killed the two groups by the recorded pids. 145 further runs focused on that window did not
reproduce it; the drill now waits 300 ms for late pid files and asserts on every run that no
stand-in leader or group child survives. The likely cause is the kill landing inside the
supervisor's spawn call — the child exists, its PID-table row is not written yet — so
`reconcile()` has no row. With the real CLI the impact is small (it reads its conversation from
the server's pipe and exits on EOF), but its MCP servers and tool shells would live on. Recorded
as P8-11.

## Drill 2 — "machine reboot"

The Mac cannot be rebooted from a test. Simulated as what a reboot does to the server's world:
the server's process group **and every process group it left** (both stand-in groups and the
escaped process) are `SIGKILL`ed at once; the PID table's rows are rewritten as rows of the
**previous boot** (`meta.bootAt` an hour before this boot), and S1's row is pointed at a live
process of ours with the **same command name and start time** — the case of a pid recycled
after a reboot. Then the same second life and checks as drill 1.

**Observed:** `reconcile()` reports both rows `dead`, kills nothing, the look-alike process is
untouched (only the boot tells them apart: `fromOtherBoot`). Recovery and every check of drill 1
pass. `processes.list(S1)` does not take the look-alike.

**Not simulated:** the power loss itself. The database runs in WAL mode with
`synchronous=NORMAL`: a process kill loses nothing committed (drills 1, 1b), but a power loss or
OS crash may roll back the **last transactions** before it — never half of one (each command is
one transaction). Recovery then works from the earlier, consistent state (the drills show any
consistent prefix recovers). See proposed decision 100 and the open question below.

**Finding F4 — a worktree cut short by the reboot.** A `kill -9` of the server alone cannot cut a
`git worktree add` short (git is its own process and finishes), but a reboot can: git leaves the
worktree **registered, locked "initializing", with a partial checkout**. `createWorktree` found
it registered and handed it to the Steward as is — a Steward committing it would delete the
files the checkout never wrote. **Fix:** `createWorktree` removes a worktree still locked
"initializing" (`git worktree remove --force --force`; nothing of a Steward can be in it — its
Steward never started) and adds it again on the task's branch. Regression:
`worktree-crash.test.ts` (fails without the fix: `b.txt` missing).

## Drill 3 — network loss during a Steward run

Simulated at the adapter boundary: the fake adapter plays what `claude-sdk-adapter.ts` shows when
the API is unreachable. Stall threshold scaled to 300 ms (5 s for the fake runtime, 5 min for the
SDK in production).

| Case | Simulation | Expected | Observed |
| ---- | ---------- | -------- | -------- |
| Stall | output, 700 ms of silence (the CLI retrying with backoff), output, finish | `stalled` shown; the supervisor told (corner case 2: "a real state and event"; `agent.stalled` is in the wake rules); `working` again on output; finishes | **F1**: `stalled` in the status store only — no `agent.stalled` in the log, the Waykeeper never told. After the fix: one `agent.stalled{silentForMs}`, the Waykeeper's turn says "… has been silent for 0 s", the Steward finishes, no failure |
| Error turn | "turn ended with an error: API Error: Connection error." then idle (the SDK's error `result`) | the Steward's report carries the error; one message resumes it | pass: the report reaches W1, its `tell_steward` "the network is back" starts the next turn, the Steward finishes; one Steward for the task |
| CLI exits | `agent.failed(runtime)` "API Error: Connection error (the claude CLI exited …)" | supervisor told; one replacement | pass: W1 told `failed (runtime)`, spawns one replacement (`net-ok`), which finishes; the first stays `failed` |
| Stall past the cap | 60 s of silence, wall-clock cap 1.2 s | the cap stops it, `failed(reason: cap)`, supervisor told | pass |

**Fix F1:** `StatusStoreOptions.onStalled(agentId, silentForMs)` is called once per silence after
the ticker's pass; the composition passes it to `AgentRuntime.noteStalled`, which logs
`agent.stalled` for a running, unpaused session. The store never writes; output brings the agent
back to `working` without an event; the next silence is logged again. Unit test in
`status-store.test.ts`.

**Finding F5 (side) — brains are stopped by the wall-clock cap.** Setting a short default
wall-clock cap for the cap case stopped the brains too, so I checked: an idle Harmonizer is
`failed(reason: cap)` "wall-clock cap: … elapsed" once the default cap (2 h) has passed since its
spawn — idle time counts. In production the Harmonizer would be replaced (fresh session) and a
Waykeeper would fail every two hours of running. That is a product question (decision 43 bounds
brains by the hierarchy for spawn caps only), so it is P8-10 with a proposed decision, not fixed
here. The drill sets the short cap after the brains started.

## Drill 4 — disk full on write

A small disk image is awkward on macOS; the database file is stopped from growing instead:
`PRAGMA max_page_count` at its current size and the free pages used up with filler rows, so
every write that needs a new page fails with **SQLITE_FULL**, exactly as on a full disk
(SQLite's own error, not a mock). The log's last pages still take a few events before they are
full too — as on a real disk. Raising the limit is "space returns".

**One write rule.** With the disk full: create a task, answer a question, pause the project,
make a card — each fails with SQLITE_FULL **to the caller**, and the snapshot of every table and
the log's end are unchanged after each (no mutation without its event, no event without its
mutation). Space back: the same commands go through; no drift.

**Finding F2 — the runtime dropped the events it could not write.** The runtime writes agent
events through `command()`, which reported a failure and moved on. On a full disk, a Steward kept
working (its CLI does not need the database), and every event it produced was dropped while the
runtime acted on it: in the first run 21 "command: database or disk is full" errors, the Steward
finished and the runtime forgot its session, but its status stayed **`starting` forever** (even
after space returned), its `agent.finished` never reached the log, so the Waykeeper was never
told and the task never moved; a restart would have "resumed" a finished session. From the code,
the same path also lost a chat line to a brain (accepted, HTTP 200, never logged — the drill now
checks it is held and delivered) and failed the request of an answer the agent had already
received, leaving the question `open`.
**Fix:** `AgentRuntime` holds what the storage refuses (`isStorageFailure`: SQLITE_FULL,
SQLITE_IOERR*, BUSY, LOCKED, READONLY, CANTOPEN, PROTOCOL) in a queue and every later runtime
write waits behind it, so the log never skips an event the runtime already acted on; the queue is
retried every second and written in order once the database accepts writes; a held write the log
now refuses (a question answered meanwhile) is reported and dropped as it would have been. The
server prints one line when writes start failing and one when they work again ("storage: writes
work again: N held agent events written"), not one per event. A shutdown tries once more; what is
still held is lost with the process and the next start treats those agents as after a crash. An
answer the agent already has is held too instead of failing the request.

**Observed after the fix:** the Steward makes its 80 tool calls and finishes while nothing can be
written (the log's end does not move); one storage line; space back → the held events land in
order (80 `agent.tool_call`, then `agent.finished`), the status is `finished`, the Waykeeper is
told it finished, no drift. The held chat line is delivered to the Harmonizer.

**Still open (P8-09):** the panel does not show that the disk is full — the user sees refused
actions as generic 500 errors and the console line is the only signal. Transcript chunks whose
write fails are dropped (by design since P1: never delivered, so no client holds a seq the
database does not); events are not.

## Other observations

- **Transcript tail on `kill -9`.** Output is written in batches (100 ms) and the newest chunk of
  an agent is held 250 ms for boundary-aware redaction (P1-27), so a kill loses up to ≈ 350 ms of
  transcript text. Events are not affected. Accepted (a graceful stop flushes).
- **Fake adapter resume.** A session ref records the step at spawn time, so after a real process
  restart the fake adapter replays a Steward's scenario from the start (the in-memory progress
  store is gone). The SDK resumes the conversation itself; nothing to fix in the server.
- **Not drilled:** a kill during recovery itself (a second crash before the first recovery
  finished). Recovery is a sequence of the same commands, each idempotent from the log; 1b shows
  any consistent prefix recovers, but no run aimed at it.

## Proposed SPEC §7 decisions (not edited into §7; numbers to be assigned at merge)

- **Proposed decision 97 — A full disk loses nothing done** (P8-04; §5, decision 8): when the
  disk is full, agents keep working and what they do is written, in order, as soon as there is
  room again; an action the user takes meanwhile is refused as a whole with "the disk is full",
  never half-done; the panel says the disk is full and how many agent events are waiting (P8-09).
  Agent output that could not be saved meanwhile is not kept.
- **Proposed decision 98 — A silent agent's supervisor is told** (P8-04; corner case 2,
  decision 18): an agent that falls silent past its runtime's threshold is shown `stalled` and its
  supervisor is told once per silence ("has been silent for N s"); nothing is stopped for it —
  only its caps stop it — and it is `working` again as soon as it speaks.
- **Proposed decision 99 — Recovery includes agents that had not started** (P8-04; decisions 8,
  44, 46): an agent the restart caught before its session started is started again — a Steward
  from its own instructions, the Harmonizer or a Waykeeper with a fresh session seeded from the
  database — and counts as resumed in the recovery report; a task worktree the machine went down
  in the middle of creating is made again.
- **Proposed decision 100 — Power loss** (P8-04; §5): after a power cut or an OS crash the map is
  whole and consistent but may miss the last moments before it (the last commands are rolled back
  whole, never half); recovery resumes from there. A process kill loses nothing.

**Proposed open question (§8):** should the event log trade write latency for power-loss
durability (`synchronous=FULL`), or is decision 100's "may miss the last moments" acceptable for
a local app? Conservative meanwhile: keep `NORMAL`.

## New tasks (appended to `PHASE_8_HARDENING.md`, added 2026-10-05)

- **P8-09 — Storage health in the panel**: a storage state in the status stream, a "disk full —
  N agent events waiting" banner, `507 storage_full` for refused REST/WS actions, a push
  notification; decision 97.
- **P8-10 — Brains and the wall-clock cap**: F5; decide (proposed: brains are not stopped by the
  per-agent wall-clock cap — they are bounded by the hierarchy — or only their turn time counts)
  and fix in `CapsEnforcer`.
- **P8-11 — A CLI forked just before a kill**: R3; record a launch intent before the spawn (or
  sweep marked orphans of agents of the killed run) so `reconcile()` can take a child whose pid
  never reached the PID table.

## Files

- Drills: `apps/server/src/test/drills/` — `drill-world.ts`, `drill-server.ts`,
  `stand-in-cli.mjs`, `drill-checks.ts`, `kill-restart.test.ts` (1, 2), `kill-anytime.test.ts`
  (1b), `never-started.test.ts` (F3), `worktree-crash.test.ts` (F4), `network.test.ts` (3),
  `disk-full.test.ts` (4).
- Fixes: `runtime/status-store.ts`, `runtime/compose.ts`, `runtime/agent-runtime.ts`
  (`noteStalled`, held writes, never-started agents), `db/database.ts` (`isStorageFailure`),
  `workspace/workspaces.ts` (unfinished worktrees).
- `package.json`: `pnpm drills`.
