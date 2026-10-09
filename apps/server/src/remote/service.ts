import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteActionResponse, RemoteReason, RemoteStatus } from '@galactic/protocol';
import {
  addRemoteHost,
  classifyServe,
  defaultExecFile,
  errorText,
  fileRemoteHost,
  findTailscale,
  readServe,
  readTailscale,
  reasonText,
  remoteHostState,
  serveTarget,
  startServe,
  stopServe,
  tailscaleReason,
  type ExecFile,
} from './tailscale.js';

/**
 * Phone access as the server owns it (P9-16; SPEC decision 137): the status every client reads
 * (`GET /api/remote/status`), and the Mac's switch (`POST /api/remote/start` / `stop`). The
 * desktop app's menu bar uses these routes too, so the checks live here once (`tailscale.ts`).
 *
 * **Ownership.** Starting Serve records it in `<dataDir>/remote-serve.json` (the target and the
 * name); stopping turns Serve off only when that record names what Serve forwards now — a Serve
 * someone else set up (`pnpm remote`, by hand, another program) is never turned off or changed.
 */

export const REMOTE_SERVE_FILE = 'remote-serve.json';
export const STATUS_CACHE_MS = 5_000;

export interface RemoteClients {
  connected: number;
  lastSeenAt?: string;
}

export interface RemoteServiceOptions {
  dataDir: string;
  configPath: string;
  /** The port the server listens on (known after `listen`). */
  port: () => number | undefined;
  /** `remoteHost` as this server loaded it (the file or `GALACTIC_REMOTE_HOST`). */
  remoteHost: string | undefined;
  /** `GALACTIC_REMOTE_HOST` is set: the file's value is not what counts. */
  remoteHostFromEnv?: boolean;
  remoteClients?: () => RemoteClients;
  exec?: ExecFile;
  exists?: (path: string) => boolean;
  now?: () => number;
  cacheMs?: number;
  log?: (line: string) => void;
}

interface Ownership {
  target: string;
  name: string;
  startedAt: string;
}

/** What a start or stop answers; `httpStatus` 200, or 409 for a refusal. */
export type RemoteAction = RemoteActionResponse & { httpStatus: 200 | 409 };

export class RemoteService {
  private cached: { at: number; status: RemoteStatus } | undefined;
  private inFlight: Promise<RemoteStatus> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private bin: string | undefined;

