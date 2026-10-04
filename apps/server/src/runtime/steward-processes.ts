import { realpathSync } from 'node:fs';
import {
  ENDED_STATES,
  type Actor,
  type Agent,
  type Event,
  type Id,
  type StewardProcess,
  type StewardProcessesResponse,
  type StopProcessesResponse,
} from '@galactic/protocol';
import { DomainError } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import { WORKTREES_DIR } from '../workspace/workspaces.js';
import {
  attribute,
  withDescendants,
  worktreeRootOf,
  type AgentGroup,
  type AttributedProcess,
  type ProcEntry,
} from './process-attribution.js';
import { osProcessTable, type ProcessTable } from './process-table.js';
import { redactSecrets } from './redact.js';
import type { StatusStore } from './status-store.js';

/**
 * A Steward's processes (P4-14; SPEC decision pending; TECHNOLOGY §2.2 "Process cleanup"): what the
 * Waykeeper's (and the Harmonizer's) `list_steward_processes` / `stop_steward_processes` tools and
 * the panel's Steward view read and stop, and the server's safety-net sweep.
 *
 *   list(agentId)          the processes attribution gives the Steward (`process-attribution.ts`),
 *                          with working directory and listening ports; its own CLI is left out
 *                          while the Steward runs (stopping that is `stop_agent`'s job)
 *   stop(agentId, {pids})  SIGTERM (and SIGCONT, should one be frozen), up to `termMs`, then SIGKILL
 *                          to what is left. Every pid must be attributable to the Steward now —
 *                          otherwise nothing is signalled and the call is refused; the attributed
 *                          descendants of the chosen pids go too. Each signal goes to one pid whose
 *                          identity (pid + start time) was just re-read, never to a group: a
 *                          recycled pid is never hit. Logs `agent.processes_stopped`.
 *   sweep                  when a Steward ends (finished, failed, stopped) — after the supervisor
 *                          reaped its group — and when its task is closed (completed, failed,
 *                          archived) for every ended Steward of the task, everything still
 *                          attributable is stopped. An idle Steward that still runs is never swept:
 *                          its dev server may be intentional; its supervisor decides.
 */

export interface StewardProcessControl {
  list(agentId: Id): Promise<StewardProcessesResponse>;
  stop(agentId: Id, opts: { pids?: number[]; by: Actor }): Promise<StopProcessesResponse>;
}

/** Where the process groups come from: the supervisor (`ProcessSupervisor` fits). */
export interface GroupSource {
  agentGroups(): AgentGroup[];
  /** Resolves once the agent's process exited and its group was reaped. */
  whenExited?(agentId: Id): Promise<unknown> | undefined;
}

