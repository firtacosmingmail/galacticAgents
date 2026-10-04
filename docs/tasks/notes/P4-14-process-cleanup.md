# P4-14 — Waykeepers clean up their Stewards' processes

Cosmin, after stray headless browsers and dev servers kept running on his machine: "I want the
process cleanup to be done by Waykeepers". Before this task the supervisor started each agent in
its own process group and killed the group on stop or when the CLI exited (corner case 4), but
processes that left the group (`setsid`, `nohup … &` whose shell exited, daemons) and the
background servers of a Steward that is alive but idle survived, and nobody looked.

## Design

```
ps snapshot ─┐
             ├─ attribute()  (runtime/process-attribution.ts, pure)
supervisor ──┘     │
 agentGroups()     ▼
            StewardProcesses (runtime/steward-processes.ts)
              list(agentId) / stop(agentId, {pids?, by}) / sweep(agentId, why)
                 │                 │                         │
   GET/POST /api/agents/:id/processes[/stop]      log subscriber: Steward ended,
   list_steward_processes / stop_steward_processes   task completed/failed/archived
   (Waykeeper and Harmonizer, own Stewards only)
                 │
            agent.processes_stopped {agentId, pids, commands, forced?, by, sweep?}
```

- **OS layer** (`runtime/process-table.ts`, injectable `ProcessTable`): `ps -A -ww -o
  pid=,ppid=,pgid=,uid=,stat=,lstart=,command=` in the C locale (macOS and Linux); working
  directories from `/proc/<pid>/cwd` on Linux, `lsof -a -d cwd -Fn -p …` elsewhere; listening
  TCP ports from `lsof -nP -a -iTCP -sTCP:LISTEN -Fn -p …`, or on Linux without lsof from
  `/proc/net/tcp{,6}` (state `0A`) matched to `/proc/<pid>/fd` socket inodes. `kill(pid, sig)`
  signals one pid, never a group.
- **Anchors** (`ProcessSupervisor.agentGroups()`): one group per agent from the PID table — pgid =
  the CLI's pid (it is spawned `detached`, so it leads its own group), its start, its end (absent
  while it runs); rows from another boot are left out. `whenExited(agentId)` lets the sweep wait for
  the supervisor's own reap of the group first.
- **Service** (`StewardProcesses`, built by `composeRuntime` when `ComposeOptions.processes` is
  given; `index.ts` passes `{ groups: supervisor }`). Without it there are no sweeps and the tools
  refuse ("this server cannot inspect processes") — every existing test composes without it, so
  none of them runs `ps`.
- **Event**: `agent.processes_stopped` (protocol, append-only). Logged only when something was
  stopped; `by` is the brain, the user, or `system` for a sweep (`sweep: 'agent_ended' |
  'task_closed'`). The web reducer ignores it (OS processes are not world state).
- **REST**: `GET /api/agents/:id/processes` → `StewardProcessesResponse{agentId, supported,
  processes[{pid, ppid, command, cwd?, ports, startedAt, why}]}`; `POST
  /api/agents/:id/processes/stop {pids?}` → `StopProcessesResponse{stopped, forced, alive}`. Both
  bearer-guarded; 404 unknown agent, 400 not a Steward or a pid that is not attributable.
- **Panel**: the Steward view shows "N processes still running" (the list in a disclosure: pid,
  command, ports) and "Stop them" → "Confirm stop" / "Keep them running". Read when the view opens,
  when the Steward's state changes, every 15 s and after a stop; nothing is shown when nothing runs.
  A REST read, not a status field: `ps`/`lsof` run only while someone looks.

## Attribution rules

A process P is considered only if it runs as the server's user and is not a zombie. Walking up
P's parent chain, the first fact that decides:

1. **Reaper** — pid ≤ 1, or the executable is `launchd`, `init` or `systemd` (a user subreaper):
   nobody's, ever. Its children are orphans (rule 5).
2. **The server's tree** — the server itself, its ancestors (below pid 1) and every member of the
   server's process group (in dev: `pnpm dev`, vite, tsx watch): nobody's.
3. **A recorded agent group** — P's pgid is an agent's recorded group and P started inside the
   leader's lifetime (from its start − 1 s to its end + 1 s): that agent's (`why: group` for the
   Steward). Another agent's group — or a pgid two agents could claim — is never the Steward's.
4. **Descendant** — P's parent is the Steward's: the Steward's (`why: descendant`) — a child that
   escaped the group with `setsid` but is still a child of a group member.
