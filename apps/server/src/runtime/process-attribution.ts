import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Id, ProcessAttribution } from '@galactic/protocol';

/**
 * Which OS processes belong to a Steward (P4-14; SPEC decision 53; TECHNOLOGY §2.2 "Process
 * cleanup"). Pure: it works on a snapshot of the process table (`ProcEntry[]`, from `ps`) and the
 * process groups the supervisor started (`AgentGroup[]`, from its PID table), and asks for working
 * directories only of the few processes the worktree rule needs. The OS layer is
 * `process-table.ts`; the service that lists, stops and sweeps is `steward-processes.ts`.
 *
 * A process P (of the server's own user, not a zombie) is the Steward's when, walking up its
 * parent chain, the first thing that decides says so:
 *
 *   1. P is a reaper (pid ≤ 1, `launchd`, `init`, `systemd`)           → never anyone's.
 *   2. P is the server, one of its ancestors, or in the server's group → never anyone's.
 *   3. P is a member of an agent's recorded process group (its pgid is the group's and P started
 *      inside the group's lifetime, so a recycled pgid does not count) → that agent's: the
 *      Steward's (`group`) or another agent's (never the Steward's).
 *   4. P's parent is the Steward's                                     → the Steward's (`descendant`:
 *      escaped its group with `setsid`, still a child).
 *   5. P's parent is a reaper (P was orphaned: daemonised, `nohup … &` whose shell exited) → the
 *      Steward's (`worktree`) only if the Steward has a task worktree, P started inside the
 *      Steward's session, and P's working directory is inside that worktree.
 *   6. Anything else (a child of the server, of another agent, of the user's shell or terminal,
 *      of an orphan that is not the Steward's)                          → not the Steward's.
 *
 * The safety argument (rule by rule) is written up in `docs/tasks/notes/P4-14-process-cleanup.md`.
 */

/** One row of the process table. `startedAt` is epoch ms, floored to the second (`ps lstart`). */
export interface ProcEntry {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  startedAt: number;
  command: string;
  zombie?: boolean;
}

/** A process group the supervisor started for an agent (its CLI is the leader: pgid = pid). */
export interface AgentGroup {
  agentId: Id;
  pgid: number;
  /** When the leader was spawned (epoch ms). */
  startedAt: number;
  /** When the leader exited; absent while it runs. */
  endedAt?: number;
}

export interface AttributionInput {
  agentId: Id;
  procs: readonly ProcEntry[];
  groups: readonly AgentGroup[];
  /** The server itself: its pid and its user. */
  self: { pid: number; uid: number };
  /** The Steward's session (epoch ms): from its creation to its end, or now while it runs. */
  window: { start: number; end: number };
  /** The task worktree's root. Absent (a serialised project, no worktree): rule 5 is off. */
  worktree?: string;
  /** Working directories of the given pids (the OS layer); missing pids are unknown. */
  cwdOf: (pids: number[]) => Promise<Map<number, string>> | Map<number, string>;
  /** Pids never listed (the Steward's own CLI while it runs). */
  exclude?: ReadonlySet<number>;
}

export interface AttributedProcess extends ProcEntry {
  why: ProcessAttribution;
  cwd?: string;
}

/** `ps lstart` has a one-second resolution (floored): every time comparison allows this much. */
export const START_SLACK_MS = 1_000;

/** Processes orphans are reparented to: never anyone's, and their children are orphans. */
export const REAPERS: ReadonlySet<string> = new Set(['launchd', 'init', 'systemd']);

/** The executable's name: the basename of the first word of the command line. */
export function executable(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return basename(first);
}

export function isReaper(p: ProcEntry): boolean {
  return p.pid <= 1 || REAPERS.has(executable(p.command));
}

/** Whether `child` is `parent` or inside it (both absolute). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The worktree root a Steward's working directory lies in (`…/.galactic/worktrees/<task>`). */
export function worktreeRootOf(
  cwd: string,
  worktreesDir = `.galactic${sep}worktrees`,
): string | undefined {
  const marker = `${sep}${worktreesDir}${sep}`;
  const at = cwd.indexOf(marker);
  if (at < 0) return undefined;
  const rest = cwd.slice(at + marker.length);
  const task = rest.split(sep)[0];
  if (!task) return undefined;
  return cwd.slice(0, at + marker.length) + task;
}

