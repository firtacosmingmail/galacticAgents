import {
  describeTool,
  ENDED_STATES,
  type AgentCaps,
  type AgentRuntime,
  type AgentState,
  type Event,
  type EventEnvelope,
  type Id,
  type StatusRecord,
} from '@galactic/protocol';

/**
 * The status store (P1-05; TECHNOLOGY §4). The one implementation of the per-agent status
 * projection: `agent.*` events (plus `question.answered`) fold into `StatusRecord`s, a silence
 * threshold turns a working agent `stalled`, the records are rebuilt from the event log on
 * startup and pushed to clients as batched diffs (≈10 Hz, never per token). Nothing is ever
 * written back: the log is the truth, this is a view of it.
 *
 * `agent.output` never enters the log (it goes to the transcript pipeline), so the runtime calls
 * `touch()` for it: output keeps the agent alive and marks it working. A rebuild from the log
 * alone cannot see output, so an agent that only ever printed is `starting` after a rebuild
 * until its next logged event; every other transition has a logged event.
 *
 * Two rules keep the records honest (P1-17, P1-25): an ended record is a sink — only a new
 * `agent.spawned` (a resume) moves it again — and a diff goes out only when something changed:
 * the wall clock is not re-sent every tick; clients extrapolate it from `startedAt`.
 */

export interface StatusStoreOptions {
  /** Caps of an agent (from its row); absent → the defaults. */
  capsOf: (agentId: Id) => AgentCaps | undefined;
  defaultCaps: AgentCaps;
  /**
   * Whether the wall-clock cap applies to the agent (SPEC decision 103: not to a brain); when it
   * does not, the record's `caps.wallClockMs` carries no `limit`. Default: it applies.
   */
  wallClockCapped?: (agentId: Id) => boolean;
  /**
   * Silence after which a working agent is `stalled`, per runtime (and agent: the scene harness's
   * fake agents never stall on their own, P4-06).
   */
  stallThresholdMs: (runtime: AgentRuntime | undefined, agentId: Id) => number;
  /**
   * Called once per silence when the ticker turns a working agent `stalled` (P8-04): the
   * composition logs it as `agent.stalled`, so the stall is a real event (corner case 2) that
   * wakes the agent's supervisor and stays in the history. The store itself never writes.
   */
  onStalled?: (agentId: Id, silentForMs: number) => void;
  /** Batch interval for diffs. */
  flushMs?: number;
  /** How often the wall clock of live agents is refreshed and stalls are checked. */
  tickMs?: number;
  /**
   * Retention of ended records (P1-16): an ended agent's record is dropped once it is older
   * than this, and the oldest ended records go first when more than `maxEnded` have piled up.
   * Dropped records are announced to subscribers so clients forget them too; the log keeps the
   * history. Default: 24 h and 500.
   */
  retainEndedMs?: number;
  maxEnded?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/** A batch of changed records plus the ids of records dropped by retention. */
export type StatusListener = (records: StatusRecord[], removed: Id[]) => void;

interface Entry {
  record: StatusRecord;
  runtime: AgentRuntime | undefined;
  spawnedAt: number;
  lastEventAt: number;
  toolCalls: number;
  /** What the agent was doing when it was paused; restored on resume. */
  beforePause: AgentState | undefined;
  /**
   * Every question the agent asked that is still open, oldest first (P4-11): two permission
   * questions can be open at once. `record.pendingQuestionId` is the newest; the agent stays
   * `waiting_for_input` while any is open.
   */
  pending: Id[];
}

const LIVE: ReadonlySet<AgentState> = new Set([
  'starting',
  'working',
  'waiting_for_input',
  'idle',
  'stalled',
  'paused',
]);

export class StatusStore {
  private readonly entries = new Map<Id, Entry>();
  private readonly listeners = new Set<StatusListener>();
  private readonly dirty = new Set<Id>();
  private readonly removed = new Set<Id>();
  private readonly retainEndedMs: number;
  private readonly maxEnded: number;
  private readonly flushMs: number;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private flushTimer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;

