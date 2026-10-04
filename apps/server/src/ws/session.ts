import type { WebSocket } from 'ws';
import { ClientMessage, type EventEnvelope, type HelloMessage } from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import type { StatusStore } from '../runtime/status-store.js';
import type { TranscriptPipeline } from '../runtime/transcripts.js';
import { CLOSE_PROTOCOL_VIOLATION, send, type SessionHandler } from './gateway.js';
import { buildSnapshot } from './snapshot.js';

export interface SessionOptions {
  /** Bytes queued on a socket before the connection is dropped as a slow consumer. */
  maxBufferedBytes?: number;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
  /** The per-agent transcript stream (P1-06); without it, subscriptions are refused. */
  transcripts?: TranscriptPipeline;
  /** The status store (P1-05): its batched diffs go out as `status` messages. */
  statuses?: StatusStore;
}

/**
 * The resumable stream (TECHNOLOGY §6.3): after `hello`, either a `snapshot` or the events since
 * `lastEventId` followed by `caught_up`, then the live `{seq, event}` stream in strict order.
 *
 * Subscribing and reading the log happen in the same synchronous tick, so no event can slip
 * between "what the client got" and "what it will get"; `lastSent` additionally drops anything
 * already covered by the snapshot or the replay.
 */
export function createSessionHandler(log: EventLog, opts: SessionOptions = {}): SessionHandler {
  const maxBuffered = opts.maxBufferedBytes ?? 4 * 1024 * 1024;

  return (socket: WebSocket, hello: HelloMessage) => {
    let lastSent = 0;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeStatus: (() => void) | undefined;
    /** Transcript subscriptions of this socket, one per agent. */
    const transcriptSubs = new Map<string, () => void>();

    const teardown = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      unsubscribeStatus?.();
      unsubscribeStatus = undefined;
      for (const off of transcriptSubs.values()) off();
      transcriptSubs.clear();
    };

    const fail = (code: number, error: 'protocol_violation', message: string) => {
      teardown();
      send(socket, { type: 'error', code: error, message });
      socket.close(code, error);
    };

    /** True when the socket can take more; otherwise it is cut as a slow consumer. */
    const ready = (): boolean => {
      if (socket.bufferedAmount <= maxBuffered) return true;
      // A close frame would only queue behind the unread backlog: cut the connection instead.
      // The client reconnects with its lastEventId and catches up (or gets a snapshot), and
      // re-subscribes its transcripts with `since`.
      opts.log?.warn(`dropping slow consumer (${socket.bufferedAmount} bytes queued)`);
      teardown();
      socket.terminate();
      return false;
    };

    const deliver = (envelope: EventEnvelope) => {
      if (envelope.seq <= lastSent) return;
      if (!ready()) return;
      lastSent = envelope.seq;
      send(socket, { type: 'event', ...envelope });
    };

    // 1. Subscribe first, then read: same tick, so nothing is missed.
    unsubscribe = log.subscribe(deliver);
    unsubscribeStatus = opts.statuses?.subscribe((statuses, removed) => {
      if (!ready()) return;
      send(socket, { type: 'status', statuses, ...(removed.length > 0 ? { removed } : {}) });
    });

    // 2. Snapshot or replay.
    const since = hello.lastEventId;
    if (since !== undefined && log.canReplayFrom(since, hello.logId)) {
      lastSent = since;
      for (const envelope of log.eventsSince(since)) {
        lastSent = envelope.seq;
        send(socket, { type: 'event', ...envelope });
      }
      send(socket, { type: 'caught_up', seq: lastSent, serverTime: new Date().toISOString() });
      // Records are server-owned (TECHNOLOGY §4): a replaying client cannot derive them, so it
      // gets the current set right after the replay, like a snapshot would have carried it. The
      // set replaces the client's (P1-38): records retention dropped while it was away go too.
      if (opts.statuses)
        send(socket, { type: 'status', statuses: opts.statuses.all(), replace: true });
      opts.log?.info(`ws session resumed from ${since}, replayed up to ${lastSent}`);
    } else {
      const snapshot = buildSnapshot(log, opts.statuses);
      lastSent = snapshot.seq;
      send(socket, { type: 'snapshot', ...snapshot, serverTime: new Date().toISOString() });
      opts.log?.info(`ws session started with snapshot at ${snapshot.seq}`);
    }

    // 3. Live: pings and transcript subscriptions; anything else is a violation.
    socket.on('message', (data) => {
      let parsed: ReturnType<typeof ClientMessage.safeParse>;
      try {
        parsed = ClientMessage.safeParse(JSON.parse(data.toString()));
      } catch {
        fail(CLOSE_PROTOCOL_VIOLATION, 'protocol_violation', 'frames must be JSON');
        return;
      }
      if (!parsed.success) {
        fail(CLOSE_PROTOCOL_VIOLATION, 'protocol_violation', 'unknown client message');
        return;
      }
      switch (parsed.data.type) {
        case 'ping':
          send(socket, { type: 'pong' });
          break;
        case 'hello':
          fail(
            CLOSE_PROTOCOL_VIOLATION,
            'protocol_violation',
            'hello must be the first frame only',
          );
          break;
        case 'transcript.subscribe': {
          const { agentId, since } = parsed.data;
          if (!opts.transcripts) {
            send(socket, {
              type: 'error',
              code: 'unsupported',
              message: 'transcripts unavailable',
            });
            break;
          }
          transcriptSubs.get(agentId)?.();
          transcriptSubs.set(
            agentId,
            opts.transcripts.subscribe(agentId, since ?? 0, (chunks) => {
              if (ready()) send(socket, { type: 'transcript', agentId, chunks });
            }),
          );
          break;
        }
        case 'transcript.unsubscribe':
          transcriptSubs.get(parsed.data.agentId)?.();
          transcriptSubs.delete(parsed.data.agentId);
          break;
      }
    });

    socket.on('close', teardown);
    socket.on('error', teardown);
  };
}
