import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { uptime } from 'node:os';
import { basename } from 'node:path';
import { STORAGE_ERROR, type Actor, type Id } from '@galactic/protocol';
import { storageConditionOf } from '../db/database.js';
import {
  carriesLaunch,
  LAUNCH_ID_ENV,
  launchCandidates,
  matchLaunch,
  type LaunchTake,
} from './launch-intents.js';
import {
  AGENT_ID_ENV,
  START_SLACK_MS,
  type AgentGroup,
  type ProcEntry,
  type Session,
} from './process-attribution.js';
import {
  MemoryProcessStore,
  type LaunchIntent,
  type ProcessRecord,
  type ProcessStore,
} from './process-store.js';
import { osProcessTable, type ProcessTable } from './process-table.js';

/**
 * The process supervisor (P1-01; TECHNOLOGY §2.2, §5.4; IMPLEMENTATION_PLAN corner cases 1, 3,
 * 4, 8b). It owns every agent child process: spawns it in its own process group, captures its
 * stdio, notices when it dies, keeps the persisted PID table current and runs the one graceful
 * stop sequence every adapter uses:
 *
 *   interrupt (runtime hook; SIGINT to the group by default)
 *     → wait for the turn to end, at most `graceMs`
 *     → SIGTERM to the group, at most `termMs`
 *     → SIGKILL to the group.
 *
 * SIGTERM is never the first signal (corner case 8b). Killing by group takes the agent's own
 * children that stayed in its group with it (corner case 4). Not all of them do: Claude Code runs
 * each Bash command in a process group of its own, so a tool command's shell (a
 * `run_in_background` one, a dev server it started) is outside the CLI's group — process
 * attribution (P4-14: `process-attribution.ts`, `steward-processes.ts`) finds and sweeps those.
 *
 * The supervisor reports what only it can know as `ProcessOutcome`s (a crash, a start failure,
 * a completed stop, a clean exit, a restart) through the spec's `onOutcome` hook — never as
 * `agent.*` events: the adapter that owns the session is the one emitter for it (P1-20) and
 * decides the verdict, so a process exit and the runtime's own final message can never race
 * each other into the log. Hard caps (P1-02) sit on top of this class.
 *
 * Children get a small allow-listed environment (P1-24; TECHNOLOGY §8): the server's own
 * variables — its token, any API keys — are not theirs unless the spec passes them explicitly.
 *
 * Every fork is preceded by a durable launch intent (P8-11, `launch()`): a server killed between
 * the fork and the PID table's row leaves the intent, and the next start's `reconcileLaunches()`
 * finds that launch's processes by the launch id in their environment.
 */

export type RestartPolicy =
  { mode: 'off' } | { mode: 'on-crash'; maxRestarts: number; backoffMs: number };

/** What the supervisor learned about a process; the adapter turns it into an `agent.*` event. */
export type ProcessOutcome =
  /** The command never started (ENOENT, EACCES, bad cwd). */
  | { kind: 'start_failed'; agentId: Id; error: string }
  /** Unrequested exit with a non-zero code or a signal. */
  | { kind: 'crashed'; agentId: Id; exit: ExitInfo }
  /** Unrequested clean exit (code 0), or an exit the runtime announced with `expectExit()`. */
  | { kind: 'exited'; agentId: Id; exit: ExitInfo }
  /** A stop sequence completed. */
  | { kind: 'stopped'; agentId: Id; exit: ExitInfo; by: Actor }
  /** The restart policy is respawning after a crash. */
  | { kind: 'restarting'; agentId: Id; exit: ExitInfo; attempt: number; maxRestarts: number };

/**
 * Variables a child inherits from the server. Enough for a CLI to find its binaries, its home
 * (Claude Code's login lives there), its locale and any proxy; nothing that authenticates the
 * server itself. Extend per spec with `env`, or per supervisor with `inheritEnv`.
 */
export const INHERITED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'CLAUDE_CONFIG_DIR',
  // Windows
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
];

export interface ProcessSpec {
  agentId: Id;
  command: string;
  args?: string[];
  /** Per-agent working directory: the Steward's worktree, or the project workspace for brains. */
  cwd: string;
  /** Added to the allow-listed inheritance; `undefined` removes an inherited variable. */
  env?: Record<string, string | undefined>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** What happened to the process, for the adapter to report. */
  onOutcome?: (outcome: ProcessOutcome) => void;
  /** Off by default: a crashed agent is reported, not silently respawned. */
  restart?: RestartPolicy;
  /**
   * Runtime-specific "end the current turn" for the graceful stop (the SDK's `interrupt()`, a
   * Ctrl-C on a PTY). Default: SIGINT to the process group. May call `turnEnded()` at once when
   * there is no turn to end.
   */
  interrupt?: (proc: ManagedProcess) => void | Promise<void>;
  /** Anything the adapter wants persisted next to the pid. */
  meta?: Record<string, unknown>;
  /**
   * Forks the child instead of `child_process.spawn` (P8-08: the PTY adapter starts its CLI under
   * a pseudo-terminal). Gets the command, its args, the cwd and the full environment the
   * supervisor built (allow-list, agent marker, launch id), and must return at once with a
   * `ChildProcess` stand-in: `pid` set, the child the leader of its own process group, `stdin`
   * (`write`, `end`, `on('error')`), `stdout` (`setEncoding`, `on('data')`), `stderr` (may be
   * `null`), and the events `spawn` (after returning), `exit(code, signal)` then `close`. A fork
   * that cannot start throws. Everything else — launch intent, PID table, stop sequence, group
   * reaping — is the supervisor's as for any child.
   */
  fork?: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) => ChildProcess;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
}

export type ProcessState = 'running' | 'stopping' | 'exited';

