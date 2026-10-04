import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Id, ProcessAttribution } from '@galactic/protocol';

/**
 * Which OS processes belong to a Steward (P4-14; SPEC decision 76; TECHNOLOGY §2.2 "Process
 * cleanup"). Pure: it works on a snapshot of the process table (`ProcEntry[]`, from `ps`) and the
 * process groups the supervisor started in this server run (`AgentGroup[]`), and asks the OS layer
 * for working directories and agent markers only of the few processes the orphan rule needs. The
 * OS layer is `process-table.ts`; the service that lists, stops and sweeps is
 * `steward-processes.ts`.
 *
 * A process P (of the server's own user, not a zombie) is the Steward's when, walking up its
 * parent chain, the first thing that decides says so:
 *
 *   1. P is a reaper (pid ≤ 1, `launchd`, `init`, `systemd`)           → never anyone's.
 *   2. P is the server, one of its ancestors, or in the server's group → never anyone's.
 *   3. P is a member of a process group the supervisor started in THIS server run (its pgid is the
 *      group's and P started inside the group's lifetime, so a recycled pgid does not count) →
 *      that agent's: the Steward's (`group`) or another agent's (never the Steward's).
 *   4. P's parent is the Steward's                                     → the Steward's (`descendant`:
 *      escaped its group with `setsid`, still a child) — but when the chain reaches the Steward
 *      only through an orphan (rules 5–6), P must be remembered (rule 5) or carry the Steward's
 *      marker too.
 *   5. P's parent is a reaper (P was orphaned: daemonised, `nohup … &` whose shell exited, a tool
 *      command's shell whose CLI died), or P is below such an orphan of the Steward's, and P's
 *      identity (pid, start time) was REMEMBERED: this server run saw it as the live Steward's by
 *      rule 3 or 4 while its CLI ran (`remembered`) → the Steward's (`remembered`), no marker needed.
 *   6. P's parent is a reaper → the Steward's (`worktree`) only if ALL of: the Steward has a task
 *      worktree; P started inside one of the Steward's sessions (a spawn or resume to its end, as
 *      the supervisor recorded them); P's working directory is inside that worktree; and P's
 *      environment carries `GALACTIC_AGENT_ID=<this Steward>` (`AGENT_ID_ENV`, set by the
 *      supervisor on every agent child and inherited by its descendants). An environment that
 *      cannot be read is no marker.
 *      Rules 5 and 6 never take a user-facing app (`isUserFacingApp`: an executable inside a macOS
 *      `*.app/Contents/` bundle, a terminal multiplexer server such as tmux or screen) nor anything
 *      below one: a `code .` or `tmux new -d` the Steward started becomes the user's once the
 *      user works in it (other folders, terminals, extension hosts, panes).
 *   7. Anything else (a child of the server, of another agent, of the user's shell or terminal,
 *      of an orphan that is not the Steward's)                          → not the Steward's.
 *
 * The safety argument (rule by rule) is written up in `docs/tasks/notes/P4-14-process-cleanup.md`.
 */

/**
 * The variable the supervisor puts in every agent child's environment (`<agentId>`); descendants
 * inherit it. Rule 5 needs it: a daemon the user started in the worktree does not have it.
 */
export const AGENT_ID_ENV = 'GALACTIC_AGENT_ID';

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

/**
 * A process group the supervisor started for an agent in this server run (its CLI is the leader:
 * pgid = pid). One per spawn, restart or resume.
 */
export interface AgentGroup {
  agentId: Id;
  pgid: number;
  /** When the leader was spawned (epoch ms). */
  startedAt: number;
  /** When the leader exited; absent while it runs. */
  endedAt?: number;
}

/** One session of an agent (epoch ms): a spawn or resume, to its end (now while it runs). */
export interface Session {
  start: number;
  end: number;
}

type PidMap<T> = Promise<Map<number, T>> | Map<number, T>;

