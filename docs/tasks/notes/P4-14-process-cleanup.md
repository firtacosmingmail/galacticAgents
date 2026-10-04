# P4-14 — Waykeepers clean up their Stewards' processes

Cosmin, after stray headless browsers and dev servers kept running on his machine: "I want the
process cleanup to be done by Waykeepers". Before this task the supervisor started each agent in
its own process group and killed the group on stop or when the CLI exited (corner case 4), but
processes that left the group (`setsid`, `nohup … &` whose shell exited, daemons) and the
background servers of a Steward that is alive but idle survived, and nobody looked.

## The P4-14 review fixes (2026-10-04)

An independent review found that the first version could stop the **user's** processes, against
decision 76. Fixed, each failing closed: **B1** — rule 5 (now rule 6) took the user's daemons started in the
worktree during the session (tmux server, `code .`, `nohup … &` then closing the terminal) and
rule 4 then their children: orphans now need the Steward's environment marker, and the window is
the actual sessions; **B2** — `agentGroups()` returned PID-table rows of an earlier server run
(whose pgid may name a user process after the downtime): now only this run's groups; the panel's
and the tool's stop-all on a live Steward could cut its in-flight tool command and MCP servers:
now held, the panel sends the pids it showed and a running Steward's stop must name pids;
identity is re-read right before SIGTERM; a replacement Waykeeper can clean up inherited
Stewards; a sweep re-checks liveness right before the signals.

## The second P4-14 review fixes (2026-10-04)

A second review of process cleanup found one more way to hit the user's processes and one way
for the Steward's own leftovers to escape, plus four smaller points. Fixed, each with tests:

- **S2 (safety)** — a GUI app or terminal multiplexer the Steward itself starts (`code .` while
  VS Code is closed: Electron detaches with the marker and the worktree as working directory;
  `tmux new -d`, which the user later attaches to) became an orphan matching the worktree rule,
  and everything the user later did in it (other folders, integrated terminals, extension hosts,
  new panes) inherited the marker and was SIGTERMed when the Steward ended. Now the orphan rules
  (5 and 6) never take a **user-facing app** nor anything below one — see "Not taken
  (user-facing app)" below.
- **S1 (functionality)** — on macOS `ps -E` hides the environment of Apple-signed binaries
  (`/bin/zsh`, `/bin/sh`, `/bin/sleep`, Xcode's `python3`), and Claude Code runs each Bash command
  in a process group of its own, so after the CLI died an orphaned `/bin/zsh -c` (a
  `run_in_background` shell) and everything under it escaped the sweep, as did the leaves of
  multi-command npm/pnpm scripts (`sh -c 'a & b'`). Now the server **remembers identities**: while
  the Steward's CLI runs, every process attribution takes through its groups (rules 3–4) is
  recorded as (pid, start time); an orphan, or a descendant of one, whose identity was recorded is
  the Steward's with no marker needed (rule 5, `why: remembered`).
- **N2** — a group's lifetime now ends at the leader's exit (the moment `exit` fired), not after
  the stdio drain and the group reap, so a pgid recycled in that window cannot match rule 3.
- **N3** — after a resume in this run, `agentSessions` keeps the earlier run's session (the PID
  table's row, captured before this run's first spawn of the agent overwrites it) next to the new
  ones, so escaped processes from before the restart can still be found (the marker is still
  required for those).
- **N4** — `stop` re-checks `disposed` after its one-second wait and after its last table read,
  and sends no SIGTERM or SIGKILL during shutdown.
- **N5** — the proposed SPEC decision in this file is replaced by a pointer to SPEC decision 76;
  the residual risks below gained the review's three.

## Design

