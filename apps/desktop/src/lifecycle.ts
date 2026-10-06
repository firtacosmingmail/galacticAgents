import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HealthResponse } from '@galactic/protocol';

/**
 * The server's lifecycle as the desktop shell manages it (P8-06).
 *
 * **Attach or start.** The data lock (`<db>.lock`, P8-03) says which process owns the database. A
 * live server holder whose `/health` answers is attached to; the shell never starts a second
 * Mission Control on the same data (the server would refuse anyway). No holder (or a stale one)
 * means the shell starts its own with `galactic start --no-open` (node + the built server and web
 * app). Liveness here is only "the pid exists and `/health` answers as galactic-agents": whether a
 * lock is stale is decided by the server itself when it starts — a start the lock refuses
 * ("… is using …") sends the shell back to attaching.
 *
 * **Stop.** Only a server this shell started is stopped (SIGTERM to the launcher, which forwards
 * it; the server stops its agents and exits; SIGKILL to the launcher's own process group after a
 * deadline). An attached server is never signalled.
 *
 * Paths follow the server's `dataPaths` (`apps/server/src/config/config.ts`): `$GALACTIC_HOME` or
 * `~/.galactic`, the database `$GALACTIC_DB` or `<home>/galactic.sqlite`, the token
 * `$GALACTIC_TOKEN` or `config.json`'s `token`.
 */

export interface DataPaths {
  dataDir: string;
  configPath: string;
  dbPath: string;
  lockPath: string;
}

export function dataPaths(env: NodeJS.ProcessEnv): DataPaths {
  const dataDir = env['GALACTIC_HOME'] ?? join(homedir(), '.galactic');
  const dbPath = env['GALACTIC_DB'] ?? join(dataDir, 'galactic.sqlite');
  return { dataDir, configPath: join(dataDir, 'config.json'), dbPath, lockPath: `${dbPath}.lock` };
}

