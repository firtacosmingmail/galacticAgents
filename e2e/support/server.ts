import { spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The real Mission Control server for the smoke tests (P8-05): the production build
 * (`apps/server/dist`, serving `apps/web/dist`), in development mode for the scene harness's fake
 * agents (`/dev/harness/*`, decision 79), the Harmonizer on the fake adapter, a fresh data
 * directory and projects root under the system's temp directory, and a free port the OS picks
 * (`GALACTIC_PORT=0`, never 4321 or 5173). No real Claude: nothing here can start one — the
 * Harmonizer is `fake` and the harness's agents have no process.
 *
 * The token is the one the server generates on its first start and writes to the temp
 * `config.json` (read back here). The config is seeded with the first-run setup done (so the
 * wizard does not cover the panel) and the `balanced` quality tier.
 */
export interface E2eServer {
  baseURL: string;
  token: string;
  home: string;
  pid: number;
  stop: () => Promise<void>;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_ENTRY = join(REPO_ROOT, 'apps', 'server', 'dist', 'index.js');
const WEB_DIR = join(REPO_ROOT, 'apps', 'web', 'dist');
const LISTENING = /listening on (http:\/\/[^\s]+)/;
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;

export async function startServer(): Promise<E2eServer> {
  for (const [path, what] of [
    [SERVER_ENTRY, 'the server'],
    [join(WEB_DIR, 'index.html'), 'the web app'],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`${what} is not built (${path} missing): run \`pnpm build\` first`);
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'galactic-e2e-'));
  const home = join(root, 'home');
  const projects = join(root, 'projects');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(projects, { recursive: true });
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ setupCompletedAt: '2026-01-01T00:00:00.000Z', qualityTier: 'balanced' }),
    { mode: 0o600 },
  );

  // Nothing of the caller's GALACTIC_* settings leaks in (a GALACTIC_HOME would point at a real
  // data directory, a GALACTIC_HARMONIZER at a real runtime).
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GALACTIC_')) env[k] = v;
  Object.assign(env, {
    GALACTIC_HOME: home,
    GALACTIC_PROJECTS_ROOT: projects,
    GALACTIC_PORT: '0',
    GALACTIC_DEV: '1',
    GALACTIC_HARMONIZER: 'fake',
    GALACTIC_WEB_DIR: WEB_DIR,
    GALACTIC_LOG: 'silent',
  });

  const logPath = join(root, 'server.log');
  const log = createWriteStream(logPath);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.pipe(log);

  let baseURL: string;
  try {
    baseURL = await waitForListening(child, log);
  } catch (error) {
    await kill(child);
    log.end();
    const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-4000) : '';
    throw new Error(`the server did not start: ${(error as Error).message}\n${tail}`, {
      cause: error,
    });
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { token?: string };
  if (!config.token) throw new Error('the server wrote no token to its config');

  return {
    baseURL,
    token: config.token,
    home,
    pid: child.pid!,
    stop: async () => {
      await kill(child);
      log.end();
      if (process.env['E2E_KEEP'] === '1') console.log(`[e2e] kept the server's files in ${root}`);
      else rmSync(root, { recursive: true, force: true });
    },
  };
}

function waitForListening(child: ChildProcess, log: NodeJS.WritableStream): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error(`no "listening" line within ${START_TIMEOUT_MS} ms`)),
      START_TIMEOUT_MS,
    );
    child.stdout!.on('data', (chunk: Buffer) => {
      log.write(chunk);
      buffer += chunk.toString('utf8');
      const match = LISTENING.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]!);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`the server exited (${signal ?? code}) before listening`));
    });
  });
}

/** SIGTERM (the server's graceful stop), then SIGKILL if it is still there after the deadline. */
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGTERM');
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<'timeout'>((r) => {
    timeout = setTimeout(() => r('timeout'), STOP_TIMEOUT_MS);
  });
  const outcome = await Promise.race([exited, timer]);
  clearTimeout(timeout);
  if (outcome === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}