export interface ManagedProcess {
  readonly agentId: Id;
  readonly pid: number;
  readonly startedAt: string;
  readonly spec: ProcessSpec;
  readonly child: ChildProcess;
  readonly state: ProcessState;
  readonly exit: ExitInfo | undefined;
  /** How many times the restart policy respawned this agent. */
  readonly restarts: number;
  /**
   * Resolves once the agent's process is gone for good: after the last exit, when no restart
   * follows. One promise for the lifetime of the agent, restarts included.
   */
  readonly exited: Promise<ExitInfo>;
  /** Writes to the child's stdin. */
  write(data: string): void;
  /**
   * The runtime reports the current turn ended (or that there is none); unblocks step 2 of a
   * graceful stop, whether it is already waiting or about to.
   */
  turnEnded(): void;
  /**
   * The runtime is about to end this process itself (the SDK closing stdin, a clean shutdown):
   * the coming exit is not a crash and gets no `agent.failed`.
   */
  expectExit(): void;
  /** Sends a signal to the whole process group. */
  signal(sig: NodeJS.Signals): void;
}

export interface StopProcessOptions {
  /** Step 2 timeout: how long the turn may take to end after `interrupt`. */
  graceMs?: number;
  /** Step 3 timeout: how long after SIGTERM before SIGKILL. */
  termMs?: number;
  /** Who asked; carried on the `stopped` outcome. */
  by?: Actor;
}

export interface ReconcileResult {
  /** Rows that were `running` but whose process is gone (or whose pid now belongs to someone else): marked `interrupted`. */
  dead: Id[];
  /** Rows whose process still ran without a supervisor: killed by group, marked `interrupted`. */
  orphans: Id[];
}

/** What `reconcileLaunches()` did with the launch intents an earlier server run left (P8-11). */
export interface LaunchReconcileResult {
  /** Agents whose launch reached the PID table after all (`reconcile()` handled the row). */
  completed: Id[];
  /** Launches whose processes were found and stopped: their groups and members. */
  taken: { agentId: Id; launchId: string; pgids: number[]; pids: number[]; forced: boolean }[];
  /** Launches with nothing left to stop (never forked, already gone, or another boot's). */
  none: Id[];
  /** Launches this platform cannot check (no process table): forgotten, nothing stopped. */
  unchecked: Id[];
}

export interface SupervisorOptions {
  store?: ProcessStore;
  now?: () => string;
  defaults?: { graceMs?: number; termMs?: number };
  /** Called when a stdio callback or the restart policy throws. */
  onError?: (error: unknown, agentId: Id) => void;
  /** Every outcome of every process, after the spec's own hook (logging, tests). */
  onOutcome?: (outcome: ProcessOutcome) => void;
  /** Extra variable names children inherit from the server, on top of `INHERITED_ENV`. */
  inheritEnv?: string[];
  /** Identity checks for `reconcile()`; defaults to `ps` and `kill(…, 0)`. Tests inject one. */
  probe?: Partial<ProcessProbe>;
  /** The process table `reconcileLaunches()` reads (P8-11); defaults to `osProcessTable()`. */
  table?: ProcessTable;
  /** This server run's id on its launch intents; a random UUID by default. */
  runId?: string;
  /**
   * Fault injection for the drills (P8-11): called right after the fork, before the PID table
   * holds the child. Never set in production.
   */
  testHooks?: { afterFork?: (info: { agentId: Id; pid: number; launchId: string }) => void };
}

/**
 * How `reconcile()` looks at a process it did not start in this life. Each method answers
 * `undefined`/`false` when it cannot tell; the defaults work on macOS and Linux.
 */
export interface ProcessProbe {
  /** Whether a process with this pid exists (signal 0). */
  alive(pid: number): boolean;
  /** Whether a process group with this id still has members (signal 0 to `-pgid`). */
  groupAlive(pgid: number): boolean;
  /** Executable name (basename of the whole `ps -o comm=`). */
  name(pid: number): string | undefined;
  /** Start time in epoch ms (`ps -o lstart=`), `undefined` when unreadable. */
  startTime(pid: number): number | undefined;
  /** Signals the group `-pgid` only (`reconcileLaunches()`, P8-11); gone already is fine. */
  signalGroup(pgid: number, sig: NodeJS.Signals): void;
}

/** How far a row's `startedAt` may be from the process's own start time (`lstart` has 1 s resolution). */
export const START_TIME_TOLERANCE_MS = 5_000;

const SYSTEM: Actor = { type: 'system' };

/** A forked child and its launch intent (`pending`: still recorded, the PID table has no row yet). */
interface Launched {
  child: ChildProcess;
  launchId: string;
  pending: boolean;
}

/** How long after `exit` to wait for stdio to drain (`close`) before settling. */
const DRAIN_MS = 250;

class Managed implements ManagedProcess {
  state: ProcessState = 'running';
  exit: ExitInfo | undefined;
  restarts = 0;
  child: ChildProcess;
  pid: number;
  startedAt: string;
  readonly exited: Promise<ExitInfo>;
  /** Set while the restart policy is between exit and the new child. */
  restarting: Promise<void> | undefined;
  /** SIGTERM → SIGKILL delay for the group left behind when the leader exits (a stop's `termMs`). */
  reapMs: number | undefined;
  private resolveExit!: (info: ExitInfo) => void;
  private turnWaiters: (() => void)[] = [];
  /** Bumped by `turnEnded()`; a stop compares it to the value it saw when it started. */
  private turnsEnded = 0;
  private exitExpected = false;
  /** The current child's launch intent (P8-11), and whether it is still recorded as pending. */
  launchId: string;
  launchPending: boolean;