```
ps snapshot ─┐
             ├─ attribute()  (runtime/process-attribution.ts, pure)
supervisor ──┘     │
 agentGroups(), agentSessions(), livePid()   (this server run)
                   ▼
            StewardProcesses (runtime/steward-processes.ts)
              list(agentId) / stop(agentId, {pids?, by}) / sweep(agentId, why)
                 │                 │                         │
   GET/POST /api/agents/:id/processes[/stop]      log subscriber: Steward ended,
   list_steward_processes / stop_steward_processes   task completed/failed/archived
   (the Steward's supervisor by decision 32)
                 │
            agent.processes_stopped {agentId, pids, commands, forced?, by, sweep?}
```

- **OS layer** (`runtime/process-table.ts`, injectable `ProcessTable`): `ps -A -ww -o
  pid=,ppid=,pgid=,uid=,stat=,lstart=,command=` in the C locale (macOS and Linux); working
  directories from `/proc/<pid>/cwd` on Linux, `lsof -a -d cwd -Fn -p …` elsewhere; the agent
  marker (`GALACTIC_AGENT_ID`) from `/proc/<pid>/environ` on Linux, `ps -E -ww -o pid=,command= -p
  …` elsewhere (only what follows the command line read from the plain table counts as the
  environment; a line that does not start with it, or two different values, is no marker);
  listening TCP ports from `lsof -nP -a -iTCP -sTCP:LISTEN -Fn -p …`, or on Linux without lsof from
  `/proc/net/tcp{,6}` (state `0A`) matched to `/proc/<pid>/fd` socket inodes. `kill(pid, sig)`
  signals one pid, never a group.
- **Marker** (`ProcessSupervisor.childEnv`): `GALACTIC_AGENT_ID=<agentId>` is set last in every
  agent child's allow-listed environment (TECHNOLOGY §8), so no spec can override it, and every
  process the agent starts inherits it unless it clears its environment.
- **Anchors** (`ProcessSupervisor.agentGroups()`, `agentSessions(agentId)`, `livePid(agentId)`):
  every process group the supervisor started **in this server run** — one per spawn, restart or
  resume; pgid = the CLI's pid (it is spawned `detached`, so it leads its own group); its start
  (the real clock at the fork) and its leader's exit as this run saw it (N2: the moment `exit`
  fired, before the drain and the reap). PID-table rows of an earlier run are never groups.
  Sessions are the same intervals (now while running), plus the PID table's latest row of an
  earlier run in this boot, from its start to its recorded end (the exit, or `reconcile()`'s time
  for an interrupted one — an upper bound); that row is captured before this run's first spawn of
  the agent overwrites it, so a resumed Steward keeps its earlier window too (N3).
  `whenExited(agentId)` lets the sweep wait for the supervisor's own reap of the group first.
- **Remembered identities** (`StewardProcesses`, in memory, this server run only): while a
  Steward's CLI runs, each attribution of it records every process taken through its groups
  (rules 3–4, `AttributedProcess.anchored`) as `pid@startedAt`, per Steward, at most
  `REMEMBER_CAP` (2048; the oldest goes first). Refreshed on every list and stop, and 750 ms after
  each `agent.tool_call` and `agent.idle` of a live Steward (coalesced; a tool call's shell starts a
  moment after the event, and the turn end follows the last one). An identity is forgotten as soon
  as a snapshot no longer shows it, so a pid that comes back later is someone else.
- **Service** (`StewardProcesses`, built by `composeRuntime` when `ComposeOptions.processes` is
  given; `index.ts` passes `{ groups: supervisor }`). Without it there are no sweeps and the tools
  refuse ("this server cannot inspect processes") — every existing test composes without it, so
  none of them runs `ps`. Without a supervisor (`groups`) nothing is attributed.
- **Event**: `agent.processes_stopped` (protocol, append-only). Logged only when something was
  stopped; `by` is the brain, the user, or `system` for a sweep (`sweep: 'agent_ended' |
  'task_closed'`). The web reducer ignores it (OS processes are not world state).