  constructor(private readonly opts: RemoteServiceOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private get exec(): ExecFile {
    return this.opts.exec ?? defaultExecFile;
  }

  private get ownershipPath(): string {
    return join(this.opts.dataDir, REMOTE_SERVE_FILE);
  }

  private readOwnership(): Ownership | undefined {
    try {
      if (!existsSync(this.ownershipPath)) return undefined;
      const parsed = JSON.parse(readFileSync(this.ownershipPath, 'utf8')) as Partial<Ownership>;
      return typeof parsed.target === 'string' && typeof parsed.name === 'string'
        ? { target: parsed.target, name: parsed.name, startedAt: String(parsed.startedAt ?? '') }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private writeOwnership(o: Ownership): void {
    writeFileSync(this.ownershipPath, `${JSON.stringify(o, null, 2)}\n`, { mode: 0o600 });
  }

  private clearOwnership(): void {
    rmSync(this.ownershipPath, { force: true });
  }

  /** The status, from a cache at most `cacheMs` old unless `fresh`; one check at a time. */
  async status(fresh = false): Promise<RemoteStatus> {
    const cacheMs = this.opts.cacheMs ?? STATUS_CACHE_MS;
    if (!fresh && this.cached && this.now() - this.cached.at < cacheMs) {
      return { ...this.cached.status, remoteClients: this.clients() };
    }
    if (!this.inFlight) {
      this.inFlight = this.check().finally(() => (this.inFlight = undefined));
    }
    const status = await this.inFlight;
    this.cached = { at: this.now(), status };
    return status;
  }

  private clients(): RemoteClients {
    return this.opts.remoteClients?.() ?? { connected: 0 };
  }

  private async check(): Promise<RemoteStatus> {
    const checkedAt = new Date(this.now()).toISOString();
    const running = this.opts.remoteHost?.toLowerCase();
    const fromFile = this.opts.remoteHostFromEnv ? undefined : fileRemoteHost(this.opts.configPath);
    const effective = running ?? fromFile;
    const base = {
      serveOwned: false,
      ready: false,
      restartNeeded: false,
      remoteClients: this.clients(),
      checkedAt,
    };
    const off = (
      tailscale: RemoteStatus['tailscale'],
      reason: RemoteReason,
      detail?: string,
    ): RemoteStatus => ({
      ...base,
      tailscale,
      remoteHost: {
        state: remoteHostState(effective, undefined),
        ...(effective ? { value: effective } : {}),
      },
      serve: 'unknown',
      reason,
      message: reasonText(reason) + (detail ? ` (${detail})` : ''),
    });

    this.bin ??= await findTailscale(this.exec, this.opts.exists);
    const bin = this.bin;
    if (!bin) return off('not_installed', 'not_installed');
    const self = await readTailscale(bin, this.exec);
    if (self.state === 'stopped' && self.detail) {
      // The CLI may have moved (the app updated): look for it again next time.
      this.bin = undefined;
    }
    const tsReason = tailscaleReason(self.state, self.name);
    if (tsReason || !self.name) {
      return off(self.state, tsReason ?? 'no_magicdns', self.detail);
    }
    const name = self.name;
    const port = this.opts.port();
    let serve: RemoteStatus['serve'] = 'unknown';
    let serveDetail: string | undefined;
    if (port !== undefined) {
      try {
        serve = classifyServe(await readServe(bin, this.exec), name, port);
      } catch (error) {
        serveDetail = errorText(error);
      }
    }
    const ownership = this.readOwnership();
    const serveOwned =
      serve === 'forwarding_to_us' &&
      port !== undefined &&
      ownership?.target === serveTarget(port) &&
      ownership.name === name;
    const hostState = remoteHostState(effective, name);
    const restartNeeded = running !== name && !this.opts.remoteHostFromEnv && fromFile === name;
    const reason: RemoteReason | undefined =
      serve === 'funnel_on'
        ? 'funnel_on'
        : hostState === 'mismatch'
          ? 'remote_host_mismatch'
          : serve === 'taken_by_other'
            ? 'port_443_taken'
            : serve === 'unknown'
              ? 'error'
              : serve === 'absent' || hostState === 'missing'
                ? 'serve_off'
                : restartNeeded
                  ? 'restart_needed'
                  : undefined;
    return {
      ...base,
      tailscale: 'running',
      name,
      url: `https://${name}`,
      remoteHost: { state: hostState, ...(effective ? { value: effective } : {}) },
      serve,
      serveOwned,
      restartNeeded,
      ready: reason === undefined,
      ...(reason
        ? {
            reason,
            message:
              reasonText(reason, { name, remoteHost: effective }) +
              (serveDetail ? ` (${serveDetail})` : ''),
          }
        : {}),
    };
  }

  /** One start or stop at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private refuse(status: RemoteStatus, reason: RemoteReason, message?: string): RemoteAction {
    return {
      httpStatus: 409,
      ok: false,
      error: 'remote_refused',
      reason,
      message: message ?? status.message ?? reasonText(reason),
      status,
    };
  }

  /**
   * Turns phone access on: adds `remoteHost` when none is set (a restart then finishes it), and
   * starts HTTP-mode Serve on 443 to this server's port when nothing is served there. Refuses,
   * changing nothing, when Tailscale is not connected with a name, `remoteHost` names another
   * machine, 443 serves something else, or Funnel is on.
   */
  start(): Promise<RemoteAction> {
    return this.serial(async () => {
      const status = await this.status(true);
      if (status.tailscale !== 'running' || !status.name) {
        return this.refuse(status, status.reason ?? 'not_running');
      }
      if (status.serve === 'funnel_on') return this.refuse(status, 'funnel_on');
      if (status.remoteHost.state === 'mismatch') return this.refuse(status, 'remote_host_mismatch');
      if (status.serve === 'taken_by_other') return this.refuse(status, 'port_443_taken');
      const port = this.opts.port();
      if (port === undefined || status.serve === 'unknown' || !this.bin) {
        return this.refuse(status, 'error');
      }
      if (status.remoteHost.state === 'missing') {
        try {
          addRemoteHost(this.opts.configPath, status.name);
          this.opts.log?.(`phone access: added "remoteHost": "${status.name}" to config.json`);
        } catch (error) {
          return this.refuse(status, 'error', `config.json could not be written: ${errorText(error)}`);
        }
      }
      if (status.serve === 'absent') {
        try {
          await startServe(this.bin, this.exec, port);
        } catch (error) {
          return this.refuse(
            await this.status(true),
            'error',
            `"tailscale serve --bg --https=443 ${serveTarget(port)}" failed: ${errorText(error)}`,
          );
        }
        this.writeOwnership({
          target: serveTarget(port),
          name: status.name,
          startedAt: new Date(this.now()).toISOString(),
        });
        this.opts.log?.(`phone access: Tailscale Serve https://${status.name} → ${serveTarget(port)}`);
      }
      const after = await this.status(true);
      return {
        httpStatus: 200,
        ok: true,
        status: after,
        ...(after.restartNeeded ? { message: reasonText('restart_needed') } : {}),
      };
    });
  }

  /**
   * Turns phone access off: stops Serve only when GalacticAgents started it (the ownership record
   * names what Serve forwards now). Someone else's Serve is refused (`not_owned`) and left as is.
   */
  stop(): Promise<RemoteAction> {
    return this.serial(async () => {
      const status = await this.status(true);
      if (status.serve !== 'forwarding_to_us') {
        // Nothing of ours is on: forget a stale record.
        if (status.serve === 'absent') this.clearOwnership();
        return { httpStatus: 200, ok: true, status, message: 'Phone access is already off.' };
      }
      if (!status.serveOwned || !this.bin) return this.refuse(status, 'not_owned');
      try {
        await stopServe(this.bin, this.exec);
      } catch (error) {
        return this.refuse(
          status,
          'error',
          `"tailscale serve --https=443 off" failed: ${errorText(error)}`,
        );
      }
      this.clearOwnership();
      this.opts.log?.('phone access: Tailscale Serve stopped');
      return { httpStatus: 200, ok: true, status: await this.status(true) };
    });
  }
}
