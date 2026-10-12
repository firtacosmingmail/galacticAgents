import { dirname } from 'node:path';
import { TAILSCALE_APP_CLI, type ExecFile, type LocateFs } from '../remote/tailscale.js';

/**
 * A fake `tailscale` CLI for tests (P9-16): answers `version`, `status --json`,
 * `serve status [--json]`, `serve --bg --https=443 <target>` and `serve --https=443 off` from a
 * state the test sets, and records every call. The real `tailscale` is never run, and the lookup
 * (`locate`) sees a fake file system and an empty `PATH` — never the user's binaries.
 */
export interface FakeTailscaleState {
  /** `false`: no Homebrew `tailscale` (and no app CLI unless `appCli`). */
  installed: boolean;
  appCli: boolean;
  /** A `tailscale` only on the `PATH`, in this folder. */
  pathDir?: string;
  /** Paths whose file is group/world-writable (refused by the lookup). */
  writable?: string[];
  backendState: string;
  dnsName: string | undefined;
  /** What `serve status --json` prints. */
  serve: Record<string, unknown>;
  /** Make the next `serve --bg …` fail. */
  failServe?: boolean;
  /** Make `serve --https=443 off` fail. */
  failServeOff?: boolean;
  /** `status --json` fails as when the daemon is not reachable. */
  statusFails?: boolean;
  /** `status --json` never answers (a hung daemon). */
  statusHangs?: boolean;
}

export const TS_NAME = 'mymac.tail1234.ts.net';
/** The binary the fake answers as when `installed` (Homebrew's). */
export const TS_BIN = '/opt/homebrew/bin/tailscale';

export function forwarding(port: number, name = TS_NAME): Record<string, unknown> {
  return {
    TCP: { '443': { HTTPS: true } },
    Web: { [`${name}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
  };
}

export function fakeTailscale(initial: Partial<FakeTailscaleState> = {}) {
  const state: FakeTailscaleState = {
    installed: true,
    appCli: false,
    backendState: 'Running',
    dnsName: `${TS_NAME}.`,
    serve: {},
    ...initial,
  };
  const binaries = (): string[] => [
    ...(state.appCli ? [TAILSCALE_APP_CLI] : []),
    ...(state.installed ? [TS_BIN] : []),
    ...(state.pathDir ? [`${state.pathDir}/tailscale`] : []),
  ];
  const calls: string[][] = [];
  const fail = (message: string, stderr = message) =>
    Promise.reject(Object.assign(new Error(message), { stderr }));
  const exec: ExecFile = (file, args) => {
    calls.push([file, ...args]);
    if (!binaries().includes(file)) return fail(`spawn ${file} ENOENT`, '');
    const [a, b, c, d] = args;
    if (a === 'version') return Promise.resolve('1.90.0\n');
    if (a === 'status' && b === '--json') {
      if (state.statusHangs) return new Promise<string>(() => undefined);
      if (state.statusFails) return fail('failed to connect to local tailscaled');
      return Promise.resolve(
        JSON.stringify({
          BackendState: state.backendState,
          Self: state.dnsName !== undefined ? { DNSName: state.dnsName } : {},
        }),
      );
    }
    if (a === 'serve' && b === 'status') {
      return Promise.resolve(c === '--json' ? JSON.stringify(state.serve) : 'serve status text\n');
    }
    if (a === 'serve' && b === '--bg' && c === '--https=443' && d) {
      if (state.failServe) return fail('serve config denied');
      const name = String(state.dnsName ?? '').replace(/\.$/, '');
      state.serve = {
        ...(state.serve['AllowFunnel'] ? { AllowFunnel: state.serve['AllowFunnel'] } : {}),
        TCP: { '443': { HTTPS: true } },
        Web: { [`${name}:443`]: { Handlers: { '/': { Proxy: d } } } },
      };
      return Promise.resolve('');
    }
    if (a === 'serve' && b === '--https=443' && c === 'off') {
      if (state.failServeOff) return fail('serve off denied');
      state.serve = {};
      return Promise.resolve('');
    }
    return fail(`unexpected tailscale ${args.join(' ')}`);
  };
  const isDir = (path: string) => binaries().some((b) => dirname(b) === path);
  const fs: LocateFs = {
    exists: (path) => binaries().includes(path) || isDir(path),
    realpath: (path) => {
      if (!binaries().includes(path) && !isDir(path)) throw new Error(`ENOENT ${path}`);
      return path;
    },
    stat: (path) => {
      const file = binaries().includes(path);
      if (!file && !isDir(path)) throw new Error(`ENOENT ${path}`);
      const writable = state.writable?.includes(path) ?? false;
      return {
        uid: 0,
        mode: (file ? 0o100000 : 0o040000) | (writable ? 0o777 : 0o755),
        isFile: () => file,
      };
    },
  };
  /** What a `RemoteService` / `findTailscale` is given to look for the binary. */
  const locate = {
    fs,
    uid: 501,
    get env(): NodeJS.ProcessEnv {
      return { PATH: state.pathDir ?? '' };
    },
  };
  /** The calls that would change Tailscale (`serve --bg …`, `serve … off`). */
  const writes = () => calls.filter((c) => c[1] === 'serve' && c[2] !== 'status');
  return { state, calls, writes, exec, fs, locate };
}