  constructor(private readonly opts: StatusStoreOptions) {
    this.flushMs = opts.flushMs ?? 100;
    this.tickMs = opts.tickMs ?? 1_000;
    this.retainEndedMs = opts.retainEndedMs ?? 24 * 60 * 60 * 1_000;
    this.maxEnded = opts.maxEnded ?? 500;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => {});
  }

  get(agentId: Id): StatusRecord | undefined {
    const e = this.entries.get(agentId);
    return e ? { ...e.record } : undefined;
  }

  all(): StatusRecord[] {
    return [...this.entries.values()].map((e) => ({ ...e.record }));
  }

  /** Live agents (not finished, failed, stopped or interrupted). */
  live(): StatusRecord[] {
    return this.all().filter((r) => LIVE.has(r.state));
  }

  /** Batched diffs: every listener gets the records that changed since the last flush. */
  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Replays a log from scratch. */
  rebuild(events: Iterable<EventEnvelope>): void {
    this.entries.clear();
    this.dirty.clear();
    for (const envelope of events) this.fold(envelope, false);
    for (const id of this.entries.keys()) this.dirty.add(id);
    this.scheduleFlush();
  }

  /** Folds one committed event. Wire it as a log subscriber. */
  fold(envelope: EventEnvelope, broadcast = true): void {
    const { event } = envelope;
    const at = Date.parse(envelope.at);
    if (event.type === 'question.cancelled') {
      // The question is gone (P1-34); a waiting agent was interrupted out of it and goes idle.
      for (const e of this.entries.values()) {
        if (!this.settle(e, event.questionId)) continue;
        const next = e.pending.at(-1);
        this.update(e, at, { pendingQuestionId: next });
        if (next === undefined && e.beforePause === 'waiting_for_input') e.beforePause = 'idle';
        if (broadcast) this.mark(e.record.agentId);
      }
      return;
    }
    if (event.type === 'question.answered') {
      for (const e of this.entries.values()) {
        if (!this.settle(e, event.questionId)) continue;
        const next = e.pending.at(-1);
        if (next !== undefined) {
          // Another question of the agent is still open: it keeps waiting for that one.
          this.update(e, at, { pendingQuestionId: next });
        } else {
          const state = e.record.state;
          const keep = state === 'paused' || ENDED_STATES.has(state);
          this.update(e, at, {
            ...(keep ? {} : { state: 'working' }),
            pendingQuestionId: undefined,
          });
          if (e.beforePause === 'waiting_for_input') e.beforePause = 'working';
        }
        if (broadcast) this.mark(e.record.agentId);
      }
      return;
    }
    if (!event.type.startsWith('agent.') || event.type === 'agent.created') return;
    const agentEvent = event as Extract<Event, { agentId: Id }>;
    const entry = this.entryFor(agentEvent.agentId, event, at);
    this.apply(entry, agentEvent, at);
    if (broadcast) this.mark(entry.record.agentId);
  }

  /** Output arrived (transcript): the agent is alive and working, but nothing is logged. */
  touch(agentId: Id, at: number = this.now()): void {
    const entry = this.entries.get(agentId);
    if (!entry || ENDED_STATES.has(entry.record.state)) return;
    const state = entry.record.state;
    entry.lastEventAt = Math.max(entry.lastEventAt, at);
    // Output means work: a starting or stalled agent is working again. Dirty per chunk, sent per
    // flush: the 100 ms batch is what keeps this off the per-token path.
    this.update(entry, at, state === 'stalled' || state === 'starting' ? { state: 'working' } : {});
    this.mark(agentId);
  }

