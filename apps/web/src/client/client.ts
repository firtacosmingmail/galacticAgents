import { ServerMessage } from '@galactic/protocol';

export type ConnectionStatus =
  'idle' | 'connecting' | 'catching_up' | 'live' | 'disconnected' | 'unauthorized' | 'closed';

/** The private close code the server uses for a bad token (`CLOSE_UNAUTHORIZED` on the server). */
export const CLOSE_UNAUTHORIZED = 4401;

export interface ClientOptions {
  url: string;
  token: string;
  /** The last `seq` this client applied, if it has state to resume from. */
  lastEventId?: number;
  onMessage: (message: ServerMessage) => void;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  /** Called whenever `lastEventId` advances (persist it for the next page load). */
  onLastEventId?: (seq: number) => void;
  reconnect?: { baseMs?: number; maxMs?: number; jitter?: boolean };
  /** Injectable for tests and non-browser environments. Defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  /** Injectable timer for tests. */
  setTimeoutImpl?: typeof setTimeout;
}

/**
 * The resumable client (TECHNOLOGY §6.3): sends `hello{token, lastEventId}`, applies the
 * snapshot or the replay, tracks `seq`, reconnects with backoff and resumes from the last seq it
 * applied. Every event is handed to `onMessage` exactly once, in order; a gap triggers a
 * reconnect instead of applying out-of-order state.
 */
export class GalacticClient {
  private socket: WebSocket | undefined;
  private attempt = 0;
  private closedByUser = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private _lastEventId: number | undefined;
  private _status: ConnectionStatus = 'idle';

  constructor(private readonly opts: ClientOptions) {
    this._lastEventId = opts.lastEventId;
  }

  get lastEventId(): number | undefined {
    return this._lastEventId;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.socket?.close(1000, 'client closed');
    this.socket = undefined;
    this.setStatus('closed');
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this._status = status;
    this.opts.onStatus?.(status, detail);
  }

  private open(): void {
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    this.setStatus('connecting');
    const socket = new WS(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      const hello = { type: 'hello', token: this.opts.token, lastEventId: this._lastEventId };
      socket.send(JSON.stringify(hello));
      this.setStatus('catching_up');
    };

    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      const parsed = ServerMessage.safeParse(JSON.parse(String(ev.data)));
      if (!parsed.success) {
        this.setStatus('disconnected', 'unreadable server message');
        socket.close(4002, 'unreadable message');
        return;
      }
      this.handle(parsed.data, socket);
    };

    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.closedByUser) return;
      if (ev.code === CLOSE_UNAUTHORIZED) {
        this.setStatus('unauthorized', ev.reason || 'bad token');
        return;
      }
      this.scheduleReconnect(ev.reason || `closed (${ev.code})`);
    };

    socket.onerror = () => {
      // `close` follows an error; nothing else to do here.
    };
  }

  private handle(message: ServerMessage, socket: WebSocket): void {
    switch (message.type) {
      case 'snapshot':
        this.advance(message.seq);
        this.opts.onMessage(message);
        this.attempt = 0;
        this.setStatus('live');
        return;
      case 'event': {
        const expected = (this._lastEventId ?? 0) + 1;
        if (message.seq < expected) return; // duplicate: already applied
        if (message.seq > expected && this._lastEventId !== undefined) {
          // A gap means the stream is not what we think; resume from what we know for sure.
          socket.close(4002, 'gap in event stream');
          return;
        }
        this.advance(message.seq);
        this.opts.onMessage(message);
        return;
      }
      case 'caught_up':
        this.advance(message.seq);
        this.opts.onMessage(message);
        this.attempt = 0;
        this.setStatus('live');
        return;
      case 'error':
        this.opts.onMessage(message);
        if (message.code === 'unauthorized') this.setStatus('unauthorized', message.message);
        return;
      case 'pong':
        this.opts.onMessage(message);
        return;
    }
  }

  private advance(seq: number): void {
    if (this._lastEventId !== undefined && seq <= this._lastEventId) return;
    this._lastEventId = seq;
    this.opts.onLastEventId?.(seq);
  }

  private scheduleReconnect(reason: string): void {
    const base = this.opts.reconnect?.baseMs ?? 500;
    const max = this.opts.reconnect?.maxMs ?? 15_000;
    const jitter = this.opts.reconnect?.jitter ?? true;
    const delay = Math.min(max, base * 2 ** this.attempt) * (jitter ? 0.5 + Math.random() : 1);
    this.attempt++;
    this.setStatus('disconnected', `${reason}; retrying in ${Math.round(delay)}ms`);
    const schedule = this.opts.setTimeoutImpl ?? setTimeout;
    this.timer = schedule(() => {
      this.timer = undefined;
      if (!this.closedByUser) this.open();
    }, delay);
  }
}