5. **Orphan in the worktree** — P's parent is a reaper (its own parent exited: `nohup … &`, a
   daemon): the Steward's (`why: worktree`) only if **all** of: the Steward has a task worktree (its
   working directory lies in `…/.galactic/worktrees/<task>`; a serialised project's Steward, which
   works in the workspace itself, has none and this rule is off), P started inside the Steward's
   session (its `createdAt` − 1 s to its last end + 1 s, or now while it runs) and P's working
   directory is inside that worktree. Its descendants then follow by rule 4.
6. **Anything else** — a child of the user's shell or terminal, of the server (its git commands),
   of another agent, of an orphan that is not the Steward's: not the Steward's.

The Steward's own CLI (the group leader) is left out while the Steward runs: stopping the Steward
is `stop_agent`. Once it ended, a still-running leader is a leftover like the rest.

`stop(agentId, {pids})`: every pid must be attributable at the moment of the call, otherwise the
call is refused and nothing is signalled; the attributed descendants of the given pids are added;
SIGTERM + SIGCONT (a frozen process must be able to die) to each; poll the table up to `termMs`
(3 s); SIGKILL only to those whose pid **and** start time are unchanged; poll 2 s more; report
`stopped`, `forced`, `alive`. Stops of one Steward are serialised.

## Safety argument

The server must never stop a process that is not the Steward's. Each rule is safe by itself:

- **Reapers and the server's tree are excluded first.** Rules 1–2 come before anything else, so
  init/launchd/systemd, the server, the terminal and shell that started it and every process of
  its group (Cosmin's dev servers on `[::1]:5173` and `127.0.0.1:4321` run in that group when he
  starts them with `pnpm dev`) can never be attributed — not even through a recorded pgid. A
  process whose parent is in the server's tree is never an orphan either (the server's own `git`
  in a worktree stays the server's, even when the server is pid 1 in a container). Dev servers
  Cosmin starts from another terminal are children of that terminal's shell: rule 6.
- **Group membership is the supervisor's fact, with a lifetime.** The supervisor creates the group
  (`setsid` via `detached: true`) and records its leader's pid and start. A pgid is not reused while
  the group has members; after it emptied, a reused pgid's members start after the recorded end, so
  rule 3's time check rejects them. Rows from another boot are dropped (pids mean nothing there).
- **Descent is a kernel fact.** `ppid` is set by the kernel; a process whose parent is the
  Steward's was created by the Steward's process tree (rule 4). It is checked against a single
  snapshot, and a parent missing from the snapshot decides nothing (rule 6).
