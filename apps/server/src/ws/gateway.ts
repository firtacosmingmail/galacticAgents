import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientMessage,
  type ErrorMessage,
  type HelloMessage,
  type ServerMessage,
} from '@galactic/protocol';
import { isAllowedHost, isAllowedOrigin, tokenMatches } from '../http/security.js';
import type { ServerConfig } from '../config/config.js';

/** WebSocket close codes in the private 4xxx range. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_BAD_HELLO = 4400;
export const CLOSE_HELLO_TIMEOUT = 4408;
export const CLOSE_PROTOCOL_VIOLATION = 4002;
export const CLOSE_SLOW_CONSUMER = 4003;

export const HELLO_TIMEOUT_MS = 5_000;

/** Called once a socket has sent a valid, authenticated `hello`. P0-08 supplies the real one. */
export type SessionHandler = (socket: WebSocket, hello: HelloMessage, req: IncomingMessage) => void;

export interface GatewayOptions {
  config: Pick<ServerConfig, 'token' | 'allowedHosts'>;
  path?: string;
  onSession: SessionHandler;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function refuse(socket: WebSocket, code: number, error: Omit<ErrorMessage, 'type'>): void {
  send(socket, { type: 'error', ...error });
  socket.close(code, error.code);
}

/**
 * The WebSocket gateway: refuses upgrades with a bad `Host` or foreign `Origin` (TECHNOLOGY §8),
 * then requires `hello{token}` as the first frame (TECHNOLOGY §6.3) before handing the socket over.
 */
export class WsGateway {
  readonly wss: WebSocketServer;
  readonly path: string;

  constructor(private readonly opts: GatewayOptions) {
    this.path = opts.path ?? '/ws';
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (socket, req) => this.awaitHello(socket, req));
  }

  /** Wire this to the HTTP server's `upgrade` event. */
  handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (url.pathname !== this.path) {
      this.deny(socket, 404, 'Not Found');
      return;
    }
    if (!isAllowedHost(req.headers.host, this.opts.config.allowedHosts)) {
      this.opts.log?.warn(`ws upgrade refused: bad Host ${req.headers.host ?? '<none>'}`);
      this.deny(socket, 403, 'Forbidden');
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, this.opts.config.allowedHosts)) {
      this.opts.log?.warn(`ws upgrade refused: bad Origin ${req.headers.origin ?? '<none>'}`);
      this.deny(socket, 403, 'Forbidden');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  };

  private deny(socket: Duplex, status: number, text: string): void {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private awaitHello(socket: WebSocket, req: IncomingMessage): void {
    const timer = setTimeout(() => {
      refuse(socket, CLOSE_HELLO_TIMEOUT, {
        code: 'bad_hello',
        message: 'hello expected within 5s',
      });
    }, HELLO_TIMEOUT_MS);

    socket.once('message', (data) => {
      clearTimeout(timer);
      let parsed: ReturnType<typeof ClientMessage.safeParse>;
      try {
        parsed = ClientMessage.safeParse(JSON.parse(data.toString()));
      } catch {
        refuse(socket, CLOSE_BAD_HELLO, { code: 'bad_hello', message: 'first frame must be JSON' });
        return;
      }
      if (!parsed.success || parsed.data.type !== 'hello') {
        refuse(socket, CLOSE_BAD_HELLO, {
          code: 'bad_hello',
          message: 'first frame must be hello{token}',
        });
        return;
      }
      if (!tokenMatches(parsed.data.token, this.opts.config.token)) {
        this.opts.log?.warn('ws hello refused: bad token');
        refuse(socket, CLOSE_UNAUTHORIZED, { code: 'unauthorized', message: 'bad token' });
        return;
      }
      this.opts.onSession(socket, parsed.data, req);
    });
  }

  close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
