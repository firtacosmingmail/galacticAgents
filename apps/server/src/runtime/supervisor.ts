import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { uptime } from 'node:os';
import { basename } from 'node:path';
import type { Actor, Id } from '@galactic/protocol';
import { MemoryProcessStore, type ProcessRecord, type ProcessStore } from './process-store.js';

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
 * children (shells, dev servers, watchers) with it (corner case 4).
 *
 * The supervisor reports what only it can know as `ProcessOutcome`s (a crash, a start failure,
 * a completed stop, a clean exit, a restart) through the spec's `onOutcome` hook — never as
 * `agent.*` events: the adapter that owns the session is the one emitter for it (P1-20) and
 * decides the verdict, so a process exit and the runtime's own final message can never race
 * each other into the log. Hard caps (P1-02) sit on top of this class.
 *
 * Children get a small allow-listed environment (P1-24; TECHNOLOGY §8): the server's own
 * variables — its token, any API keys — are not theirs unless the spec passes them explicitly.
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
  /** Identity check for `reconcile()`; defaults to `ps`. Tests inject one. */
  processName?: (pid: number) => string | undefined;
}

const SYSTEM: Actor = { type: 'system' };
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
  private resolveExit!: (info: ExitInfo) => void;
  private turnWaiters: (() => void)[] = [];
  /** Bumped by `turnEnded()`; a stop compares it to the value it saw when it started. */
  private turnsEnded = 0;
  private exitExpected = false;

  constructor(
    readonly agentId: Id,
    readonly spec: ProcessSpec,
    child: ChildProcess,
    startedAt: string,
  ) {
    this.child = child;
    this.pid = child.pid ?? -1;
    this.startedAt = startedAt;
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  /** A restart replaces the child; the lifetime `exited` promise stays. */
  replaceChild(child: ChildProcess, startedAt: string): void {
    this.child = child;
    this.pid = child.pid ?? -1;
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

/** The executable name of a live process, via `ps` (macOS and Linux). */
export function processName(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? undefined : basename(out.split(/\s+/)[0]!);
  } catch {
    return undefined;
  }
}

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
  private readonly nameOf: (pid: number) => string | undefined;
  private readonly bootAt = bootTime();
  private disposed = false;

  constructor(opts: SupervisorOptions = {}) {
    this.store = opts.store ?? new MemoryProcessStore();
    this.now = opts.now ?? (() => new Date().toISOString());
    this.graceMs = opts.defaults?.graceMs ?? 10_000;
    this.termMs = opts.defaults?.termMs ?? 5_000;
    this.onError = opts.onError ?? (() => {});
    this.onOutcome = opts.onOutcome ?? (() => {});
    this.inherited = [...INHERITED_ENV, ...(opts.inheritEnv ?? [])];
    this.nameOf = opts.processName ?? processName;
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
    const managed = this.adopt(spec);
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
   * failure surfaces as a `start_failed` outcome and settles `exited`.
   */
  adopt(spec: ProcessSpec): ManagedProcess {
    if (this.disposed) throw new Error('supervisor disposed');
    const existing = this.procs.get(spec.agentId);
    if (existing && existing.state !== 'exited') {
      throw new Error(`agent ${spec.agentId} already has a running process (pid ${existing.pid})`);
    }
    const child = this.launch(spec);
    const managed = new Managed(spec.agentId, spec, child, this.now());
    this.procs.set(spec.agentId, managed);
    this.record(managed, 'running');
    this.watch(managed, child);
    return managed;
  }

  private launch(spec: ProcessSpec): ChildProcess {
    return spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: this.childEnv(spec),
      // Own process group (setsid): the group kill takes the agent's own children along.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  private watch(managed: Managed, child: ChildProcess): void {
    const { spec } = managed;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.safely(spec, () => spec.onStdout?.(chunk)));
    child.stderr?.on('data', (chunk: string) => this.safely(spec, () => spec.onStderr?.(chunk)));
    child.stdin?.on('error', () => {}); // EPIPE after the child died is not an error for us
    let started = false;
    child.once('spawn', () => {
      started = true;
      if (child.pid !== undefined) {
        managed.pid = child.pid;
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
      void withTimeout(closed, DRAIN_MS).then(() =>
        this.onExit(managed, child, { code, signal, at: this.now() }),
      );
    });
  }

  private safely(spec: ProcessSpec, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.onError(error, spec.agentId);
    }
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
      const child = this.launch(managed.spec);
      managed.replaceChild(child, this.now());
      this.record(managed, 'running');
      this.watch(managed, child);
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

    // 1. Ask the runtime to end the turn. The waiter is registered first so a hook that reports
    //    the turn end synchronously is not missed.
    const turnOrExit = Promise.race([managed.waitTurnEnd(managed.turnMark), managed.exited]);
    try {
      if (managed.spec.interrupt) await managed.spec.interrupt(managed);
      else managed.signal('SIGINT');
    } catch (error) {
      this.onError(error, agentId);
    }
    // 2. Wait for the turn to end (or the process to exit) within the grace period.
    const turnEnded = await withTimeout(turnOrExit, graceMs);
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
   * still runs the recorded command — pids are recycled, and killing a stranger is worse than
   * leaving an orphan.
   */
  reconcile(): ReconcileResult {
    const result: ReconcileResult = { dead: [], orphans: [] };
    for (const row of this.store.running()) {
      if (this.procs.has(row.agentId)) continue; // ours, this life
      if (row.pid !== undefined && this.isOurs(row)) {
        signalGroup(row.pid, 'SIGKILL');
        result.orphans.push(row.agentId);
      } else {
        result.dead.push(row.agentId);
      }
      this.store.upsert({ ...row, status: 'interrupted', endedAt: this.now() });
    }
    return result;
  }

  private isOurs(row: ProcessRecord): boolean {
    const pid = row.pid!;
    if (!isAlive(pid)) return false;
    const rowBoot = row.meta?.['bootAt'];
    if (
      typeof rowBoot === 'string' &&
      Math.abs(Date.parse(rowBoot) - Date.parse(this.bootAt)) > 60_000
    ) {
      return false; // recorded in a previous boot: the pid cannot be the same process
    }
    const command = row.meta?.['command'];
    if (typeof command !== 'string') return false;
    const live = this.nameOf(pid);
    const name = basename(command);
    // Linux truncates `comm` to 15 characters.
    return live !== undefined && (live === name || (live.length >= 15 && name.startsWith(live)));
  }

  /** The persisted row for an agent (running, exited or interrupted). */
  processRecord(agentId: Id): ProcessRecord | undefined {
    return this.store.get(agentId);
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
      meta: { ...(managed.spec.meta ?? {}), command: managed.spec.command, bootAt: this.bootAt },
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
      this.onError(error, managed.agentId);
    }
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
