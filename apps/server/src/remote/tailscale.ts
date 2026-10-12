import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { RemoteHostState, RemoteReason, ServeState, TailscaleState } from '@galactic/protocol';

/**
 * Tailscale and Serve for phone access (P7-02 `pnpm remote`, P9-16 the server's
 * `/api/remote/*` and the desktop app; `docs/REMOTE_ACCESS.md`). One module for every caller:
 * `scripts/remote-start.mjs` imports the built copy (`apps/server/dist/remote/tailscale.js`), the
 * server's `RemoteService` uses it, and the desktop app goes through the server's routes.
 *
 * Security rules, kept here once:
 * - only **HTTP-mode** Serve, `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, ever
 *   points at the server (it adds `X-Forwarded-For`, which marks its requests remote); never a
 *   TCP or TLS-terminated-TCP Serve, never Funnel;
 * - port 443 serving anything else, or Funnel on anywhere, is a refusal — never overwritten;
 * - the `tailscale` program is run with an argument array (`execFile`), never through a shell.
 *
 * Only node built-ins and type imports: the script loads it without the server's dependencies.
 */

/** The CLI inside the Mac app (the App Store and standalone builds both ship it). */
export const TAILSCALE_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * Runs a program with an argument array and resolves with its stdout; rejects with an error
 * carrying `stderr` when it fails. Never a shell.
 */
export type ExecFile = (file: string, args: readonly string[]) => Promise<string>;

export const defaultExecFile: ExecFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
          );
        } else resolve(String(stdout));
      },
    );
  });

/** The error's stderr or message, one line. */
export function errorText(error: unknown): string {
  const e = error as { stderr?: unknown; message?: unknown };
  const text = String((e?.stderr && String(e.stderr).trim()) || e?.message || error);
  return text.trim().split('\n').slice(0, 3).join(' ');
}

/** Where `tailscale` is looked for first, in this order (P9-16 review S1). */
export const TAILSCALE_CANDIDATES = [
  TAILSCALE_APP_CLI,
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
] as const;

/** The file-system calls the lookup makes (a fake in tests). */
export interface LocateFs {
  exists(path: string): boolean;
  realpath(path: string): string;
  stat(path: string): { uid: number; mode: number; isFile(): boolean };
}

const nodeFs: LocateFs = {
  exists: existsSync,
  realpath: (path) => realpathSync(path),
  stat: (path) => statSync(path),
};

export interface LocateOptions {
  exec?: ExecFile;
  fs?: LocateFs;
  /** `PATH` comes from here (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** The user who may own the binary besides root (default `process.getuid()`). */
  uid?: number;
  /** Told which binary was found on the `PATH` (the last resort). */
  log?: (line: string) => void;
}

/**
 * The real path of `path` when it is a binary we may run: a file owned by root or this user,
 * neither it nor its folder writable by the group or others. `undefined` otherwise.
 */
export function trustedBinary(path: string, fs: LocateFs, uid: number): string | undefined {
  try {
    if (!fs.exists(path)) return undefined;
    const real = fs.realpath(path);
    const file = fs.stat(real);
    if (!file.isFile()) return undefined;
    for (const st of [file, fs.stat(dirname(real))]) {
      if (st.uid !== 0 && st.uid !== uid) return undefined;
      if ((st.mode & 0o022) !== 0) return undefined;
    }
    return real;
  } catch {
    return undefined;
  }
}

/**
 * The `tailscale` CLI as an absolute, trusted path: the Mac app's CLI when it is there, then
 * Homebrew's (`/opt/homebrew/bin`, `/usr/local/bin`), and only then the `PATH` — resolved here,
 * once, to an absolute path, and logged. Each must pass `trustedBinary` and answer `version`.
 * `undefined` when none does. Never a bare name for `execFile` to look up.
 */
export async function findTailscale(opts: LocateOptions = {}): Promise<string | undefined> {
  const exec = opts.exec ?? defaultExecFile;
  const fs = opts.fs ?? nodeFs;
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const runs = async (bin: string) => {
    try {
      await exec(bin, ['version']);
      return true;
    } catch {
      return false;
    }
  };
  for (const candidate of TAILSCALE_CANDIDATES) {
    const real = trustedBinary(candidate, fs, uid);
    if (real && (await runs(real))) return real;
  }
  const PATH = (opts.env ?? process.env)['PATH'] ?? '';
  for (const dir of PATH.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const real = trustedBinary(join(dir, 'tailscale'), fs, uid);
    if (real && (await runs(real))) {
      opts.log?.(`tailscale: using ${real} (found on the PATH)`);
      return real;
    }
  }
  return undefined;
}

export interface TailscaleSelf {
  state: Exclude<TailscaleState, 'not_installed'>;
  /** `BackendState` as Tailscale said it (`Running`, `Stopped`, `NeedsLogin`, …). */
  backendState?: string;
  /** This Mac's MagicDNS name, lower case, no trailing dot; only a `*.ts.net` name. */
  name?: string;
  /** Why the status could not be read. */
  detail?: string;
}

