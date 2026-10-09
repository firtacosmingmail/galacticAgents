import type { ExecFile } from '../remote/tailscale.js';

/**
 * A fake `tailscale` CLI for tests (P9-16): answers `version`, `status --json`,
 * `serve status [--json]`, `serve --bg --https=443 <target>` and `serve --https=443 off` from a
 * state the test sets, and records every call. The real `tailscale` is never run.
 */
export interface FakeTailscaleState {
  /** `false`: no `tailscale` on the PATH (and no app CLI unless `appCli`). */
  installed: boolean;
  appCli: boolean;
  backendState: string;
  dnsName: string | undefined;
  /** What `serve status --json` prints. */
  serve: Record<string, unknown>;
  /** Make the next `serve --bg …` fail. */
  failServe?: boolean;
  /** `status --json` fails as when the daemon is not reachable. */
  statusFails?: boolean;
}

export const TS_NAME = 'mymac.tail1234.ts.net';

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
  const calls: string[][] = [];
  const fail = (message: string, stderr = message) =>
    Promise.reject(Object.assign(new Error(message), { stderr }));
  const exec: ExecFile = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'tailscale' && !state.installed) return fail('spawn tailscale ENOENT', '');
    const [a, b, c, d] = args;
    if (a === 'version') return Promise.resolve('1.90.0\n');
    if (a === 'status' && b === '--json') {
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
        TCP: { '443': { HTTPS: true } },
        Web: { [`${name}:443`]: { Handlers: { '/': { Proxy: d } } } },
      };
      return Promise.resolve('');
    }
    if (a === 'serve' && b === '--https=443' && c === 'off') {
      state.serve = {};
      return Promise.resolve('');
    }
    return fail(`unexpected tailscale ${args.join(' ')}`);
  };
  const exists = (path: string) => state.appCli && path.endsWith('/Tailscale');
  /** The calls that would change Tailscale (`serve --bg …`, `serve … off`). */
  const writes = () => calls.filter((c) => c[1] === 'serve' && c[2] !== 'status');
  return { state, calls, writes, exec, exists };
}