- **Orphans need three independent facts.** For a process whose ancestry is lost (rule 5) the
  server only takes it when it started during the Steward's session **and** works inside the task's
  own worktree **and** its parent is a reaper — i.e. no live process outside the server's view
  started it. A process the user starts from a terminal has the terminal's shell as parent (rule
  6), even when it runs in the worktree during the session; a process from before the session, or
  in any other directory, fails the time or the directory check; a serialised project (Steward in
  the user's own workspace) never uses this rule at all.
- **Other agents' processes are excluded** by their own groups (rule 3) and descent from them
  (rule 6), and by the worktree being per task.
- **The user's uid only; no zombies.** Other users' processes are never candidates (and could not
  be signalled anyway).
- **Signals go to verified pids.** `stop` re-validates the request against a fresh attribution,
  signals one pid at a time (never `kill(-pgid)`), and the SIGKILL goes only to a pid whose start
  time is unchanged since attribution — a recycled pid is someone else and is left alone.
- **The model never decides.** The brain tools only pass pids; the server refuses any pid outside
  the attribution, and the tools' reach is the caller's own Stewards (`supervisorId` = the caller).

Known limits (documented, conservative): a process another agent started in this Steward's
worktree during its session and then fully detached (new session, parent gone, so no group and no
ancestry) is indistinguishable from the Steward's own orphan and would be attributed to it; the
Waykeeper's merge and the Harmonizer do their work in their own groups, so in practice this needs an
agent deliberately daemonising inside another task's worktree. A Steward that was resumed keeps only
its latest group in the PID table (keyed by agent); escaped processes of earlier sessions are still
found by rule 5 when they are in the worktree.

## Proposed SPEC decision (for SPEC.md §7, next free number)

| n | Leftover processes | **Waykeepers clean up their Stewards' processes; the server sweeps what is left** (2026-10-04, P4-14; §2.2, §2.5, decisions 8, 18, 36; corner cases 3, 4, 8b): a Steward's processes are the ones it started — its own process group, children that escaped it, and processes started during its session that run inside its task's worktree and whose parent is gone. Never the server's own processes, never another agent's, never anything the user started (in a terminal, before the Steward started, or outside the worktree). Before merging or closing a task, and when a Steward stopped or failed, its supervisor (the Waykeeper; the Harmonizer for an asteroid task) lists the Steward's processes and stops the leftovers — a dev server the user asked to keep running is the exception, which the supervisor mentions in its report — and reports what it stopped. Stopping is graceful first (SIGTERM), then forced after a few seconds. As a safety net the server stops whatever is left of a Steward when it ends (finished, failed or stopped) and when its task is completed, failed or archived; a Steward that is alive and idle is never swept automatically (its server may be intentional), and an agent interrupted by a restart is not swept (it comes back). Every stop is logged with who asked. The Steward view in the panel shows "N processes still running" with the list and a confirmed Stop. |

## Tests

- `runtime/process-attribution.test.ts` (16): every rule on synthetic tables — group members,
  recycled pgid, escaped descendants, worktree orphans and their children, a systemd subreaper,
  orphans before the session / outside the worktree / without a worktree / after the end, the
  user's shell and the server's own children in the worktree, another agent's (escaped) processes,
  another uid, zombies, an ambiguous pgid, a server that is pid 1, descendant expansion; `ps`, `lsof -F` and
  `/proc/net/tcp` parsing; the worktree root.
- `runtime/steward-processes.test.ts` (7), **real processes** (skipped on Windows): a CLI stand-in
  spawned through the supervisor in the worktree starts an in-group HTTP server and a `detached`
  (setsid) child; orphans (`sh -c '… & echo $!'` from a detached shell) in and outside the worktree;
  a plain child of the test process in the worktree. Listing finds the group member (with its port),
  the escaped child and the in-worktree orphan, never the CLI, the outside orphan, the test's child
  or the test process; a stop with any foreign pid is refused and signals nothing; stops by pid and
  all; SIGKILL for a process that ignores SIGTERM; the sweep after the Steward ends (after the
  supervisor reaped its group) kills the escaped child and the orphan, not the outside one; an
  orphan from before the session is never taken; the sweeps on a scripted table (live Steward not
  swept, `agent_ended` then `task_closed`); refusals for unknown agents and non-Stewards.
- `brains/waykeeper/processes.test.ts` (3, brain harness, real git worktrees, a real orphan dev
  server started by a fake Steward): the Waykeeper lists → stops → merges → closes → reports, the
  server is dead, one `agent.processes_stopped` by the Waykeeper and no sweep event; the safety net
  stops a finished Steward's server when its Waykeeper did nothing; both prompts carry the rule.
- `brains/steward-tools.test.ts` (+4): the tools refuse another Waykeeper's Steward, a non-Steward
  and an unknown agent without calling the service; refuse without the service; list one / all;
  stop as the calling brain; malformed pids.
- `http/process-routes.test.ts` (3): bearer guard, 404/400 mapping, stop as the user, body checks.
- `panel/steward/StewardProcesses.test.tsx` (3): nothing shown when nothing runs; count, list,
  ports; cancel and confirmed stop; re-read on a state change.
- Every test that spawns processes kills every pid it saw in `afterEach` (and the supervisor's
  groups), and `afterAll` runs `pkill -9 -f <per-run marker>`.

## Deferred

- A `processes` count on `StatusRecord` (so the scene or the cards could show leftovers without a
  REST read): not needed for the Steward view; it would put `ps` on a timer for every agent.
- Persisting every group an agent ever had (the PID table keeps the latest per agent).
- Sweeping after a restart: an interrupted Steward's escaped processes survive a server restart
  (reconcile kills the CLI's group only); the next end or task close of that Steward sweeps them.
- Brains' own leftovers (a Waykeeper running a dev server for a merge check): out of scope; their
  group is reaped when they stop.
- Windows: `list` answers `supported: false` (no `ps`), the tools say so.

## Platform notes

- macOS: `ps lstart` is local time with one-second resolution (floored) — every time comparison
  allows ±1 s. `comm`/`command` may contain spaces; `-ww` avoids truncation. Orphans are reparented
  to `launchd` (pid 1). `lsof` exits 1 when one of the pids is gone; its output is still used.
- Linux: orphans go to pid 1 or to the nearest subreaper (`systemd --user`); the executable name
  check treats `systemd` as a reaper. `/proc/<pid>/cwd` may read `… (deleted)` after a worktree was
  removed; the suffix is stripped. Without `lsof`, ports come from `/proc/net/tcp{,6}`.
- In containers whose pid 1 is not an init (e.g. `node` itself), orphans are reparented to that
  process; its children are then the server's own (rule 2) and orphans are never attributed — safe, but
  rule 5 does nothing there.
