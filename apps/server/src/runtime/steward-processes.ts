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
  heldBy,
  withDescendants,
  worktreeRootOf,
  type AgentGroup,
  type AttributedProcess,
  type ProcEntry,
  type Session,
} from './process-attribution.js';
import { osProcessTable, type ProcessTable } from './process-table.js';
import { redactSecrets } from './redact.js';
import type { StatusStore } from './status-store.js';

/**
 * A Steward's processes (P4-14; SPEC decision 76; TECHNOLOGY §2.2 "Process cleanup"): what the
 * Waykeeper's (and the Harmonizer's) `list_steward_processes` / `stop_steward_processes` tools and
 * the panel's Steward view read and stop, and the server's safety-net sweep.
 *
 *   list(agentId)          the processes attribution gives the Steward (`process-attribution.ts`),
 *                          with working directory and listening ports; its own CLI is left out
 *                          while the Steward runs (stopping that is `stop_agent`'s job), and what
 *                          the running CLI uses — its direct children (MCP servers, the shell of
 *                          a tool command) and their descendants — is marked `held`
 *   stop(agentId, {pids})  SIGTERM (and SIGCONT, should one be frozen), up to `termMs`, then SIGKILL
 *                          to what is left. Every pid must be attributable to the Steward now —
 *                          otherwise nothing is signalled and the call is refused; the attributed
 *                          descendants of the chosen pids go too, except held ones not named
 *                          themselves (or under a named held one). Without pids ("stop all"): only
 *                          for a Steward that ended — a running one's stop must name its pids.
 *                          Right before SIGTERM the table is read again and a pid whose start time
 *                          or parent changed is left alone (`skipped`); a pid that started in the
 *                          same second as the attribution snapshot (where `lstart`'s one-second
 *                          resolution cannot tell it from a recycled pid) is re-attributed after
 *                          that second, and skipped if still that young. Each signal goes to one
 *                          pid, never to a group. Logs `agent.processes_stopped`.
 *   sweep                  when a Steward ends (finished, failed, stopped) — after the supervisor
 *                          reaped its group — and when its task is closed (completed, failed,
 *                          archived) for every ended Steward of the task, everything still
 *                          attributable is stopped. An idle Steward that still runs is never swept:
 *                          its dev server may be intentional; its supervisor decides. The
 *                          liveness check is repeated right before the signals (a resume races).
 */

export interface StewardProcessControl {
  list(agentId: Id): Promise<StewardProcessesResponse>;
  /** Several Stewards from one `ps` snapshot. */
  listMany(agentIds: readonly Id[]): Promise<StewardProcessesResponse[]>;
  stop(agentId: Id, opts: { pids?: number[]; by: Actor }): Promise<StopProcessesResponse>;
}

/** Where the process groups and sessions come from: the supervisor (`ProcessSupervisor` fits). */
export interface GroupSource {
  /** The groups the supervisor started in this server run. */
  agentGroups(): AgentGroup[];
  /** The agent's sessions (spawn or resume → end). Absent or empty: the orphan rule is off. */
  agentSessions?(agentId: Id): Session[];
  /** The agent's CLI pid while it runs. */
  livePid?(agentId: Id): number | undefined;
  /** Resolves once the agent's process exited and its group was reaped. */
  whenExited?(agentId: Id): Promise<unknown> | undefined;
}

export interface StewardProcessesOptions {
  log: EventLog;
  statuses: StatusStore;
  /** The supervisor; without one nothing is attributed (no groups, no sessions). */
  groups?: GroupSource;
  /** Default: `osProcessTable()`. */
  table?: ProcessTable;
  /** The server itself (default: this process and its user). */
  self?: { pid: number; uid: number };
  /** SIGTERM → SIGKILL delay. Default 3 s. */
  termMs?: number;
  /** How long a sweep waits for the supervisor's own reaping first. Default 15 s. */
  settleMs?: number;
  onError?: (error: unknown, context: string) => void;
}

const SYSTEM: Actor = { type: 'system' };
const TERMINAL = new Set<Event['type']>(['agent.finished', 'agent.failed', 'agent.stopped']);
/** Task states after which nothing of the task should run. */
const CLOSED_TASK = new Set(['completed', 'failed', 'archived']);
/** A command line as the model, the panel and the log see it. */
const COMMAND_CHARS = 200;
/** `ps lstart` resolution. */
const SECOND = 1_000;

