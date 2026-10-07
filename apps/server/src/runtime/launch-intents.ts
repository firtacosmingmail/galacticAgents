import type { Id } from '@galactic/protocol';
import {
  AGENT_ID_ENV,
  RUN_ID_ENV,
  runIdOfKey,
  isInside,
  isReaper,
  isUserFacingApp,
  serverTree,
  START_SLACK_MS,
  type ProcEntry,
} from './process-attribution.js';
import type { LaunchIntent } from './process-store.js';

/**
 * Launches a killed server may have forked without recording them (P8-11; SPEC decision 76;
 * notes `docs/tasks/notes/P8-11-launch-intent.md`). Pure, like `process-attribution.ts`: it works
 * on a snapshot of the process table and the environment and working directory of the few
 * processes that could belong to a launch.
 *
 * The supervisor writes a **launch intent** before it forks an agent's CLI and gives the child two
 * variables, which every descendant inherits: the agent marker (`GALACTIC_AGENT_ID=<agent>`) and
 * the launch id (`GALACTIC_LAUNCH_ID=<intent id>`, a random UUID: no other process carries it). An
 * intent whose PID-table row never came (the server was killed between the fork and the row) is
 * matched at the next start by these rules. A process group G of the snapshot is the launch's
 * when ALL of:
 *
 *   - every member of G is the server's user's, none is a reaper or in the new server's own tree,
 *     none is a user-facing app (`isUserFacingApp`) nor below one — else G is left whole;
 *   - EITHER the leader is alive (`pid = pgid = G`) and it is the launched CLI: its environment
 *     carries this agent's marker AND this launch's id, it started inside the launch window
 *     (`intendedAt − 1 s` to `intendedAt + 5 s`: the fork follows the intent at once; `ps lstart`
 *     has a one-second resolution), its parent is a reaper (its parent, the killed server, is
 *     gone), and its working directory is inside the launch's (the worktree);
 *   - OR the leader is gone (no process `pid = G`) and the group still has members — the CLI exited
 *     and left its group, as `reconcile()`'s leftover group — and a member carries the marker and
 *     the launch id, started after the intent, and runs inside the launch's working directory.
 *
 * A process whose environment cannot be read (another user's, a macOS platform binary) carries
 * nothing: it never makes a group the launch's. Inside a group that qualifies, members are taken
 * by the kernel's grouping, as `reconcile()` does — a group id is not handed out again while the
 * group has members, and only the launch's processes can have joined it.
 *
 * Only the CLI's own group is taken (decision 106): one launch has one such group. When the CLI
 * is alive, its group is the leader's (the earliest-started leader that qualifies: the CLI is the
 * launch's first process, so a later one is a descendant that moved out); every leaderless group
 * carrying the launch id is then one a descendant moved out to, and is not taken. When the CLI is
 * gone, a leaderless group is taken only if it is the one leaderless group carrying the launch:
 * with several (a tool's `nohup`/`setsid` group whose own leader exited, next to the CLI's), the
 * CLI's cannot be told apart, and all of them are left alone (fail closed).
 *
 * What escaped the CLI's group (a `setsid` dev server) is not taken here, as `reconcile()` leaves
 * it (decision 76: an interrupted agent comes back); the supervisor records the launch as an
 * interrupted session of the agent instead, so the Steward's sweep finds it when it ends.
 */

/** Every agent child's launch id (`ProcessSupervisor.launch`); descendants inherit it. */
export const LAUNCH_ID_ENV = 'GALACTIC_LAUNCH_ID';

/** How long after its intent the CLI may have been forked (the reconcile tolerance). */
export const LAUNCH_WINDOW_MS = 5_000;

export interface LaunchTake {
  intentId: string;
  agentId: Id;
  pgid: number;
  /** `leader`: the launched CLI is alive; `leftover`: it exited and left its group. */
  kind: 'leader' | 'leftover';
  /** The CLI, when alive. */
  leader?: ProcEntry;
  /** The group's members in the snapshot (the leader included). */
  members: ProcEntry[];
}

export interface LaunchMatchInput {
  intent: LaunchIntent;
  procs: readonly ProcEntry[];
  /** The new server: its pid and its user. */
  self: { pid: number; uid: number };
  /** Variables of each readable environment (`ProcessTable.environment`); missing: unreadable. */
  envOf: ReadonlyMap<number, ReadonlyMap<string, string>>;
  /** Working directories (`ProcessTable.cwds`); missing: unknown. */
  cwdOf: ReadonlyMap<number, string>;
  /** Process groups never taken (this run's own). */
  excludeGroups?: ReadonlySet<number>;
}

const startOf = (intent: LaunchIntent) => Date.parse(intent.intendedAt);

/**
 * The processes whose environment (and, if marked, working directory) the matcher needs: the
 * server's user's, not zombies, reapers or the server's tree, started after the intent.
 */
