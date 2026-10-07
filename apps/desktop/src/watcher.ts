import {
  applyEvent,
  applySnapshot,
  CLOSE_UNAUTHORIZED,
  emptyWorld,
  countDeliverables,
  notificationOf,
  ServerMessage,
  unknownEventFrame,
  type EventEnvelope,
  type NotificationKind,
  type NotificationLookup,
  type PanelNotification,
  type StorageCondition,
  type WorldState,
} from '@galactic/protocol';

/**
 * The shell's status watcher (P8-06): one read-only WebSocket session to Mission Control, folded
 * with the protocol's own `applySnapshot` / `applyEvent` (the page's fold), from which the menu
 * bar's state and the OS notifications are derived.
 *
 * - **Waiting count**: open questions the user holds plus cards waiting for a decision — the
 *   page's "N waiting for you" (`waitingForUserCount` in `apps/web/src/panel/inbox-model.ts`).
 * - **Storage**: the snapshot's and the `status` messages' `storage` (P8-09).
 * - **Notifications** (`notificationOf`, the page's and the server's function, so ids match): only
 *   the kinds in `SHELL_NOTIFICATION_KINDS` (Web Push's kinds, decision 95: permission, question,
 *   project finished, project failed). Never a replay of history: the first snapshot sets the
 *   baseline. Events missed while the socket was down come back as the resume's replay; once it is
 *   caught up, what is still current (a question still open and still the user's) and at most a
 *   day old is shown — the five most important one by one, the rest folded into one "N more"
 *   (decision 59's backfill rule). A snapshot instead of a replay (another database, or the server
 *   could not resume) sets a new baseline without notifying. Each id is notified once per run.
 *
 * The token is read through `token()` on every connect (a reset token is picked up) and sent only
 * in the `hello` frame; it is never logged.
 */

/** The kinds the shell posts (the push kinds: SPEC decisions 59, 95; proposed decision in notes). */
export const SHELL_NOTIFICATION_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  'permission',
  'question',
  'project_completed',
  'project_failed',
]);

export const BACKFILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BACKFILL_MAX_SHOWN = 5;
/** How many notified ids are remembered (dedup across reconnects). */
const REMEMBERED_IDS = 2000;

export type WatcherConnection = 'connecting' | 'live' | 'disconnected' | 'unauthorized';

export interface WatcherState {
  connection: WatcherConnection;
  waiting: number;
  storage: StorageCondition;
  /** Why it is disconnected (no secrets). */
  detail?: string;
}

export interface ShellNotification {
  id: string;
  title: string;
  body?: string;
}

/** The part of a WebSocket the watcher uses (the global one in Node ≥ 22; a fake in tests). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WatcherOptions {
  /** `ws://127.0.0.1:<port>/ws`. */
  url: string;
  /** The token, read on every connect; undefined when it cannot be read (retried later). */
  token: () => string | undefined;
  onState: (state: WatcherState) => void;
  onNotify: (n: ShellNotification) => void;
  openSocket?: (url: string) => SocketLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  reconnect?: { baseMs?: number; maxMs?: number };
}

/** The page's "waiting for you" number (inbox-model.ts `waitingForUserCount`). */
export function waitingForUser(world: Pick<WorldState, 'questions' | 'proposals'>): number {
  let n = 0;
  for (const q of Object.values(world.questions))
    if (q.status === 'open' && q.holder.type === 'user') n++;
  for (const p of Object.values(world.proposals))
    if (p.state === 'pending' || p.state === 'edited') n++;
  return n;
}

const lookupOf = (world: WorldState): NotificationLookup => ({
  task: (id) => world.tasks[id],
  project: (id) => world.projects[id],
  question: (id) => world.questions[id],
  agent: (id) => world.agents[id],
  // Decision 134: "Task finished · 2 deliverables" (older servers send none: no count).
  deliverables: (target) => countDeliverables(Object.values(world.deliverables ?? {}), target),
});

const importance = (n: PanelNotification) =>
  n.kind === 'permission' ? 0 : n.kind === 'question' ? 1 : 2;

/** Whether a notification is still worth showing after a replay (an answered question is not). */
function stillCurrent(n: PanelNotification, world: WorldState): boolean {
  if (n.target.kind !== 'question') return true;
  const q = world.questions[n.target.id];
  return q !== undefined && q.status === 'open' && q.holder.type === 'user';
}

export class StatusWatcher {
  private socket: SocketLike | undefined;
  private world: WorldState = emptyWorld();
  private logId: string | undefined;
  private lastSeq: number | undefined;
  private storage: StorageCondition = 'ok';
  private connection: WatcherConnection = 'connecting';
  private detail: string | undefined;
  /** Replaying after a resume: notifications are collected until `caught_up`. */
  private replaying = false;
  private pending: PanelNotification[] = [];
  private readonly notified: string[] = [];
  private readonly notifiedSet = new Set<string>();
  private attempt = 0;
  private timer: unknown;
  private stopped = false;
  private lastSent: string | undefined;