- **REST**: `GET /api/agents/:id/processes` → `StewardProcessesResponse{agentId, supported,
  processes[{pid, ppid, command, cwd?, ports, startedAt, why, held?}]}`; `POST
  /api/agents/:id/processes/stop {pids?}` → `StopProcessesResponse{stopped, forced, alive,
  skipped?}`. Both bearer-guarded; 404 unknown agent, 400 not a Steward, a pid that is not
  attributable, or no pids while the Steward runs. Any client holding the token can stop a
  Steward's processes over REST — remote ones too (the PWA over Tailscale), exactly like
  `stop_agent`/the control routes; the coordinator raises whether remote clients should be allowed
  to as a SPEC §8 question.
- **Panel**: the Steward view shows "N processes still running" (the list in a disclosure: pid,
  command, ports, and "in use by the Steward" for held rows). "Stop them" (or "Stop the K not in
  use" when some are held) reads the list again, shows exactly what it will stop (pid and command
  of each) and "Confirm stop" sends **those pids** — never an empty body, so the server never stops
  "whatever is attributable by then". A held row has its own Stop (the same read-again-and-confirm
  flow for that one pid). Read when the view opens, when the Steward's state changes, every 15 s
  and after a stop; nothing is shown when nothing runs. A REST read, not a status field: `ps`/`lsof`
  run only while someone looks.
- **Tools** (`brains/steward-tools.ts`): reach — the recorded supervisor, or (decision 32:
  supervisors are matched by role and project) the newest live Waykeeper of the Steward's task's
  project, or the live Harmonizer for a standalone task's Steward (`maySupervise`), so a replacement
  Waykeeper can clean up inherited Stewards. `list_steward_processes` without `agentId` covers the
  Stewards in reach that run or ended in the last 24 h, from one `ps` snapshot (`listMany`). A
  stop without pids is refused while the Steward runs. `tell_steward` has the same pre-existing gap
  (recorded supervisor only) and is left as it was.

## Attribution rules

A process P is considered only if it runs as the server's user and is not a zombie. Walking up
P's parent chain, the first fact that decides:

1. **Reaper** — pid ≤ 1, or the executable is `launchd`, `init` or `systemd` (a user subreaper):
   nobody's, ever. Its children are orphans (rules 5–6).
2. **The server's tree** — the server itself, its ancestors (below pid 1) and every member of the
   server's process group (in dev: `pnpm dev`, vite, tsx watch): nobody's.
3. **A group of this run** — P's pgid is a group the supervisor started in this server run and P
   started inside the leader's lifetime (from its start − 1 s to its observed end + 1 s): that
   agent's (`why: group` for the Steward). Another agent's group — or a pgid two agents could claim —
   is never the Steward's.
4. **Descendant** — P's parent is the Steward's: the Steward's (`why: descendant`) — a child that
   escaped the group with `setsid` but is still a child of a group member. Below an orphan of the
   Steward's (rules 5–6), P must also be remembered (rule 5) or carry the Steward's marker (else it
   is not the Steward's, nor is anything below it).
5. **Remembered orphan** — P's parent is a reaper (its CLI died: a tool command's shell in its own
   group; `nohup … &`), or P is below an orphan of the Steward's, and P's identity (pid, start time)
   was recorded in this server run while the Steward's CLI ran, when rule 3 or 4 took it: the
   Steward's (`why: remembered`), no marker, worktree or session needed — it was seen to be the
   Steward's. Not for a user-facing app (below).
6. **Marked orphan in the worktree** — P's parent is a reaper: the Steward's (`why: worktree`) only
   if **all** of: the Steward has a task worktree (its working directory lies in
   `…/.galactic/worktrees/<task>`; a serialised project's Steward, which works in the workspace
   itself, has none and this rule is off); P started inside one of the Steward's **sessions** (each
   spawn or resume to its end, ±1 s — not its creation to its last end: a gap between sessions does
   not count); P's working directory is inside that worktree; and P's environment carries
   `GALACTIC_AGENT_ID=<this Steward>`. An environment that cannot be read (gone, another user's, a
   macOS platform binary) is no marker: not the Steward's. Not for a user-facing app (below).
