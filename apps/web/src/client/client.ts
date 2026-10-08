import { CLOSE_UNAUTHORIZED, ServerMessage, unknownEventFrame } from '@galactic/protocol';

export type ConnectionStatus =
  'idle' | 'connecting' | 'catching_up' | 'live' | 'disconnected' | 'unauthorized' | 'closed';

/** `WebSocket.OPEN`, spelled out so injected implementations need not carry the constants. */
const WS_OPEN = 1;

export interface ClientOptions {
  url: string;
  token: string;
  /** The last `seq` this client applied, if it has state to resume from … */
  lastEventId?: number;
  /** … and the identity of the log it applied it from (`snapshot.logId`); both or neither. */
  logId?: string;
  onMessage: (message: ServerMessage) => void;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  /** Called whenever `lastEventId` advances (persist it for the next page load). */
  onLastEventId?: (seq: number) => void;
  reconnect?: { baseMs?: number; maxMs?: number; jitter?: boolean };
  /** Injectable for tests and non-browser environments. Defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  /** Injectable timer for tests. */
  setTimeoutImpl?: typeof setTimeout;
  /** The last transcript `seq` the client holds for an agent: re-subscriptions resume from it. */
  transcriptSince?: (agentId: string) => number;
  /** The last output `seq` the client holds for a run: re-subscriptions resume from it (P9-10). */
  runSince?: (runId: string) => number;
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
  private _logId: string | undefined;
  private _status: ConnectionStatus = 'idle';
  /** Agents whose transcript this client wants; re-sent after every reconnect. */
  private readonly transcripts = new Set<string>();
  /** Runs whose output this client wants (P9-10); re-sent after every reconnect. */
  private readonly runs = new Set<string>();

  constructor(private readonly opts: ClientOptions) {
    this._lastEventId = opts.lastEventId;
    this._logId = opts.logId;
  }

  get lastEventId(): number | undefined {
    return this._lastEventId;
  }

  /** The log the applied state belongs to; set by the first snapshot. */
  get logId(): string | undefined {
    return this._logId;
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

  /**
   * Opens the per-agent transcript stream (P1-06). Survives reconnects: the subscription is
   * re-sent with the last `seq` the store holds every time the stream goes live again.
   */
  subscribeTranscript(agentId: string): void {
    this.transcripts.add(agentId);
    if (this._status === 'live') this.sendTranscriptSubscribe(agentId);
  }

  unsubscribeTranscript(agentId: string): void {
    this.transcripts.delete(agentId);
    // Only an open socket can take it (a CONNECTING one throws); otherwise there is nothing to
    // undo: the next session re-subscribes the active subscriptions only.
    if (this.socket?.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify({ type: 'transcript.unsubscribe', agentId }));
    }
  }

  private sendTranscriptSubscribe(agentId: string): void {
    const since = this.opts.transcriptSince?.(agentId) ?? 0;
    this.socket?.send(JSON.stringify({ type: 'transcript.subscribe', agentId, since }));
  }

  /**
   * Opens a managed run's output stream (P9-08 `run.subscribe`; P9-10). Like a transcript, it
   * survives reconnects: re-sent from the last `seq` the store holds whenever the stream goes live.
   */
  subscribeRun(runId: string): void {
    this.runs.add(runId);
    if (this._status === 'live') this.sendRunSubscribe(runId);
  }

  unsubscribeRun(runId: string): void {
    this.runs.delete(runId);
    if (this.socket?.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify({ type: 'run.unsubscribe', runId }));
    }
  }

  private sendRunSubscribe(runId: string): void {
    const since = this.opts.runSince?.(runId) ?? 0;
    this.socket?.send(JSON.stringify({ type: 'run.subscribe', runId, since }));
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    const wentLive = status === 'live' && this._status !== 'live';
    this._status = status;
    this.opts.onStatus?.(status, detail);
    if (wentLive) {
      for (const agentId of this.transcripts) this.sendTranscriptSubscribe(agentId);
      for (const runId of this.runs) this.sendRunSubscribe(runId);
    }
  }

  private open(): void {
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    this.setStatus('connecting');
    const socket = new WS(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      // Resume only when we know which log our state came from; otherwise ask for a snapshot.
      const resume = this._logId !== undefined && this._lastEventId !== undefined;
      const hello = {
        type: 'hello',
        token: this.opts.token,
        ...(resume ? { lastEventId: this._lastEventId, logId: this._logId } : {}),
      };
      socket.send(JSON.stringify(hello));
      this.setStatus('catching_up');
    };

    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        // A frame that is not JSON carries nothing we could apply: skip it, keep the stream.
        console.warn('galactic: ignoring a server frame that is not JSON');
        return;
      }
      const parsed = ServerMessage.safeParse(data);
      if (!parsed.success) {
        // An event type a newer server added: skip it and move past its seq (TECHNOLOGY §6.3,
        // protocol evolution). Closing would resume from the same seq and loop on it.
        const unknown = unknownEventFrame(data);
        if (unknown) {
          this.skipUnknownEvent(unknown.seq, unknown.eventType, socket);
          return;
        }
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
        // A snapshot replaces whatever we had, possibly from another log: accept its seq as is.
        this._logId = message.logId;
        this._lastEventId = undefined;
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
      case 'status':
      case 'transcript':
      case 'run_output': // P9-08: only after the page's own `run.subscribe`
        this.opts.onMessage(message);
        return;
    }
  }

  /** An event this build cannot read: ordered like any event, then skipped (not applied). */
  private skipUnknownEvent(seq: number, eventType: string, socket: WebSocket): void {
    const expected = (this._lastEventId ?? 0) + 1;
    if (seq < expected) return;
    if (seq > expected && this._lastEventId !== undefined) {
      socket.close(4002, 'gap in event stream');
      return;
    }
    console.warn(
      `galactic: skipping event ${seq} of a type this page does not know (${eventType}); reload to get the newer build`,
    );
    this.advance(seq);
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
