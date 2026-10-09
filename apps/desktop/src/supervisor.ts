import type { StorageCondition, WorldState } from '@galactic/protocol';
import { answerQuestion, outcomeNotice, type TrayAnswer } from './answer.js';
import type { ConnectionState, ServerInfo, ShellLine } from './lines.js';
import {
  DEFAULT_PLAN_DEPS,
  OwnServer,
  plan,
  urlOf,
  type DataPaths,
  type OwnServerOptions,
  type PlanDeps,
  type StartResult,
} from './lifecycle.js';
import type { PhoneAccess } from './phone.js';
import { emptyTrayMenu, trayMenu } from './tray-menu.js';
import { trayView } from './tray-view.js';
import { StatusWatcher, type WatcherOptions, type WatcherState } from './watcher.js';

/**
 * The Node side's state machine (P8-06): keeps the shell attached to, or running, one Mission
 * Control, and turns the status watcher's state into `ShellLine`s for the Rust side.
 *
 * - At launch (and after "Start Mission Control"), no running server means the shell starts its
 *   own; a running one is attached to.
 * - Its own server exiting unexpectedly is started again, up to three times in five minutes; then
 *   the menu says why and offers "Start Mission Control".
 * - An attached server going away is **not** replaced by one of the shell's: the user stopped it
 *   (or is restarting it — a second server racing it for the lock would make its start fail). The
 *   menu says Mission Control is not running and offers the start; a server that comes back is
 *   attached to again.
 * - A holder that is starting, or an import / restore, is waited for; one whose pid is alive but
 *   that does not answer for 15 s gets a start attempt, and the server's own lock check decides
 *   (a refusal sends the shell back to waiting).
 */

export const TICK_MS = 2000;
const UNANSWERING_GRACE_MS = 15_000;
const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_CRASHES = 3;
const MAX_START_FAILURES = 3;

type Phase = 'starting' | 'stopped' | 'error' | 'connected';

export interface SupervisorOptions {
  paths: DataPaths;
  token: () => string | undefined;
  emit: (line: ShellLine) => void;
  log: (line: string) => void;
  /** Everything `OwnServer` needs but its callbacks. */
  server: Omit<OwnServerOptions, 'onExit' | 'log'>;
  planDeps?: PlanDeps;
  makeOwnServer?: (opts: OwnServerOptions) => Pick<OwnServer, 'start' | 'stop' | 'running'>;
  makeWatcher?: (opts: WatcherOptions) => Pick<StatusWatcher, 'start' | 'stop'>;
  now?: () => number;
  tickMs?: number;
  /** The menu's answers go through it (a fake server in tests). */
  fetch?: typeof fetch;
  /**
   * Phone access (P9-16, `phone.ts`): told when the live Mission Control changes and after a
   * reconnect; while it is on, a server this app starts gets `GALACTIC_PHONE_ACCESS=1`.
   */
  phone?: Pick<PhoneAccess, 'on' | 'setServer' | 'reconnected' | 'stop'>;
}

export class Supervisor {
  private server: ServerInfo | undefined;
  private own: Pick<OwnServer, 'start' | 'stop' | 'running'> | undefined;
  private watcher: Pick<StatusWatcher, 'start' | 'stop'> | undefined;
  private watched: WatcherState | undefined;
  private phase: Phase = 'starting';
  private detail: string | undefined;
  private autoStart = true;
  private crashes: number[] = [];
  private startFailures = 0;
  private waitingSince: number | undefined;
  private busy = false;
  private quitting = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private lastStatus: string | undefined;
  /** The watcher's folded world (the menu's question sections, P9-15). */
  private world: WorldState | undefined;
  /** Permission requests answered from the menu whose answer has not come back yet. */
  private readonly sending = new Set<string>();
  private lastMenu: string | undefined;
  private answers = 0;
  /** The current server's status socket was live at least once (a later live is a reconnect). */
  private liveOnce = false;

  constructor(private readonly opts: SupervisorOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  run(): void {
    this.emitStatus();
    void this.tick();
    this.interval = setInterval(() => void this.tick(), this.opts.tickMs ?? TICK_MS);
  }

  /** The menu's "Start Mission Control". */
  requestStart(): void {
    if (this.quitting) return;
    this.autoStart = true;
    this.crashes = [];
    this.startFailures = 0;
    void this.tick();
  }

  /** Stops the watcher and, only if this shell started it, the server. */
  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    if (this.interval) clearInterval(this.interval);
    this.watcher?.stop();
    this.watcher = undefined;
    this.opts.phone?.stop();
    if (this.own?.running) {
      this.opts.log('stopping the Mission Control this app started');
      await this.own.stop();
    }
    this.opts.emit({ type: 'exited' });
  }