7. **Anything else** — a child of the user's shell or terminal, of the server (its git commands),
   of another agent, of an orphan that is not the Steward's, a user-facing app reached through an
   orphan and everything below it: not the Steward's.

**Not taken (user-facing app).** Rules 5 and 6 — and descent from a process they took — never take
a process whose command line lies inside a macOS application bundle (`*.app/Contents/`: Electron
apps such as VS Code and its helpers, terminal emulators, any GUI app; an argument with that path
counts too, on the safe side) nor a terminal multiplexer server (`tmux`, including Linux's
`tmux: server`; `screen`/`SCREEN`; `zellij`; `dtach`; `abduco`), and nothing below one. Even when
the Steward started it, what the user later does in it inherits the marker and was "seen" below
the Steward. Rules 3–4 still take such a process while it is in the Steward's own group or
descends from it (a headed browser an MCP server started), so a running Steward's list still
shows it. Cost: an orphaned app-bundle browser (a headed Playwright Chromium from
`ms-playwright/…/Chromium.app`) is no longer swept once its parent is gone; headless runs use
`chrome-headless-shell`/`headless_shell`, a plain binary, and are.

The Steward's own CLI (the group leader) is left out while the Steward runs: stopping the Steward
is `stop_agent`. Once it ended, a still-running leader is a leftover like the rest. While it runs,
what its CLI uses — its direct children (MCP servers from the user's settings such as a Playwright
server and its browser, the shell of the running tool command, a background shell) and every
attributed descendant of them — is **held**: listed and marked, never in a stop-all, stopped only
when named (or below a named held process).

`stop(agentId, {pids})`: every pid must be attributable at the moment of the call, otherwise the
call is refused and nothing is signalled; the attributed descendants of the given pids are added,
except held ones not named; without pids only for a Steward that ended (a sweep, or the user/tool
on an ended Steward). Then:

1. A target that started in the attribution snapshot's own second is ambiguous (see the residual
   risk below): wait until that second is over and attribute again (missing pids are then skipped,
   not refused); whatever is still that young is skipped.
2. A sweep checks again that the Steward is not live (a resume raced it) and does nothing if it is.
3. Read the table once more and skip any target whose start time or parent changed, or that is
   gone (`skipped`).
4. SIGTERM + SIGCONT (a frozen process must be able to die) to each; poll the table up to `termMs`
   (3 s); SIGKILL only to those whose pid **and** start time are unchanged; poll 2 s more; report
   `stopped`, `forced`, `alive`, `skipped`. Stops of one Steward are serialised.

## Safety argument

The server must never stop a process that is not the Steward's. Each rule is safe by itself:

- **Reapers and the server's tree are excluded first.** Rules 1–2 come before anything else, so
  init/launchd/systemd, the server, the terminal and shell that started it and every process of
  its group (Cosmin's dev servers on `[::1]:5173` and `127.0.0.1:4321` run in that group when he
  starts them with `pnpm dev`) can never be attributed — not even through a recorded pgid. A
  process whose parent is in the server's tree is never an orphan either (the server's own `git`
  in a worktree stays the server's, even when the server is pid 1 in a container). Dev servers
  Cosmin starts from another terminal are children of that terminal's shell: rule 7.
- **Group membership is this run's fact, with a lifetime.** The supervisor creates the group
  (`setsid` via `detached: true`) and records, in memory, its leader's pid, its start and the end
  it observed after reaping the group. A pgid is not reused while the group has members, and the
  server watched the group the whole time; after it emptied, a reused pgid's members start after
  the recorded end, so rule 3's time check rejects them. Rows of the PID table from an earlier
  run are **never** groups: the server was not watching during the downtime, `reconcile()` writes
  its own time as their end, and a user process may have taken the pid/pgid meanwhile (B2).