/** `tailscale status --json` read leniently. */
export function parseStatus(json: unknown): TailscaleSelf {
  const status = (json ?? {}) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
  const backendState = typeof status.BackendState === 'string' ? status.BackendState : undefined;
  const state: TailscaleSelf['state'] =
    backendState === 'Running'
      ? 'running'
      : backendState === 'NeedsLogin' || backendState === 'NeedsMachineAuth'
        ? 'needs_login'
        : 'stopped';
  const dns = String(status.Self?.DNSName ?? '')
    .replace(/\.$/, '')
    .toLowerCase();
  return {
    state,
    ...(backendState ? { backendState } : {}),
    ...(state === 'running' && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(dns)
      ? { name: dns }
      : {}),
  };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  return trimmed ? JSON.parse(trimmed) : {};
}

/** Reads `tailscale status --json`; a failure (no daemon) is `stopped` with the detail. */
export async function readTailscale(bin: string, exec: ExecFile): Promise<TailscaleSelf> {
  try {
    return parseStatus(parseJson(await exec(bin, ['status', '--json'])));
  } catch (error) {
    // `tailscale status --json` prints the JSON (and exits 1) when the backend is stopped.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
      try {
        return parseStatus(JSON.parse(stdout));
      } catch {
        // fall through
      }
    }
    return { state: 'stopped', detail: errorText(error) };
  }
}

/** The one target Serve may forward to: the server's loopback port, over HTTP. */
export const serveTarget = (port: number) => `http://127.0.0.1:${port}`;

interface ServeConfig {
  AllowFunnel?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
  TCP?: Record<string, { HTTPS?: unknown; HTTP?: unknown; TCPForward?: unknown }>;
}

/** Funnel is on for any name or port in `tailscale serve status --json`. */
export function funnelOn(json: unknown): boolean {
  const serve = (json ?? {}) as ServeConfig;
  return !!serve.AllowFunnel && Object.values(serve.AllowFunnel).some(Boolean);
}

/**
 * What `tailscale serve status --json` says about port 443 for this Mac's name and this server's
 * port: "forwards exactly `/` to us", nothing, or anything else on 443 (another target, more
 * paths, another name's 443, a TCP forward) is taken. Funnel is a separate question
 * (`funnelOn`): with Funnel on, a Serve of ours is still ours — and must still be turned off.
 */
export function classifyServe(json: unknown, name: string, port: number): ServeState {
  const serve = (json ?? {}) as ServeConfig;
  const web443 = Object.entries(serve.Web ?? {}).filter(([key]) => key.endsWith(':443'));
  const ours = serve.Web?.[`${name}:443`]?.Handlers ?? {};
  const others = web443.filter(([key]) => key !== `${name}:443`);
  const tcp443 = serve.TCP?.['443'];
  const handlers = Object.keys(ours);
  if (
    others.length === 0 &&
    handlers.length === 1 &&
    ours['/']?.Proxy === serveTarget(port) &&
    (!tcp443 || tcp443.HTTPS)
  ) {
    return 'forwarding_to_us';
  }
  if (
    handlers.length > 0 ||
    others.some(([, v]) => Object.keys(v.Handlers ?? {}).length > 0) ||
    (tcp443 && !tcp443.HTTPS)
  ) {
    return 'taken_by_other';
  }
  return 'absent';
}

export async function readServe(bin: string, exec: ExecFile): Promise<unknown> {
  return parseJson(await exec(bin, ['serve', 'status', '--json']));
}

/** `tailscale serve status` as text (the script prints it). */
export async function serveStatusText(bin: string, exec: ExecFile): Promise<string> {
  return exec(bin, ['serve', 'status']);
}

/** HTTP-mode Serve on 443 to the server's port, in the background. Nothing else, ever. */
export async function startServe(bin: string, exec: ExecFile, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  await exec(bin, ['serve', '--bg', '--https=443', serveTarget(port)]);
}

/** Turns off what Serve does on 443 (only for a Serve GalacticAgents started: the caller checks). */
export async function stopServe(bin: string, exec: ExecFile): Promise<void> {
  await exec(bin, ['serve', '--https=443', 'off']);
}

/** `remoteHost` against this Mac's name. */
export function remoteHostState(
  configured: string | undefined,
  name: string | undefined,
): RemoteHostState {
  const value = configured?.trim().toLowerCase();
  if (!value) return 'missing';
  if (!name) return 'configured';
  return value === name ? 'matches' : 'mismatch';
}

