import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  REMOTE_REASON_SHORT,
  RemoteActionResponse,
  RemoteStatus,
  type RemoteStatus as RemoteStatusT,
} from '@galactic/protocol';
import type { PhoneLine, ServerInfo, ShellLine } from './lines.js';

/**
 * Phone access from the desktop app (P9-16; SPEC decision 137; docs/DESKTOP.md §2): while the app
 * has a live Mission Control and "Phone Access" is on (the default), it makes sure the phone can
 * reach it — through Mission Control's own routes (`GET /api/remote/status`,
 * `POST /api/remote/start|stop`), which own the Tailscale and Serve checks. The app runs no
 * `tailscale` itself.
 *
 * - **On**: a check at once when the app attaches to or starts Mission Control, after each
 *   reconnect and every 60 s; when Serve forwards nothing on 443 and Tailscale is connected, it
 *   asks Mission Control to start it (`remoteHost` is added too: a server the app starts got it
 *   before it read its config — `GALACTIC_PHONE_ACCESS=1` — while an attached one needs a
 *   restart, which the menu says).
 * - **Off**: asks Mission Control to stop Serve, which it does only when GalacticAgents started it.
 * - **Turned off on purpose** (P9-16 review S3): a stop from the panel or the menu, or our Serve
 *   stopped outside GalacticAgents, is recorded by Mission Control (`status.turnedOff`); the
 *   automatic start (`{auto: true}`) then leaves it off, the switch shows unchecked, and only the
 *   user's own start (the switch, the panel's button) turns it on again.
 * - **Quit**: when the app stops the Mission Control it started, it first asks it to turn off the
 *   Serve it started (`releaseForQuit`), so 443 never forwards to a dead port.
 * - The switch is remembered in the app's own settings file, not in Mission Control's config.
 */

export const PHONE_CHECK_MS = 60_000;

export interface DesktopSettings {
  phoneAccess: boolean;
}

/** `GALACTIC_DESKTOP_SETTINGS`, else `~/Library/Application Support/dev.galacticagents.desktop/`. */
export function desktopSettingsPath(env: NodeJS.ProcessEnv): string {
  return (
    env['GALACTIC_DESKTOP_SETTINGS'] ??
    join(homedir(), 'Library', 'Application Support', 'dev.galacticagents.desktop', 'settings.json')
  );
}

/** The app's settings; phone access is on unless turned off. */
export function readDesktopSettings(path: string): DesktopSettings {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DesktopSettings>;
    return { phoneAccess: parsed.phoneAccess !== false };
  } catch {
    return { phoneAccess: true };
  }
}