- **Descent is a kernel fact.** `ppid` is set by the kernel; a process whose parent is the
  Steward's was created by the Steward's process tree (rule 4). It is checked against a single
  snapshot, and a parent missing from the snapshot decides nothing (rule 7).
- **Orphans need four independent facts, one of them carried by the process itself.** For a
  process whose ancestry is lost (rule 6) the server only takes it when its parent is a reaper
  **and** it started during one of the Steward's sessions **and** it works inside the task's own
  worktree **and** it carries the Steward's marker. The marker is what separates the Steward's
  daemons from the user's: a tmux server, `code .` (Electron), or `nohup … &` from a terminal that
  was then closed — all started by the user in the worktree during the session — have the user's
  environment, without `GALACTIC_AGENT_ID` (or another agent's), so they and everything below
  them are never taken (B1). Inheritance means the marker survives `setsid`, `nohup`, double
  forks and the death of every ancestor; a process that clears its environment loses it and is
  simply not found (fail closed). Below an orphan, rule 4 requires the marker at every step, so a
  marked orphan that hands work to an unmarked process does not extend the attribution. A process
  the user starts from a terminal keeps the terminal's shell as parent (rule 7) anyway; a serialised
  project (Steward in the user's own workspace) never uses rule 6 at all.
- **Remembered identities are observed facts, narrowly kept.** An identity is recorded only when
  rule 3 or 4 took the process through the Steward's own groups (kernel facts) while its CLI ran,
  in this server run; it is the pair (pid, start time), forgotten as soon as a snapshot no longer
  shows it, so a pid recycled later does not match (the one-second `lstart` window is the residual
  risk below). The server's tree, another agent's group and user-facing apps are decided before
  memory is consulted.
- **User-facing apps are never taken through an orphan** (S2): a GUI app or multiplexer the
  Steward launched becomes the user's workspace the moment the user works in it, and everything
  started there inherits the marker; the orphan rules never take one nor anything below it.
- **Other agents' processes are excluded** by their own groups (rule 3), descent from them (rule
  7), their own marker (rule 6 needs this Steward's id), the memory being per Steward (rule 5),
  and the worktree being per task.
- **The user's uid only; no zombies.** Other users' processes are never candidates (and could not
  be signalled anyway).
- **Signals go to the pids that were shown, verified just before.** The panel sends exactly the pids
  it showed after reading the list again; the tool must name pids while the Steward runs. `stop`
  re-validates the request against a fresh attribution, re-reads the table right before SIGTERM
  (start time and parent unchanged), signals one pid at a time (never `kill(-pgid)`), and the
  SIGKILL goes only to a pid whose start time is unchanged.
- **A live Steward's session is not cut from under it.** Its CLI is never listed; its direct
  helpers and the running tool command are held and need a per-pid choice; a stop-all is refused;
  the sweep never touches a live Steward and checks again right before the signals.
- **The model never decides.** The brain tools only pass pids; the server refuses any pid outside
  the attribution, and the tools' reach is the Steward's recorded supervisor or its prescribed one
  by decision 32 (the project's newest live Waykeeper; the live Harmonizer for an asteroid).

**Residual risk (identity at signal time).** `ps lstart` has a one-second resolution (floored), so
"same pid, same start time, same parent" cannot tell a process from one that replaced it under the
same pid within the same second. The stop path narrows this to: a target that started in the
attribution snapshot's own second is looked at again after that second; the last identity read
happens a few milliseconds before the SIGTERM. A process that dies and whose pid is handed to a new
process with the same parent inside those milliseconds, in the same second, would be hit — pids are
handed out in sequence on macOS and Linux, so this needs a full wrap of the pid space within that
window. Reading the start time at a finer resolution (`/proc/<pid>/stat` starttime in clock ticks,
`proc_pidinfo` on macOS) or `pidfd_send_signal` on Linux would close it; not done.

Known limits (documented, conservative): a process that deliberately sets **this** Steward's id
in its environment (someone typing `GALACTIC_AGENT_ID=<its id> …`) and daemonises in its worktree
during its session would be taken — the marker is an inherited fact, not a secret. A Steward's process that clears its environment
(`env -i`, some sandboxes) and is orphaned is found only if it was remembered (rule 5); on macOS
the environment of platform binaries (`/bin/sh`, `/bin/zsh`, `/bin/sleep`, `/usr/bin/python3`
shims…) is hidden from `ps -E`, so such an orphan is found only if it was remembered — i.e. seen
while the Steward's CLI ran (on a list, a stop, or the refresh after a tool call or turn end); one
that started and was orphaned between two looks is not (a node, toolchain-Python or browser
process below it still has its marker, but needs a remembered or marked parent chain). Memory is
per server run: after a restart only the marker rule applies. A Steward from before a restart
keeps its earlier run's latest PID-table row as a session next to this run's ones (N3); escaped
processes of still earlier sessions are found only if they started in one of those.

**Residual risks added by the second review** (documented, not closed):

- **An environment value read as a marker (macOS).** `ps -E` prints the environment
  space-separated after the command line, so a variable whose *value* contains
  ` GALACTIC_AGENT_ID=<id>` reads as a marker. It must be this exact Steward's id (a random id
  the process would have to know), the orphan must have started in the Steward's session inside
  its worktree, and two different values are no marker. The cheap hardenings considered do not
  close it: "the first `GALACTIC_` variable" fails when the fake sits in an earlier variable's
  value, and "the agent id exists" adds nothing since the value must already equal this Steward's
  id. The fix is reading the NUL-separated environment (`sysctl KERN_PROCARGS2`, native code);
  deferred. Linux reads `/proc/<pid>/environ` (NUL-separated) and is not affected.
- **argv rewritten between the two `ps` reads.** The `ps -E` line counts only when it starts with
  the command line from the first read; a process that rewrites its argv in between to that same
  text followed by ` GALACTIC_AGENT_ID=<id>` would be read as marked. It needs a deliberate,
  timed rewrite with this Steward's id; same bounds as above.
- **A marker exported into the worktree's shell config.** A Steward that writes `export
  GALACTIC_AGENT_ID=<its id>` into the worktree's `.envrc` (direnv) or `mise.toml` makes the
  user's later shells in that worktree carry its marker, so a daemon the user starts there during
  the Steward's session and orphans would match rule 6. direnv and mise refuse a changed file
  until the user allows/trusts it, and the session window and the worktree still bound it; a
  process started from the user's shell keeps that shell as parent (rule 7) while it lives.
- **Per-user daemons a Steward starts first** (a Gradle daemon, watchman, `ssh` ControlMaster,
  `gpg-agent`) carry its marker or are remembered and are swept with it even if the user's own
  tools started using them meanwhile; they restart on demand, but an `ssh` master's multiplexed
  sessions drop.

## SPEC decision

The product rule is SPEC.md §7 **decision 76** (Leftover processes); this file is its technical
companion and no longer carries a proposed text.

## Tests

- `runtime/process-attribution.test.ts`: every rule on synthetic tables — group members, recycled
  pgid, escaped descendants, marked worktree orphans and their children, a systemd subreaper,
  orphans before the session / outside the worktree / without a worktree / after the end, the
  user's shell and the server's own children in the worktree, another agent's (escaped)
  processes, another uid, zombies, an ambiguous pgid, a server that is pid 1, descendant
  expansion; **B1**: the user's daemons in the worktree (tmux server and its shells, Electron and
  its helpers) without a marker are never taken, nor with another agent's marker; with this
  Steward's marker they are, and below them only what is marked too; an unreadable environment is
  no marker; a process started in a gap between two sessions is not taken, nor anything without a
  recorded session; **B2**: a pgid reused by the user's shell with only this run's groups; held
  processes of a live CLI; `ps`, `ps -E`, `/proc/<pid>/environ`, `lsof -F` and `/proc/net/tcp`
  parsing; the worktree root.
- Second review (`process-attribution.test.ts`): **S2** — an Electron orphan from `code .` with
  this Steward's marker, its helpers, an integrated terminal and the user's work in it: not taken,
  not even when remembered; a tmux server (`tmux new -d`, Linux `tmux: server`, `SCREEN -dmS`) with
  the marker and its panes: not taken; an app below a marked orphan and what is under it: not
  taken, the orphan's other child is; a plain marked node orphan: taken; an app-bundle browser in
  the live group: taken (rule 3); the matcher. **S1** — a remembered orphan shell and its
  remembered children are taken without a marker, a worktree or a session; below it, what was
  never seen needs the marker; nothing unremembered and unmarked, nor the same pid with another
  start time; memory never overrides another agent's group or the server's tree; `anchored` only
  for rules 3–4. `steward-processes.test.ts`: **S1 with real processes** — a CLI stand-in runs
  `/bin/sh -c '<node leaf> & wait'` in a group of its own (as Claude Code runs Bash); listed as
  held descendants while it runs; the CLI is SIGKILLed alone; on macOS the shell shows no marker;
  the list then finds the shell and the leaf as `remembered`, never the user's unmarked daemon in
  the worktree; the sweep at the Steward's end stops both and not the daemon. Scripted: a
  `agent.tool_call` of a live Steward triggers a refresh that remembers its shell; once orphaned
  (no marker, no session) it is found, an unseen later shell is not, nor the same pid with another
  start time; **N4** — a stop waiting out the snapshot's second signals nothing after `dispose()`.
  `supervisor.test.ts`: **N2** — a leader that leaves a SIGTERM-ignoring child: the group's end is
  recorded at the leader's exit, ≥ 350 ms before the reap settles; **N3** — an earlier run's
  interrupted row stays a session after this run's spawn overwrites the row (a row of another
  boot never is).
- `runtime/supervisor.test.ts` (+2, real processes): the marker in the child's environment
  (inherited by a grandchild, never overridable by a spec); B2 with a scripted PID table — a
  previous run's row (same boot) reconciled to `interrupted` is not a group, a user process in its
  reused pgid is not attributed (and would have been with the old reading), its session still
  bounds rule 6; spawns of this run give one group and one session each, with the observed end;
  `livePid`.
- `runtime/steward-processes.test.ts`, **real processes** (skipped on Windows): a CLI stand-in
  spawned through the supervisor in the worktree starts an in-group HTTP server and a `detached`
  (setsid) child; orphans (`sh -c '… & echo $!'` from a detached shell) in and outside the
  worktree, with the Steward's marker, another agent's, or none (the user's daemon); a marked
  child of the test process in the worktree. Listing finds the group member (with its port, held),
  the escaped child (held) and the marked in-worktree orphan, never the CLI, the outside orphan,
  the unmarked or other-marked ones, the test's child or the test process; a stop with any foreign
  pid, or without pids while the Steward runs, is refused and signals nothing; held processes only
  by name; SIGKILL for a process that ignores SIGTERM; the sweep after the Steward ends (after the
  supervisor reaped its group) kills the escaped child and the orphan, not the outside one or the
  user's daemon; a marked orphan from before the session is never taken. On a scripted table: the
  sweeps (live Steward not swept, `agent_ended` then `task_closed`); a sweep whose Steward is
  resumed while it reads the table signals nothing; a pid whose start time changed before SIGTERM is
  skipped; a target as young as the snapshot's second is re-attributed after it (and skipped if it
  stays that young); refusals for unknown agents and non-Stewards.
- `runtime/status-store.test.ts` (+1, P4-11): two open permission questions — answering the newer
  keeps the agent `waiting_for_input` on the older; a cancelled one likewise; a rebuild agrees.
- `brains/waykeeper/processes.test.ts` (3, brain harness, real git worktrees, a real marked orphan
  dev server started by a fake Steward, sessions from a stub group source): the Waykeeper lists →
  stops → merges → closes → reports, the server is dead, one `agent.processes_stopped` by the
  Waykeeper and no sweep event; the safety net stops a finished Steward's server when its Waykeeper
  did nothing; both prompts carry the rule.
- `brains/steward-tools.test.ts`: the tools refuse another Waykeeper's Steward, a non-Steward and
  an unknown agent without calling the service; refuse without the service; list one / all (one
  `listMany`, live and recently ended Stewards only); stop as the calling brain; malformed pids;
  a replacement Waykeeper (the project's newest live one) reaches its predecessor's Steward, an
  older or stopped Waykeeper and another project's do not, the live Harmonizer reaches an
  asteroid's Steward but not a project's.
- `http/process-routes.test.ts` (3): bearer guard, 404/400 mapping, stop as the user, body checks.
- `panel/steward/StewardProcesses.test.tsx` (4): nothing shown when nothing runs; count, list,
  ports; cancel; "Stop them" reads the list again, shows what it will stop and sends exactly those
  pids; held rows are left out of the bulk stop and have their own confirmed Stop; re-read on a
  state change.
- Every test that spawns processes kills every pid it saw in `afterEach` (and the supervisor's
  groups), and `afterAll` runs `pkill -9 -f <per-run tag>`.

## Deferred

- A `processes` count on `StatusRecord` (so the scene or the cards could show leftovers without a
  REST read): not needed for the Steward view; it would put `ps` on a timer for every agent.
- Persisting every group and session an agent ever had (the PID table keeps the latest per agent;
  this run's are in memory).
- Sweeping after a restart: an interrupted Steward's escaped processes survive a server restart
  (reconcile kills the CLI's group only); the next end or task close of that Steward sweeps the
  marked ones that started in its earlier run's or this run's sessions (remembered identities do
  not survive a restart).
- Persisting remembered identities across a restart (with the boot id), and a periodic refresh of
  live Stewards between tool calls.
- Reading the macOS environment NUL-separated (`sysctl KERN_PROCARGS2`) instead of `ps -E`.
- Brains' own leftovers (a Waykeeper running a dev server for a merge check): out of scope; their
  group is reaped when they stop.
- Windows: `list` answers `supported: false` (no `ps`), the tools say so.
- A finer process identity (`/proc/<pid>/stat` start ticks, `proc_pidinfo`, `pidfd_send_signal`)
  to close the one-second `lstart` window.
- `tell_steward`'s reach (recorded supervisor only) could use `maySupervise` too.

## Platform notes

- macOS: `ps lstart` is local time with one-second resolution (floored) — every time comparison
  allows ±1 s. `comm`/`command` may contain spaces; `-ww` avoids truncation. Orphans are reparented
  to `launchd` (pid 1). `lsof` exits 1 when one of the pids is gone; its output is still used.
  `ps -E` shows the environment of the user's own processes except platform binaries (SIP:
  `/bin/sh`, `/bin/zsh`, `/bin/sleep`, Xcode's `python3`), whose line is the bare command line: no
  marker — rule 5's memory covers them when they were seen while the CLI ran. Claude Code runs each
  Bash command in a process group of its own, so the CLI's group reap does not reach its shells.
- Linux: orphans go to pid 1 or to the nearest subreaper (`systemd --user`); the executable name
  check treats `systemd` as a reaper. `/proc/<pid>/cwd` may read `… (deleted)` after a worktree was
  removed; the suffix is stripped. Without `lsof`, ports come from `/proc/net/tcp{,6}`.
  `/proc/<pid>/environ` is the environment at exec time (what the process inherited).
- In containers whose pid 1 is not an init (e.g. `node` itself), orphans are reparented to that
  process; its children are then the server's own (rule 2) and orphans are never attributed — safe, but
  rules 5–6 do nothing there.