/** `config.json` as an object (an absent file is `{}`); throws when it is not valid JSON. */
export function readConfigFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** `remoteHost` from `config.json`, lower case; `undefined` when absent or unreadable. */
export function fileRemoteHost(configPath: string): string | undefined {
  try {
    const value = readConfigFile(configPath)['remoteHost'];
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds `"remoteHost": name` to `config.json` (kept 0600), keeping everything else. Written as
 * the settings are (`SettingsService`): a 0600 temp file renamed over it, so a full disk or a
 * crash never leaves a truncated config.json.
 */
export function addRemoteHost(configPath: string, name: string): void {
  const config = readConfigFile(configPath);
  config['remoteHost'] = name;
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, configPath);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Each reason in words, with what to do. */
export function reasonText(
  reason: RemoteReason,
  ctx: { name?: string | undefined; remoteHost?: string | undefined } = {},
): string {
  switch (reason) {
    case 'not_installed':
      return 'Tailscale is not installed on this Mac. Install it (tailscale.com/download) and sign in, on the Mac and on the phone.';
    case 'not_running':
      return 'Tailscale is not running or not connected. Open the Tailscale app and connect.';
    case 'needs_login':
      return 'Tailscale is not signed in. Open the Tailscale app and sign in.';
    case 'no_magicdns':
      return 'This Mac has no MagicDNS name. In the Tailscale admin console (DNS page), turn on MagicDNS and HTTPS certificates.';
    case 'remote_host_mismatch':
      return `remoteHost is "${ctx.remoteHost ?? ''}", but this Mac's Tailscale name is "${ctx.name ?? ''}": the server would refuse the phone. Correct remoteHost in config.json (or GALACTIC_REMOTE_HOST), then restart Mission Control.`;
    case 'funnel_on':
      return 'Tailscale Funnel is ON: it publishes this Mac to the public internet. Turn it off now ("tailscale funnel reset"); Mission Control is never put behind Funnel.';
    case 'port_443_taken':
      return 'Tailscale Serve already serves port 443 to something else. Clear it ("tailscale serve --https=443 off") to use it for GalacticAgents.';
    case 'serve_off':
      return 'Phone access is off. Turn it on on the Mac: Settings → Access, or the menu bar app.';
    case 'turned_off_outside':
      return 'Phone access was turned off outside GalacticAgents (Tailscale Serve was stopped). It stays off until you turn it on again: Settings → Access, or the menu bar app.';
    case 'restart_needed':
      return 'remoteHost was added after Mission Control started: restart Mission Control to finish turning on phone access.';
    case 'not_owned':
      return 'Tailscale Serve was not started by GalacticAgents, so it is left on. Turn it off with "tailscale serve --https=443 off".';
    case 'error':
      return 'Tailscale could not be read.';
  }
}

/** Tailscale's own state as a reason (`undefined` when it is connected with a name). */
export function tailscaleReason(
  tailscale: TailscaleState,
  name: string | undefined,
): RemoteReason | undefined {
  switch (tailscale) {
    case 'not_installed':
      return 'not_installed';
    case 'needs_login':
      return 'needs_login';
    case 'stopped':
      return 'not_running';
    case 'running':
      return name ? undefined : 'no_magicdns';
  }
}

/** How long `prepareRemoteHost` may take in all: a hung Tailscale must not stall startup. */
export const PREPARE_REMOTE_HOST_MS = 5_000;

/**
 * Before a server the desktop app starts reads its config (`GALACTIC_PHONE_ACCESS=1`): adds this
 * Mac's Tailscale name as `remoteHost` when none is set, so the server starts with it (a running
 * server needs a restart to pick one up). Never changes one that is set. Gives up, changing
 * nothing, after `timeoutMs` (5 s). Returns what it did.
 */
export async function prepareRemoteHost(opts: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  exec?: ExecFile;
  locate?: Omit<LocateOptions, 'exec'>;
  timeoutMs?: number;
}): Promise<string | undefined> {
  if (opts.env['GALACTIC_REMOTE_HOST']) return undefined;
  if (fileRemoteHost(opts.configPath)) return undefined;
  const exec = opts.exec ?? defaultExecFile;
  const timeoutMs = opts.timeoutMs ?? PREPARE_REMOTE_HOST_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(undefined);
    }, timeoutMs);
  });
  const lookup = (async () => {
    const bin = await findTailscale({ ...opts.locate, exec });
    if (!bin || timedOut) return undefined;
    const self = await readTailscale(bin, exec);
    return self.state === 'running' ? self.name : undefined;
  })();
  // A lookup that fails after the deadline is not an unhandled rejection.
  lookup.catch(() => undefined);
  try {
    const name = await Promise.race([lookup, deadline]);
    if (timedOut) throw new Error(`Tailscale did not answer within ${timeoutMs} ms`);
    if (!name) return undefined;
    addRemoteHost(opts.configPath, name);
    return `Phone access: added "remoteHost": "${name}" to ${opts.configPath}`;
  } finally {
    clearTimeout(timer);
  }
}