  /** One look at the world: attach, wait, start or report stopped. */
  async tick(): Promise<void> {
    if (this.busy || this.quitting) return;
    this.busy = true;
    try {
      if (this.own?.running) return;
      if (this.server && this.watched?.connection === 'live') return;
      const next = await plan(this.opts.paths, this.opts.planDeps ?? DEFAULT_PLAN_DEPS);
      if (this.quitting) return;
      if (next.kind === 'attach') {
        this.waitingSince = undefined;
        if (!this.server || this.server.port !== next.port || this.server.owned) {
          this.opts.log(`attaching to Mission Control (pid ${next.pid}, port ${next.port})`);
          this.setServer({ url: urlOf(next.port), port: next.port, owned: false, pid: next.pid });
        }
        return;
      }
      if (next.kind === 'wait') {
        this.waitingSince ??= this.now();
        // Only a server that does not answer is raced after the grace; an import or a restore
        // holding the data is waited out, however long it takes (P8-06 review).
        if (
          this.autoStart &&
          next.holder.role === 'server' &&
          this.now() - this.waitingSince > UNANSWERING_GRACE_MS
        ) {
          this.waitingSince = undefined;
          await this.tryStart();
          return;
        }
        if (!this.server || this.watched?.connection !== 'live')
          this.setPhase('starting', next.why);
        return;
      }
      this.waitingSince = undefined;
      if (this.server && !this.server.owned) {
        // The attached server is gone: the user stopped it. Not replaced by the shell's own.
        this.opts.log('the attached Mission Control stopped');
        this.autoStart = false;
        this.clearServer();
      }
      if (this.autoStart) await this.tryStart();
      else if (this.phase !== 'error') this.setPhase('stopped');
    } finally {
      this.busy = false;
    }
  }

  private async tryStart(): Promise<void> {
    this.setPhase('starting');
    const make = this.opts.makeOwnServer ?? ((o: OwnServerOptions) => new OwnServer(o));
    const phoneOn = this.opts.phone?.on ?? false;
    const own = make({
      ...this.opts.server,
      // Phone access: the server adds this Mac's Tailscale name as `remoteHost` before it reads
      // its config, so it needs no restart to accept the phone.
      env: phoneOn ? { ...this.opts.server.env, GALACTIC_PHONE_ACCESS: '1' } : this.opts.server.env,
      log: this.opts.log,
      onExit: (code, signal) => this.onOwnExit(own, code, signal),
    });
    this.own = own;
    this.opts.log('starting Mission Control');
    const result: StartResult = await own.start();
    if (this.quitting) {
      await own.stop();
      return;
    }
    switch (result.kind) {
      case 'started':
        this.startFailures = 0;
        this.opts.log(`Mission Control started on port ${result.port}`);
        this.setServer({
          url: urlOf(result.port),
          port: result.port,
          owned: true,
          pid: result.pid,
        });
        return;
      case 'locked':
        // Another server took the data first: attach to it on the next tick.
        this.own = undefined;
        this.setPhase('starting', 'another Mission Control holds the data');
        return;
      case 'failed':
        await own.stop();
        this.own = undefined;
        this.startFailures++;
        this.opts.log(`Mission Control did not start: ${result.reason}`);
        if (this.startFailures >= MAX_START_FAILURES) this.autoStart = false;
        this.setPhase('error', result.reason);
        return;
    }
  }

