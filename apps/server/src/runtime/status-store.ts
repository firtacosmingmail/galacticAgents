import type {
  AgentCaps,
  AgentRuntime,
  AgentState,
  Event,
  EventEnvelope,
  Id,
  StatusRecord,
} from '@galactic/protocol';

/**
 * The status store (P1-05; TECHNOLOGY §4). The one implementation of the per-agent status
 * projection: `agent.*` events (plus `question.answered`) fold into `StatusRecord`s, a silence
 * threshold turns a working agent `stalled`, the records are rebuilt from the event log on
 * startup and pushed to clients as batched diffs (≈10 Hz, never per token). Nothing is ever
 * written back: the log is the truth, this is a view of it.
 *
 * `agent.output` never enters the log (it goes to the transcript pipeline), so the runtime calls
 * `touch()` for it: output keeps the agent alive and marks it working, but a rebuild from the log
 * alone gives the same states, since every state transition has a logged event.
 */

export interface StatusStoreOptions {
  /** Caps of an agent (from its row); absent → the defaults. */
  capsOf: (agentId: Id) => AgentCaps | undefined;
  defaultCaps: AgentCaps;
  /** Silence after which a working agent is `stalled`, per runtime. */
  stallThresholdMs: (runtime: AgentRuntime | undefined) => number;
  /** Batch interval for diffs. */
  flushMs?: number;
  /** How often the wall clock of live agents is refreshed and stalls are checked. */
  tickMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export type StatusListener = (records: StatusRecord[]) => void;

interface Entry {
  record: StatusRecord;
  runtime: AgentRuntime | undefined;
  spawnedAt: number;
  lastEventAt: number;
  toolCalls: number;
}

const LIVE: ReadonlySet<AgentState> = new Set([
  'starting',
  'working',
  'waiting_for_input',
  'idle',
  'stalled',
  'paused',
]);
const ENDED: ReadonlySet<AgentState> = new Set(['finished', 'failed', 'stopped', 'interrupted']);

export class StatusStore {
  private readonly entries = new Map<Id, Entry>();
  private readonly listeners = new Set<StatusListener>();
  private readonly dirty = new Set<Id>();
  private readonly flushMs: number;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private flushTimer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;

  constructor(private readonly opts: StatusStoreOptions) {
    this.flushMs = opts.flushMs ?? 100;
    this.tickMs = opts.tickMs ?? 1_000;
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
    if (event.type === 'question.answered') {
      for (const e of this.entries.values()) {
        if (e.record.pendingQuestionId === event.questionId) {
          this.update(e, at, { state: 'working', pendingQuestionId: undefined });
          if (broadcast) this.mark(e.record.agentId);
        }
      }
      return;
    }
    if (!event.type.startsWith('agent.')) return;
    const agentEvent = event as Extract<Event, { agentId: Id }>;
    const entry = this.entryFor(agentEvent.agentId, event, at);
    this.apply(entry, agentEvent, at);
    if (broadcast) this.mark(entry.record.agentId);
  }

  /** Output arrived (transcript): the agent is alive and working, but nothing is logged. */
  touch(agentId: Id, at: number = this.now()): void {
    const entry = this.entries.get(agentId);
    if (!entry || ENDED.has(entry.record.state)) return;
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

  /** One ticker pass: stalled detection and wall-clock refresh for live agents. */
  tick(now: number = this.now()): void {
    for (const entry of this.entries.values()) {
      const { record } = entry;
      if (!LIVE.has(record.state)) continue;
      if (record.state === 'working' || record.state === 'starting') {
        const threshold = this.opts.stallThresholdMs(entry.runtime);
        if (now - entry.lastEventAt >= threshold) {
          record.state = 'stalled';
        }
      }
      record.caps = this.caps(entry, now);
      this.mark(record.agentId);
    }
  }

  /** Sends pending diffs now. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty.size === 0) return;
    const records = [...this.dirty]
      .map((id) => this.entries.get(id))
      .filter((e): e is Entry => e !== undefined)
      .map((e) => ({ ...e.record }));
    this.dirty.clear();
    for (const listener of [...this.listeners]) {
      try {
        listener(records);
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
          lastEventAt: new Date(at).toISOString(),
          caps: { wallClockMs: { used: 0, limit: 1 }, toolCalls: { used: 0, limit: 1 } },
        },
        runtime,
        spawnedAt: at,
        lastEventAt: at,
        toolCalls: 0,
      };
      entry.record.caps = this.caps(entry, at);
      this.entries.set(agentId, entry);
    }
    return entry;
  }

  private apply(entry: Entry, event: Extract<Event, { agentId: Id }>, at: number): void {
    const paused = entry.record.state === 'paused';
    switch (event.type) {
      case 'agent.spawned':
        entry.runtime = event.runtime;
        entry.spawnedAt = at;
        entry.toolCalls = 0;
        this.update(entry, at, {
          state: 'starting',
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
        this.update(entry, at, {
          ...(paused ? {} : { state: 'waiting_for_input' }),
          pendingQuestionId: event.questionId,
          currentActivity: `${event.kind === 'permission' ? 'Permission' : 'Question'}: ${event.question.text}`,
        });
        return;
      case 'agent.idle':
        this.update(entry, at, {
          ...(paused ? {} : { state: 'idle' }),
          ...(event.cost ? { costSoFar: event.cost } : {}),
        });
        return;
      case 'agent.stalled':
        this.update(entry, at, paused ? {} : { state: 'stalled' });
        return;
      case 'agent.paused':
        this.update(entry, at, { state: 'paused' });
        return;
      case 'agent.resumed':
        this.update(entry, at, {
          state: entry.record.pendingQuestionId ? 'waiting_for_input' : 'working',
        });
        return;
      case 'agent.finished':
        this.update(entry, at, {
          state: 'finished',
          currentActivity: event.result ?? 'Finished',
          ...(event.cost ? { costSoFar: event.cost } : {}),
          pendingQuestionId: undefined,
        });
        return;
      case 'agent.failed':
        this.update(entry, at, {
          state: 'failed',
          currentActivity: event.error,
          ...(event.cost ? { costSoFar: event.cost } : {}),
          pendingQuestionId: undefined,
        });
        return;
      case 'agent.stopped':
        this.update(entry, at, { state: 'stopped', pendingQuestionId: undefined });
        return;
    }
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
    if (!ENDED.has(entry.record.state) || ENDED.has(record.state)) {
      entry.lastEventAt = Math.max(entry.lastEventAt, at);
    }
    record.lastEventAt = new Date(entry.lastEventAt).toISOString();
    record.caps = this.caps(entry, at);
    entry.record = record;
  }

  private caps(entry: Entry, now: number): StatusRecord['caps'] {
    const caps = this.opts.capsOf(entry.record.agentId) ?? this.opts.defaultCaps;
    const ended = ENDED.has(entry.record.state);
    const used = ended ? entry.record.caps.wallClockMs.used : Math.max(0, now - entry.spawnedAt);
    return {
      wallClockMs: { used, limit: caps.maxWallClockMs },
      toolCalls: { used: entry.toolCalls, limit: caps.maxToolCalls },
    };
  }

  private mark(agentId: Id): void {
    this.dirty.add(agentId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.dirty.size === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushMs);
  }
}

function describeTool(toolName: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>;
    const detail = i['command'] ?? i['file_path'] ?? i['pattern'] ?? i['path'] ?? i['url'];
    if (typeof detail === 'string') return `${toolName}: ${detail.slice(0, 120)}`;
  }
  return toolName;
}
