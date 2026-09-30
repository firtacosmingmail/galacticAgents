import { spawn, type ChildProcess } from 'node:child_process';
import type { Actor, AgentEvent, Id } from '@galactic/protocol';
import { EventQueue } from './event-queue.js';
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
 * The supervisor speaks the normalised event vocabulary for what only it can know: a crash is
 * `agent.failed(reason: crash)`, a spawn error `agent.failed(reason: runtime)`, a completed stop
 * `agent.stopped`. A clean exit (code 0) is the adapter's to interpret (`agent.finished`), so it
 * emits nothing. Hard caps (P1-02) sit on top of this class.
 */

export type RestartPolicy =
  { mode: 'off' } | { mode: 'on-crash'; maxRestarts: number; backoffMs: number };

export interface ProcessSpec {
  agentId: Id;
  command: string;
  args?: string[];
  /** Per-agent working directory: the Steward's worktree, or the project workspace for brains. */
  cwd: string;
  env?: Record<string, string | undefined>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Off by default: a crashed agent is reported, not silently respawned. */
  restart?: RestartPolicy;
  /**
   * Runtime-specific "end the current turn" for the graceful stop (the SDK's `interrupt()`, a
   * Ctrl-C on a PTY). Default: SIGINT to the process group.
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
  /** Resolves when the process has exited (also after a restart: it is the latest process). */
  readonly exited: Promise<ExitInfo>;
  /** Writes to the child's stdin. */
  write(data: string): void;
  /** The runtime reports the current turn ended; unblocks step 2 of a running graceful stop. */
  turnEnded(): void;
  /** Sends a signal to the whole process group. */
  signal(sig: NodeJS.Signals): void;
}

export interface StopProcessOptions {
  /** Step 2 timeout: how long the turn may take to end after `interrupt`. */
  graceMs?: number;
  /** Step 3 timeout: how long after SIGTERM before SIGKILL. */
  termMs?: number;
  by?: Actor;
  /**
   * Emit nothing: the caller (caps, adapter) reports the outcome itself. The default emits
   * `agent.stopped`.
   */
  silent?: boolean;
}

export interface ReconcileResult {
  /** Rows that were `running` but whose process is gone: marked `interrupted`. */
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
}

const SYSTEM: Actor = { type: 'system' };

class Managed implements ManagedProcess {
  state: ProcessState = 'running';
  exit: ExitInfo | undefined;
  restarts = 0;
  child: ChildProcess;
  pid: number;
  startedAt: string;
  exited: Promise<ExitInfo>;
  private resolveExit!: (info: ExitInfo) => void;
  /** Resolved by `turnEnded()`; replaced when a stop sequence starts waiting. */
  private turnWaiters: (() => void)[] = [];

  constructor(
    readonly agentId: Id,
    readonly spec: ProcessSpec,
    child: ChildProcess,
    startedAt: string,
  ) {
    this.child = child;
    this.pid = child.pid!;
    this.startedAt = startedAt;
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  /** A restart replaces the child; the exit promise starts over. */
  replaceChild(child: ChildProcess, startedAt: string): void {
    this.child = child;
    this.pid = child.pid!;
    this.startedAt = startedAt;
    this.state = 'running';
    this.exit = undefined;
    this.restarts++;
    this.exited = new Promise((r) => (this.resolveExit = r));
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
    const waiters = this.turnWaiters.splice(0);
    for (const w of waiters) w();
  }

  /** Resolves on `turnEnded()`; the caller races it against exit and the timeout. */
  waitTurnEnd(): Promise<void> {
    return new Promise((resolve) => this.turnWaiters.push(resolve));
  }

  signal(sig: NodeJS.Signals): void {
    signalGroup(this.pid, sig);
  }
}

/** Sends `sig` to the whole process group; falls back to the pid alone if the group is gone. */
export function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
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

/** Whether a process with this pid exists (signal 0). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ProcessSupervisor {
  readonly events = new EventQueue<AgentEvent>();
  private readonly procs = new Map<Id, Managed>();
  private readonly store: ProcessStore;
  private readonly now: () => string;
  private readonly graceMs: number;
  private readonly termMs: number;
  private readonly onError: (error: unknown, agentId: Id) => void;
  private disposed = false;

  constructor(opts: SupervisorOptions = {}) {
    this.store = opts.store ?? new MemoryProcessStore();
    this.now = opts.now ?? (() => new Date().toISOString());
    this.graceMs = opts.defaults?.graceMs ?? 10_000;
    this.termMs = opts.defaults?.termMs ?? 5_000;
    this.onError = opts.onError ?? (() => {});
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
   * (command not found, bad cwd) rejects and emits `agent.failed(reason: runtime)`.
   */
  async spawn(spec: ProcessSpec): Promise<ManagedProcess> {
    if (this.disposed) throw new Error('supervisor disposed');
    const existing = this.procs.get(spec.agentId);
    if (existing && existing.state !== 'exited') {
      throw new Error(`agent ${spec.agentId} already has a running process (pid ${existing.pid})`);
    }
    const child = await this.launch(spec);
    const managed = new Managed(spec.agentId, spec, child, this.now());
    this.procs.set(spec.agentId, managed);
    this.record(managed, 'running');
    this.watch(managed, child);
    return managed;
  }