/** The token the status socket sends: never logged, never written to stdout. */
export function readToken(env: NodeJS.ProcessEnv, paths: DataPaths): string | undefined {
  const fromEnv = env['GALACTIC_TOKEN'];
  if (fromEnv) return fromEnv;
  try {
    const parsed = JSON.parse(readFileSync(paths.configPath, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

/** What the data lock says (the server's `DataLockInfo`, read leniently). */
export interface LockHolder {
  pid: number;
  role: string;
  port?: number;
}

export function readLock(lockPath: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.role !== 'string') return undefined;
    return {
      pid: parsed.pid,
      role: parsed.role,
      ...(typeof parsed.port === 'number' ? { port: parsed.port } : {}),
    };
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const urlOf = (port: number) => `http://127.0.0.1:${port}`;

/**
 * Whether Mission Control answers on the port. The request sends no `Sec-Fetch-Site`, so the
 * server never puts the token in the answer (TECHNOLOGY §8).
 */
export async function healthy(
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${urlOf(port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    return HealthResponse.safeParse(await res.json()).success;
  } catch {
    return false;
  }
}

/**
 * What the lock says to do now:
 * - `attach`: a live server holder answering on its port;
 * - `wait`: a live holder that is starting, not answering yet, or an import / restore;
 * - `start`: no holder, or one whose process is gone.
 */
export type Plan =
  | { kind: 'attach'; port: number; pid: number }
  | { kind: 'wait'; holder: LockHolder; why: string }
  | { kind: 'start' };

export interface PlanDeps {
  readLock: (path: string) => LockHolder | undefined;
  alive: (pid: number) => boolean;
  healthy: (port: number) => Promise<boolean>;
}

export const DEFAULT_PLAN_DEPS: PlanDeps = {
  readLock,
  alive: pidAlive,
  healthy: (p) => healthy(p),
};

export async function plan(paths: DataPaths, deps: PlanDeps = DEFAULT_PLAN_DEPS): Promise<Plan> {
  const holder = deps.readLock(paths.lockPath);
  if (!holder || !deps.alive(holder.pid)) return { kind: 'start' };
  if (holder.role !== 'server') {
    return { kind: 'wait', holder, why: `a galactic ${holder.role} is using the data` };
  }
  if (holder.port === undefined)
    return { kind: 'wait', holder, why: 'Mission Control is starting' };
  if (await deps.healthy(holder.port))
    return { kind: 'attach', port: holder.port, pid: holder.pid };
  return { kind: 'wait', holder, why: `Mission Control (pid ${holder.pid}) does not answer` };
}

/** Hides the token in a line of the launcher's output (its banner prints it). */
export function redactLine(line: string): string {
  return /token/i.test(line) && /Token:\s*\S/.test(line)
    ? line.replace(/(Token:\s*)\S+/, '$1(hidden)')
    : line;
}

export type StartResult =
  | { kind: 'started'; port: number; pid: number }
  | { kind: 'locked' }
  | { kind: 'failed'; reason: string };

export interface OwnServerOptions {
  /** `apps/server/bin/galactic.mjs`. */
  launcher: string;
  node?: string;
  env: NodeJS.ProcessEnv;
  /** `--port`, from `GALACTIC_PORT` (the server reads that too). */
  port?: number;
  log: (line: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  spawnImpl?: typeof spawn;
  startTimeoutMs?: number;
}

/** The server this shell started; the only one it ever signals. */
export class OwnServer {
  private child: ChildProcess | undefined;
  private exited = false;
  private exitWaiters: (() => void)[] = [];

  constructor(private readonly opts: OwnServerOptions) {}

  get pid(): number | undefined {
    return this.exited ? undefined : this.child?.pid;
  }

  get running(): boolean {
    return this.child !== undefined && !this.exited;
  }

  /** Starts `galactic start --no-open` and resolves once it listens (or fails, or is refused). */
  start(): Promise<StartResult> {
    const { opts } = this;
    const args = [opts.launcher, 'start', '--no-open'];
    if (opts.port !== undefined) args.push('--port', String(opts.port));
    const child = (opts.spawnImpl ?? spawn)(opts.node ?? process.execPath, args, {
      env: opts.env,
      // Its own process group: a last-resort SIGKILL reaches the launcher and the server (the
      // server's agents run in groups of their own and are reconciled by its next start).
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exited = false;
    let output = '';
    return new Promise<StartResult>((resolve) => {
      let settled = false;
      const settle = (r: StartResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(
        () => settle({ kind: 'failed', reason: 'Mission Control did not start in time' }),
        opts.startTimeoutMs ?? 120_000,
      );
      const onLine = (line: string) => {
        if (output.length < 8000) output += line + '\n';
        opts.log(`[server] ${redactLine(line)}`);
        const m = /listening on http:\/\/[^\s:]+:(\d+)/.exec(line);
        if (m && child.pid !== undefined) {
          settle({ kind: 'started', port: Number(m[1]), pid: child.pid });
        }
      };
      lines(child.stdout, onLine);
      lines(child.stderr, onLine);
      child.on('error', (error) => {
        this.markExited();
        settle({ kind: 'failed', reason: error.message });
      });
      child.on('exit', (code, signal) => {
        this.markExited();
        // After it listened, an exit is the server going away: the caller decides what next.
        if (settled) {
          opts.onExit(code, signal);
          return;
        }
        if (/is using .*\(lock /.test(output)) settle({ kind: 'locked' });
        else {
          const last = output.trim().split('\n').slice(-1)[0] ?? '';
          settle({
            kind: 'failed',
            reason: `Mission Control exited (${code ?? signal})${last ? `: ${redactLine(last)}` : ''}`,
          });
        }
      });
    });
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    for (const w of this.exitWaiters.splice(0)) w();
  }

  private whenExited(ms: number): Promise<boolean> {
    if (this.exited || !this.child) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Stops it: SIGTERM to the launcher (forwarded to the server, which stops its agents within its
   * own 25 s deadline), then SIGKILL to the launcher's group after `graceMs`. Nothing is signalled
   * once it has exited, so a recycled pid is never hit.
   */
  async stop(graceMs = 35_000): Promise<void> {
    const child = this.child;
    if (!child || this.exited || child.pid === undefined) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    if (await this.whenExited(graceMs)) return;
    if (this.exited) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await this.whenExited(5000);
  }
}

function lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffered += chunk;
    let i;
    while ((i = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, i).replace(/\r$/, '');
      buffered = buffered.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buffered.trim()) onLine(buffered);
    buffered = '';
  });
}