  constructor(private readonly opts: WatcherOptions) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) (this.opts.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, 'shell closed');
  }

  /** The state as last reported (tests). */
  get state(): WatcherState {
    return this.current();
  }

  private current(): WatcherState {
    return {
      connection: this.connection,
      waiting: waitingForUser(this.world),
      storage: this.storage,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }

  private report(): void {
    const state = this.current();
    const key = JSON.stringify(state);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.opts.onState(state);
  }

  private setConnection(connection: WatcherConnection, detail?: string): void {
    this.connection = connection;
    this.detail = detail;
    this.report();
  }

  private open(): void {
    if (this.stopped) return;
    const token = this.opts.token();
    if (!token) {
      this.setConnection('disconnected', 'the token cannot be read');
      this.scheduleReconnect();
      return;
    }
    let socket: SocketLike;
    try {
      socket = (this.opts.openSocket ?? defaultOpenSocket)(this.opts.url);
    } catch {
      this.setConnection('disconnected', 'cannot open the socket');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    if (this.connection !== 'disconnected') this.setConnection('connecting');
    socket.onopen = () => {
      if (this.socket !== socket) return;
      const resume = this.logId !== undefined && this.lastSeq !== undefined;
      socket.send(
        JSON.stringify({
          type: 'hello',
          token,
          ...(resume ? { lastEventId: this.lastSeq, logId: this.logId } : {}),
        }),
      );
      this.replaying = resume;
      this.pending = [];
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const parsed = ServerMessage.safeParse(data);
      if (!parsed.success) {
        const unknown = unknownEventFrame(data);
        if (unknown) {
          if (!this.inOrder(unknown.seq, socket)) return;
          this.lastSeq = unknown.seq;
          return;
        }
        socket.close(4002, 'unreadable message');
        return;
      }
      this.handle(parsed.data, socket);
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.stopped) return;
      if (ev.code === CLOSE_UNAUTHORIZED) {
        this.setConnection('unauthorized', 'the token was refused');
      } else {
        this.setConnection('disconnected', ev.reason || `closed (${ev.code})`);
      }
      this.scheduleReconnect();
    };
    socket.onerror = () => {};
  }

  /** False (and a reconnect to resume) when an event skips ahead; false for a duplicate. */
  private inOrder(seq: number, socket: SocketLike): boolean {
    const expected = (this.lastSeq ?? 0) + 1;
    if (seq < expected) return false;
    if (seq > expected && this.lastSeq !== undefined) {
      socket.close(4002, 'gap in event stream');
      return false;
    }
    return true;
  }

  private handle(message: ServerMessage, socket: SocketLike): void {
    switch (message.type) {
      case 'snapshot': {
        // A new baseline: nothing before it is notified (never a replay of history).
        this.world = applySnapshot(message);
        this.logId = message.logId;
        this.lastSeq = message.seq;
        this.storage = message.storage?.condition ?? 'ok';
        this.replaying = false;
        this.pending = [];
        this.attempt = 0;
        this.setConnection('live');
        return;
      }
      case 'event': {
        if (!this.inOrder(message.seq, socket)) return;
        const { type: _type, ...envelope } = message;
        this.world = applyEvent(this.world, envelope);
        this.lastSeq = message.seq;
        this.consider(envelope);
        this.report();
        return;
      }
      case 'caught_up': {
        this.lastSeq = Math.max(this.lastSeq ?? 0, message.seq);
        this.flushReplay();
        this.attempt = 0;
        this.setConnection('live');
        return;
      }
      case 'status':
        if (message.storage) {
          this.storage = message.storage.condition;
          this.report();
        }
        return;
      case 'error':
        if (message.code === 'unauthorized')
          this.setConnection('unauthorized', 'the token was refused');
        return;
      default:
        return;
    }
  }

  private consider(envelope: EventEnvelope): void {
    const n = notificationOf(envelope, lookupOf(this.world));
    if (!n || !SHELL_NOTIFICATION_KINDS.has(n.kind)) return;
    if (this.replaying) {
      this.pending.push(n);
      return;
    }
    this.post(n);
  }

  private flushReplay(): void {
    const now = (this.opts.now ?? Date.now)();
    const fresh = this.pending.filter(
      (n) =>
        !this.notifiedSet.has(n.id) &&
        now - Date.parse(n.at) <= BACKFILL_MAX_AGE_MS &&
        stillCurrent(n, this.world),
    );
    this.replaying = false;
    this.pending = [];
    const unique = [...new Map(fresh.map((n) => [n.id, n])).values()];
    unique.sort((a, b) => importance(a) - importance(b) || b.seq - a.seq);
    for (const n of unique.slice(0, BACKFILL_MAX_SHOWN)) this.post(n);
    const rest = unique.slice(BACKFILL_MAX_SHOWN);
    for (const n of rest) this.remember(n.id);
    if (rest.length > 0) {
      this.opts.onNotify({
        id: `galactic:backfill-summary:${this.lastSeq ?? 0}`,
        title: `${rest.length} more update${rest.length === 1 ? '' : 's'} while disconnected`,
        body: 'Open GalacticAgents to see them.',
      });
    }
  }

  private remember(id: string): boolean {
    if (this.notifiedSet.has(id)) return false;
    this.notifiedSet.add(id);
    this.notified.push(id);
    while (this.notified.length > REMEMBERED_IDS) {
      const old = this.notified.shift();
      if (old !== undefined) this.notifiedSet.delete(old);
    }
    return true;
  }

  private post(n: PanelNotification): void {
    if (!this.remember(n.id)) return;
    this.opts.onNotify({ id: n.id, title: n.title, ...(n.body ? { body: n.body } : {}) });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = this.opts.reconnect?.baseMs ?? 500;
    const max = this.opts.reconnect?.maxMs ?? 10_000;
    const delay = Math.min(max, base * 2 ** this.attempt);
    this.attempt++;
    const set = this.opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = undefined;
      this.open();
    }, delay);
  }
}

function defaultOpenSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}
