import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import type { IPty } from 'node-pty';

/**
 * `node-pty` behind the supervisor's `fork` hook (P8-08). The one module that touches the native
 * package: loaded on the first PTY spawn (a server without a `pty` runtime never loads it), and
 * wrapped in the `ChildProcess` stand-in the supervisor watches like any child — so the CLI gets
 * the launch intent, the PID-table row, the agent marker, the graceful stop and the group reaping
 * every other agent process gets. `forkpty` makes the child a session leader: its pid is its
 * process group, which is what the supervisor signals.
 */

type PtyModule = typeof import('node-pty');

let loading: Promise<PtyModule> | undefined;

/** Loads `node-pty` once (and makes its macOS helper executable first, see below). */
export function loadPty(): Promise<PtyModule> {
  loading ??= (async () => {
    ensureSpawnHelper();
    return import('node-pty');
  })();
  return loading;
}

/** Where `node-pty` is installed, or `undefined` when it is not. */
export function ptyPackageDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return dirname(dirname(require.resolve('node-pty')));
  } catch {
    return undefined;
  }
}

/** The `spawn-helper` binaries `node-pty` may run (macOS: it starts every child through one). */
export function spawnHelpers(dir: string | undefined = ptyPackageDir()): string[] {
  if (!dir) return [];
  return [
    join(dir, 'build', 'Release', 'spawn-helper'),
    join(dir, 'build', 'Debug', 'spawn-helper'),
    join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ].filter((p) => existsSync(p));
}

/**
 * `node-pty` 1.1.0 publishes its macOS prebuilt `spawn-helper` without the execute bit, and its
 * install script does not add it, so every spawn fails with "posix_spawnp failed". Adds the bit
 * (owner, group, others, like an installed binary) where it is missing; returns the helpers that
 * stay unusable (not ours to change). Fixed upstream in the 1.2 betas.
 */
export function ensureSpawnHelper(helpers: string[] = spawnHelpers()): string[] {
  const stuck: string[] = [];
  for (const helper of helpers) {
    try {
      accessSync(helper, constants.X_OK);
      continue;
    } catch {
      // not executable: fix below
    }
    try {
      chmodSync(helper, statSync(helper).mode | 0o111);
      accessSync(helper, constants.X_OK);
    } catch {
      stuck.push(helper);
    }
  }
  return stuck;
}

/** The terminal a PTY agent runs in. */
export interface PtyTerminalOptions {
  cols: number;
  rows: number;
  /** `TERM` for the child (default `xterm-256color`). */
  name?: string;
}

/**
 * The supervisor's `fork` hook for a PTY: spawns the command under a pseudo-terminal and returns
 * the `ChildProcess` stand-in (`PtyChild`). `pty` is the loaded module (`loadPty()`).
 */
export function ptyFork(
  pty: PtyModule,
  terminal: PtyTerminalOptions,
): (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => ChildProcess {
  return (command, args, { cwd, env }) => {
    const term = pty.spawn(command, args, {
      name: terminal.name ?? 'xterm-256color',
      cols: terminal.cols,
      rows: terminal.rows,
      cwd,
      env: { ...env, TERM: terminal.name ?? 'xterm-256color' },
    });
    // The supervisor uses a known subset of `ChildProcess` (documented on `ProcessSpec.fork`);
    // `PtyChild` implements exactly that subset.
    return new PtyChild(term) as unknown as ChildProcess;
  };
}

/** A signal number as its name (`9` → `SIGKILL`). */
export function signalName(n: number): NodeJS.Signals | null {
  if (!n) return null;
  const hit = Object.entries(osConstants.signals).find(([, v]) => v === n);
  return (hit?.[0] as NodeJS.Signals | undefined) ?? null;
}

/**
 * A pseudo-terminal as the supervisor sees a child: `stdout` carries the terminal's output (a
 * terminal has one stream; `stderr` is `null`), `stdin.write` types into it, `stdin.end()` sends
 * end-of-file (Ctrl-D). `spawn` is emitted on the next tick, `exit(code, signal)` and `close` when
 * the CLI has gone (node-pty reports the exit after the output it read).
 */
export class PtyChild extends EventEmitter {
  readonly pid: number;
  readonly stdout: EventEmitter & { setEncoding(enc: string): void };
  readonly stderr = null;
  readonly stdin: EventEmitter & { write(data: string): boolean; end(): void };
  private exited = false;

  constructor(private readonly term: IPty) {
    super();
    this.pid = term.pid;
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    this.stdout = stdout;
    const write = (data: string): boolean => {
      if (this.exited) return false;
      try {
        term.write(data);
        return true;
      } catch (error) {
        stdin.emit('error', error);
        return false;
      }
    };
    const stdin = Object.assign(new EventEmitter(), {
      write,
      end: () => {
        write('\x04');
      },
    });
    this.stdin = stdin;
    term.onData((data) => stdout.emit('data', data));
    term.onExit(({ exitCode, signal }) => {
      this.exited = true;
      const sig = signalName(signal ?? 0);
      this.emit('exit', sig ? null : exitCode, sig);
      this.emit('close', sig ? null : exitCode, sig);
    });
    process.nextTick(() => this.emit('spawn'));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    try {
      this.term.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}
