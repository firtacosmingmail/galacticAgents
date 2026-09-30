import type { Database, Statement } from 'better-sqlite3';
import { Event, isTranscriptEvent, type EventEnvelope, type Snapshot } from '@galactic/protocol';
import { tables, type Tables } from '../db/tables.js';

/** What a command sees: the domain tables and a way to append events to the same transaction. */
export interface CommandContext {
  tables: Tables;
  /** Queues an event; it is inserted right after the mutation, inside the same transaction. */
  emit(event: Event): void;
}

export interface CommandOutcome<T> {
  value: T;
  /** The events this command appended, with their committed `seq`. */
  events: EventEnvelope[];
}

export type Subscriber = (envelope: EventEnvelope) => void;

export interface EventLogOptions {
  /** Clock, injectable for tests. Must return an ISO timestamp. */
  now?: () => string;
  /** Called when a subscriber throws; the other subscribers still get the event. */
  onSubscriberError?: (error: unknown, envelope: EventEnvelope) => void;
  /** Above this many missed events a reconnecting client gets a snapshot instead of a replay. */
  maxReplay?: number;
}

/**
 * The event bus and the one write rule (TECHNOLOGY §6.1): `runCommand` runs the domain mutation
 * and inserts its events in one transaction, `seq` is the events rowid, and in-memory subscribers
 * are notified strictly in `seq` order after the outermost commit. A throw anywhere rolls back
 * both the rows and the events.
 */
export class EventLog {
  readonly tables: Tables;
  private readonly now: () => string;
  private readonly onSubscriberError: (error: unknown, envelope: EventEnvelope) => void;
  readonly maxReplay: number;
  private readonly subscribers = new Set<Subscriber>();
  private readonly insertEvent: Statement;
  private readonly selectSince: Statement;
  private readonly selectMax: Statement;
  private readonly selectMin: Statement;
  /** Events committed but not yet published (only non-empty inside a command). */
  private pending: EventEnvelope[] = [];
  private depth = 0;

  constructor(
    readonly db: Database,
    opts: EventLogOptions = {},
  ) {
    this.tables = tables(db);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onSubscriberError = opts.onSubscriberError ?? (() => {});
    this.maxReplay = opts.maxReplay ?? 10_000;
    this.insertEvent = db.prepare('INSERT INTO events (at, type, payload) VALUES (?, ?, ?)');
    this.selectSince = db.prepare(
      'SELECT id, at, type, payload FROM events WHERE id > ? ORDER BY id LIMIT ?',
    );
    this.selectMax = db.prepare('SELECT COALESCE(MAX(id), 0) AS seq FROM events');
    this.selectMin = db.prepare('SELECT COALESCE(MIN(id), 0) AS seq FROM events');
  }

  /** Runs `fn` under the one write rule. Nested calls join the outer transaction. */
  runCommand<T>(fn: (ctx: CommandContext) => T): CommandOutcome<T> {
    const mine: EventEnvelope[] = [];
    const queued: Event[] = [];
    const ctx: CommandContext = {
      tables: this.tables,
      emit: (event) => {
        const parsed = Event.parse(event);
        if (isTranscriptEvent(parsed)) {
          throw new Error('agent.output belongs in transcript_chunks, not in the event log');
        }
        queued.push(parsed);
      },
    };

    this.depth++;
    let value: T;
    try {
      value = this.db.transaction(() => {
        const result = fn(ctx);
        for (const event of queued) {
          const at = this.now();
          const info = this.insertEvent.run(at, event.type, JSON.stringify(event));
          mine.push({ seq: Number(info.lastInsertRowid), at, event });
        }
        return result;
      })();
      this.pending.push(...mine);
    } catch (error) {
      if (this.depth === 1) this.pending = [];
      throw error;
    } finally {
      this.depth--;
    }

    if (this.depth === 0) this.publish();
    return { value, events: mine };
  }

  private publish(): void {
    const batch = this.pending;
    this.pending = [];
    for (const envelope of batch) {
      for (const subscriber of this.subscribers) {
        try {
          subscriber(envelope);
        } catch (error) {
          this.onSubscriberError(error, envelope);
        }
      }
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** The `seq` of the latest committed event, 0 when the log is empty. */
  currentSeq(): number {
    return (this.selectMax.get() as { seq: number }).seq;
  }

  /** The oldest `seq` still in the log (retention pruning may raise it), 0 when empty. */
  oldestSeq(): number {
    return (this.selectMin.get() as { seq: number }).seq;
  }

  /** Events with `seq > since`, in order. */
  eventsSince(since: number, limit = this.maxReplay): EventEnvelope[] {
    const rows = this.selectSince.all(since, limit) as {
      id: number;
      at: string;
      payload: string;
    }[];
    return rows.map((r) => ({ seq: r.id, at: r.at, event: JSON.parse(r.payload) as Event }));
  }

  /**
   * Whether a client that last saw `since` can be caught up by replay: the events after it are
   * still in the log and there are not too many of them.
   */
  canReplayFrom(since: number): boolean {
    const oldest = this.oldestSeq();
    const current = this.currentSeq();
    if (since > current) return false;
    if (oldest > 0 && since < oldest - 1) return false;
    return current - since <= this.maxReplay;
  }

  /** The current state of every table, consistent with the `seq` it reports. */
  snapshot(): Snapshot {
    return this.db.transaction(() => ({
      seq: this.currentSeq(),
      agents: this.tables.agents.all(),
      bodies: this.tables.bodies.all(),
      projects: this.tables.projects.all(),
      tasks: this.tables.tasks.all(),
      questions: this.tables.questions.all(),
      proposals: this.tables.proposals.all(),
      // The status store is a Phase 1 projection; until then nothing is running.
      statuses: [],
    }))();
  }
}