  private launch(spec: ProcessSpec): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        // Own process group (setsid): the group kill takes the agent's own children along.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const onError = (error: Error) => {
        child.removeListener('spawn', onSpawn);
        const message = `could not start ${spec.command}: ${error.message}`;
        this.events.push({
          type: 'agent.failed',
          agentId: spec.agentId,
          error: message,
          reason: 'runtime',
        });
        reject(new Error(message));
      };
      const onSpawn = () => {
        child.removeListener('error', onError);
        resolve(child);
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }

  private watch(managed: Managed, child: ChildProcess): void {
    const { spec } = managed;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.safely(spec, () => spec.onStdout?.(chunk)));
    child.stderr?.on('data', (chunk: string) => this.safely(spec, () => spec.onStderr?.(chunk)));
    child.stdin?.on('error', () => {}); // EPIPE after the child died is not an error for us
    child.once('error', (error) => this.onError(error, spec.agentId));
    child.once('exit', (code, signal) => {
      // `exit` fires when the process ends; stdio may still drain, which the callbacks handle.
      this.onExit(managed, child, { code, signal, at: this.now() });
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
    const requested = managed.state === 'stopping';
    const crashed = !requested && (info.code !== 0 || info.signal !== null);
    const policy = managed.spec.restart ?? { mode: 'off' };

    if (crashed && policy.mode === 'on-crash' && managed.restarts < policy.maxRestarts) {
      this.record(managed, 'exited', info);
      this.events.push({
        type: 'agent.progress',
        agentId: managed.agentId,
        summary: `restarting after crash (${describeExit(info)}), attempt ${managed.restarts + 1}/${policy.maxRestarts}`,
      });
      void sleep(policy.backoffMs).then(() => this.restart(managed, info));
      return;
    }

    managed.settleExit(info);
    this.record(managed, 'exited', info);
    if (crashed) {
      this.events.push({
        type: 'agent.failed',
        agentId: managed.agentId,
        error: `process ${describeExit(info)}`,
        reason: 'crash',
      });
    }
    // A requested stop emits `agent.stopped` from `stop()`, which knows who asked.
  }

  private async restart(managed: Managed, previous: ExitInfo): Promise<void> {
    if (this.disposed || managed.state === 'stopping') {
      managed.settleExit(previous);
      return;
    }
    try {
      const child = await this.launch(managed.spec);
      managed.replaceChild(child, this.now());
      this.record(managed, 'running');
      this.watch(managed, child);
    } catch (error) {
      this.onError(error, managed.agentId);
      managed.settleExit(previous);
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
    const graceMs = opts.graceMs ?? this.graceMs;
    const termMs = opts.termMs ?? this.termMs;

    // 1. Ask the runtime to end the turn.
    try {
      if (managed.spec.interrupt) await managed.spec.interrupt(managed);
      else managed.signal('SIGINT');
    } catch (error) {
      this.onError(error, agentId);
    }
    // 2. Wait for the turn to end (or the process to exit) within the grace period.
    const turnOrExit = Promise.race([managed.waitTurnEnd(), managed.exited]);
    const turnEnded = await withTimeout(turnOrExit, graceMs);
    if (managed.exit) return this.finishStop(managed, opts);
    // The turn ended cleanly (or never will): the runtime may shut down on its own — give it a
    // moment before terminating, but only if it signalled the turn end.
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
    if (!opts.silent) {
      this.events.push({ type: 'agent.stopped', agentId: managed.agentId, by: opts.by ?? SYSTEM });
    }
    return managed.exit;
  }

  /** Immediate group kill (SIGKILL). For emergencies and tests; `stop()` is the normal path. */
  async kill(agentId: Id): Promise<ExitInfo | undefined> {
    const managed = this.procs.get(agentId);
    if (!managed || managed.state === 'exited') return managed?.exit;
    managed.state = 'stopping';
    managed.signal('SIGKILL');
    return managed.exited;
  }

  /**
   * Startup reconciliation (corner cases 3 and 4). Every `running` row belongs to a previous
   * server life: nothing can re-attach to a live process, so a still-running orphan is killed
   * by group and both kinds are marked `interrupted` for the resume path to respawn from their
   * session refs.
   */
  reconcile(): ReconcileResult {
    const result: ReconcileResult = { dead: [], orphans: [] };
    for (const row of this.store.running()) {
      if (this.procs.has(row.agentId)) continue; // ours, this life
      if (row.pid !== undefined && isAlive(row.pid)) {
        signalGroup(row.pid, 'SIGKILL');
        result.orphans.push(row.agentId);
      } else {
        result.dead.push(row.agentId);
      }
      this.store.upsert({ ...row, status: 'interrupted', endedAt: this.now() });
    }
    return result;
  }

  /** The persisted row for an agent (running, exited or interrupted). */
  processRecord(agentId: Id): ProcessRecord | undefined {
    return this.store.get(agentId);
  }

  /** Stops every live process (graceful, silent unless `by` is given) and closes the stream. */
  async dispose(opts: StopProcessOptions = { silent: true }): Promise<void> {
    this.disposed = true;
    await Promise.all(this.list().map((p) => this.stop(p.agentId, opts)));
    this.events.close();
  }

  private record(managed: Managed, status: ProcessRecord['status'], exit?: ExitInfo): void {
    const rec: ProcessRecord = {
      agentId: managed.agentId,
      pid: managed.pid,
      startedAt: managed.startedAt,
      status,
    };
    if (exit) {
      rec.endedAt = exit.at;
      if (exit.code !== null) rec.exitCode = exit.code;
      if (exit.signal !== null) rec.signal = exit.signal;
    }
    if (managed.spec.meta) rec.meta = managed.spec.meta;
    try {
      this.store.upsert(rec);
    } catch (error) {
      this.onError(error, managed.agentId);
    }
  }
}

function describeExit(info: ExitInfo): string {
  return info.signal ? `killed by ${info.signal}` : `exited with code ${info.code}`;
}

/** Resolves `true` when `p` settles within `ms`, `false` on timeout. */
function withTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  return Promise.race([p.then(() => true), timeout]).finally(() => clearTimeout(timer));
}
