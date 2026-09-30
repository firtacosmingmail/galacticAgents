import type { WebSocket } from 'ws';
import { ClientMessage, type EventEnvelope, type HelloMessage } from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import { CLOSE_PROTOCOL_VIOLATION, send, type SessionHandler } from './gateway.js';

export interface SessionOptions {
  /** Bytes queued on a socket before the connection is dropped as a slow consumer. */
  maxBufferedBytes?: number;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
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

    const fail = (code: number, error: 'protocol_violation', message: string) => {
      unsubscribe?.();
      unsubscribe = undefined;
      send(socket, { type: 'error', code: error, message });
      socket.close(code, error);
    };

    const deliver = (envelope: EventEnvelope) => {
      if (envelope.seq <= lastSent) return;
      if (socket.bufferedAmount > maxBuffered) {
        // A close frame would only queue behind the unread backlog: cut the connection instead.
        // The client reconnects with its lastEventId and catches up (or gets a snapshot).
        opts.log?.warn(`dropping slow consumer (${socket.bufferedAmount} bytes queued)`);
        unsubscribe?.();
        unsubscribe = undefined;
        socket.terminate();
        return;
      }
      lastSent = envelope.seq;
      send(socket, { type: 'event', ...envelope });
    };

    // 1. Subscribe first, then read: same tick, so nothing is missed.
    unsubscribe = log.subscribe(deliver);

    // 2. Snapshot or replay.
    const since = hello.lastEventId;
    if (since !== undefined && log.canReplayFrom(since, hello.logId)) {
      lastSent = since;
      for (const envelope of log.eventsSince(since)) {
        lastSent = envelope.seq;
        send(socket, { type: 'event', ...envelope });
      }
      send(socket, { type: 'caught_up', seq: lastSent });
      opts.log?.info(`ws session resumed from ${since}, replayed up to ${lastSent}`);
    } else {
      const snapshot = log.snapshot();
      lastSent = snapshot.seq;
      send(socket, { type: 'snapshot', ...snapshot });
      opts.log?.info(`ws session started with snapshot at ${snapshot.seq}`);
    }

    // 3. Live: only ping is allowed from the client for now; anything else is a violation.
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
      }
    });

    socket.on('close', () => {
      unsubscribe?.();
      unsubscribe = undefined;
    });
    socket.on('error', () => {
      unsubscribe?.();
      unsubscribe = undefined;
    });
  };
}