export function launchCandidates(
  intent: LaunchIntent,
  procs: readonly ProcEntry[],
  self: { pid: number; uid: number },
): ProcEntry[] {
  const from = startOf(intent) - START_SLACK_MS;
  if (Number.isNaN(from)) return [];
  const server = serverTree(procs, self.pid);
  return procs.filter(
    (p) =>
      p.uid === self.uid && !p.zombie && !isReaper(p) && !server.has(p.pid) && p.startedAt >= from,
  );
}

/**
 * The marker a launch's processes carry: the agent marker, or for a managed run (P9-08, key
 * `run:<runId>`) the run marker — a run's processes never carry an agent's.
 */
export function launchMarker(intent: Pick<LaunchIntent, 'agentId'>): [name: string, value: string] {
  const runId = runIdOfKey(intent.agentId);
  return runId !== undefined ? [RUN_ID_ENV, runId] : [AGENT_ID_ENV, intent.agentId];
}

/** Whether `p`'s readable environment names this launch of this agent (or run). */
export function carriesLaunch(
  p: ProcEntry,
  intent: LaunchIntent,
  envOf: LaunchMatchInput['envOf'],
): boolean {
  const env = envOf.get(p.pid);
  const [name, value] = launchMarker(intent);
  return env?.get(name) === value && env.get(LAUNCH_ID_ENV) === intent.id;
}

/** The process groups of the snapshot that are this launch's, by the rules above. */
export function matchLaunch(input: LaunchMatchInput): LaunchTake[] {
  const { intent, procs, self, envOf, cwdOf } = input;
  const at = startOf(intent);
  if (Number.isNaN(at)) return [];
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const server = serverTree(procs, self.pid);
  const serverGroup = byPid.get(self.pid)?.pgid;
  const marked = (p: ProcEntry) => carriesLaunch(p, intent, envOf);
  const inCwd = (p: ProcEntry) => {
    const cwd = cwdOf.get(p.pid);
    return cwd !== undefined && isInside(cwd, intent.cwd);
  };
  const parentIsReaper = (p: ProcEntry) => {
    const parent = byPid.get(p.ppid);
    return p.ppid <= 1 || (parent !== undefined && isReaper(parent));
  };
  const belowUserApp = (p: ProcEntry): boolean => {
    let q: ProcEntry | undefined = p;
    for (let depth = 0; q && depth < 256; depth++) {
      if (isUserFacingApp(q)) return true;
      if (q.ppid <= 1) return false;
      q = byPid.get(q.ppid);
      if (q && isReaper(q)) return false;
    }
    return false;
  };

  const groups = new Map<number, ProcEntry[]>();
  for (const p of procs) {
    if (p.pgid <= 1) continue;
    const list = groups.get(p.pgid) ?? [];
    list.push(p);
    groups.set(p.pgid, list);
  }

  const leaders: LaunchTake[] = [];
  const leftovers: LaunchTake[] = [];
  for (const [pgid, all] of groups) {
    if (pgid === serverGroup || input.excludeGroups?.has(pgid)) continue;
    const members = all.filter((p) => !p.zombie);
    if (members.length === 0) continue;
    // Fail closed: one member that is not ours to take leaves the whole group alone.
    const safe = members.every(
      (p) => p.uid === self.uid && !isReaper(p) && !server.has(p.pid) && !belowUserApp(p),
    );
    if (!safe) continue;
    const found = byPid.get(pgid);
    const leader = found && found.pgid === pgid && !found.zombie ? found : undefined;
    if (leader) {
      if (
        marked(leader) &&
        leader.startedAt >= at - START_SLACK_MS &&
        leader.startedAt <= at + LAUNCH_WINDOW_MS &&
        parentIsReaper(leader) &&
        inCwd(leader)
      ) {
        leaders.push({
          intentId: intent.id,
          agentId: intent.agentId,
          pgid,
          kind: 'leader',
          leader,
          members,
        });
      }
      continue;
    }
    // The leader is gone (or a zombie): a leftover group, if a member names this launch.
    if (members.some((p) => marked(p) && p.startedAt >= at - START_SLACK_MS && inCwd(p))) {
      leftovers.push({
        intentId: intent.id,
        agentId: intent.agentId,
        pgid,
        kind: 'leftover',
        members,
      });
    }
  }
  // Only the CLI's own group (see above): what moved out of it is left to the agent.
  if (leaders.length > 0) {
    const first = leaders.reduce((a, b) => {
      const sa = a.leader!.startedAt;
      const sb = b.leader!.startedAt;
      return sb < sa || (sb === sa && b.pgid < a.pgid) ? b : a;
    });
    return [first];
  }
  return leftovers.length === 1 ? leftovers : [];
}
