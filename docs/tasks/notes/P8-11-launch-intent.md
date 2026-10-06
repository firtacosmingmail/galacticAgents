# P8-11 — A CLI forked just before a kill (launch intents)

Branch `p8-11-launch-intent`, from `p8-wave3-pids-push-acp` (368057c). Resolves residual **R3**
of the P8-04 kill-at-any-moment drill (`P8-04-drills.md`): a child the supervisor forked in the
instant before the server was killed could run with no PID-table row, so `reconcile()` — which
only goes by rows — never took it.

## The gap

`ProcessSupervisor.register()` forks (`child_process.spawn`, synchronous) and writes the
`agent_processes` row right after, in the same tick. A `SIGKILL` can still land between the two
(libuv's fork and the JS that follows), and a row write the storage refuses (a full disk) was
swallowed — in both cases a live CLI and its process group with no row. With the real Claude CLI
the CLI itself exits on stdin EOF, but its group (MCP servers) lives on.

## Design

```
launch(spec)                                  (supervisor.ts — every spawn, adopt, restart)
  1. store.addLaunch(intent)   ── refused? → nothing forked, start_failed, spawn/adopt throws
  2. spawn(…, env + GALACTIC_AGENT_ID=<agent> + GALACTIC_LAUNCH_ID=<intent id>)
     (testHooks.afterFork — fault injection only)
  3. record(row with meta.launchId)  ── written → store.removeLaunch(intent)
                                     ── refused → intent kept (retried at the next row write)

startup (index.ts):  reconcile()  →  reconcileLaunches()  →  compose / recover …
```

- **Intent** (`agent_launches`, migration **0013**; `LaunchIntent` in `process-store.ts`): id (a
  random UUID), agent id, command, args, cwd (the worktree, or the brain's workspace), server run
  id (a UUID per `ProcessSupervisor`, overridable), boot time, real-clock time just before the
  fork, the spec's meta. A row exists only while the launch is pending: it is deleted once the
  PID-table row holding the child is written, or when the fork failed (`child.pid` undefined).
  Runtime bookkeeping like `agent_processes`: no event, not in a snapshot, not exported.
- **Launch id in the environment.** The child gets `GALACTIC_LAUNCH_ID=<intent id>` next to the
  agent marker; every descendant inherits it. No other process can carry a fresh UUID, so a
  recycled pid (the user's process now) cannot match, and neither can the agent's processes of
  other launches (other runs, other spawns) — the marker alone would not tell those apart.
- **Completed vs open.** At startup an intent of another run whose agent's PID-table row has
  `meta.launchId` equal to its id completed (the kill came after the row; `reconcile()` already
  took the row). An intent of another boot is forgotten (nothing survives a reboot). Intents of
  this run are never touched. The data lock (P8-03) guarantees there is no other live server on
  the database, so every intent of another run is a dead run's.
- **Matching** (`runtime/launch-intents.ts`, pure; `matchLaunch`). One `ps` snapshot; environment
  (`ProcessTable.environment`, new: the marker and the launch id in one read) only of the server
  user's live processes started after the intent; working directories only of those carrying the
  launch. A process group is the launch's when every member is the server user's, none is a
  reaper, in the new server's tree, a user-facing app or below one (else the group is left whole),
  and either
  - **leader**: the leader (`pid = pgid`) is alive, carries this agent's marker **and** this
    launch id, started in the launch window (`intendedAt − 1 s` … `intendedAt + 5 s`; `ps lstart`
    floors to the second), its parent is a reaper (the killed server is gone) and its cwd is inside
    the launch's cwd; or
  - **leftover**: the leader is gone and a member carries marker and launch id, started after the
    intent and runs inside the launch's cwd (a CLI that exited on EOF and left its group, as
    `reconcile()` takes a dead leader's group).
  An unreadable environment (a macOS platform binary, another user's) never qualifies a group;
  inside a group that qualifies, members are taken by the kernel's grouping, as `reconcile()`
  does (a group id is not reused while it has members).
- **Stopping** (`reconcileLaunches`): each group is re-checked right before its first signal
  (leader: still alive with the snapshot's start time — unreadable counts as changed; leftover:
  leader still gone, group still alive), then SIGTERM + SIGCONT to the group, SIGKILL after
  `termMs` (the supervisor's, 5 s by default) to groups still alive. Signals go through
  `ProcessProbe.signalGroup` (new; injectable, so scripted tests never signal a real process).
- **What escaped the group** (a `setsid` child of the CLI) is not taken — the same line
  `reconcile()` draws (decision 76: an interrupted agent comes back). Instead the launch is
  recorded as an **interrupted session** of the agent in `agent_processes` (start = the intent's
  time, end = now, `meta.fromLaunchIntent`), unless the table already holds a newer row. Process
  attribution's sessions (`agentSessions`, P4-14 N3) then cover it, so the Steward's process list
  and its sweep when it ends find the escaped process (`why: worktree`: marker + worktree + session).
- **Full disk** (P8-04 held-writes rules). The intent write is the only record a kill would
  leave, so when it is refused **nothing is forked**: the spawn reports `start_failed` ("could not
  start …: the launch could not be recorded (database or disk is full)") and `spawn()` rejects /
  `adopt()` throws — the SDK adapter maps it to `agent.failed(runtime)`. Agents already running
  keep running (decision 99). New agents are already refused on a full disk (their
  `agent.created` is refused); the change affects a resume or restart that would fork while the
  disk is full. When the row write after a successful fork is refused, the intent stays (it is
  what the next start goes by) and is removed by the next row write that succeeds.
- **Hook for other adapters (P8-07).** The intent is recorded inside `ProcessSupervisor.launch()`,
  which `spawn()`, `adopt()` and the restart policy all go through: an adapter that starts its
  runtime through the supervisor (the ACP adapter included) gets it with no code of its own.
  Startup: `ProcessSupervisor.reconcileLaunches()` after `reconcile()`, before anything spawns.
  Fault injection: `SupervisorOptions.testHooks.afterFork({agentId, pid, launchId})`.

## Safety (decision 76, P4-14 rules)

| Rule | How |
| ---- | --- |
| Only this data directory's runs | Intents live in this database; the data lock excludes a second server; other boots are forgotten; the launch id is unique to one launch of this database |
| Never a process whose environment cannot be read | No environment entry → no marker/launch id → never qualifies a group (`carriesLaunch`) |
| Never user-facing apps, nor below one | A group with a member that is an app, or whose ancestor chain reaches one, is left whole |
| Never anything the user started | The launch id is inherited only by the launch's descendants; the leader's parent must be a reaper and its start inside a 6 s window right after the intent |
| Never the server's own, never another user's | Server tree and group excluded; any member of another uid leaves the group alone |
| pid reuse | Launch id + start-time re-check right before SIGTERM; a leaderless group must still be leaderless |

## Tests

- `runtime/launch-intents.test.ts` (13, pure): leader and whole group (an unreadable `/bin/sh`
  member included); cwd in a subfolder / outside / unknown; **pid reuse** (no marker; unreadable
  environment); **marker without this launch id**, another agent's marker with this launch id,
  marker only; the window (early, late, the floored edge); an escaped leader with a live parent and
  a process under the user's shell; **user-facing apps** (Electron leader, tmux member, a member
  below iTerm); another uid's member; zombie leader; the server's group and excluded groups;
  leftover groups (taken; unmarked, outside, from before the intent; a pid alive under another
  group); `launchCandidates`.
- `runtime/supervisor-launch.test.ts` (12): the intent exists at the fork and the row does not;
  after it the row names the launch and the intent is gone; the child sees `GALACTIC_LAUNCH_ID`
  next to its marker; **full disk on the intent** → `start_failed`, nothing forked (the script
  never ran), `spawn` rejects and `adopt` throws; row refused after the fork → intent kept, removed
  by the next row; ENOENT leaves no intent; a restart records its own launch. Scripted table and
  probe: graceful stop and the interrupted session (and `agentSessions`); forced after `termMs`;
  completed intents read nothing; other boot forgotten, this run's untouched; no signal when the
  environment cannot be read, the leader's start time changed (pid reuse) or cannot be read again;
  no process table → unchecked; a newer row is not overwritten.
- `test/drills/unrecorded-launch.test.ts` (2, **real processes, fault injection**): the drill
  server (`--pause-after-fork s1|s2`) blocks in `afterFork` right after forking a Steward's
  stand-in CLI; the drill waits for the stand-in and SIGKILLs the server. S1 (leader alive, a
  group child, an escaped `setsid` child): the intent is there and the row is not; `reconcile()`
  takes nothing; `reconcileLaunches()` takes S1's group (leader and child gone), leaves the escaped
  process, writes the interrupted session; after `recover()` the Steward's process list finds the
  escaped process as `worktree`. S2 (the leader exits on EOF, its child stays): the leftover group
  is taken. `kill-anytime.test.ts` and `kill-restart.test.ts` now run `reconcileLaunches()` after
  `reconcile()` as `index.ts` does (drill 1 asserts it takes nothing — every stand-in has its row).
- `supervisor.test.ts`: the persisted row's meta now carries `launchId`.

## Results (2026-10-06, Cosmin's Mac)

- Gates: `pnpm build`, `typecheck`, `lint`, `format:check`, `test` green (server 1191 passed,
  1 skipped; web 1669; protocol 98).
- `pnpm drills`: 7 files, 38 tests green.
- Long kill-anytime loop: `GALACTIC_DRILLS=150 GALACTIC_DRILLS_SEED=8411` over the default window
  (0.3–2.3 s): 150/150 pass (259 s), every second life running `reconcileLaunches()`; no stand-in
  survived. No random kill happened to land in the fork-to-row gap (microseconds wide) — that is
  what the fault-injection drill is for.
- `unrecorded-launch.test.ts` run 10 times in a row: 20/20 pass; no stray stand-in afterwards.

## Proposed SPEC §7 decisions (not edited into §7; renumber on collision)

- **Proposed decision 106 — An agent started just before a crash is cleaned up too** (P8-11;
  decisions 8, 76; corner cases 3, 4): the server notes that it is about to start an agent's
  program before it starts it; if the server is killed in that instant, the next start finds that
  program and what it started in its own group (by the agent's marker and that start's own tag in
  their environment, started right then, in the agent's folder) and stops them gracefully, then
  forcefully — the same as the processes it had recorded. What the agent moved out of its group
  is left to the agent, which comes back, and is cleaned up when it ends (decision 76). The rules
  of decision 76 hold: never a process whose environment cannot be read, never a user-facing app
  or anything below one, never anything the user started.
- **Proposed decision 107 — No agent process the server cannot keep track of** (P8-11;
  decisions 76, 99): when the disk is full and the server cannot note that it is starting an
  agent's program, it does not start it: that start fails with "the disk is full" and can be
  retried once there is room. Agents already running keep working (decision 99).

## Left / not done

- A kill during `reconcileLaunches()` itself: the intents are removed only after their groups
  were handled, so the next start does it again (idempotent), but no drill aims at it.
- Leftover groups cannot be told apart from an escaped `setsid` group of the same launch whose own
  leader exited (both carry the launch id and run in the worktree): such a group is taken. It is
  the agent's own process of the killed run either way, never the user's.
- No `ps` (Windows): intents are forgotten as `unchecked` — the supervisor's process groups do
  not work there either.
