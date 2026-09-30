import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '@galactic/protocol';
import { buildApp, type AppOptions } from '../app.js';
import type { ServerConfig } from '../config/config.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export function testConfig(
  overrides: Partial<ServerConfig> = {},
): ServerConfig & { cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'galactic-test-'));
  return {
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', '*.ts.net'],
    dev: true,
    dataDir,
    configPath: join(dataDir, 'config.json'),
    dbPath: join(dataDir, 'galactic.sqlite'),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
    ...overrides,
  };
}

export async function startTestApp(opts: Partial<AppOptions> = {}) {
  const config = opts.config ?? testConfig();
  const app = buildApp({ ...opts, config });
  const port = await app.listen();
  return {
    app,
    config,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async stop() {
      await app.close();
      if ('cleanup' in config) (config as { cleanup: () => void }).cleanup();
    },
  };
}

export interface WsOutcome {
  /** Messages received before the socket closed (or until `until` returned true). */
  messages: ServerMessage[];
  closeCode?: number;
  /** Set when the upgrade itself was refused (HTTP status) or the connection errored. */
  error?: string;
}

/**
 * Opens a socket, optionally sends frames, and collects server messages until the socket closes
 * or `until(messages)` is satisfied.
 */
export function connectWs(
  url: string,
  options: {
    headers?: Record<string, string>;
    origin?: string;
    send?: unknown[];
    until?: (messages: ServerMessage[]) => boolean;
    timeoutMs?: number;
  } = {},
): Promise<WsOutcome> {
  return new Promise((resolve) => {
    const messages: ServerMessage[] = [];
    const wsOptions: WebSocket.ClientOptions = { headers: options.headers ?? {} };
    if (options.origin !== undefined) wsOptions.origin = options.origin;
    const ws = new WebSocket(url, wsOptions);
    const done = (extra: Partial<WsOutcome>) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.terminate();
      resolve({ messages, ...extra });
    };
    const timer = setTimeout(() => done({ error: 'timeout' }), options.timeoutMs ?? 5_000);
    ws.on('unexpected-response', (_req, res) => done({ error: `http ${res.statusCode}` }));
    ws.on('error', (err) => done({ error: err.message }));
    ws.on('open', () => {
      for (const frame of options.send ?? []) {
        ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
      }
    });
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as ServerMessage);
      if (options.until?.(messages)) done({});
    });
    ws.on('close', (code) => done({ closeCode: code }));
  });
}