  constructor(
    readonly agentId: Id,
    readonly spec: ProcessSpec,
    launched: Launched,
    startedAt: string,
  ) {
    this.child = launched.child;
    this.pid = launched.child.pid ?? -1;
    this.launchId = launched.launchId;
    this.launchPending = launched.pending;
    this.startedAt = startedAt;
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  /** A restart replaces the child; the lifetime `exited` promise stays. */
  replaceChild(launched: Launched, startedAt: string): void {
    const { child } = launched;
    this.child = child;
    this.pid = child.pid ?? -1;
    this.launchId = launched.launchId;
    this.launchPending = launched.pending;
    this.startedAt = startedAt;
    this.exit = undefined;
    this.restarts++;
    this.exitExpected = false;
  }

  settleExit(info: ExitInfo): void {
    this.state = 'exited';
    this.exit = info;
    this.resolveExit(info);
  }

  write(data: string): void {
    this.child.stdin?.write(data);
  }

  turnEnded(): void {
    this.turnsEnded++;
    for (const w of this.turnWaiters.splice(0)) w();
  }

  /** Resolves on the next `turnEnded()` after `since`, or at once if one already happened. */
  waitTurnEnd(since: number): Promise<void> {
    if (this.turnsEnded > since) return Promise.resolve();
    return new Promise((resolve) => this.turnWaiters.push(resolve));
  }

  get turnMark(): number {
    return this.turnsEnded;
  }

  expectExit(): void {
    this.exitExpected = true;
  }

  get isExitExpected(): boolean {
    return this.exitExpected;
  }

  signal(sig: NodeJS.Signals): void {
    if (this.pid > 1) signalGroup(this.pid, sig);
  }
}

/** Sends `sig` to the whole process group; falls back to the pid alone if the group is gone. */
export function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  }
}

/** Whether a process with this pid exists and is ours to signal (signal 0). */
export function isAlive(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the process group `pgid` still has live members: signal 0 to the group, then — since
 * zombies answer signal 0 too and an orphan's zombie lingers until init reaps it (forever under
 * a container init that never does) — a `ps` look for a member that is not a zombie.
 */
export function isGroupAlive(pgid: number): boolean {
  if (pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    // EPERM: the group exists but is not ours to signal — it still has members.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pgid=,stat='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').some((line) => {
      const [group, stat] = line.trim().split(/\s+/);
      return Number(group) === pgid && stat !== undefined && !stat.startsWith('Z');
    });
  } catch {
    return true; // cannot tell: the signal said there are members
  }
}

/** Whether `pid` runs and is not a zombie (`ps -o stat=`); for checks after a kill. */
export function isRunning(pid: number): boolean {
  if (!isAlive(pid)) return false;
  const stat = ps('stat', pid);
  return stat === undefined ? isAlive(pid) : !stat.startsWith('Z');
}