  private onOwnExit(
    own: Pick<OwnServer, 'start' | 'stop' | 'running'>,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.quitting || this.own !== own) return;
    this.own = undefined;
    this.opts.log(`Mission Control exited (${code ?? signal})`);
    const now = this.now();
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    this.clearServer();
    if (this.crashes.length >= MAX_CRASHES) {
      this.autoStart = false;
      this.setPhase('error', 'Mission Control stopped unexpectedly several times');
    } else {
      this.setPhase('starting', 'Mission Control stopped; starting it again');
      void this.tick();
    }
  }

  private setServer(info: ServerInfo): void {
    this.watcher?.stop();
    this.server = info;
    this.watched = undefined;
    this.liveOnce = false;
    this.world = undefined;
    this.sending.clear();
    this.phase = 'connected';
    this.detail = undefined;
    this.opts.emit({ type: 'server', server: info });
    this.opts.phone?.setServer(info);
    const make = this.opts.makeWatcher ?? ((o: WatcherOptions) => new StatusWatcher(o));
    const watcher = make({
      url: `ws://127.0.0.1:${info.port}/ws`,
      token: this.opts.token,
      onState: (state) => {
        if (this.watcher !== watcher) return;
        const wasLive = this.watched?.connection === 'live';
        const everLive = this.liveOnce;
        this.watched = state;
        if (state.connection === 'live') {
          this.liveOnce = true;
          if (!wasLive && everLive) this.opts.phone?.reconnected();
        }
        this.emitStatus();
        if (state.connection !== 'live') void this.tick();
      },
      onNotify: (n) => {
        if (this.watcher !== watcher) return;
        this.opts.emit({ type: 'notify', ...n });
      },
      onWorld: (world) => {
        if (this.watcher !== watcher) return;
        this.world = world;
        this.emitMenu();
      },
    });
    this.watcher = watcher;
    this.emitStatus();
    watcher.start();
  }

  private clearServer(): void {
    this.watcher?.stop();
    this.watcher = undefined;
    this.watched = undefined;
    this.server = undefined;
    this.world = undefined;
    this.sending.clear();
    this.opts.phone?.setServer(undefined);
    this.emitMenu();
  }

  private setPhase(phase: Exclude<Phase, 'connected'>, detail?: string): void {
    if (this.server && this.watched?.connection === 'live') return;
    this.phase = phase;
    this.detail = detail;
    this.emitStatus();
  }

  private connectionState(): { state: ConnectionState; detail?: string | undefined } {
    if (this.phase !== 'connected' || !this.server) {
      return { state: this.phase === 'connected' ? 'starting' : this.phase, detail: this.detail };
    }
    const w = this.watched;
    if (!w || w.connection === 'connecting') return { state: 'starting' };
    if (w.connection === 'live') return { state: 'live' };
    if (w.connection === 'unauthorized') return { state: 'error', detail: 'the token was refused' };
    return { state: 'disconnected', detail: w.detail };
  }

  private emitStatus(): void {
    const { state, detail } = this.connectionState();
    const waiting = this.watched?.waiting ?? 0;
    const storage: StorageCondition = this.watched?.storage ?? 'ok';
    const view = trayView({ state, waiting, storage, server: this.server, detail });
    const line: ShellLine = {
      type: 'status',
      state,
      waiting,
      storage,
      view,
      ...(detail ? { detail } : {}),
    };
    const key = JSON.stringify(line);
    if (key !== this.lastStatus) {
      this.lastStatus = key;
      this.opts.emit(line);
    }
    this.emitMenu();
  }

  /** The menu's question sections, when they changed; empty unless the status socket is live. */
  private emitMenu(): void {
    const live = this.connectionState().state === 'live';
    const menu =
      live && this.world ? trayMenu(this.world, { sending: this.sending }) : emptyTrayMenu();
    const key = JSON.stringify(menu);
    if (key === this.lastMenu) return;
    this.lastMenu = key;
    this.opts.emit({ type: 'menu', menu });
  }

  /**
   * "Allow once" / "Deny" from the menu (P9-15): the panel's answer route, with the token and the
   * version the menu showed. A refusal is said in a notification ("already answered by …"); a
   * success needs none (the stream updates the menu and the panel). Only a permission request the
   * world shows open and waiting on the user is answered here (anything else: "no longer
   * waiting"); a second click while one is on its way is ignored.
   */
  async answer(answer: TrayAnswer): Promise<void> {
    if (this.quitting || this.sending.has(answer.questionId)) return;
    const server = this.server;
    const token = this.opts.token();
    const notice = (title: string, body: string) =>
      this.opts.emit({
        type: 'notify',
        id: `galactic:tray-answer:${answer.questionId}:${++this.answers}`,
        title,
        body,
      });
    if (!server || this.connectionState().state !== 'live' || !token) {
      notice(
        'Could not answer the permission request',
        'Mission Control is not connected. Answer it in GalacticAgents.',
      );
      return;
    }
    const known = this.world?.questions[answer.questionId];
    if (
      !known ||
      known.kind !== 'permission' ||
      known.status !== 'open' ||
      known.holder.type !== 'user'
    ) {
      this.opts.log('ignored a menu answer to a question that is not a waiting permission request');
      notice(
        'Permission request is no longer waiting',
        'Your answer was not sent. Open GalacticAgents to see what waits for you.',
      );
      return;
    }
    this.sending.add(answer.questionId);
    this.emitMenu();
    try {
      const outcome = await answerQuestion(answer, {
        baseUrl: server.url,
        token,
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      });
      this.opts.log(`menu answer (${answer.decision}): ${outcome.kind}`);
      const n = outcomeNotice(outcome, answer.decision);
      if (n) notice(n.title, n.body);
    } finally {
      this.sending.delete(answer.questionId);
      this.emitMenu();
    }
  }
}