const clipCommand = (command: string) => {
  const text = redactSecrets(command);
  return text.length > COMMAND_CHARS ? `${text.slice(0, COMMAND_CHARS - 1)}…` : text;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const floorSecond = (ms: number) => Math.floor(ms / SECOND) * SECOND;

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** One `ps` snapshot and when it was taken (just before `ps` ran). */
interface Snapshot {
  procs: ProcEntry[];
  takenAt: number;
}

interface Attributed {
  snapshot: Snapshot;
  mine: AttributedProcess[];
  /** What the running CLI uses (empty once the Steward ended). */
  held: Set<number>;
  live: boolean;
}

export class StewardProcesses implements StewardProcessControl {
  private readonly table: ProcessTable;
  private readonly self: { pid: number; uid: number };
  private readonly termMs: number;
  private readonly settleMs: number;
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

  /** The Steward's sessions, as the supervisor recorded them (none without one). */
  private sessionsOf(agent: Agent): Session[] {
    return this.opts.groups?.agentSessions?.(agent.id) ?? [];
  }

  /** The Steward's CLI while it runs here. */
  private cliOf(agent: Agent, groups: readonly AgentGroup[]): number | undefined {
    const source = this.opts.groups;
    if (source?.livePid) return source.livePid(agent.id);
    // A source without `livePid`: the agent's latest group that has not ended.
    const open = groups.filter((g) => g.agentId === agent.id && g.endedAt === undefined);
    return open.at(-1)?.pgid;
  }

  /** The task worktree the Steward works in, or `undefined` (a serialised project's workspace). */
  private worktreeOf(agent: Agent): string | undefined {
    const cwd = (agent.meta as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd !== 'string') return undefined;
    const root = worktreeRootOf(cwd, WORKTREES_DIR);
    return root === undefined ? undefined : realpathOr(root);
  }

  private async snapshot(): Promise<Snapshot | undefined> {
    const takenAt = Date.now();
    const procs = await this.table.list();
    return procs ? { procs, takenAt } : undefined;
  }

  /** What attribution gives the Steward in `snapshot` (a fresh one by default). */
  private async attributed(agent: Agent, given?: Snapshot): Promise<Attributed | undefined> {
    const snapshot = given ?? (await this.snapshot());
    if (!snapshot) return undefined;
    const groups = this.opts.groups?.agentGroups() ?? [];
    const live = this.isLive(agent.id);
    // Its own CLI while it runs: stopping the Steward is `stop_agent`, not a cleanup.
    const cli = live ? this.cliOf(agent, groups) : undefined;
    const worktree = this.worktreeOf(agent);
    const commandOf = new Map(snapshot.procs.map((p) => [p.pid, p.command]));
    const mine = await attribute({
      agentId: agent.id,
      procs: snapshot.procs,
      groups,
      self: this.self,
      sessions: this.sessionsOf(agent),
      ...(worktree ? { worktree } : {}),
      cwdOf: (pids) => this.table.cwds(pids),
      markerOf: (pids) =>
        this.table.markers?.(pids.map((pid) => ({ pid, command: commandOf.get(pid) ?? '' }))) ??
        new Map(),
      exclude: new Set(cli !== undefined ? [cli] : []),
    });
    const held = cli !== undefined ? heldBy(mine, cli) : new Set<number>();
    return { snapshot, mine, held, live };
  }

  private async describe(found: Attributed): Promise<StewardProcess[]> {
    const pids = found.mine.map((p) => p.pid);
    const missing = found.mine.filter((p) => p.cwd === undefined).map((p) => p.pid);
    const [cwds, ports] = await Promise.all([this.table.cwds(missing), this.table.ports(pids)]);
    return found.mine.map((p) => {
      const cwd = p.cwd ?? cwds.get(p.pid);
      return {
        pid: p.pid,
        ppid: p.ppid,
        command: clipCommand(p.command),
        ...(cwd !== undefined ? { cwd } : {}),
        ports: ports.get(p.pid) ?? [],
        startedAt: new Date(p.startedAt).toISOString(),
        why: p.why,
        ...(found.held.has(p.pid) ? { held: true as const } : {}),
      };
    });
  }

  async list(agentId: Id): Promise<StewardProcessesResponse> {
    return (await this.listMany([agentId]))[0]!;
  }

  async listMany(agentIds: readonly Id[]): Promise<StewardProcessesResponse[]> {
    const agents = agentIds.map((id) => this.steward(id));
    if (agents.length === 0) return [];
    const snapshot = await this.snapshot();
    if (!snapshot) return agents.map((a) => ({ agentId: a.id, supported: false, processes: [] }));
    const out: StewardProcessesResponse[] = [];
    for (const agent of agents) {
      const found = (await this.attributed(agent, snapshot))!;
      out.push({
        agentId: agent.id,
        supported: true,
        processes: await this.describe(found),
      });
    }
    return out;
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

  /**
   * The processes a stop takes from `found`: the named pids (each must be attributable unless
   * `lenient`) and their attributed descendants — a held process only when it, or a held ancestor
   * of it, was named. Without pids: everything not held.
   */
  private targets(
    agentId: Id,
    found: Attributed,
    pids: number[] | undefined,
    lenient: boolean,
  ): { targets: AttributedProcess[]; gone: number[] } {
    if (!pids) return { targets: found.mine.filter((p) => !found.held.has(p.pid)), gone: [] };
    const known = new Set(found.mine.map((p) => p.pid));
    const foreign = pids.filter((pid) => !known.has(pid));
    if (foreign.length > 0 && !lenient) {
      throw new DomainError(
        'invalid',
        `not processes of Steward ${agentId} (or no longer running): ${foreign.join(', ')}; ` +
          'list them again with list_steward_processes',
      );
    }
    const named = pids.filter((pid) => known.has(pid));
    const heldNamed = new Set(
      withDescendants(
        found.mine,
        named.filter((pid) => found.held.has(pid)),
      ).map((p) => p.pid),
    );
    const targets = withDescendants(found.mine, named).filter(
      (p) => !found.held.has(p.pid) || heldNamed.has(p.pid),
    );
    return { targets, gone: foreign };
  }

  private async stopNow(
    agent: Agent,
    opts: { pids?: number[]; by: Actor; sweep?: 'agent_ended' | 'task_closed' },
  ): Promise<StopProcessesResponse> {
    const agentId = agent.id;
    const empty: StopProcessesResponse = { agentId, stopped: [], forced: [], alive: [] };
    if (opts.sweep && this.isLive(agentId)) return empty;
    if (!opts.pids && !opts.sweep && this.isLive(agentId)) {
      throw new DomainError(
        'invalid',
        `Steward ${agentId} is still running: name the pids to stop (from list_steward_processes); ` +
          'stopping all of them is only for a Steward that ended',
      );
    }
    let found = await this.attributed(agent);
    if (!found) {
      if (opts.pids?.length) {
        throw new DomainError('invalid', 'processes cannot be inspected on this platform');
      }
      return empty;
    }
    let { targets, gone } = this.targets(agentId, found, opts.pids, false);
    // `lstart` has a one-second resolution: a process that started in the snapshot's own second
    // cannot be told from one that replaced it under the same pid within that second. Look again
    // once that second is over; whatever is still that young is left alone.
    const young = (f: Attributed) => (p: ProcEntry) =>
      p.startedAt >= floorSecond(f.snapshot.takenAt);
    if (targets.some(young(found))) {
      await sleep(floorSecond(found.snapshot.takenAt) + SECOND + 50 - Date.now());
      const again = await this.attributed(agent);
      if (!again) return empty;
      found = again;
      ({ targets, gone } = this.targets(agentId, found, opts.pids, true));
    }
    const skipped = new Set<number>(gone);
    for (const p of targets.filter(young(found))) skipped.add(p.pid);
    targets = targets.filter((p) => !skipped.has(p.pid));

    // A sweep never stops a Steward that came back meanwhile (a resume raced the attribution).
    if (opts.sweep && this.isLive(agentId)) return empty;
    // Identity right before the signal: the same start time and the same parent.
    const fresh = new Map(((await this.table.list()) ?? []).map((p) => [p.pid, p]));
    targets = targets.filter((p) => {
      const q = fresh.get(p.pid);
      const same = q !== undefined && !q.zombie && q.startedAt === p.startedAt && q.ppid === p.ppid;
      if (!same) skipped.add(p.pid);
      return same;
    });
    const skippedList = [...skipped].sort((a, b) => a - b);
    if (targets.length === 0) {
      return { ...empty, ...(skippedList.length > 0 ? { skipped: skippedList } : {}) };
    }

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
      ...(skippedList.length > 0 ? { skipped: skippedList } : {}),
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
   * running — the same pid with the same start time (a recycled pid is someone else: gone). The
   * parent is not compared here: it changes legitimately once a stopped parent is gone.
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
   * sent-back session): its processes are its own business while it lives — checked here and
   * again right before the signals.
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
