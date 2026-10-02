import type { AgentCaps, AgentEvent, AgentRole, Id } from '@galactic/protocol';

/**
 * Hard caps (P1-02; SPEC decision 18, TECHNOLOGY §5.4). Enforced here, never by prompts: a
 * per-agent wall-clock cap, a per-agent tool-call cap and a global cap on concurrent agents. A
 * cap hit calls `onCapHit` with a reason the runtime puts into `agent.failed(reason: cap)`; a
 * spawn over the concurrency cap is refused with the same kind of reason. P2-17 adds the
 * hierarchy's spawn caps: live Stewards per Waykeeper and spawns per hour (global and per spawning
 * brain). Brains (the Harmonizer, Waykeepers) do not count against `maxConcurrentAgents`, and the
 * Harmonizer is never refused by a spawn cap (P2-17; `docs/tasks/notes/P2-17-caps.md`). Dollar budgets in Phase 8.
 */

/** The spawn caps of the hierarchy (P2-17); every field has a default. */
export interface SpawnCaps {
  /** Live Stewards one Waykeeper may supervise at once. */
  maxStewardsPerWaykeeper: number;
  /** New agents created in any sliding hour, whoever spawned them. */
  maxSpawnsPerHour: number;
  /** New agents one brain (the new agent's `supervisorId`) may spawn in any sliding hour. */
  maxSpawnsPerHourPerBrain: number;
}

export const DEFAULT_SPAWN_CAPS: SpawnCaps = {
  maxStewardsPerWaykeeper: 3,
  maxSpawnsPerHour: 30,
  maxSpawnsPerHourPerBrain: 20,
};
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4;

/** Every configurable cap, as the config and the composition root pass them. */
export interface CapsConfig extends Partial<SpawnCaps> {
  maxConcurrentAgents?: number;
  defaults?: AgentCaps;
}

/** What a spawn check needs to know about the agent to be started. */
export interface SpawnCheck {
  role?: AgentRole;
  supervisorId?: Id;
  /** The supervisor's role: the Stewards-per-Waykeeper cap applies under a Waykeeper. */
  supervisorRole?: AgentRole;
  /** A resumed or renewed session: the same agent again, not a new spawn (no rate check). */
  again?: boolean;
}

/** How an agent tracked here is placed; read when a cap counts agents. */
export interface TrackedInfo {
  role?: AgentRole | undefined;
  supervisorId?: Id | undefined;
}

const HOUR_MS = 60 * 60 * 1000;
const BRAINS: ReadonlySet<AgentRole> = new Set(['harmonizer', 'waykeeper']);

export interface CapsOptions {
  /** Global maximum of live agents. */
  maxConcurrentAgents: number;
  /** Per-agent defaults when a spawn does not set its own. */
  defaults: AgentCaps;
  /** The hierarchy's spawn caps (P2-17); default `DEFAULT_SPAWN_CAPS`. */
  spawn?: Partial<SpawnCaps>;
  /**
   * The current placement of a tracked agent (the runtime reads its row, so a supervisor change
   * is seen); default: what `track` was told.
   */
  agentOf?: (agentId: Id) => TrackedInfo | undefined;
  onCapHit: (agentId: Id, reason: string) => void;
  now?: () => number;
}

export interface CapUsage {
  wallClockMs: { used: number; limit: number };
  toolCalls: { used: number; limit: number };
}

interface Tracked {
  caps: AgentCaps;
  startedAt: number;
  toolCalls: number;
  timer: NodeJS.Timeout | undefined;
  hit: boolean;
  info: TrackedInfo;
}

export const DEFAULT_CAPS: AgentCaps = { maxWallClockMs: 2 * 60 * 60 * 1000, maxToolCalls: 500 };

export class CapsEnforcer {
  private readonly tracked = new Map<Id, Tracked>();
  private readonly now: () => number;
  readonly spawnCaps: SpawnCaps;
  /** New spawns in the last hour, oldest first: when, and which brain spawned them. */
  private spawns: { at: number; by: Id | undefined }[] = [];

  constructor(private readonly opts: CapsOptions) {
    this.now = opts.now ?? Date.now;
    this.spawnCaps = { ...DEFAULT_SPAWN_CAPS, ...(opts.spawn ?? {}) };
  }

  get defaults(): AgentCaps {
    return this.opts.defaults;
  }

  get maxConcurrent(): number {
    return this.opts.maxConcurrentAgents;
  }

  /** Fills missing caps from the defaults. */
  resolve(caps?: Partial<AgentCaps>): AgentCaps {
    return { ...this.opts.defaults, ...(caps ?? {}) };
  }

  get liveCount(): number {
    return this.tracked.size;
  }