function ps(field: string, pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // A fixed locale keeps `lstart` in the C format (`Wed Oct  1 10:00:00 2026`).
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * The executable name of a live process, via `ps` (macOS and Linux). macOS prints the full path
 * in `comm`, which may contain spaces, so the whole trimmed output is the path.
 */
export function processName(pid: number): string | undefined {
  const out = ps('comm', pid);
  return out === undefined ? undefined : commandName(out);
}

/** `ps -o comm=` output → executable name: the basename of the whole trimmed line. */
export function commandName(psComm: string): string {
  return basename(psComm.trim());
}

/** `ps -o lstart=` output (`Wed Oct  1 10:00:00 2026`, local time) → epoch ms. */
export function parseLstart(psLstart: string): number | undefined {
  const ms = Date.parse(psLstart.trim().replace(/\s+/g, ' '));
  return Number.isNaN(ms) ? undefined : ms;
}

/** When a live process started, in epoch ms (`ps -o lstart=`: local time, 1 s resolution). */
export function processStartTime(pid: number): number | undefined {
  const out = ps('lstart', pid);
  return out === undefined ? undefined : parseLstart(out);
}

export const DEFAULT_PROBE: ProcessProbe = {
  alive: isAlive,
  groupAlive: isGroupAlive,
  name: processName,
  startTime: processStartTime,
  signalGroup: (pgid, sig) => killGroup(pgid, sig),
};

/** When this machine booted (ISO); pids are only comparable within one boot. */
export function bootTime(): string {
  return new Date(Date.now() - uptime() * 1000).toISOString();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ProcessSupervisor {
  private readonly procs = new Map<Id, Managed>();
  private readonly store: ProcessStore;
  private readonly now: () => string;
  private readonly graceMs: number;
  private readonly termMs: number;
  private readonly onError: (error: unknown, agentId: Id) => void;
  private readonly onOutcome: (outcome: ProcessOutcome) => void;
  private readonly inherited: readonly string[];
  private readonly probe: ProcessProbe;
  private readonly table: ProcessTable;
  private readonly runId: string;
  private readonly testHooks: SupervisorOptions['testHooks'];
  private readonly bootAt = bootTime();
  /**
   * Every process group this supervisor started in this server run, per agent, in order (P4-14):
   * one per spawn, restart or resume, with the real clock's start and the end this run observed.
   * Never rows of an earlier run: a pgid from before this server started may name anything now.
   */
  private readonly runGroups = new Map<
    Id,
    { pgid: number; startedAt: number; endedAt?: number }[]
  >();
  /**
   * An agent's latest session from an earlier server run of this boot (its PID-table row), taken
   * before this run's first spawn of the agent overwrites the row (P4-14, N3). `undefined`: none.
   */
  private readonly earlierSessions = new Map<Id, Session | undefined>();
  private disposed = false;

  constructor(opts: SupervisorOptions = {}) {
    this.store = opts.store ?? new MemoryProcessStore();
    this.now = opts.now ?? (() => new Date().toISOString());
    this.graceMs = opts.defaults?.graceMs ?? 10_000;
    this.termMs = opts.defaults?.termMs ?? 5_000;
    this.onError = opts.onError ?? (() => {});
    this.onOutcome = opts.onOutcome ?? (() => {});
    this.inherited = [...INHERITED_ENV, ...(opts.inheritEnv ?? [])];
    this.probe = { ...DEFAULT_PROBE, ...(opts.probe ?? {}) };
    this.table = opts.table ?? osProcessTable();
    this.runId = opts.runId ?? randomUUID();
    this.testHooks = opts.testHooks;
  }

  /** The environment a child gets: the allow-listed inheritance plus the spec's own variables. */
  childEnv(spec: ProcessSpec): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.inherited) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    for (const [name, value] of Object.entries(spec.env ?? {})) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    // The agent marker (P4-14): every process the agent starts inherits it, so an orphan in a
    // Steward's worktree can be told from the user's own daemon there. Never overridable.
    env[AGENT_ID_ENV] = spec.agentId;
    return env;
  }

  private report(managed: Managed, outcome: ProcessOutcome): void {
    this.safely(managed.spec, () => managed.spec.onOutcome?.(outcome));
    this.safely(managed.spec, () => this.onOutcome(outcome));
  }

  get(agentId: Id): ManagedProcess | undefined {
    return this.procs.get(agentId);
  }

  list(): ManagedProcess[] {
    return [...this.procs.values()];
  }

  /** Live processes only. */
  get runningCount(): number {
    return this.list().filter((p) => p.state !== 'exited').length;
  }

  /**
   * Spawns the child in its own process group and resolves once it is running. A spawn failure
   * (command not found, bad cwd) rejects and reports a `start_failed` outcome.
   */
  async spawn(spec: ProcessSpec): Promise<ManagedProcess> {
    const managed = this.register(spec);
    const child = managed.child;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        child.removeListener('spawn', onSpawn);
        reject(new Error(`could not start ${spec.command}: ${error.message}`));
      };
      const onSpawn = () => {
        child.removeListener('error', onError);
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
    return managed;
  }

  /**
   * Synchronous spawn for callers that must hand the child over at once (the SDK's
   * `spawnClaudeCodeProcess` hook). The process is registered and watched immediately; a start
   * failure surfaces as a `start_failed` outcome and settles `exited`. No restart policy: the
   * caller holds the child it was handed, and a restart would replace it behind its back.
   */
  adopt(spec: ProcessSpec): ManagedProcess {
    if (spec.restart && spec.restart.mode !== 'off') {
      throw new Error(
        `adopt() does not support a restart policy (agent ${spec.agentId}): the caller owns the child it was handed`,
      );
    }
    return this.register(spec);
  }

  private register(spec: ProcessSpec): ManagedProcess {
    if (this.disposed) throw new Error('supervisor disposed');
    const existing = this.procs.get(spec.agentId);
    if (existing && existing.state !== 'exited') {
      throw new Error(`agent ${spec.agentId} already has a running process (pid ${existing.pid})`);
    }
    if (!this.earlierSessions.has(spec.agentId)) {
      this.earlierSessions.set(spec.agentId, this.storedSession(spec.agentId));
    }
    let launched: Launched;
    try {
      launched = this.launch(spec);
    } catch (error) {
      // Nothing was forked (the intent could not be written, or `spawn` threw): a start failure.
      const outcome: ProcessOutcome = {
        kind: 'start_failed',
        agentId: spec.agentId,
        error: error instanceof Error ? error.message : String(error),
      };
      this.safely(spec, () => spec.onOutcome?.(outcome));
      this.safely(spec, () => this.onOutcome(outcome));
      throw error;
    }
    const managed = new Managed(spec.agentId, spec, launched, this.now());
    this.procs.set(spec.agentId, managed);
    this.record(managed, 'running');
    this.watch(managed, launched.child);
    return managed;
  }

  /**
   * Forks the agent's CLI (P8-11). The launch intent is written FIRST, durably: a server killed
   * between the fork and the PID table's row leaves the intent, and the next start finds the
   * launch's processes by the launch id in their environment (`reconcileLaunches()`). When the
   * intent cannot be written (a full disk), nothing is forked: a process the server cannot record
   * could outlive it unseen. The caller writes the row, which removes the intent (`record`).
   * This is the one place every adapter's process goes through (`spawn`, `adopt`, restarts).
   */
  private launch(spec: ProcessSpec): Launched {
    const launchId = randomUUID();
    const intent: LaunchIntent = {
      id: launchId,
      agentId: spec.agentId,
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd,
      runId: this.runId,
      bootAt: this.bootAt,
      // The real clock, like `ps lstart`: the window the fork falls in.
      intendedAt: new Date().toISOString(),
      ...(spec.meta ? { meta: spec.meta } : {}),
    };
    try {
      this.store.addLaunch(intent);
    } catch (error) {
      const condition = storageConditionOf(error);
      if (condition) {
        // A storage refusal keeps its code (`isStorageFailure` holds), so a route answers it as
        // the standard refusal (507 `storage_full`: "The disk is full…"; SPEC decisions 104, 107).
        throw Object.assign(
          new Error(
            `could not start ${spec.command}: the launch could not be recorded. ${STORAGE_ERROR[condition].message}`,
            { cause: error },
          ),
          { code: (error as { code: string }).code },
        );
      }
      throw new Error(
        `could not start ${spec.command}: the launch could not be recorded (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
    let child: ChildProcess;
    try {
      const env = { ...this.childEnv(spec), [LAUNCH_ID_ENV]: launchId };
      child = spec.fork
        ? spec.fork(spec.command, spec.args ?? [], { cwd: spec.cwd, env })
        : spawn(spec.command, spec.args ?? [], {
            cwd: spec.cwd,
            env,
            // Own process group (setsid): the group kill takes the agent's children that stayed
            // in it along (not a tool command's shell in a group of its own: see the class comment).
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
    } catch (error) {
      this.forgetLaunch(launchId, spec.agentId);
      throw error;
    }
    if (child.pid === undefined) {
      // The fork failed (ENOENT, EACCES, bad cwd; `error` follows): no process to look for.
      return { child, launchId, pending: !this.forgetLaunch(launchId, spec.agentId) };
    }
    this.testHooks?.afterFork?.({ agentId: spec.agentId, pid: child.pid, launchId });
    return { child, launchId, pending: true };
  }

  /** Removes a launch intent; `false` (and an error reported) when the storage refused it. */
  private forgetLaunch(launchId: string, agentId: Id): boolean {
    try {
      this.store.removeLaunch(launchId);
      return true;
    } catch (error) {
      this.onError(error, agentId);
      return false;
    }
  }

  private watch(managed: Managed, child: ChildProcess): void {
    const { spec } = managed;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.safely(spec, () => spec.onStdout?.(chunk)));
    child.stderr?.on('data', (chunk: string) => this.safely(spec, () => spec.onStderr?.(chunk)));
    child.stdin?.on('error', () => {}); // EPIPE after the child died is not an error for us
    let started = false;
    // `spawn()` forks synchronously: the child started no later than now.
    const launchedAt = Date.now();
    child.once('spawn', () => {
      started = true;
      if (child.pid !== undefined) {
        managed.pid = child.pid;
        const groups = this.runGroups.get(spec.agentId) ?? [];
        groups.push({ pgid: child.pid, startedAt: launchedAt });
        this.runGroups.set(spec.agentId, groups);
        this.record(managed, 'running');
      }
    });
    child.once('error', (error) => {
      if (started) return this.onError(error, spec.agentId);
      // The process never started (ENOENT, EACCES, bad cwd): no `exit` will follow.
      if (managed.child !== child || managed.exit) return;
      const message = `could not start ${spec.command}: ${error.message}`;
      managed.settleExit({ code: null, signal: null, at: this.now() });
      this.record(managed, 'exited', managed.exit);
      this.procs.delete(spec.agentId);
      this.report(managed, { kind: 'start_failed', agentId: spec.agentId, error: message });
    });
    child.once('exit', (code, signal) => {
      // stdio may still drain after `exit`; wait for `close` briefly so output precedes the verdict.
      const closed = new Promise<void>((r) => child.once('close', () => r()));
      const at = this.now();
      // The same moment on the real clock (`now` may be injected): the group's lifetime ends at
      // the leader's exit, not after the drain and reap — a pgid recycled meanwhile is not its.
      const exitedAt = Date.now();
      const pgid = child.pid ?? -1;
      this.endRunGroup(spec.agentId, pgid, exitedAt);
      void withTimeout(closed, DRAIN_MS)
        .then(() => this.reapGroup(pgid, managed.reapMs ?? this.termMs))
        .catch((error: unknown) => this.onError(error, spec.agentId))
        .then(() => this.onExit(managed, child, { code, signal, at }));
    });
  }

  private safely(spec: ProcessSpec, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.onError(error, spec.agentId);
    }
  }

  /**
   * The leader is gone (clean exit, crash, external signal, completed stop) but its group may
   * still hold the agent's own children that stayed in it — a dev server, a watcher (corner case
   * 4). A Bash tool command's shell is not among them under Claude Code (its own group): process
   * attribution's sweep handles those (P4-14). SIGTERM the group (and SIGCONT, in case it was paused), then SIGKILL after `termMs`
   * if members remain. A group id is not reused while the group has members, so the signal
   * cannot reach a stranger. `exited` settles only afterwards.
   */
  private async reapGroup(pgid: number, termMs: number): Promise<void> {
    if (pgid <= 1 || !this.probe.groupAlive(pgid)) return;
    killGroup(pgid, 'SIGTERM');
    killGroup(pgid, 'SIGCONT');
    if (await until(() => !this.probe.groupAlive(pgid), termMs)) return;
    killGroup(pgid, 'SIGKILL');
    await until(() => !this.probe.groupAlive(pgid), 1_000);
  }

  private onExit(managed: Managed, child: ChildProcess, info: ExitInfo): void {
    if (managed.child !== child) return; // a restart already replaced it
    const stopping = managed.state === 'stopping';
    const requested = stopping || managed.isExitExpected;
    const crashed = !requested && (info.code !== 0 || info.signal !== null);
    const policy = managed.spec.restart ?? { mode: 'off' };

    if (crashed && policy.mode === 'on-crash' && managed.restarts < policy.maxRestarts) {
      this.record(managed, 'exited', info);
      this.report(managed, {
        kind: 'restarting',
        agentId: managed.agentId,
        exit: info,
        attempt: managed.restarts + 1,
        maxRestarts: policy.maxRestarts,
      });
      managed.restarting = sleep(policy.backoffMs).then(() => this.restart(managed, info));
      return;
    }

    managed.settleExit(info);
    this.record(managed, 'exited', info);
    if (crashed) this.report(managed, { kind: 'crashed', agentId: managed.agentId, exit: info });
    else if (!stopping)
      this.report(managed, { kind: 'exited', agentId: managed.agentId, exit: info });
    // A requested stop reports `stopped` from `stop()`, which knows who asked.
  }

  private async restart(managed: Managed, previous: ExitInfo): Promise<void> {
    try {
      if (this.disposed || managed.state === 'stopping') {
        managed.settleExit(previous);
        return;
      }
      // `launch` is synchronous, so no stop can slip in between the check above and the new child.
      const launched = this.launch(managed.spec);
      managed.replaceChild(launched, this.now());
      this.record(managed, 'running');
      this.watch(managed, launched.child);
    } catch (error) {
      this.onError(error, managed.agentId);
      managed.settleExit(previous);
    } finally {
      managed.restarting = undefined;
    }
  }

  /**
   * The graceful stop sequence. Resolves with the exit info once the process is gone. Stopping
   * an unknown or already exited agent resolves immediately.
   */
  async stop(agentId: Id, opts: StopProcessOptions = {}): Promise<ExitInfo | undefined> {
    const managed = this.procs.get(agentId);
    if (!managed) return undefined;
    if (managed.state === 'exited') return managed.exit;
    if (managed.state === 'stopping') return managed.exited;
    managed.state = 'stopping';
    if (managed.restarting) await managed.restarting; // lets the restart path see `stopping`
    if (managed.exit) return this.finishStop(managed, opts);
    const graceMs = opts.graceMs ?? this.graceMs;
    const termMs = opts.termMs ?? this.termMs;
    managed.reapMs = termMs;

    // 1. Ask the runtime to end the turn. The waiter is registered first so a hook that reports
    //    the turn end synchronously is not missed. The hook runs inside the grace window: one
    //    that never settles (a control request to a wedged CLI) must not keep SIGTERM away.
    const deadline = Date.now() + graceMs;
    const turnOrExit = Promise.race([managed.waitTurnEnd(managed.turnMark), managed.exited]);
    let hook: Promise<void>;
    try {
      hook = Promise.resolve(
        managed.spec.interrupt ? managed.spec.interrupt(managed) : managed.signal('SIGINT'),
      ).catch((error: unknown) => this.onError(error, agentId));
    } catch (error) {
      this.onError(error, agentId);
      hook = Promise.resolve();
    }
    await withTimeout(Promise.race([hook, turnOrExit]), graceMs);
    // 2. Wait for the turn to end (or the process to exit) within what is left of the grace.
    const turnEnded = await withTimeout(turnOrExit, Math.max(0, deadline - Date.now()));
    if (managed.exit) return this.finishStop(managed, opts);
    // The turn ended cleanly: the runtime may shut down on its own — give it a moment before
    // terminating, but only if it signalled the turn end.
    if (turnEnded) {
      const gone = await withTimeout(managed.exited, Math.min(termMs, 1_000));
      if (gone) return this.finishStop(managed, opts);
    }
    // 3. Terminate the group.
    managed.signal('SIGTERM');
    if (await withTimeout(managed.exited, termMs)) return this.finishStop(managed, opts);
    // 4. Kill the group.
    managed.signal('SIGKILL');
    await managed.exited;
    return this.finishStop(managed, opts);
  }

  private finishStop(managed: Managed, opts: StopProcessOptions): ExitInfo | undefined {
    this.report(managed, {
      kind: 'stopped',
      agentId: managed.agentId,
      exit: managed.exit!,
      by: opts.by ?? SYSTEM,
    });
    return managed.exit;
  }

  /** Immediate group kill (SIGKILL). For emergencies and tests; `stop()` is the normal path. */
  async kill(agentId: Id): Promise<ExitInfo | undefined> {
    const managed = this.procs.get(agentId);
    if (!managed || managed.state === 'exited') return managed?.exit;
    managed.state = 'stopping';
    if (managed.restarting) await managed.restarting;
    managed.signal('SIGKILL');
    return managed.exited;
  }

  /**
   * Startup reconciliation (corner cases 3 and 4). Every `running` row belongs to a previous
   * server life: nothing can re-attach to a live process, so a still-running orphan is killed
   * by group and both kinds are marked `interrupted` for the resume path to respawn from their
   * session refs. A pid is only trusted when the row comes from this boot and the live process
   * still runs the recorded command with the recorded start time — pids are recycled, and
   * killing a stranger is worse than leaving an orphan. When the leader is dead but its group
   * still has members (children that stayed in the CLI's group), the group is killed too. A
   * Bash tool command's shell runs in a group of its own under Claude Code and is not reached
   * here (P4-14's attribution looks for it, with the marker). A launch whose row was never
   * written is `reconcileLaunches()`'s (P8-11).
   */
  reconcile(): ReconcileResult {
    const result: ReconcileResult = { dead: [], orphans: [] };
    for (const row of this.store.running()) {
      if (this.procs.has(row.agentId)) continue; // ours, this life
      if (row.pid !== undefined && this.isOurs(row)) {
        signalGroup(row.pid, 'SIGKILL');
        result.orphans.push(row.agentId);
      } else if (row.pid !== undefined && this.isOurLeftoverGroup(row)) {
        // The CLI is gone but its group lives on (shells, dev servers): kill the group.
        killGroup(row.pid, 'SIGKILL');
        result.orphans.push(row.agentId);
      } else {
        result.dead.push(row.agentId);
      }
      this.store.upsert({ ...row, status: 'interrupted', endedAt: this.now() });
    }
    return result;
  }

  /**
   * Startup, after `reconcile()` and before this run spawns anything (P8-11; SPEC decision 76):
   * the launch intents an earlier server run left. An intent whose PID-table row exists completed
   * (`reconcile()` took the row). Any other is a launch the killed server may have forked without
   * recording: its processes are found by the launch id and agent marker in their environment, the
   * launch window and the worktree (`launch-intents.ts`), and their process groups are stopped —
   * SIGTERM (and SIGCONT), then SIGKILL after `termMs` — with the safety rules of process
   * attribution: never a process whose environment cannot be read, never a user-facing app or
   * anything below one, never another user's, never the server's own. Each launch is then
   * recorded as an interrupted session of its agent (so the Steward's sweep can find what escaped
   * its group) and the intent is forgotten. Intents of another boot are simply forgotten.
   */
  async reconcileLaunches(opts: { termMs?: number } = {}): Promise<LaunchReconcileResult> {
    const result: LaunchReconcileResult = { completed: [], taken: [], none: [], unchecked: [] };
    let intents: LaunchIntent[];
    try {
      intents = this.store.launches().filter((i) => i.runId !== this.runId);
    } catch (error) {
      this.onError(error, 'launch intents');
      return result;
    }
    const open: LaunchIntent[] = [];
    for (const intent of intents) {
      if (this.otherBoot(intent.bootAt)) {
        result.none.push(intent.agentId);
        this.forgetLaunch(intent.id, intent.agentId);
      } else if (this.store.get(intent.agentId)?.meta?.['launchId'] === intent.id) {
        result.completed.push(intent.agentId);
        this.forgetLaunch(intent.id, intent.agentId);
      } else {
        open.push(intent);
      }
    }
    if (open.length === 0) return result;

    const procs = await this.table.list();
    if (procs === undefined) {
      for (const intent of open) {
        result.unchecked.push(intent.agentId);
        this.closeLaunch(intent);
      }
      return result;
    }
    const self = { pid: process.pid, uid: process.getuid?.() ?? -1 };
    const candidates = new Map<number, ProcEntry>();
    for (const intent of open) {
      for (const p of launchCandidates(intent, procs, self)) candidates.set(p.pid, p);
    }
    const envOf =
      candidates.size > 0 && this.table.environment
        ? await this.table.environment([...candidates.values()], [AGENT_ID_ENV, LAUNCH_ID_ENV])
        : new Map<number, Map<string, string>>();
    const marked = [...candidates.values()]
      .filter((p) => open.some((intent) => carriesLaunch(p, intent, envOf)))
      .map((p) => p.pid);
    const cwdOf = marked.length > 0 ? await this.table.cwds(marked) : new Map<number, string>();
    const excludeGroups = new Set(this.agentGroups().map((g) => g.pgid));
    const takes = open.flatMap((intent) =>
      matchLaunch({ intent, procs, self, envOf, cwdOf, excludeGroups }),
    );

    // Graceful, then forced — each group re-checked right before its first signal.
    const signalled: LaunchTake[] = [];
    for (const take of takes) {
      if (this.disposed || !this.stillTheLaunch(take)) continue;
      this.probe.signalGroup(take.pgid, 'SIGTERM');
      this.probe.signalGroup(take.pgid, 'SIGCONT');
      signalled.push(take);
    }
    const termMs = opts.termMs ?? this.termMs;
    const gone = (t: LaunchTake) => !this.probe.groupAlive(t.pgid);
    if (signalled.length > 0) await until(() => signalled.every(gone), termMs);
    const forced = new Set<number>();
    for (const take of signalled) {
      if (gone(take) || this.disposed) continue;
      this.probe.signalGroup(take.pgid, 'SIGKILL');
      forced.add(take.pgid);
    }
    if (forced.size > 0) await until(() => signalled.every(gone), 1_000);

    for (const intent of open) {
      const mine = signalled.filter((t) => t.intentId === intent.id);
      if (mine.length > 0) {
        result.taken.push({
          agentId: intent.agentId,
          launchId: intent.id,
          pgids: mine.map((t) => t.pgid),
          pids: mine.flatMap((t) => t.members.map((p) => p.pid)).sort((a, b) => a - b),
          forced: mine.some((t) => forced.has(t.pgid)),
        });
      } else {
        result.none.push(intent.agentId);
      }
      this.closeLaunch(intent, mine.find((t) => t.leader)?.leader?.pid);
    }
    return result;
  }

  /** The group is still what the snapshot showed: the same leader, or still leaderless. */
  private stillTheLaunch(take: LaunchTake): boolean {
    if (take.leader) {
      if (!this.probe.alive(take.leader.pid)) return false;
      const started = this.probe.startTime(take.leader.pid);
      // Fail closed: a start time that cannot be read again is not the same process.
      return started !== undefined && Math.abs(started - take.leader.startedAt) <= START_SLACK_MS;
    }
    return !this.probe.alive(take.pgid) && this.probe.groupAlive(take.pgid);
  }

  /**
   * Records the launch as an interrupted session of its agent — unless the PID table already
   * holds a newer one — so process attribution's session window covers it, then forgets the
   * intent.
   */
  private closeLaunch(intent: LaunchIntent, pid?: number): void {
    try {
      const row = this.store.get(intent.agentId);
      const newer =
        row !== undefined &&
        (row.status === 'running' || Date.parse(row.startedAt) > Date.parse(intent.intendedAt));
      if (!newer) {
        this.store.upsert({
          agentId: intent.agentId,
          ...(pid !== undefined ? { pid } : {}),
          startedAt: intent.intendedAt,
          endedAt: new Date().toISOString(),
          status: 'interrupted',
          meta: {
            ...(intent.meta ?? {}),
            command: intent.command,
            bootAt: intent.bootAt,
            launchId: intent.id,
            fromLaunchIntent: true,
          },
        });
      }
    } catch (error) {
      this.onError(error, intent.agentId);
    }
    this.forgetLaunch(intent.id, intent.agentId);
  }

  /** Recorded in a previous boot: the pid cannot be the same process. */
  private fromOtherBoot(row: ProcessRecord): boolean {
    return this.otherBoot(row.meta?.['bootAt']);
  }

  private otherBoot(bootAt: unknown): boolean {
    return (
      typeof bootAt === 'string' && Math.abs(Date.parse(bootAt) - Date.parse(this.bootAt)) > 60_000
    );
  }

  /**
   * The live process behind `row.pid` is the one we started: same boot, same command name and,
   * when `ps` can tell, the same start time — a recycled pid that now belongs to the user's own
   * interactive `claude` has the right name but another start time. When the start time cannot
   * be read, name + boot decide as before.
   */
  private isOurs(row: ProcessRecord): boolean {
    const pid = row.pid!;
    if (!this.probe.alive(pid)) return false;
    if (this.fromOtherBoot(row)) return false;
    const command = row.meta?.['command'];
    if (typeof command !== 'string') return false;
    const live = this.probe.name(pid);
    const name = basename(command);
    // Linux truncates `comm` to 15 characters.
    const sameName =
      live !== undefined && (live === name || (live.length >= 15 && name.startsWith(live)));
    if (!sameName) return false;
    const started = this.probe.startTime(pid);
    const recorded = Date.parse(row.startedAt);
    if (started === undefined || Number.isNaN(recorded)) return true;
    return Math.abs(started - recorded) <= START_TIME_TOLERANCE_MS;
  }

  /**
   * The leader is dead but a group with its id still has members. A pid is not handed out
   * again while a group of that id exists, so within the same boot (the identity check that
   * still applies without a leader to look at) the group is the one our CLI created.
   */
  private isOurLeftoverGroup(row: ProcessRecord): boolean {
    const pid = row.pid!;
    if (pid <= 1 || this.probe.alive(pid)) return false;
    if (typeof row.meta?.['bootAt'] !== 'string' || this.fromOtherBoot(row)) return false;
    return this.probe.groupAlive(pid);
  }

  /** The persisted row for an agent (running, exited or interrupted). */
  processRecord(agentId: Id): ProcessRecord | undefined {
    return this.store.get(agentId);
  }

  /** The leader exited at `at` (real clock, epoch ms): the group's lifetime ends there (N2). */
  private endRunGroup(agentId: Id, pgid: number, at: number): void {
    const group = this.runGroups
      .get(agentId)
      ?.find((g) => g.pgid === pgid && g.endedAt === undefined);
    if (group) group.endedAt = at;
  }

  /**
   * The process groups agents got in THIS server run (P4-14): the anchors of process attribution
   * (rule 3). Every spawn, restart and resume, with the leader's lifetime as this run saw it, so a
   * member that started after the group ended (a recycled pgid) is not taken for one of its own.
   * Rows of the PID table from an earlier run are never used: the server was not watching during
   * the downtime, so their pgids may since name the user's processes (and their end is only the
   * time of `reconcile()`).
   */
  agentGroups(): AgentGroup[] {
    const groups: AgentGroup[] = [];
    for (const [agentId, list] of this.runGroups) {
      for (const g of list) {
        groups.push({
          agentId,
          pgid: g.pgid,
          startedAt: g.startedAt,
          ...(g.endedAt !== undefined ? { endedAt: g.endedAt } : {}),
        });
      }
    }
    return groups;
  }

  /**
   * An agent's sessions (P4-14: the time windows of attribution's worktree rule): the PID table's
   * latest row from an earlier run of this boot, from its start to the end recorded for it (its
   * exit, or `reconcile()`'s time for an interrupted one, an upper bound) — kept after this run
   * resumes the agent (N3), since that spawn overwrites the row — and every spawn, restart and
   * resume of this run to its end (now while it runs). The rule also requires the agent's
   * environment marker, so the wider earlier window cannot take the user's processes; it lets a
   * sweep still find the escaped processes of a Steward from before a restart.
   */
  agentSessions(agentId: Id): Session[] {
    const now = Date.now();
    const run = this.runGroups.get(agentId) ?? [];
    const earlier = this.earlierSessions.has(agentId)
      ? this.earlierSessions.get(agentId)
      : this.storedSession(agentId);
    return [
      ...(earlier ? [earlier] : []),
      ...run.map((g) => ({ start: g.startedAt, end: g.endedAt ?? now })),
    ];
  }

  /** The PID table's row as a session of an earlier run of this boot, if it is one. */
  private storedSession(agentId: Id): Session | undefined {
    const row = this.store.get(agentId);
    if (!row || row.status === 'running') return undefined;
    if (typeof row.meta?.['bootAt'] !== 'string' || this.fromOtherBoot(row)) return undefined;
    const start = Date.parse(row.startedAt);
    const end = row.endedAt ? Date.parse(row.endedAt) : NaN;
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
    return { start, end };
  }

  /** The pid of the agent's CLI while it runs in this server run (P4-14: its helpers are held). */
  livePid(agentId: Id): number | undefined {
    const managed = this.procs.get(agentId);
    return managed && managed.state !== 'exited' && managed.pid > 1 ? managed.pid : undefined;
  }

  /**
   * Resolves once the agent's process is gone and its group reaped (P4-14: the safety-net sweep
   * waits for the supervisor's own clean-up first); `undefined` when nothing of it runs here.
   */
  whenExited(agentId: Id): Promise<unknown> | undefined {
    const managed = this.procs.get(agentId);
    return managed && managed.state !== 'exited' ? managed.exited : undefined;
  }

  /** Stops every live process (graceful). */
  async dispose(opts: StopProcessOptions = {}): Promise<void> {
    this.disposed = true;
    await Promise.all(this.list().map((p) => this.stop(p.agentId, opts)));
  }

  private record(managed: Managed, status: ProcessRecord['status'], exit?: ExitInfo): void {
    const rec: ProcessRecord = {
      agentId: managed.agentId,
      startedAt: managed.startedAt,
      status,
      meta: {
        ...(managed.spec.meta ?? {}),
        command: managed.spec.command,
        bootAt: this.bootAt,
        // The launch this row completes (P8-11): its intent is then no longer needed.
        launchId: managed.launchId,
      },
    };
    if (managed.pid > 0) rec.pid = managed.pid;
    if (exit) {
      rec.endedAt = exit.at;
      if (exit.code !== null) rec.exitCode = exit.code;
      if (exit.signal !== null) rec.signal = exit.signal;
    }
    try {
      this.store.upsert(rec);
    } catch (error) {
      // The intent stays (P8-11): after a kill the next start still finds this launch.
      this.onError(error, managed.agentId);
      return;
    }
    if (managed.launchPending && rec.pid !== undefined) {
      managed.launchPending = !this.forgetLaunch(managed.launchId, managed.agentId);
    }
  }
}

/** Signals the group `-pgid` only — never the pid alone: the leader is gone and its pid may be reused. */
function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // already gone
  }
}

/** Polls `check` until it holds (`true`) or `ms` passes (`false`). */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= end) return false;
    await sleep(Math.min(25, Math.max(1, end - Date.now())));
  }
}

/** Resolves `true` when `p` settles within `ms`, `false` on timeout. */
function withTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  return Promise.race([p.then(() => true), timeout]).finally(() => clearTimeout(timer));
}
