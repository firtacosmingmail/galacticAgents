import type { AgentCaps, AgentEvent, Id } from '@galactic/protocol';

/**
 * Hard caps (P1-02; SPEC decision 18, TECHNOLOGY §5.4). Enforced here, never by prompts: a
 * per-agent wall-clock cap, a per-agent tool-call cap and a global cap on concurrent agents. A
 * cap hit calls `onCapHit` with a reason the runtime puts into `agent.failed(reason: cap)`; a
 * spawn over the concurrency cap is refused with the same kind of reason. Stewards-per-Waykeeper
 * and spawns-per-hour arrive with the hierarchy (Phase 2); dollar budgets in Phase 8.
 */

export interface CapsOptions {
  /** Global maximum of live agents. */
  maxConcurrentAgents: number;
  /** Per-agent defaults when a spawn does not set its own. */
  defaults: AgentCaps;
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
}

export const DEFAULT_CAPS: AgentCaps = { maxWallClockMs: 2 * 60 * 60 * 1000, maxToolCalls: 500 };

export class CapsEnforcer {
  private readonly tracked = new Map<Id, Tracked>();
  private readonly now: () => number;

  constructor(private readonly opts: CapsOptions) {
    this.now = opts.now ?? Date.now;
  }

  get defaults(): AgentCaps {
    return this.opts.defaults;
  }

  /** Fills missing caps from the defaults. */
  resolve(caps?: Partial<AgentCaps>): AgentCaps {
    return { ...this.opts.defaults, ...(caps ?? {}) };
  }

  get liveCount(): number {
    return this.tracked.size;
  }

  /** Whether one more agent may start now; the reason is meant for the event payload. */
  canSpawn(): { ok: true } | { ok: false; reason: string } {
    const limit = this.opts.maxConcurrentAgents;
    if (this.tracked.size >= limit) {
      return {
        ok: false,
        reason: `concurrency cap: ${this.tracked.size} of ${limit} agents already running`,
      };
    }
    return { ok: true };
  }

  /** Starts the clock for an agent. Replaces any previous tracking of the same id. */
  track(agentId: Id, caps: AgentCaps): void {
    this.release(agentId);
    const entry: Tracked = {
      caps,
      startedAt: this.now(),
      toolCalls: 0,
      timer: undefined,
      hit: false,
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

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} s`;
  return `${ms} ms`;
}
