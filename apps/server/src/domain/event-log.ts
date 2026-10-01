import { randomUUID } from 'node:crypto';
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

function db_get(db: Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value;
}

export interface EventLogOptions {
  /** Clock, injectable for tests. Must return an ISO timestamp. */
  now?: () => string;
  /** Called when a subscriber throws; the other subscribers still get the event. */
  onSubscriberError?: (error: unknown, envelope: EventEnvelope) => void;
  /** Above this many missed events a reconnecting client gets a snapshot instead of a replay. */
  maxReplay?: number;
}

/**
 * The domain tables at one `seq`. The wire `Snapshot` adds the status records, a projection the
 * runtime owns (TECHNOLOGY §4): `ws/snapshot.ts` assembles the two, so the domain log never
 * depends on the runtime layer.
 */
export type TableSnapshot = Omit<Snapshot, 'statuses'>;

/**
 * The event bus and the one write rule (TECHNOLOGY §6.1): `runCommand` runs the domain mutation
 * and inserts its events in one transaction, `seq` is the events rowid, and in-memory subscribers
 * are notified strictly in `seq` order after the outermost commit. A throw anywhere rolls back
 * both the rows and the events.
 */
export class EventLog {
  readonly tables: Tables;
  /**
   * Identity of this log, generated once when the database is created and kept in `settings`.
   * A client may only resume (`hello{lastEventId, logId}`) against the log it took its state
   * from; a deleted or replaced database gives it a snapshot instead of an unrelated replay.
   */
  readonly logId: string;
  private readonly now: () => string;
  private readonly onSubscriberError: (error: unknown, envelope: EventEnvelope) => void;
  readonly maxReplay: number;
  private readonly subscribers = new Set<Subscriber>();
  private readonly insertEvent: Statement;
  private readonly selectSince: Statement;
  private readonly selectMax: Statement;
  private readonly selectMin: Statement;
  /** Events committed but not yet published (only non-empty while publishing). */
  private pending: EventEnvelope[] = [];
  /**
   * Events inserted by the transaction under way (the outermost command and every nested one),
   * handed to `pending` only when the outermost command commits: a nested command that
   * succeeded inside an outer one that then threw is rolled back with it and never published.
   */
  private uncommitted: EventEnvelope[] = [];
  private depth = 0;
  /** True while subscribers are being notified; commands run by a subscriber queue behind the batch. */
  private publishing = false;

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
    this.logId = this.loadLogId();
  }

  private loadLogId(): string {
    const row = db_get(this.db, 'log_id');
    if (row) return row;
    const id = randomUUID();
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('log_id', id);
    return id;
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
    const mark = this.uncommitted.length;
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
      this.uncommitted.push(...mine);
      if (this.depth === 1) {
        // The outermost command committed: its events (and its nested commands') are published.
        this.pending.push(...this.uncommitted);
        this.uncommitted = [];
      }
    } catch (error) {
      // This command's savepoint (or the whole transaction) was rolled back: so were the events
      // its nested commands inserted. Events of an enclosing publish loop are already committed.
      this.uncommitted.length = mark;
      throw error;
    } finally {
      this.depth--;
    }

    if (this.depth === 0) this.publish();
    return { value, events: mine };
  }

  /**
   * Notifies subscribers strictly in `seq` order. A subscriber may run a command of its own while
   * being notified (a projection reacting to an event, a brain mailbox); its events are committed
   * at once but published only after the current batch, so no subscriber ever sees a later `seq`
   * before an earlier one.
   */
  private publish(): void {
    if (this.publishing) return; // the outer drain loop picks up what was just queued
    this.publishing = true;
    try {
      while (this.pending.length > 0) {
        const envelope = this.pending.shift()!;
        for (const subscriber of [...this.subscribers]) {
          try {
            subscriber(envelope);
          } catch (error) {
            this.onSubscriberError(error, envelope);
          }
        }
      }
    } finally {
      this.publishing = false;
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
   * Whether a client that last saw `since` of the log `logId` can be caught up by replay: it is
   * this log, the events after `since` are still in it and there are not too many of them.
   */
  canReplayFrom(since: number, logId?: string): boolean {
    if (logId !== this.logId) return false;
    const oldest = this.oldestSeq();
    const current = this.currentSeq();
    if (since > current) return false;
    if (oldest > 0 && since < oldest - 1) return false;
    return current - since <= this.maxReplay;
  }

  /** The current state of every table, consistent with the `seq` it reports. */
  snapshot(): TableSnapshot {
    return this.db.transaction(() => ({
      logId: this.logId,
      seq: this.currentSeq(),
      agents: this.tables.agents.all(),
      bodies: this.tables.bodies.all(),
      projects: this.tables.projects.all(),
      tasks: this.tables.tasks.all(),
      questions: this.tables.questions.all(),
      proposals: this.tables.proposals.all(),
    }))();
  }
}