  /** Starts the stall/wall-clock ticker. */
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), this.tickMs);
    this.ticker.unref?.();
  }

  /** One ticker pass: stall detection. Only a record that changed is marked for the next diff. */
  tick(now: number = this.now()): void {
    const stalled: { agentId: Id; silentForMs: number }[] = [];
    for (const entry of this.entries.values()) {
      const { record } = entry;
      if (record.state !== 'working' && record.state !== 'starting') continue;
      const threshold = this.opts.stallThresholdMs(entry.runtime, record.agentId);
      if (now - entry.lastEventAt < threshold) continue;
      entry.record = { ...record, state: 'stalled', caps: this.caps(entry, now) };
      this.mark(record.agentId);
      stalled.push({ agentId: record.agentId, silentForMs: now - entry.lastEventAt });
    }
    this.prune(now);
    // After the pass: logging the stall folds its event back into this store.
    for (const { agentId, silentForMs } of stalled) {
      try {
        this.opts.onStalled?.(agentId, silentForMs);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  /** Retention (P1-16): drops ended records past their time or beyond the cap, oldest first. */
  prune(now: number = this.now()): Id[] {
    const ended = [...this.entries.values()]
      .filter((e) => ENDED_STATES.has(e.record.state))
      .sort((a, b) => a.lastEventAt - b.lastEventAt);
    const dropped: Id[] = [];
    const overflow = Math.max(0, ended.length - this.maxEnded);
    ended.forEach((entry, i) => {
      if (i < overflow || now - entry.lastEventAt >= this.retainEndedMs) {
        dropped.push(entry.record.agentId);
      }
    });
    for (const id of dropped) {
      this.entries.delete(id);
      this.dirty.delete(id);
      this.removed.add(id);
    }
    if (dropped.length > 0) this.scheduleFlush();
    return dropped;
  }

  /** Sends pending diffs now. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty.size === 0 && this.removed.size === 0) return;
    const records = [...this.dirty]
      .map((id) => this.entries.get(id))
      .filter((e): e is Entry => e !== undefined)
      .map((e) => ({ ...e.record }));
    const removed = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    for (const listener of [...this.listeners]) {
      try {
        listener(records, removed);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.flush();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------

  private entryFor(agentId: Id, event: Event, at: number): Entry {
    let entry = this.entries.get(agentId);
    if (!entry) {
      const runtime = event.type === 'agent.spawned' ? event.runtime : undefined;
      entry = {
        record: {
          agentId,
          state: 'starting',
          startedAt: new Date(at).toISOString(),
          lastEventAt: new Date(at).toISOString(),
          caps: { wallClockMs: { used: 0, limit: 1 }, toolCalls: { used: 0, limit: 1 } },
        },
        runtime,
        spawnedAt: at,
        lastEventAt: at,
        toolCalls: 0,
        beforePause: undefined,
        pending: [],
      };
      entry.record.caps = this.caps(entry, at);
      this.entries.set(agentId, entry);
    }
    return entry;
  }

  private apply(entry: Entry, event: Extract<Event, { agentId: Id }>, at: number): void {
    const paused = entry.record.state === 'paused';
    // An ended record is a sink (P1-17): the runtime logs one terminal event per agent, and a
    // straggler in an older log must not move a finished agent to `stopped`.
    if (ENDED_STATES.has(entry.record.state) && event.type !== 'agent.spawned') return;
    switch (event.type) {
      case 'agent.spawned':
        entry.runtime = event.runtime;
        entry.spawnedAt = at;
        entry.toolCalls = 0;
        entry.beforePause = undefined;
        entry.pending = [];
        this.update(entry, at, {
          state: 'starting',
          startedAt: new Date(at).toISOString(),
          currentActivity: undefined,
          pendingQuestionId: undefined,
          progress: undefined,
          costSoFar: undefined,
        });
        return;
      case 'agent.output':
        this.update(entry, at, paused ? {} : { state: 'working' });
        return;
      case 'agent.tool_call':
        entry.toolCalls++;
        this.update(entry, at, {
          ...(paused ? {} : { state: 'working' }),
          currentActivity: describeTool(event.toolName, event.input),
        });
        return;
      case 'agent.progress':
        this.update(entry, at, {
          ...(paused ? {} : { state: 'working' }),
          currentActivity: event.summary,
          ...(event.progress ? { progress: event.progress } : {}),
        });
        return;
      case 'agent.needs_input':
        entry.pending = [...entry.pending.filter((q) => q !== event.questionId), event.questionId];
        this.update(entry, at, {
          ...(paused ? {} : { state: 'waiting_for_input' }),
          pendingQuestionId: event.questionId,
          currentActivity: `${event.kind === 'permission' ? 'Permission' : 'Question'}: ${event.question.text}`,
        });
        return;
      case 'agent.idle':
        // An idle agent is not waiting for anything: a question still pending was withdrawn.
        entry.pending = [];
        this.update(entry, at, {
          ...(paused ? {} : { state: 'idle' }),
          ...(event.cost ? { costSoFar: event.cost } : {}),
          pendingQuestionId: undefined,
        });
        if (paused && entry.beforePause === 'waiting_for_input') entry.beforePause = 'idle';
        return;
      case 'agent.stalled':
        this.update(entry, at, paused ? {} : { state: 'stalled' });
        return;
      case 'agent.paused':
        if (!paused) entry.beforePause = entry.record.state;
        this.update(entry, at, { state: 'paused' });
        return;
      case 'agent.resumed': {
        const restored =
          entry.pending.length > 0 ? 'waiting_for_input' : (entry.beforePause ?? 'working');
        entry.beforePause = undefined;
        this.update(entry, at, { state: restored === 'stalled' ? 'working' : restored });
        return;
      }
      case 'agent.finished':
        entry.pending = [];
        this.update(entry, at, {
          state: 'finished',
          currentActivity: event.result ?? 'Finished',
          ...(event.cost ? { costSoFar: event.cost } : {}),
          pendingQuestionId: undefined,
        });
        return;
      case 'agent.failed':
        entry.pending = [];
        this.update(entry, at, {
          state: 'failed',
          currentActivity: event.error,
          ...(event.cost ? { costSoFar: event.cost } : {}),
          pendingQuestionId: undefined,
        });
        return;
      case 'agent.stopped':
        entry.pending = [];
        this.update(entry, at, { state: 'stopped', pendingQuestionId: undefined });
        return;
      case 'agent.interrupted':
        // Its open question is cancelled with it (P1-34): a resumed session re-asks.
        entry.pending = [];
        this.update(entry, at, {
          state: 'interrupted',
          currentActivity: event.reason,
          pendingQuestionId: undefined,
        });
        return;
    }
  }

  /** Removes an answered or cancelled question from the agent's open ones; whether it was one. */
  private settle(entry: Entry, questionId: Id): boolean {
    if (!entry.pending.includes(questionId)) return false;
    entry.pending = entry.pending.filter((q) => q !== questionId);
    return true;
  }

  /** Applies changes, refreshes timestamps and caps. `undefined` in `changes` clears a field. */
  private update(
    entry: Entry,
    at: number,
    changes: { [K in keyof StatusRecord]?: StatusRecord[K] | undefined },
  ): void {
    const record: StatusRecord = { ...entry.record };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete (record as Record<string, unknown>)[key];
      else (record as Record<string, unknown>)[key] = value;
    }
    if (!ENDED_STATES.has(entry.record.state) || ENDED_STATES.has(record.state)) {
      entry.lastEventAt = Math.max(entry.lastEventAt, at);
    }
    record.lastEventAt = new Date(entry.lastEventAt).toISOString();
    record.caps = this.caps(entry, at);
    entry.record = record;
  }

  private caps(entry: Entry, now: number): StatusRecord['caps'] {
    const caps = this.opts.capsOf(entry.record.agentId) ?? this.opts.defaultCaps;
    const ended = ENDED_STATES.has(entry.record.state);
    const used = ended ? entry.record.caps.wallClockMs.used : Math.max(0, now - entry.spawnedAt);
    return {
      wallClockMs: {
        used,
        ...((this.opts.wallClockCapped?.(entry.record.agentId) ?? true)
          ? { limit: caps.maxWallClockMs }
          : {}),
      },
      toolCalls: { used: entry.toolCalls, limit: caps.maxToolCalls },
    };
  }

  private mark(agentId: Id): void {
    this.dirty.add(agentId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || (this.dirty.size === 0 && this.removed.size === 0)) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushMs);
  }
}