  /**
   * Whether one more agent may start now; the reason (which cap, the count, the limit, when it
   * frees) goes into the event payload or back to the brain as its tool error. Brains never count
   * against the concurrency cap and the Harmonizer is never refused (P2-17).
   */
  canSpawn(check: SpawnCheck = {}): { ok: true } | { ok: false; reason: string } {
    if (check.role === 'harmonizer') return { ok: true };
    if (!check.role || !BRAINS.has(check.role)) {
      const limit = this.opts.maxConcurrentAgents;
      const workers = this.countLive((info) => !info.role || !BRAINS.has(info.role));
      if (workers >= limit) {
        return {
          ok: false,
          reason:
            `concurrency cap: ${workers} of ${limit} agents already running ` +
            `(the Harmonizer and Waykeepers not counted); a slot frees when one of them ends`,
        };
      }
    }
    if (check.role === 'steward' && check.supervisorId && check.supervisorRole === 'waykeeper') {
      const limit = this.spawnCaps.maxStewardsPerWaykeeper;
      const by = check.supervisorId;
      const live = this.countLive((info) => info.role === 'steward' && info.supervisorId === by);
      if (live >= limit) {
        return {
          ok: false,
          reason:
            `Stewards-per-Waykeeper cap: Waykeeper ${by} already supervises ${live} of ${limit} ` +
            `live Stewards; a slot frees when one of them finishes, fails or is stopped`,
        };
      }
    }
    if (check.again) return { ok: true };
    const now = this.now();
    this.prune(now);
    const all = this.spawns;
    if (all.length >= this.spawnCaps.maxSpawnsPerHour) {
      return {
        ok: false,
        reason:
          `spawn-rate cap: ${all.length} of ${this.spawnCaps.maxSpawnsPerHour} agents spawned ` +
          `in the last hour (all brains and the panel); ${frees(all[0]!.at, now)}`,
      };
    }
    if (check.supervisorId) {
      const mine = all.filter((s) => s.by === check.supervisorId);
      const limit = this.spawnCaps.maxSpawnsPerHourPerBrain;
      if (mine.length >= limit) {
        return {
          ok: false,
          reason:
            `spawn-rate cap: ${check.supervisorId} spawned ${mine.length} of ${limit} agents ` +
            `in the last hour; ${frees(mine[0]!.at, now)}`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * Counts a new spawn for the per-hour caps, by the brain that spawned it (`supervisorId`).
   * The runtime calls it when an agent row is created, and on startup for every row created in
   * the last hour, so the window survives a restart.
   */
  noteSpawn(by: Id | undefined, at?: number): void {
    const now = this.now();
    const when = Math.min(at ?? now, now);
    if (when <= now - HOUR_MS) return;
    const entry = { at: when, by };
    const i = this.spawns.findIndex((s) => s.at > when);
    if (i < 0) this.spawns.push(entry);
    else this.spawns.splice(i, 0, entry);
    this.prune(now);
  }

  /** Spawns counted in the last hour, optionally only those of one brain. */
  spawnsInLastHour(by?: Id): number {
    this.prune(this.now());
    return by === undefined ? this.spawns.length : this.spawns.filter((s) => s.by === by).length;
  }

  private prune(now: number): void {
    const from = now - HOUR_MS;
    let i = 0;
    while (i < this.spawns.length && this.spawns[i]!.at <= from) i++;
    if (i > 0) this.spawns = this.spawns.slice(i);
  }

  private countLive(match: (info: TrackedInfo) => boolean): number {
    let n = 0;
    for (const [id, entry] of this.tracked) {
      if (match(this.opts.agentOf?.(id) ?? entry.info)) n++;
    }
    return n;
  }

  /** Starts the clock for an agent. Replaces any previous tracking of the same id. */
  track(agentId: Id, caps: AgentCaps, info: TrackedInfo = {}): void {
    this.release(agentId);
    const entry: Tracked = {
      caps,
      startedAt: this.now(),
      toolCalls: 0,
      timer: undefined,
      hit: false,
      info,
    };
    entry.timer = setTimeout(() => {
      this.hit(agentId, entry, `wall-clock cap: ${formatMs(caps.maxWallClockMs)} elapsed`);
    }, caps.maxWallClockMs);
    entry.timer.unref?.();
    this.tracked.set(agentId, entry);
  }

  /** Counts tool calls and releases finished agents. Safe to feed every agent event. */
  onEvent(event: AgentEvent): void {
    const entry = this.tracked.get(event.agentId);
    if (!entry) return;
    switch (event.type) {
      case 'agent.tool_call':
        entry.toolCalls++;
        if (entry.toolCalls > entry.caps.maxToolCalls) {
          this.hit(
            event.agentId,
            entry,
            `tool-call cap: ${entry.toolCalls} calls, limit ${entry.caps.maxToolCalls}`,
          );
        }
        return;
      case 'agent.finished':
      case 'agent.failed':
      case 'agent.stopped':
        this.release(event.agentId);
        return;
      default:
        return;
    }
  }

  /**
   * Pre-flight for the permission gate (P1-18): whether one more tool call fits under the cap.
   * When it does not, the cap is hit right here — the call is refused *and* the agent is stopped
   * — so an agent whose every call is refused cannot spin. The refusal reason is meant for the
   * agent (the hook's deny message).
   */
  reserveToolCall(agentId: Id): { ok: true } | { ok: false; reason: string } {
    const entry = this.tracked.get(agentId);
    if (!entry || entry.toolCalls + 1 <= entry.caps.maxToolCalls) return { ok: true };
    const reason = `tool-call cap: ${entry.toolCalls} calls made, limit ${entry.caps.maxToolCalls}`;
    this.hit(agentId, entry, reason);
    return { ok: false, reason };
  }

  usage(agentId: Id): CapUsage | undefined {
    const entry = this.tracked.get(agentId);
    if (!entry) return undefined;
    return {
      wallClockMs: { used: this.now() - entry.startedAt, limit: entry.caps.maxWallClockMs },
      toolCalls: { used: entry.toolCalls, limit: entry.caps.maxToolCalls },
    };
  }

  release(agentId: Id): void {
    const entry = this.tracked.get(agentId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.tracked.delete(agentId);
  }

  dispose(): void {
    for (const id of [...this.tracked.keys()]) this.release(id);
  }

  private hit(agentId: Id, entry: Tracked, reason: string): void {
    if (entry.hit) return;
    entry.hit = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.opts.onCapHit(agentId, reason);
  }
}

/** When the oldest spawn of a window leaves it. */
function frees(oldest: number, now: number): string {
  const at = oldest + HOUR_MS;
  return `frees at ${new Date(at).toISOString()} (in ${formatMs(Math.max(at - now, 0))})`;
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} s`;
  return `${ms} ms`;
}