export interface StewardProcessesOptions {
  log: EventLog;
  statuses: StatusStore;
  /** The supervisor; without one only the worktree rule finds anything. */
  groups?: GroupSource;
  /** Default: `osProcessTable()`. */
  table?: ProcessTable;
  /** The server itself (default: this process and its user). */
  self?: { pid: number; uid: number };
  /** SIGTERM → SIGKILL delay. Default 3 s. */
  termMs?: number;
  /** How long a sweep waits for the supervisor's own reaping first. Default 15 s. */
  settleMs?: number;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

const SYSTEM: Actor = { type: 'system' };
const TERMINAL = new Set<Event['type']>(['agent.finished', 'agent.failed', 'agent.stopped']);
const ENDINGS = ['agent.finished', 'agent.failed', 'agent.stopped', 'agent.interrupted'] as const;
/** Task states after which nothing of the task should run. */
const CLOSED_TASK = new Set(['completed', 'failed', 'archived']);
/** A command line as the model, the panel and the log see it. */
const COMMAND_CHARS = 200;

const clipCommand = (command: string) => {
  const text = redactSecrets(command);
  return text.length > COMMAND_CHARS ? `${text.slice(0, COMMAND_CHARS - 1)}…` : text;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export class StewardProcesses implements StewardProcessControl {
  private readonly table: ProcessTable;
  private readonly self: { pid: number; uid: number };
  private readonly termMs: number;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown, context: string) => void;
  /** One stop or sweep at a time per Steward. */
  private readonly busy = new Map<Id, Promise<unknown>>();
  /** Sweeps scheduled from the log and not settled yet. */
  private readonly pending = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly opts: StewardProcessesOptions) {
    this.table = opts.table ?? osProcessTable();
    this.self = opts.self ?? { pid: process.pid, uid: process.getuid?.() ?? -1 };
    this.termMs = opts.termMs ?? 3_000;
    this.settleMs = opts.settleMs ?? 15_000;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => {});
  }

  /** The Steward, or a refusal. */
  private steward(agentId: Id): Agent {
    const agent = this.opts.log.tables.agents.get(agentId);
    if (!agent) throw new DomainError('not_found', `no agent ${agentId}`);
    if (agent.role !== 'steward') {
      throw new DomainError('invalid', `agent ${agentId} is a ${agent.role}, not a Steward`);
    }
    return agent;
  }

  private isLive(agentId: Id): boolean {
    const status = this.opts.statuses.get(agentId);
    return status !== undefined && !ENDED_STATES.has(status.state);
  }

  /** The Steward's session: from its creation to its last end (or now while it runs). */
  private windowOf(agent: Agent): { start: number; end: number } {
    const start = Date.parse(agent.createdAt);
    if (this.isLive(agent.id)) return { start, end: this.now() };
    const ends = ENDINGS.flatMap((type) => this.opts.log.latestOf(type, agent.id, 1)).map((e) =>
      Date.parse(e.at),
    );
    return { start, end: ends.length > 0 ? Math.max(...ends) : this.now() };
  }

  /** The task worktree the Steward works in, or `undefined` (a serialised project's workspace). */
  private worktreeOf(agent: Agent): string | undefined {
    const cwd = (agent.meta as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd !== 'string') return undefined;
    const root = worktreeRootOf(cwd, WORKTREES_DIR);
    return root === undefined ? undefined : realpathOr(root);
  }

  /** What attribution gives the Steward now; `undefined` when the table cannot be read. */
  private async attributed(
    agent: Agent,
  ): Promise<{ procs: ProcEntry[]; mine: AttributedProcess[] } | undefined> {
    const procs = await this.table.list();
    if (!procs) return undefined;
    const groups = this.opts.groups?.agentGroups() ?? [];
    // Its own CLI while it runs: stopping the Steward is `stop_agent`, not a cleanup.
    const own = groups.find((g) => g.agentId === agent.id);
    const exclude = new Set<number>(
      own && this.isLive(agent.id) && own.endedAt === undefined ? [own.pgid] : [],
    );
    const worktree = this.worktreeOf(agent);
    const mine = await attribute({
      agentId: agent.id,
      procs,
      groups,
      self: this.self,
      window: this.windowOf(agent),
      ...(worktree ? { worktree } : {}),
      cwdOf: (pids) => this.table.cwds(pids),
      exclude,
    });
    return { procs, mine };
  }

  async list(agentId: Id): Promise<StewardProcessesResponse> {
    const agent = this.steward(agentId);
    const found = await this.attributed(agent);
    if (!found) return { agentId, supported: false, processes: [] };
    const pids = found.mine.map((p) => p.pid);
    const missing = found.mine.filter((p) => p.cwd === undefined).map((p) => p.pid);
    const [cwds, ports] = await Promise.all([this.table.cwds(missing), this.table.ports(pids)]);
    const processes: StewardProcess[] = found.mine.map((p) => {
      const cwd = p.cwd ?? cwds.get(p.pid);
      return {
        pid: p.pid,
        ppid: p.ppid,
        command: clipCommand(p.command),
        ...(cwd !== undefined ? { cwd } : {}),
        ports: ports.get(p.pid) ?? [],
        startedAt: new Date(p.startedAt).toISOString(),
        why: p.why,
      };
    });
    return { agentId, supported: true, processes };
  }

  async stop(
    agentId: Id,
    opts: { pids?: number[]; by: Actor; sweep?: 'agent_ended' | 'task_closed' },
  ): Promise<StopProcessesResponse> {
    const agent = this.steward(agentId);
    return this.serial(agentId, () => this.stopNow(agent, opts));
  }

  private async serial<T>(agentId: Id, fn: () => Promise<T>): Promise<T> {
    const before = this.busy.get(agentId) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(fn);
    this.busy.set(agentId, next);
    try {
      return await next;
    } finally {
      if (this.busy.get(agentId) === next) this.busy.delete(agentId);
    }
  }

  private async stopNow(
    agent: Agent,
    opts: { pids?: number[]; by: Actor; sweep?: 'agent_ended' | 'task_closed' },
  ): Promise<StopProcessesResponse> {
    const agentId = agent.id;
    const empty: StopProcessesResponse = { agentId, stopped: [], forced: [], alive: [] };
    const found = await this.attributed(agent);
    if (!found) {
      if (opts.pids?.length) {
        throw new DomainError('invalid', 'processes cannot be inspected on this platform');
      }
      return empty;
    }
    const byPid = new Map(found.mine.map((p) => [p.pid, p]));
    if (opts.pids) {
      const foreign = opts.pids.filter((pid) => !byPid.has(pid));
      if (foreign.length > 0) {
        throw new DomainError(
          'invalid',
          `not processes of Steward ${agentId} (or no longer running): ${foreign.join(', ')}; ` +
            'list them again with list_steward_processes',
        );
      }
    }
    const targets = opts.pids ? withDescendants(found.mine, opts.pids) : found.mine;
    if (targets.length === 0) return empty;

    for (const p of targets) {
      this.table.kill(p.pid, 'SIGTERM');
      this.table.kill(p.pid, 'SIGCONT');
    }
    let alive = await this.waitGone(targets, this.termMs);
    const forced: number[] = [];
    if (alive.length > 0) {
      for (const p of alive) if (this.table.kill(p.pid, 'SIGKILL')) forced.push(p.pid);
      alive = await this.waitGone(alive, 2_000);
    }
    const left = new Set(alive.map((p) => p.pid));
    const stopped = targets.filter((p) => !left.has(p.pid));
    const result: StopProcessesResponse = {
      agentId,
      stopped: stopped.map((p) => p.pid),
      forced: forced.filter((pid) => !left.has(pid)),
      alive: alive.map((p) => p.pid),
    };
    if (stopped.length > 0 && !this.disposed) {
      try {
        this.opts.log.runCommand(({ emit }) =>
          emit({
            type: 'agent.processes_stopped',
            agentId,
            pids: result.stopped,
            commands: stopped.map((p) => clipCommand(p.command)),
            ...(result.forced.length > 0 ? { forced: result.forced } : {}),
            by: opts.by,
            ...(opts.sweep ? { sweep: opts.sweep } : {}),
          }),
        );
      } catch (error) {
        this.onError(error, `log processes stopped ${agentId}`);
      }
    }
    return result;
  }

  /**
   * Polls the table until none of `procs` runs any more, at most `ms`; returns the ones still
   * running — the same pid with the same start time (a recycled pid is someone else: gone).
   */
  private async waitGone(procs: readonly ProcEntry[], ms: number): Promise<ProcEntry[]> {
    const end = Date.now() + ms;
    for (;;) {
      const table = await this.table.list();
      const now = new Map((table ?? []).map((p) => [p.pid, p]));
      const running = procs.filter((p) => {
        const q = now.get(p.pid);
        return q !== undefined && !q.zombie && q.startedAt === p.startedAt;
      });
      if (running.length === 0 || Date.now() >= end) return running;
      await sleep(Math.min(100, Math.max(1, end - Date.now())));
    }
  }

  /**
   * The safety net for one Steward: waits for the supervisor's own reaping of its group, then
   * stops whatever is still attributable. Never for a Steward that is running again (a resumed or
   * sent-back session): its processes are its own business while it lives.
   */
  async sweep(
    agentId: Id,
    why: 'agent_ended' | 'task_closed',
  ): Promise<StopProcessesResponse | undefined> {
    if (this.disposed) return undefined;
    const exited = this.opts.groups?.whenExited?.(agentId);
    if (exited) {
      await Promise.race([exited.catch(() => undefined), sleep(this.settleMs)]);
    }
    if (this.disposed || this.isLive(agentId)) return undefined;
    try {
      return await this.stop(agentId, { by: SYSTEM, sweep: why });
    } catch (error) {
      this.onError(error, `sweep processes of ${agentId}`);
      return undefined;
    }
  }

  /** Sweeps in flight (tests wait for them). */
  idle(): Promise<void> {
    return Promise.allSettled([...this.busy.values(), ...this.pending]).then(() => undefined);
  }

  private schedule(agentId: Id, why: 'agent_ended' | 'task_closed'): void {
    const p: Promise<unknown> = new Promise((r) => setImmediate(r))
      .then(() => this.sweep(agentId, why))
      .catch((error: unknown) => this.onError(error, `sweep ${agentId}`))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Subscribes the sweeps to the log. Returns the unsubscribe function. */
  watch(): () => void {
    const { log } = this.opts;
    this.unsubscribe?.();
    const unsubscribe = log.subscribe(({ event }) => {
      if (this.disposed) return;
      if (TERMINAL.has(event.type) && 'agentId' in event) {
        if (log.tables.agents.get(event.agentId)?.role === 'steward') {
          this.schedule(event.agentId, 'agent_ended');
        }
        return;
      }
      if (event.type === 'task.state_changed' && CLOSED_TASK.has(event.to)) {
        for (const agent of log.tables.agents.all()) {
          if (agent.role === 'steward' && agent.taskId === event.taskId && !this.isLive(agent.id)) {
            this.schedule(agent.id, 'task_closed');
          }
        }
      }
    });
    this.unsubscribe = unsubscribe;
    return unsubscribe;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