type Verdict = ProcessAttribution | 'reaper' | 'server' | 'other' | 'foreign';
const MINE: ReadonlySet<Verdict> = new Set(['group', 'descendant', 'worktree']);

/** The pids of the server's own tree: itself, its ancestors (below pid 1) and its process group. */
export function serverTree(procs: readonly ProcEntry[], selfPid: number): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const tree = new Set<number>([selfPid]);
  let p = byPid.get(selfPid);
  const pgid = p?.pgid;
  while (p && p.ppid > 1 && !tree.has(p.ppid)) {
    tree.add(p.ppid);
    p = byPid.get(p.ppid);
  }
  if (pgid !== undefined && pgid > 1) {
    for (const q of procs) if (q.pgid === pgid) tree.add(q.pid);
  }
  return tree;
}

/** The agent whose recorded group `p` belongs to; `null` when two agents could claim it. */
function groupOwner(p: ProcEntry, groups: readonly AgentGroup[]): Id | null | undefined {
  const owners = new Set(
    groups
      .filter(
        (g) =>
          g.pgid === p.pgid &&
          p.startedAt >= g.startedAt - START_SLACK_MS &&
          (g.endedAt === undefined || p.startedAt <= g.endedAt + START_SLACK_MS),
      )
      .map((g) => g.agentId),
  );
  if (owners.size === 0) return undefined;
  return owners.size === 1 ? [...owners][0]! : null;
}

/** The Steward's processes, by the rules above. */
export async function attribute(input: AttributionInput): Promise<AttributedProcess[]> {
  const { agentId, procs, groups, self, window, worktree } = input;
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const server = serverTree(procs, self.pid);
  const inWindow = (p: ProcEntry) =>
    p.startedAt >= window.start - START_SLACK_MS && p.startedAt <= window.end + START_SLACK_MS;
  const parentIsReaper = (p: ProcEntry) => {
    const parent = byPid.get(p.ppid);
    return p.ppid <= 1 || (parent !== undefined && isReaper(parent));
  };

  // Rule 5 needs working directories: only of orphans of ours that started in the session.
  const orphanCandidates = worktree
    ? procs.filter(
        (p) =>
          p.uid === self.uid &&
          !p.zombie &&
          !isReaper(p) &&
          !server.has(p.pid) &&
          groupOwner(p, groups) === undefined &&
          parentIsReaper(p) &&
          inWindow(p),
      )
    : [];
  const cwds =
    orphanCandidates.length > 0
      ? await input.cwdOf(orphanCandidates.map((p) => p.pid))
      : new Map<number, string>();

  const memo = new Map<number, Verdict>();
  const verdict = (p: ProcEntry, depth = 0): Verdict => {
    const known = memo.get(p.pid);
    if (known) return known;
    let v: Verdict;
    if (isReaper(p)) v = 'reaper';
    else if (server.has(p.pid)) v = 'server';
    else {
      const owner = groupOwner(p, groups);
      if (owner !== undefined) v = owner === agentId ? 'group' : 'other';
      else if (parentIsReaper(p)) {
        const cwd = cwds.get(p.pid);
        v =
          worktree !== undefined && inWindow(p) && cwd !== undefined && isInside(cwd, worktree)
            ? 'worktree'
            : 'foreign';
      } else {
        const parent = byPid.get(p.ppid);
        // A parent gone from the snapshot (it exited between the two reads) decides nothing.
        if (!parent || depth > 256) v = 'foreign';
        else v = MINE.has(verdict(parent, depth + 1)) ? 'descendant' : 'foreign';
      }
    }
    memo.set(p.pid, v);
    return v;
  };

  const out: AttributedProcess[] = [];
  for (const p of procs) {
    if (p.uid !== self.uid || p.zombie || input.exclude?.has(p.pid)) continue;
    const v = verdict(p);
    if (!MINE.has(v)) continue;
    const cwd = cwds.get(p.pid);
    out.push({ ...p, why: v as ProcessAttribution, ...(cwd !== undefined ? { cwd } : {}) });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}

/** The attributed processes `pids` and every attributed descendant of them. */
export function withDescendants(
  attributed: readonly AttributedProcess[],
  pids: Iterable<number>,
): AttributedProcess[] {
  const chosen = new Set(pids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of attributed) {
      if (!chosen.has(p.pid) && chosen.has(p.ppid)) {
        chosen.add(p.pid);
        grew = true;
      }
    }
  }
  return attributed.filter((p) => chosen.has(p.pid));
}