export function writeDesktopSettings(path: string, settings: DesktopSettings): void {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // a first write
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, ...settings }, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * The menu's Phone line from what is known. Pure.
 * - ready: "Phone: https://<name>" (and "· N connected");
 * - remoteHost added after the server started: "Phone: restart Mission Control to finish" (or,
 *   for the app's own server, "quit and reopen GalacticAgents to finish");
 * - off: "Phone: off" (turned off) or "Phone: off — <reason>".
 */
export function phoneView(input: {
  on: boolean;
  server: ServerInfo | undefined;
  status: RemoteStatusT | undefined;
  /** Why the status could not be read (an old Mission Control, the token, the network). */
  error?: string | undefined;
  /** A start or stop refusal to say instead of the status's reason. */
  refusal?: string | undefined;
}): PhoneLine {
  const { server, status } = input;
  // Turned off on purpose (the panel, the menu, or outside GalacticAgents) shows as off — the
  // switch unchecked, so a click on it is the user turning it on again.
  const on = input.on && !status?.turnedOff;
  const line = (label: string, extra: Partial<PhoneLine> = {}): PhoneLine => ({
    on,
    label,
    ...extra,
  });
  if (!server) return line(on ? 'Phone: waiting for Mission Control' : 'Phone: off');
  if (input.error) return line(`Phone: off — ${input.error}`);
  if (!status) return line(on ? 'Phone: checking…' : 'Phone: off');
  if (status.funnel) {
    // Loudly, whatever the switch says: this Mac is published to the public internet.
    return line('Phone: WARNING — Tailscale Funnel is ON (public internet)', {
      ...(status.message ? { detail: status.message } : {}),
    });
  }
  const url = status.url;
  if (status.ready && url) {
    const n = status.remoteClients.connected;
    const label = `Phone: ${url}${n > 0 ? ` · ${n} connected` : ''}`;
    return line(on || status.serveOwned ? label : `${label} (Serve set up elsewhere)`, { url });
  }
  if (status.reason === 'restart_needed' && (on || status.serveOwned)) {
    return line(
      server.owned
        ? 'Phone: quit and reopen GalacticAgents to finish'
        : 'Phone: restart Mission Control to finish',
      { ...(url ? { url } : {}), detail: status.message ?? '' },
    );
  }
  if (input.refusal) return line(`Phone: off — ${input.refusal}`);
  if (status.turnedOff === 'outside' && status.serve === 'absent') {
    return line(`Phone: off — ${REMOTE_REASON_SHORT.turned_off_outside}`, {
      ...(status.message ? { detail: status.message } : {}),
    });
  }
  if (!on) return line('Phone: off');
  const reason = status.reason ?? 'error';
  return line(`Phone: off — ${REMOTE_REASON_SHORT[reason]}`, {
    ...(status.message ? { detail: status.message } : {}),
  });
}

export interface PhoneAccessOptions {
  settingsPath: string;
  token: () => string | undefined;
  emit: (line: ShellLine) => void;
  log: (line: string) => void;
  fetch?: typeof fetch;
  intervalMs?: number;
  read?: (path: string) => DesktopSettings;
  write?: (path: string, settings: DesktopSettings) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

export class PhoneAccess {
  private settings: DesktopSettings;
  private server: ServerInfo | undefined;
  private status: RemoteStatusT | undefined;
  private error: string | undefined;
  private refusal: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private checkQueued = false;
  private lastLine: string | undefined;
  private stopped = false;

  constructor(private readonly opts: PhoneAccessOptions) {
    this.settings = (opts.read ?? readDesktopSettings)(opts.settingsPath);
  }

  /** Whether "Phone Access" is on (a server the app starts then gets `GALACTIC_PHONE_ACCESS=1`). */
  get on(): boolean {
    return this.settings.phoneAccess;
  }

  /** The live Mission Control changed (attached, started, gone). */
  setServer(server: ServerInfo | undefined): void {
    const same =
      server?.port === this.server?.port && server?.owned === this.server?.owned && !!server;
    this.server = server;
    if (!same) {
      this.status = undefined;
      this.error = undefined;
      this.refusal = undefined;
    }
    if (!server) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.emit();
      return;
    }
    this.emit();
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), this.opts.intervalMs ?? PHONE_CHECK_MS);
      this.timer.unref?.();
    }
    void this.check();
  }

  /** The status socket is live again: look at once. */
  reconnected(): void {
    if (this.server) void this.check();
  }

  /** "Phone Access" from the menu. */
  async setOn(on: boolean): Promise<void> {
    if (this.stopped) return;
    this.settings = { ...this.settings, phoneAccess: on };
    try {
      (this.opts.write ?? writeDesktopSettings)(this.opts.settingsPath, this.settings);
    } catch (error) {
      this.opts.log(`phone access: settings not saved: ${(error as Error).message}`);
    }
    this.opts.log(`phone access turned ${on ? 'on' : 'off'}`);
    this.refusal = undefined;
    this.emit();
    if (!this.server) return;
    // The user's own start: it also ends "turned off on purpose" on Mission Control's side.
    if (on) await this.serialized(() => this.turnOn(false));
    else await this.serialized(() => this.turnOff());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The app is quitting and stops the Mission Control it started: asks it first to turn off the
   * Serve it started (`by: 'app_quit'` — not "turned off by the user", so the next launch turns
   * phone access on again), so 443 never forwards to a dead port that another process could take.
   * Mission Control leaves a Serve it did not start alone. At most `timeoutMs`; never throws.
   */
  async releaseForQuit(timeoutMs = 3_000): Promise<void> {
    if (!this.server) return;
    try {
      const body = RemoteActionResponse.safeParse(
        await this.request('POST', '/api/remote/stop', { by: 'app_quit' }, timeoutMs),
      );
      this.opts.log(
        `phone access: on quit, ${body.success && body.data.ok ? 'Serve is off' : 'Serve left as is'}`,
      );
    } catch (error) {
      // 409: not ours (left on) or Tailscale not readable; a timeout: nothing more to do.
      this.opts.log(`phone access: on quit, Serve left as is (${(error as Error).message})`);
    }
  }

  /** One look (and a start when on and Serve is off); a look already waiting is not doubled. */
  check(): Promise<void> {
    if (this.checkQueued) return this.queue;
    this.checkQueued = true;
    return this.serialized(async () => {
      this.checkQueued = false;
      await this.look();
    });
  }

  /** One request to Mission Control's phone routes at a time, in order. */
  private serialized(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn, fn).catch((error: unknown) => {
      this.opts.log(`phone access: ${(error as Error).message}`);
    });
    this.queue = next;
    return next;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<unknown> {
    const server = this.server;
    const token = this.opts.token();
    if (!server || !token) throw new Error('no token');
    const res = await (this.opts.fetch ?? fetch)(`${server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) throw new HttpError(res.status, answer);
    return answer;
  }

  private async look(): Promise<void> {
    if (!this.server || this.stopped) return;
    try {
      const status = RemoteStatus.parse(await this.request('GET', '/api/remote/status'));
      this.status = status;
      this.error = undefined;
      // Never against the user: turned off on purpose (from the panel, the menu, or Serve stopped
      // outside GalacticAgents) stays off until the user turns it on again.
      if (this.on && !status.turnedOff && this.shouldStart(status)) await this.turnOn(true);
    } catch (error) {
      this.status = undefined;
      this.error =
        error instanceof HttpError && error.status === 404
          ? 'update Mission Control (no phone access routes)'
          : error instanceof HttpError && error.status === 401
            ? 'the token was refused'
            : 'Mission Control did not answer';
      this.opts.log(`phone access: status not read (${(error as Error).message})`);
    }
    this.emit();
  }

  /** Serve forwards nothing on 443 (or `remoteHost` is missing) and Tailscale is connected. */
  private shouldStart(status: RemoteStatusT): boolean {
    return (
      status.tailscale === 'running' &&
      !!status.name &&
      status.remoteHost.state !== 'mismatch' &&
      (status.serve === 'absent' ||
        (status.serve === 'forwarding_to_us' && status.remoteHost.state === 'missing'))
    );
  }

  /** `auto`: the 60 s check's start, which Mission Control refuses while turned off on purpose. */
  private async turnOn(auto: boolean): Promise<void> {
    const body = await this.action('start', auto ? { auto: true } : undefined);
    if (body) this.opts.log(`phone access: start ${body.ok ? 'done' : `refused (${body.reason})`}`);
    this.emit();
  }

  private async turnOff(): Promise<void> {
    const body = await this.action('stop', { by: 'user' });
    if (body) {
      this.opts.log(`phone access: stop ${body.ok ? 'done' : `refused (${body.reason})`}`);
      this.refusal =
        !body.ok && body.reason === 'not_owned' ? REMOTE_REASON_SHORT.not_owned : undefined;
    }
    this.emit();
  }

  private async action(
    name: 'start' | 'stop',
    payload?: Record<string, unknown>,
  ): Promise<RemoteActionResponse | undefined> {
    try {
      const body = RemoteActionResponse.parse(
        await this.request('POST', `/api/remote/${name}`, payload),
      );
      this.status = body.status;
      return body;
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        const parsed = RemoteActionResponse.safeParse(error.body);
        if (parsed.success) {
          this.status = parsed.data.status;
          return parsed.data;
        }
      }
      this.opts.log(`phone access: ${name} failed (${(error as Error).message})`);
      return undefined;
    }
  }

  private emit(): void {
    const phone = phoneView({
      on: this.on,
      server: this.server,
      status: this.status,
      error: this.error,
      refusal: this.refusal,
    });
    const key = JSON.stringify(phone);
    if (key === this.lastLine) return;
    this.lastLine = key;
    this.opts.emit({ type: 'phone', phone });
  }
}
