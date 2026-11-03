import { spawn } from 'node:child_process';

/**
 * JSON-RPC 2.0 over stdio, as `codex app-server` speaks it (P11-01 notes, Codex 1): one JSON object
 * per line, both ways. The client sends requests and notifications; the server sends responses,
 * notifications, and **server requests** (approvals, dynamic tool calls, questions) that the client
 * answers with the same id. The server omits `"jsonrpc"` on its own messages; we always send it.
 *
 * `RpcPeer` is transport-free: `write` sends one line, `receive` takes stdout chunks. The adapter
 * plugs it onto a supervised process; `queryAppServer` onto a short-lived child for the model list
 * and the usage figures.
 */

export type RequestId = number | string;

export interface RpcMessage {
  jsonrpc?: string;
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A JSON-RPC error response, thrown by `request()`. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method} failed: ${message}`);
  }
}

/** The connection closed (the process went away) while a request waited. */
export class RpcClosed extends Error {}

/** What a server request handler returns: a result, or a JSON-RPC error. */
export type ServerRequestReply = { result: unknown } | { error: { code: number; message: string } };

export interface RpcPeerOptions {
  write: (line: string) => void;
  /** A server request (it has an id); the reply goes back with that id. */
  onRequest: (method: string, params: unknown, id: RequestId) => Promise<ServerRequestReply>;
  onNotification: (method: string, params: unknown) => void;
  /** A line that is not JSON, or a handler that threw. */
  onError?: (error: unknown) => void;
}

export const METHOD_NOT_FOUND = -32601;

export class RpcPeer {
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private readonly waiting = new Map<
    RequestId,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly opts: RpcPeerOptions) {}

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcClosed(`${method}: the connection is closed`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** Feeds stdout; complete lines are dispatched. */
  receive(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.dispatch(line);
    }
  }

  /** Rejects every waiting request; later sends are dropped. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, w] of this.waiting) {
      this.waiting.delete(id);
      w.reject(new RpcClosed(`${w.method}: the connection closed`));
    }
  }

  private send(message: RpcMessage): void {
    try {
      this.opts.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.opts.onError?.(error);
    }
  }

  private dispatch(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch (error) {
      this.opts.onError?.(
        new Error(`not JSON from app-server: ${line.slice(0, 200)}`, { cause: error }),
      );
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      const id = msg.id;
      const method = msg.method;
      this.opts
        .onRequest(method, msg.params, id)
        .catch((error: unknown): ServerRequestReply => ({
          error: { code: -32603, message: (error as Error).message ?? String(error) },
        }))
        .then((reply) => {
          if (this.closed) return;
          this.send({ jsonrpc: '2.0', id, ...reply });
        })
        .catch((error: unknown) => this.opts.onError?.(error));
      return;
    }
    if (msg.method !== undefined) {
      try {
        this.opts.onNotification(msg.method, msg.params);
      } catch (error) {
        this.opts.onError?.(error);
      }
      return;
    }
    if (msg.id !== undefined) {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error)
        w.reject(new RpcError(w.method, msg.error.code, msg.error.message, msg.error.data));
      else w.resolve(msg.result);
    }
  }
}

/** The `initialize` every connection opens with; `experimentalApi` is needed for dynamic tools. */
export function initializeParams(version: string): Record<string, unknown> {
  return {
    clientInfo: { name: 'galactic-agents', title: 'GalacticAgents', version },
    capabilities: { experimentalApi: true, requestAttestation: false },
  };
}

export interface QueryOptions {
  command: string;
  /** Arguments before `app-server` (tests: the fake agent's script path). */
  args: string[];
  appServerArgs: string[];
  env: Record<string, string>;
  version: string;
  timeoutMs?: number;
}

/**
 * Starts a short-lived `codex app-server` (not an agent: no supervisor, no PID row, no turn),
 * initializes it, runs `fn` and kills it. Used for `model/list` and the account's rate limits.
 * Rejects on a timeout, a failed start or an early exit; server requests are refused.
 */
export async function queryAppServer<T>(
  opts: QueryOptions,
  fn: (peer: RpcPeer) => Promise<T>,
): Promise<T> {
  const child = spawn(opts.command, [...opts.args, 'app-server', ...opts.appServerArgs], {
    env: opts.env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const peer = new RpcPeer({
    write: (line) => child.stdin.write(line),
    onRequest: async () => ({ error: { code: METHOD_NOT_FOUND, message: 'not supported' } }),
    onNotification: () => {},
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => peer.receive(chunk));
  child.stdin.on('error', () => {});
  let timer: NodeJS.Timeout | undefined;
  const ended = new Promise<never>((_, reject) => {
    child.once('error', (error) => reject(error));
    child.once('exit', (code, signal) => {
      peer.close();
      reject(new Error(`codex app-server exited (${signal ?? `code ${code}`})`));
    });
    timer = setTimeout(
      () => reject(new Error('codex app-server did not answer in time')),
      opts.timeoutMs ?? 15_000,
    );
  });
  ended.catch(() => {});
  try {
    return await Promise.race([
      (async () => {
        await peer.request('initialize', initializeParams(opts.version));
        peer.notify('initialized');
        return fn(peer);
      })(),
      ended,
    ]);
  } finally {
    clearTimeout(timer);
    peer.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