export interface AttributionInput {
  agentId: Id;
  procs: readonly ProcEntry[];
  /** The groups the supervisor started in this server run (never rows of an earlier run). */
  groups: readonly AgentGroup[];
  /** The server itself: its pid and its user. */
  self: { pid: number; uid: number };
  /** The Steward's sessions, as the supervisor recorded them. None: rule 5 is off. */
  sessions: readonly Session[];
  /** The task worktree's root. Absent (a serialised project, no worktree): rule 5 is off. */
  worktree?: string;
  /** Working directories of the given pids (the OS layer); missing pids are unknown. */
  cwdOf: (pids: number[]) => PidMap<string>;
  /**
   * The `AGENT_ID_ENV` value in each given process's environment (the OS layer); a pid that is
   * missing has none, or its environment could not be read — either way it is not the Steward's.
   */
  markerOf: (pids: number[]) => PidMap<string>;
  /** Pids never listed (the Steward's own CLI while it runs). */
  exclude?: ReadonlySet<number>;
  /**
   * Whether this process (pid and start time) was seen as the live Steward's by rule 3 or 4 in
   * this server run (rule 5). Absent: nothing is remembered.
   */
  remembered?: (p: ProcEntry) => boolean;
}

export interface AttributedProcess extends ProcEntry {
  why: ProcessAttribution;
  cwd?: string;
  /**
   * Taken by rule 3 or 4 through the Steward's own groups (kernel facts, no orphan on the way):
   * what the caller remembers while the Steward's CLI runs (rule 5).
   */
  anchored?: true;
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

/**
 * Terminal multiplexer servers: what the user attaches to later. Compared lower-case, without a
 * trailing colon (Linux tmux renames itself `tmux: server`; the screen server runs as `SCREEN`).
 */
export const MULTIPLEXERS: ReadonlySet<string> = new Set([
  'tmux',
  'screen',
  'zellij',
  'dtach',
  'abduco',
]);

/** A macOS application bundle: the executable, or an argument, lies inside `<name>.app/Contents/`. */
const APP_BUNDLE = /\.app\/Contents\//;

/**
 * A user-facing app (S2 of the second P4-14 review): a GUI application from a macOS `.app` bundle
 * (`code .` → Electron, its helpers, a terminal emulator) or a terminal multiplexer server. Even
 * when the Steward started it, what the user later does in it (other folders, integrated
 * terminals, extension hosts, new panes) inherits its marker — so the orphan rules (5 and 6)
 * never take one, nor anything below it. Matching an argument as well errs on the safe side.
 */
export function isUserFacingApp(p: Pick<ProcEntry, 'command'>): boolean {
  if (APP_BUNDLE.test(p.command)) return true;
  return MULTIPLEXERS.has(executable(p.command).replace(/:$/, '').toLowerCase());
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

/**
 * Internal verdicts. `orphan-descendant`: below an orphan of the Steward's, marked at every step
 * (reported as `descendant`); `user-app`: a user-facing app on an orphan path, or below one —
 * never the Steward's, nor anything below it.
 */
type Verdict =
  ProcessAttribution | 'orphan-descendant' | 'user-app' | 'reaper' | 'server' | 'other' | 'foreign';
const MINE: ReadonlySet<Verdict> = new Set([
  'group',
  'descendant',
  'orphan-descendant',
  'worktree',
  'remembered',
]);
/** Verdicts reached through an orphan: below them, rule 5 or the marker is required. */
const ORPHAN_PATH: ReadonlySet<Verdict> = new Set(['worktree', 'orphan-descendant', 'remembered']);

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
  const { agentId, procs, groups, self, sessions, worktree } = input;
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const server = serverTree(procs, self.pid);
  const remembered = (p: ProcEntry) => input.remembered?.(p) === true;
  const inSession = (p: ProcEntry) =>
    sessions.some(
      (s) => p.startedAt >= s.start - START_SLACK_MS && p.startedAt <= s.end + START_SLACK_MS,
    );
  // A server that is itself pid 1 (a container) reaps orphans: its children are its own, never
  // orphans of the Steward's — the orphan rules are then off, which is the safe side.
  const parentIsReaper = (p: ProcEntry) => {
    if (server.has(p.ppid)) return false;
    const parent = byPid.get(p.ppid);
    return p.ppid <= 1 || (parent !== undefined && isReaper(parent));
  };
  const ours = (p: ProcEntry) => p.uid === self.uid && !p.zombie;
  const orphan = (p: ProcEntry) =>
    ours(p) &&
    !isReaper(p) &&
    !server.has(p.pid) &&
    groupOwner(p, groups) === undefined &&
    parentIsReaper(p) &&
    !isUserFacingApp(p);

  // Rule 6 needs working directories and markers: only of orphans of ours that started in one of
  // the Steward's sessions. Rule 5's remembered orphans need neither, but what is below an orphan
  // of either kind needs its marker (or to be remembered itself).
  const worktreeCandidates = new Set(
    worktree !== undefined && sessions.length > 0
      ? procs.filter((p) => orphan(p) && inSession(p)).map((p) => p.pid)
      : [],
  );
  const roots = new Set([
    ...worktreeCandidates,
    ...procs.filter((p) => orphan(p) && remembered(p)).map((p) => p.pid),
  ]);
  const below = new Map<number, boolean>();
  const underRoot = (p: ProcEntry, depth = 0): boolean => {
    const known = below.get(p.pid);
    if (known !== undefined) return known;
    let v: boolean;
    if (roots.has(p.pid)) v = true;
    else if (
      depth > 256 ||
      isReaper(p) ||
      server.has(p.pid) ||
      groupOwner(p, groups) !== undefined ||
      parentIsReaper(p) ||
      isUserFacingApp(p)
    ) {
      v = false;
    } else {
      const parent = byPid.get(p.ppid);
      v = parent !== undefined && underRoot(parent, depth + 1);
    }
    below.set(p.pid, v);
    return v;
  };
  let cwds = new Map<number, string>();
  let markers = new Map<number, string>();
  if (roots.size > 0) {
    const markerPids = procs
      .filter((p) => ours(p) && underRoot(p) && !remembered(p))
      .map((p) => p.pid);
    [cwds, markers] = await Promise.all([
      worktreeCandidates.size > 0
        ? input.cwdOf([...worktreeCandidates])
        : new Map<number, string>(),
      markerPids.length > 0 ? input.markerOf(markerPids) : new Map<number, string>(),
    ]);
  }
  const marked = (p: ProcEntry) => markers.get(p.pid) === agentId;

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
        if (isUserFacingApp(p)) v = 'user-app';
        else if (remembered(p)) v = 'remembered';
        else
          v =
            worktree !== undefined &&
            worktreeCandidates.has(p.pid) &&
            cwd !== undefined &&
            isInside(cwd, worktree) &&
            marked(p)
              ? 'worktree'
              : 'foreign';
      } else {
        const parent = byPid.get(p.ppid);
        // A parent gone from the snapshot (it exited between the two reads) decides nothing.
        if (!parent || depth > 256) v = 'foreign';
        else {
          const up = verdict(parent, depth + 1);
          if (up === 'user-app') v = 'user-app';
          else if (ORPHAN_PATH.has(up)) {
            // Below an orphan: never a user-facing app; else remembered, or marked at every step.
            if (isUserFacingApp(p)) v = 'user-app';
            else if (remembered(p)) v = 'remembered';
            else v = marked(p) ? 'orphan-descendant' : 'foreign';
          } else v = MINE.has(up) ? 'descendant' : 'foreign';
        }
      }
    }
    memo.set(p.pid, v);
    return v;
  };

  const out: AttributedProcess[] = [];
  for (const p of procs) {
    if (!ours(p) || input.exclude?.has(p.pid)) continue;
    const v = verdict(p);
    if (!MINE.has(v)) continue;
    const why = (v === 'orphan-descendant' ? 'descendant' : v) as ProcessAttribution;
    const cwd = cwds.get(p.pid);
    out.push({
      ...p,
      why,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(v === 'group' || v === 'descendant' ? { anchored: true as const } : {}),
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}

/**
 * What a live Steward's CLI is using right now: its direct children — the MCP servers it launched,
 * the shell of a tool command (running, or a background one) — and every attributed descendant of
 * them. Stopped only when named one by one (TECHNOLOGY §2.2 "Process cleanup").
 */
export function heldBy(attributed: readonly AttributedProcess[], cliPid: number): Set<number> {
  const direct = attributed.filter((p) => p.ppid === cliPid).map((p) => p.pid);
  return new Set(withDescendants(attributed, direct).map((p) => p.pid));
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
