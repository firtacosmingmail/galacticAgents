import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type Actor,
  type Deliverable,
  type DeliverableRun,
  type EventEnvelope,
  type Id,
  type PermissionAction,
  type RunEndReason,
  type RunPreviewResponse,
  type RunRefusal,
  type RunSettings,
} from '@galactic/protocol';
import { isStorageFailure } from '../db/database.js';
import {
  recordRunEnded,
  recordRunPorts,
  recordRunStarted,
  type RunEndInput,
} from '../domain/deliverables.js';
import { DomainError } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import { classifyCommand, mentionsPush } from '../domain/permissions.js';
import { LAUNCH_ID_ENV } from '../runtime/launch-intents.js';
import {
  isReaper,
  isSharedDaemon,
  isUserFacingApp,
  RUN_ID_ENV,
  runProcessKey,
  serverTree,
  START_SLACK_MS,
  type ProcEntry,
} from '../runtime/process-attribution.js';
import { osProcessTable, type ProcessTable } from '../runtime/process-table.js';
import { redactSecrets } from '../runtime/redact.js';
import {
  isGroupAlive,
  processStartTime,
  type ExitInfo,
  type ManagedProcess,
  type ProcessOutcome,
  type ProcessSpec,
  type StopProcessOptions,
} from '../runtime/supervisor.js';
import { checkPath, type RefusedPlaces } from './paths.js';
import { rootsInputOf, rootsOf } from './roots.js';
import type { RunOutput } from './run-output.js';

/**
 * Managed runs (P9-08; TECHNOLOGY §9.8; SPEC decisions 129–131). A command deliverable runs only
 * when the user confirms it on the Mac: the confirmation is the gate — the project's permission
 * table and trust level do not apply (decision 129) — and its warnings come from the permission
 * engine's reading of the line (`preview`). No agent ever starts, restarts or stops a run: the
 * service refuses an agent's call, and no agent tool reaches it.
 *
 * **Starting** (`start`): the row's `version` must be the one the dialog showed (409 `stale` with
 * the current row), the preview's `confirmation` must cover exactly the line started (400
 * `unconfirmed`: a token bound to the deliverable, its version and the line's hash), one live run
 * per command (409 `running`), at most `deliverables.runs.maxConcurrent` at once (409 `run_cap`),
 * and the command's folder must still pass the path rules and be the project's folder or its
 * deliverables folder (or a standalone task's workspace) — a folder in a task's worktree waits for
 * the merge (409 `after_merge`). The line is the stored one, or the user's edit for this run: one
 * line, no control character, no `[redacted:…]` mask (400 `invalid`). The event log gets the line
 * redacted (`redactSecrets`); the process runs the real one. The process goes through the supervisor like an agent's
 * (`ProcessSpec.owner = {kind: 'run'}`): `/bin/sh -c <line>` in its own process group, the launch
 * intent written first (a disk that refuses it refuses the run: 507), the allow-listed
 * environment plus `GALACTIC_RUN_ID` and the launch id, never an agent marker, never the server's
 * token or keys; stdin is a pipe closed at once (the command reads end-of-file). `run.started` is logged after the fork, with the body a
 * detected command had when it was confirmed (`meta.body`), so the next preview can say "changed
 * since the last run".
 *
 * **Output** goes to `RunOutput` (redacted, `run_output`, the `run_output` stream). **Ports**
 * come from the output (`http://localhost:<port>`) and from the system — `lsof` over the run's
 * process group, the processes below it and those carrying its marker — every 2 s while a run is
 * in its first minute, every 10 s after: one process-table snapshot and one `lsof` per tick for
 * all the runs, the markers (other processes' environments) read every 15 s only and never kept
 * beyond the match; the system's set wins once it has one (an address printed in the output may
 * be another program's). `run.ports` when the set changes, at most once per 2 s.
 *
 * **Stopping** (`stop`; open to remote clients, decision 131): SIGTERM to the group and to the
 * processes outside it carrying the run's marker (each identity-checked — pid and start time read
 * again — and never a user-facing app or anything below one), SIGKILL after `termMs` (5 s) to what
 * is still the same process; then `run.ended{outcome: 'stopped', by, reason?}`. A run that ends by
 * itself is swept the same way after its `run.ended` (what it left carrying its marker). The
 * marker sweep never takes a daemon shared by the user's session (`isSharedDaemon`: an ssh
 * ControlMaster, ssh-agent, gpg-agent, watchman, the Gradle daemon, …) — the group kill does. The log
 * subscriber stops runs when their project (or a parent) is closed, cancelled or archived
 * (`project_closed`), their standalone task finishes or is archived (`task_finished`), or their
 * deliverable is removed (`deliverable_removed`); `stopAll('server_stopping')` at shutdown.
 *
 * **Restart pass** (`recover`, at startup after the supervisor's `reconcile()` and
 * `reconcileLaunches()`, which stop the previous runs' groups by their PID rows and launch
 * intents): what still carries a live run's marker is stopped, and every run the log still has
 * live ends as `stopped` with `reason: 'server_restarted'`. Nothing is started again (decision 130).
 *
 * A `run.ended` the storage refuses is held and retried every second (the runtime's rule for
 * writes that describe what already happened, P8-04); the restart pass ends it anyway.
 */

/** What the run service needs of the process supervisor (`ProcessSupervisor` fits). */
export interface RunSupervisor {
  spawn(spec: ProcessSpec): Promise<ManagedProcess>;
  stop(key: Id, opts?: StopProcessOptions): Promise<ExitInfo | undefined>;
  childEnv(spec: ProcessSpec): Record<string, string>;
}

export interface RunServiceOptions {
  log: EventLog;
  supervisor: RunSupervisor;
  output: RunOutput;
  /** The `deliverables.runs` settings, read at every start. */
  settings: () => RunSettings;
  /** The data folder and home, refused as roots (§9.2). */
  places: RefusedPlaces;
  /** The process table for ports and marker carriers; default `osProcessTable()`. */
  table?: ProcessTable;
  /** The server itself: never signalled (default this process and its user). */
  self?: { pid: number; uid: number };
  /** A live process's start time (epoch ms), for the identity checks; default `ps lstart`. */
  startTime?: (pid: number) => number | undefined;
  /** Whether a process group still has members; default `isGroupAlive`. */
  groupAlive?: (pgid: number) => boolean;
  /** SIGTERM → SIGKILL (decision 130: five seconds). */
  termMs?: number;
  /**
   * Port polling: every `fastMs` while a run is younger than `fastForMs`, else every `slowMs`;
   * the marker carriers are looked for every `markerMs` (default 15 s).
   */
  ports?: { fastMs?: number; slowMs?: number; fastForMs?: number; markerMs?: number };
  /** How often a refused `run.ended` is tried again. */
  retryMs?: number;
  onError?: (error: unknown, context: string) => void;
}

/** A refusal of the run service, with its HTTP status (TECHNOLOGY §9.8). */
export class RunError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid'
      | 'stale'
      | 'running'
      | 'run_cap'
      | 'after_merge'
      | 'folder'
      | 'not_running'
      | 'unconfirmed'
      | 'start_failed',
    message: string,
    readonly deliverable?: Deliverable,
  ) {
    super(message);
  }

  get status(): number {
    if (this.code === 'not_found') return 404;
    if (this.code === 'invalid' || this.code === 'unconfirmed') return 400;
    if (this.code === 'start_failed') return 500;
    return 409;
  }
}

/** A run this server started and still watches. */
interface LiveRun {
  runId: Id;
  deliverableId: Id;
  key: Id;
  line: string;
  cwd: string;
  /** Real clock (epoch ms) just before the fork: marker carriers start after it. */
  forkedAt: number;
  state: 'starting' | 'running' | 'stopping';
  pgid?: number;
  /** `run.started` is in the log: an exit may be recorded. */
  recorded: boolean;
  /** An outcome that came before `run.started` was recorded. */
  pending?: ProcessOutcome;
  /** Set by `stop`: the outcome is `stopped`, whatever the exit says. */
  stop?: { by: Actor; reason?: string };
  /** The stop under way (group and marker carriers). */
  terminating?: Promise<void>;
  outputPorts: Set<number>;
  outputTail: string;
  systemPorts: Set<number>;
  /** Marker carriers found by the last marker scan: pid → start time (re-checked each tick). */
  carriers: Map<number, number>;
  lastPortsAt: number;
  reportTimer?: NodeJS.Timeout | undefined;
  ended: Promise<void>;
  resolveEnded: () => void;
}

const SYSTEM: Actor = { type: 'system' };
const SECOND = 1_000;
/** Addresses a run's output names (TECHNOLOGY §9.8). */
const PORT_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})\b/g;
/** How the confirmation words what the engine read (decision 49's categories). */
const WARNING_OF: Partial<Record<PermissionAction, string>> = {
  destructive: 'deletes or overwrites files',
  network: 'uses the network',
  push: 'may push (sends something off this machine)',
  outside_workspace: 'reaches outside the project folder',
};
const CLOSED = new Set(['completed', 'failed', 'archived']);
/** How long a preview's confirmation is good for. */
const CONFIRMATION_TTL_MS = 15 * 60 * 1_000;
/**
 * What an edited line may not hold: a newline or another control character (C0 but tab, DEL, C1,
 * the Unicode line and paragraph separators) — the dialog shows one line, so the run is one line.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ports named in `text` (valid ones only). */
export function portsInOutput(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PORT_IN_OUTPUT)) {
    const port = Number(m[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) out.push(port);
  }
  return out;
}

/**
 * A line the user edited in the Run dialog (review S2): trimmed, one line — no newline or other
 * control character — and no `[redacted:…]` mask (the dialog shows a stored secret masked: an
 * edit must type it again rather than run the mask).
 */
export function checkEditedLine(edited: string): string {
  const line = edited.trim();
  if (line === '') throw new RunError('invalid', 'A run needs a command line.');
  if (CONTROL.test(line)) {
    throw new RunError(
      'invalid',
      'An edited command is one line: no newline or other control character.',
    );
  }
  if (line.includes('[redacted:')) {
    throw new RunError(
      'invalid',
      'The command still holds a hidden secret ([redacted:…]): type it again, or run the stored command unedited.',
    );
  }
  return line;
}

export class RunService {
  private readonly log: EventLog;
  private readonly supervisor: RunSupervisor;
  private readonly output: RunOutput;
  private readonly table: ProcessTable;
  private readonly self: { pid: number; uid: number };
  private readonly startTime: (pid: number) => number | undefined;
  private readonly groupAlive: (pgid: number) => boolean;
  private readonly termMs: number;
  private readonly fastMs: number;
  private readonly slowMs: number;
  private readonly fastForMs: number;
  private readonly markerMs: number;
  private readonly retryMs: number;
  /** Signs the previews' confirmations (this server run only). */
  private readonly confirmKey = randomBytes(32);
  /** The one port-polling timer for every live run (one snapshot per tick). */
  private portsTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private lastMarkerScanAt = 0;
  private readonly onError: (error: unknown, context: string) => void;
  /** Live runs by run id. */
  private readonly live = new Map<Id, LiveRun>();
  /** `run.ended` writes the storage refused, retried in order. */
  private readonly held: { runId: Id; input: RunEndInput }[] = [];
  private retryTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private closing = false;

  constructor(private readonly opts: RunServiceOptions) {
    this.log = opts.log;
    this.supervisor = opts.supervisor;
    this.output = opts.output;
    this.table = opts.table ?? osProcessTable();
    this.self = opts.self ?? { pid: process.pid, uid: process.getuid?.() ?? -1 };
    this.startTime = opts.startTime ?? processStartTime;
    this.groupAlive = opts.groupAlive ?? isGroupAlive;
    this.termMs = opts.termMs ?? 5_000;
    this.fastMs = opts.ports?.fastMs ?? 2_000;
    this.slowMs = opts.ports?.slowMs ?? 10_000;
    this.fastForMs = opts.ports?.fastForMs ?? 60_000;
    this.markerMs = opts.ports?.markerMs ?? 15_000;
    this.retryMs = opts.retryMs ?? 1_000;
    this.onError = opts.onError ?? (() => {});
  }

  /** Follows the log: closed work and removed deliverables stop their runs. */
  watch(): void {
    this.unsubscribe ??= this.log.subscribe((envelope) => this.onEvent(envelope));
  }

  /** The runs this server watches now, by deliverable (the routes' live states). */
  liveRun(deliverableId: Id): { runId: Id; state: LiveRun['state'] } | undefined {
    for (const run of this.live.values()) {
      if (run.deliverableId === deliverableId) return { runId: run.runId, state: run.state };
    }
    return undefined;
  }

  get liveCount(): number {
    return this.live.size;
  }

  // -- the confirmation ------------------------------------------------------------------------

  /**
   * What the Run dialog shows (decision 129); `refusal` when a start now would be refused. With
   * `edited`, the line the user edited in the dialog: its warnings, and a confirmation for it
   * (wave-3 review S3). The line shown is redacted; the confirmation covers the real one.
   */
  preview(deliverableId: Id, edited?: string): RunPreviewResponse {
    const row = this.commandRow(deliverableId);
    const command = row.command!;
    const cwd = this.checkCwd(row);
    const line = edited === undefined ? command.line : checkEditedLine(edited);
    const { warnings, reasons } = this.warningsOf(line, row, cwd.ok ? cwd.cwd : command.cwd);
    const detected = row.meta?.['detected'] as { body?: unknown } | undefined;
    const body = typeof detected?.body === 'string' ? detected.body : undefined;
    const lastBody = this.log.tables.runs.of(row.id, 1)[0]?.meta?.['body'];
    const changed =
      body !== undefined && typeof lastBody === 'string' ? lastBody !== body : undefined;
    const refusal: RunRefusal | undefined = !cwd.ok
      ? cwd.refusal
      : this.liveRun(row.id)
        ? { code: 'running', message: 'This command is already running: stop it first.' }
        : this.live.size >= this.opts.settings().maxConcurrent
          ? { code: 'run_cap', message: this.capMessage() }
          : undefined;
    return {
      deliverableId: row.id,
      version: row.version,
      line: redactSecrets(line),
      cwd: cwd.ok ? cwd.cwd : command.cwd,
      envKeys: this.envKeys(row.id),
      warnings,
      ...(reasons.length > 0 ? { reasons } : {}),
      source: row.source,
      addedBy: row.addedBy,
      ...(command.detectedFrom ? { detectedFrom: command.detectedFrom } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(changed !== undefined ? { bodyChanged: changed } : {}),
      ...(changed && typeof lastBody === 'string' ? { lastRunBody: lastBody } : {}),
      ...(refusal ? { refusal } : {}),
      confirmation: this.confirmationOf(row.id, row.version, line),
    };
  }

  /** A token for exactly `line` at `version` of the deliverable: `<issued ms, base 36>.<HMAC>`. */
  private confirmationOf(deliverableId: Id, version: number, line: string, at = Date.now()) {
    return `${at.toString(36)}.${this.macOf(deliverableId, version, line, at)}`;
  }

  private macOf(deliverableId: Id, version: number, line: string, at: number): string {
    const lineHash = createHash('sha256').update(line, 'utf8').digest('hex');
    return createHmac('sha256', this.confirmKey)
      .update(`run-confirmation\n${deliverableId}\n${version}\n${at}\n${lineHash}`)
      .digest('base64url');
  }

  /** Whether `token` is a confirmation of this server run for exactly `line` at `version`. */
  private covers(token: string, deliverableId: Id, version: number, line: string): boolean {
    const [issued, mac, extra] = token.split('.');
    if (!issued || !mac || extra !== undefined || !/^[0-9a-z]{1,12}$/.test(issued)) return false;
    const at = parseInt(issued, 36);
    const age = Date.now() - at;
    if (!Number.isSafeInteger(at) || age < -60_000 || age > CONFIRMATION_TTL_MS) return false;
    const want = Buffer.from(this.macOf(deliverableId, version, line, at));
    const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  // -- starting --------------------------------------------------------------------------------

  /**
   * Every check a start makes before anything happens (the row, its version, the confirmation of
   * the exact line, one run per command, the cap, the folder). `replacing` is the run a restart
   * stops first: it counts neither as the command's live run nor against the cap.
   */
  private prepare(
    deliverableId: Id,
    confirmed: { version: number; line?: string | undefined; confirmation: string },
    by: Actor,
    replacing?: Id,
  ): { row: Deliverable; cwd: string; line: string } {
    if (by.type === 'agent') {
      throw new RunError('invalid', 'An agent cannot start a run: the user starts it on the Mac.');
    }
    if (this.closing) throw new RunError('start_failed', 'Mission Control is stopping.');
    const row = this.commandRow(deliverableId);
    if (confirmed.version !== row.version) {
      throw new RunError(
        'stale',
        'The command changed since the dialog opened: check it again.',
        row,
      );
    }
    const line = confirmed.line === undefined ? row.command!.line : checkEditedLine(confirmed.line);
    if (line.trim() === '' || line.includes('\0')) {
      throw new RunError('invalid', 'A run needs a command line (without NUL characters).');
    }
    if (!this.covers(confirmed.confirmation, row.id, row.version, line)) {
      throw new RunError(
        'unconfirmed',
        'The confirmation does not cover this command line: open the Run dialog again.',
      );
    }
    const live = this.liveRun(row.id);
    if (live && live.runId !== replacing) {
      throw new RunError('running', 'This command is already running: stop it first.');
    }
    const others = [...this.live.keys()].filter((id) => id !== replacing).length;
    if (others >= this.opts.settings().maxConcurrent) {
      throw new RunError('run_cap', this.capMessage());
    }
    const cwd = this.checkCwd(row);
    if (!cwd.ok) throw new RunError(cwd.refusal.code as RunError['code'], cwd.refusal.message);
    return { row, cwd: cwd.cwd, line };
  }

  /**
   * Starts a run the user confirmed on the Mac (the routes check where the request comes from).
   * Resolves once the process runs and `run.started` is logged.
   */
  async start(
    deliverableId: Id,
    confirmed: { version: number; line?: string | undefined; confirmation: string },
    by: Actor,
  ): Promise<DeliverableRun> {
    const { row, cwd, line } = this.prepare(deliverableId, confirmed, by);

    const runId = `r-${randomUUID()}`;
    let resolveEnded!: () => void;
    const run: LiveRun = {
      runId,
      deliverableId: row.id,
      key: runProcessKey(runId),
      line,
      cwd,
      forkedAt: Date.now(),
      state: 'starting',
      recorded: false,
      outputPorts: new Set(),
      outputTail: '',
      systemPorts: new Set(),
      carriers: new Map(),
      lastPortsAt: 0,
      ended: new Promise<void>((r) => (resolveEnded = r)),
      resolveEnded: () => resolveEnded(),
    };
    // Reserved before the first await: a second Run, or the cap, sees it at once.
    this.live.set(runId, run);
    let proc: ManagedProcess;
    try {
      proc = await this.supervisor.spawn(this.specOf(run));
    } catch (error) {
      this.live.delete(runId);
      run.resolveEnded();
      // A launch intent the disk refused keeps its storage code: the route answers 507.
      if (isStorageFailure(error)) throw error;
      throw new RunError(
        'start_failed',
        `The command could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    run.pgid = proc.pid;
    proc.child.stdin?.end();
    const detected = row.meta?.['detected'] as { body?: unknown } | undefined;
    let recorded: DeliverableRun;
    try {
      recorded = this.log.runCommand((ctx) =>
        recordRunStarted(
          ctx,
          {
            runId,
            deliverableId: row.id,
            // The log keeps the line redacted (a token typed into it is never stored); the
            // process runs the real one.
            line: redactSecrets(line),
            cwd,
            meta: {
              pid: proc.pid,
              ...(typeof detected?.body === 'string' ? { body: detected.body } : {}),
              ...(confirmed.line !== undefined && line !== row.command!.line
                ? { edited: true }
                : {}),
            },
          },
          by,
        ),
      ).value;
    } catch (error) {
      // Not logged (the disk, or a run that slipped in): the process must not outlive it.
      run.stop = { by: SYSTEM };
      run.state = 'stopping';
      await this.supervisor
        .stop(run.key, { graceMs: 0, termMs: 0, reapMs: 0, by: SYSTEM })
        .catch((e: unknown) => this.onError(e, `run ${runId}: stop after a refused start`));
      this.live.delete(runId);
      run.resolveEnded();
      if (error instanceof DomainError && error.code === 'conflict') {
        throw new RunError('running', error.message);
      }
      throw error;
    }
    run.recorded = true;
    if (run.state === 'starting') run.state = 'running';
    if (run.pending) {
      const outcome = run.pending;
      delete run.pending;
      void this.ended(run, outcome);
    } else {
      this.schedulePorts();
    }
    return recorded;
  }

  /**
   * Restart (`POST /api/runs/:id/restart`): every check a start makes runs first — the version,
   * the confirmation of the exact line, the folder, the cap without this run — so a restart that
   * could not start again stops nothing (wave-3 review S6); then the run is stopped and a new one
   * started (which checks again).
   */
  async restart(
    runId: Id,
    confirmed: { version: number; line?: string | undefined; confirmation: string },
    by: Actor,
  ): Promise<DeliverableRun> {
    const previous = this.log.tables.runs.get(runId);
    if (!previous) throw new RunError('not_found', `no run ${runId}`);
    this.prepare(previous.deliverableId, confirmed, by, runId);
    await this.stop(runId, by);
    return this.start(previous.deliverableId, confirmed, by);
  }

  private specOf(run: LiveRun): ProcessSpec {
    return {
      agentId: run.key,
      owner: { kind: 'run', id: run.runId },
      command: '/bin/sh',
      args: ['-c', run.line],
      cwd: run.cwd,
      meta: { deliverableId: run.deliverableId },
      // The graceful step of a stop is SIGTERM to the group (not the agents' SIGINT).
      interrupt: (proc) => {
        proc.signal('SIGTERM');
        proc.signal('SIGCONT');
      },
      onStdout: (chunk) => this.onOutput(run, chunk),
      onStderr: (chunk) => this.onOutput(run, chunk),
      onOutcome: (outcome) => {
        if (outcome.kind === 'restarting') return;
        if (!run.recorded) {
          run.pending = outcome;
          return;
        }
        void this.ended(run, outcome);
      },
    };
  }

  private onOutput(run: LiveRun, chunk: string): void {
    this.output.append(run.runId, chunk);
    const text = run.outputTail + chunk;
    run.outputTail = text.slice(-64);
    let grew = false;
    for (const port of portsInOutput(text)) {
      if (!run.outputPorts.has(port)) {
        run.outputPorts.add(port);
        grew = true;
      }
    }
    if (grew) this.reportPorts(run);
  }

  // -- stopping --------------------------------------------------------------------------------

  /**
   * Stops a live run (the user's Stop — from the Mac or the phone, decision 131 — or the server's
   * own with a `reason`). Resolves once it ended. An ended run is answered as it is.
   */
  async stop(runId: Id, by: Actor, reason?: string): Promise<DeliverableRun> {
    if (by.type === 'agent') {
      throw new RunError('invalid', 'An agent cannot stop a run: only the user does.');
    }
    const run = this.live.get(runId);
    if (!run) {
      const row = this.log.tables.runs.get(runId);
      if (!row) throw new RunError('not_found', `no run ${runId}`);
      return row;
    }
    if (run.state !== 'stopping') {
      run.state = 'stopping';
      run.stop = { by, ...(reason ? { reason } : {}) };
      run.terminating = this.terminate(run).catch((error: unknown) =>
        this.onError(error, `run ${runId}: stop`),
      );
    }
    await run.ended;
    return this.log.tables.runs.get(runId)!;
  }

  /** SIGTERM to the group and the marker carriers, SIGKILL after `termMs` to what is left. */
  private async terminate(run: LiveRun): Promise<void> {
    const deadline = Date.now() + this.termMs;
    const group = this.supervisor
      .stop(run.key, {
        graceMs: this.termMs,
        termMs: 0,
        reapMs: () => Math.max(250, deadline - Date.now()),
        by: run.stop?.by ?? SYSTEM,
      })
      .catch((error: unknown) => this.onError(error, `run ${run.runId}: stop`));
    await this.sweepCarriers(run.runId, run.forkedAt, deadline, run.pgid);
    await group;
  }

  /**
   * The processes outside the run's group that carry its marker: SIGTERM (and SIGCONT), then
   * SIGKILL at `deadline` to each that is still the same process. Never a user-facing app or
   * anything below one, another user's, a reaper or the server's own tree.
   */
  private async sweepCarriers(
    runId: Id,
    since: number,
    deadline: number,
    pgid?: number,
  ): Promise<number[]> {
    const carriers = await this.carriers(runId, since, pgid);
    const signalled = carriers.filter((p) => this.same(p) && this.table.kill(p.pid, 'SIGTERM'));
    for (const p of signalled) this.table.kill(p.pid, 'SIGCONT');
    while (signalled.some((p) => this.same(p)) && Date.now() < deadline) await sleep(50);
    for (const p of signalled) if (this.same(p)) this.table.kill(p.pid, 'SIGKILL');
    return signalled.map((p) => p.pid);
  }

  /** The pid still names the process seen in the snapshot (its start time, read again). */
  private same(p: ProcEntry): boolean {
    const started = this.startTime(p.pid);
    return started !== undefined && Math.abs(started - p.startedAt) <= START_SLACK_MS;
  }

  /**
   * Processes carrying `GALACTIC_RUN_ID=<runId>`, started after the run (outside `pgid`), but
   * never a daemon shared by the user's session (`isSharedDaemon`).
   */
  private async carriers(runId: Id, since: number, pgid?: number): Promise<ProcEntry[]> {
    const procs = await this.table.list();
    if (!procs || !this.table.environment) return [];
    // A daemon shared by the user's session is never the run's to take (review S4): the group
    // kill reaches it only when it stayed in the run's group.
    const candidates = this.candidates(procs, since).filter(
      (p) => p.pgid !== pgid && !isSharedDaemon(p),
    );
    if (candidates.length === 0) return [];
    const env = await this.table.environment(candidates, [RUN_ID_ENV]);
    return candidates.filter((p) => env.get(p.pid)?.get(RUN_ID_ENV) === runId);
  }

  /** The processes of the server's user that a run could have started, safe to look at. */
  private candidates(procs: readonly ProcEntry[], since: number): ProcEntry[] {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const server = serverTree(procs, this.self.pid);
    const belowUserApp = (p: ProcEntry): boolean => {
      let q: ProcEntry | undefined = p;
      for (let depth = 0; q && depth < 256; depth++) {
        if (isUserFacingApp(q)) return true;
        if (q.ppid <= 1) return false;
        q = byPid.get(q.ppid);
        if (q && isReaper(q)) return false;
      }
      return false;
    };
    const from = Math.floor(since / SECOND) * SECOND - START_SLACK_MS;
    return procs.filter(
      (p) =>
        p.uid === this.self.uid &&
        !p.zombie &&
        !isReaper(p) &&
        !server.has(p.pid) &&
        p.startedAt >= from &&
        !belowUserApp(p),
    );
  }

  /** A process outcome ends the run: `run.ended`, then what it left carrying its marker. */
  private async ended(run: LiveRun, outcome: ProcessOutcome): Promise<void> {
    if (!this.live.has(run.runId)) return;
    this.clearTimers(run);
    this.output.flush();
    const input = this.endOf(run, outcome);
    this.recordEnded(run.runId, input);
    this.live.delete(run.runId);
    // What it left outside its group (a daemon it started) goes with it; a stop under way takes
    // it itself (and is waited for).
    if (run.stop) {
      await run.terminating;
    } else {
      await this.sweepCarriers(run.runId, run.forkedAt, Date.now() + this.termMs, run.pgid).catch(
        (error: unknown) => this.onError(error, `run ${run.runId}: sweep`),
      );
    }
    run.resolveEnded();
  }

  private endOf(run: LiveRun, outcome: ProcessOutcome): RunEndInput {
    const exit = 'exit' in outcome ? outcome.exit : undefined;
    const codes = {
      ...(exit?.code !== null && exit?.code !== undefined ? { exitCode: exit.code } : {}),
      ...(exit?.signal ? { signal: exit.signal } : {}),
    };
    if (run.stop) {
      return {
        outcome: 'stopped',
        ...codes,
        ...(run.stop.reason ? { reason: run.stop.reason } : {}),
        by: run.stop.by,
      };
    }
    if (outcome.kind === 'start_failed') return { outcome: 'failed', reason: 'start_failed' };
    if (exit?.signal) return { outcome: 'failed', ...codes };
    return { outcome: 'exited', ...codes };
  }

  /** `run.ended`; held and retried when the storage refuses it (P8-04). */
  private recordEnded(runId: Id, input: RunEndInput): void {
    if (this.held.length > 0) {
      this.held.push({ runId, input });
      return;
    }
    try {
      this.log.runCommand((ctx) => recordRunEnded(ctx, runId, input));
    } catch (error) {
      if (!isStorageFailure(error)) {
        this.onError(error, `run ${runId}: run.ended`);
        return;
      }
      this.held.push({ runId, input });
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      while (this.held.length > 0) {
        const next = this.held[0]!;
        try {
          this.log.runCommand((ctx) => recordRunEnded(ctx, next.runId, next.input));
        } catch (error) {
          if (isStorageFailure(error)) {
            this.scheduleRetry();
            return;
          }
          this.onError(error, `run ${next.runId}: run.ended`);
        }
        this.held.shift();
      }
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  // -- ports -----------------------------------------------------------------------------------

  /**
   * The one polling timer (review N1): every `fastMs` while a live run is younger than
   * `fastForMs`, else every `slowMs`; armed while a run is running.
   */
  private schedulePorts(): void {
    if (this.portsTimer || this.polling || this.closing) return;
    const running = [...this.live.values()].filter((r) => r.state === 'running');
    if (running.length === 0) return;
    const now = Date.now();
    const young = running.some((r) => now - r.forkedAt < this.fastForMs);
    this.portsTimer = setTimeout(
      () => {
        this.portsTimer = undefined;
        this.polling = true;
        void this.pollPorts()
          .catch((error: unknown) => this.onError(error, 'runs: ports'))
          .finally(() => {
            this.polling = false;
            this.schedulePorts();
          });
      },
      young ? this.fastMs : this.slowMs,
    );
    this.portsTimer.unref?.();
  }

  /**
   * One tick for every running run: one process-table snapshot; each run's group, what is below
   * it, and its marker carriers — looked for in other processes' environments every `markerMs`
   * only, the environments dropped once matched (only the matching pids and their start times are
   * kept, re-checked against each snapshot); then one `lsof` over all of them.
   */
  private async pollPorts(): Promise<void> {
    const runs = [...this.live.values()].filter((r) => r.state === 'running' && r.pgid);
    if (runs.length === 0) return;
    const procs = await this.table.list();
    if (!procs) return;
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const pidsOf = new Map<LiveRun, Set<number>>();
    for (const run of runs) {
      const pids = new Set(procs.filter((p) => p.pgid === run.pgid && !p.zombie).map((p) => p.pid));
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of procs) {
          if (!pids.has(p.pid) && pids.has(p.ppid) && !p.zombie && !isUserFacingApp(p)) {
            pids.add(p.pid);
            grew = true;
          }
        }
      }
      pidsOf.set(run, pids);
    }
    const now = Date.now();
    if (this.table.environment && now - this.lastMarkerScanAt >= this.markerMs) {
      this.lastMarkerScanAt = now;
      const since = Math.min(...runs.map((r) => r.forkedAt));
      const taken = new Set([...pidsOf.values()].flatMap((set) => [...set]));
      const rest = this.candidates(procs, since).filter((p) => !taken.has(p.pid));
      const found = new Map<Id, Map<number, number>>();
      if (rest.length > 0) {
        const env = await this.table.environment(rest, [RUN_ID_ENV]);
        for (const p of rest) {
          const id = env.get(p.pid)?.get(RUN_ID_ENV);
          if (id === undefined) continue;
          if (!found.has(id)) found.set(id, new Map());
          found.get(id)!.set(p.pid, p.startedAt);
        }
        env.clear();
      }
      for (const run of runs) run.carriers = found.get(run.runId) ?? new Map();
    }
    for (const run of runs) {
      for (const [pid, startedAt] of run.carriers) {
        const p = byPid.get(pid);
        if (!p || p.zombie || Math.abs(p.startedAt - startedAt) > START_SLACK_MS) {
          run.carriers.delete(pid);
        } else {
          pidsOf.get(run)!.add(pid);
        }
      }
    }
    const all = [...new Set([...pidsOf.values()].flatMap((set) => [...set]))];
    const portsByPid = await this.table.ports(all);
    for (const run of runs) {
      if (this.live.get(run.runId) !== run) continue;
      const found = new Set<number>();
      for (const pid of pidsOf.get(run)!) {
        for (const port of portsByPid.get(pid) ?? []) found.add(port);
      }
      run.systemPorts = found;
      this.reportPorts(run);
    }
  }

  /** `run.ports` when the set changed, at most once per `fastMs`. */
  private reportPorts(run: LiveRun): void {
    if (!run.recorded || this.live.get(run.runId) !== run) return;
    const wait = run.lastPortsAt + this.fastMs - Date.now();
    if (wait > 0) {
      if (!run.reportTimer) {
        run.reportTimer = setTimeout(() => {
          run.reportTimer = undefined;
          this.reportPorts(run);
        }, wait);
        run.reportTimer.unref?.();
      }
      return;
    }
    const ports = [...(run.systemPorts.size > 0 ? run.systemPorts : run.outputPorts)];
    const current = this.log.tables.runs.get(run.runId);
    const sorted = [...new Set(ports)].sort((a, b) => a - b);
    if (!current || JSON.stringify(current.ports) === JSON.stringify(sorted)) return;
    try {
      this.log.runCommand((ctx) => recordRunPorts(ctx, run.runId, sorted));
      run.lastPortsAt = Date.now();
    } catch (error) {
      // The next poll tries again (the set still differs).
      if (!isStorageFailure(error)) this.onError(error, `run ${run.runId}: run.ports`);
    }
  }

  private clearTimers(run: LiveRun): void {
    if (run.reportTimer) clearTimeout(run.reportTimer);
    run.reportTimer = undefined;
  }

  // -- closed work, shutdown, restart ----------------------------------------------------------

  private onEvent({ event }: EventEnvelope): void {
    if (this.live.size === 0) return;
    const stopWhere = (match: (d: Deliverable) => boolean, reason: RunEndReason) => {
      for (const run of [...this.live.values()]) {
        const row = this.log.tables.deliverables.get(run.deliverableId);
        if (row && match(row)) {
          void this.stop(run.runId, SYSTEM, reason).catch((error: unknown) =>
            this.onError(error, `run ${run.runId}: stop (${reason})`),
          );
        }
      }
    };
    switch (event.type) {
      case 'project.state_changed':
        if (CLOSED.has(event.to)) {
          stopWhere((d) => this.inProject(d, event.projectId), 'project_closed');
        }
        return;
      case 'task.state_changed': {
        if (!CLOSED.has(event.to)) return;
        const task = this.log.tables.tasks.get(event.taskId);
        if (task && task.projectId === undefined) {
          stopWhere((d) => d.taskId === event.taskId, 'task_finished');
        }
        return;
      }
      case 'deliverable.removed':
        stopWhere((d) => d.id === event.deliverableId, 'deliverable_removed');
        return;
      default:
        return;
    }
  }

  /** The deliverable's project is `projectId` or below it. */
  private inProject(d: Deliverable, projectId: Id): boolean {
    const seen = new Set<Id>();
    let id = d.projectId ?? (d.taskId ? this.log.tables.tasks.get(d.taskId)?.projectId : undefined);
    while (id !== undefined && !seen.has(id)) {
      if (id === projectId) return true;
      seen.add(id);
      id = this.log.tables.projects.get(id)?.parentProjectId;
    }
    return false;
  }

  /** Shutdown: every live run stopped (`server_stopping`), awaited; no new run starts. */
  async stopAll(reason: RunEndReason = 'server_stopping'): Promise<void> {
    this.closing = true;
    await Promise.all(
      [...this.live.values()].map((run) =>
        this.stop(run.runId, SYSTEM, reason).catch((error: unknown) =>
          this.onError(error, `run ${run.runId}: stop (${reason})`),
        ),
      ),
    );
  }

  /**
   * The restart pass (TECHNOLOGY §9.8): after the supervisor's `reconcile()` and
   * `reconcileLaunches()`, what still carries the marker of a run the log has live is stopped,
   * and each such run ends `stopped` with `server_restarted`. Returns the runs it ended.
   */
  async recover(
    opts: { launches?: readonly { runId: Id; intendedAt: string }[] | undefined } = {},
  ): Promise<{ ended: Id[]; stopped: number[] }> {
    const open = this.log.tables.deliverables
      .all()
      .filter((d) => d.lastRun && d.lastRun.state !== 'ended' && !this.live.has(d.lastRun.runId));
    const ended: Id[] = [];
    const stopped: number[] = [];
    // Runs forked just before the crash that the log may not know (`run.started` never written):
    // the supervisor took their group by the launch intent; what escaped it carries the marker.
    const known = new Set(open.map((d) => d.lastRun!.runId));
    for (const launch of opts.launches ?? []) {
      if (known.has(launch.runId) || this.live.has(launch.runId)) continue;
      const since = Date.parse(launch.intendedAt);
      try {
        stopped.push(
          ...(await this.sweepCarriers(
            launch.runId,
            Number.isNaN(since) ? 0 : since,
            Date.now() + this.termMs,
          )),
        );
      } catch (error) {
        this.onError(error, `run ${launch.runId}: restart sweep`);
      }
    }
    for (const d of open) {
      const runId = d.lastRun!.runId;
      const since = Date.parse(d.lastRun!.startedAt);
      try {
        stopped.push(
          ...(await this.sweepCarriers(
            runId,
            Number.isNaN(since) ? 0 : since,
            Date.now() + this.termMs,
          )),
        );
      } catch (error) {
        this.onError(error, `run ${runId}: restart sweep`);
      }
      this.recordEnded(runId, {
        outcome: 'stopped',
        reason: 'server_restarted' satisfies RunEndReason,
        by: SYSTEM,
      });
      ended.push(runId);
    }
    return { ended, stopped };
  }

  /** Stops following the log and forgets the runs (no write after this; `stopAll` first). */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const run of this.live.values()) {
      this.clearTimers(run);
      run.resolveEnded();
    }
    this.live.clear();
    if (this.portsTimer) clearTimeout(this.portsTimer);
    this.portsTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  // -- checks ----------------------------------------------------------------------------------

  /** A listed command deliverable, or the refusal. */
  private commandRow(deliverableId: Id): Deliverable {
    const row = this.log.tables.deliverables.get(deliverableId);
    if (!row || row.removedAt !== undefined) {
      throw new RunError('not_found', `no deliverable ${deliverableId}`);
    }
    if (row.kind !== 'command' || !row.command) {
      throw new RunError('invalid', `deliverable ${deliverableId} is a ${row.kind}, not a command`);
    }
    return row;
  }

  /**
   * The command's folder, re-checked (§9.2) over the same roots every read uses (`rootsOf`, so a
   * deliverables folder or worktree replaced by a link is no root): inside the project's folder or
   * its deliverables folder (or a standalone task's workspace), never a task's worktree — that one
   * waits for the merge.
   */
  private checkCwd(
    row: Deliverable,
  ): { ok: true; cwd: string } | { ok: false; refusal: RunRefusal } {
    const roots = rootsOf(this.log.tables, row, this.opts.places);
    if (!roots) {
      return {
        ok: false,
        refusal: { code: 'folder', message: "The command's project folder is not known." },
      };
    }
    const check = checkPath(row.command!.cwd, roots);
    if (!check.ok) {
      return { ok: false, refusal: { code: 'folder', message: check.reason } };
    }
    if (check.where === 'worktree') {
      return {
        ok: false,
        refusal: {
          code: 'after_merge',
          message: "Available after the merge: the command is still in the task's worktree.",
        },
      };
    }
    // The project's folder (or its deliverables folder), never the rest of the repository it is
    // in (decision 129: "a run happens in the project's folder"; review N6).
    if (check.type !== 'folder' || !['workspace', 'deliverables'].includes(check.where)) {
      return {
        ok: false,
        refusal: { code: 'folder', message: 'A run happens in the project folder.' },
      };
    }
    return { ok: true, cwd: check.path };
  }

  private warningsOf(
    line: string,
    row: Deliverable,
    cwd: string,
  ): { warnings: string[]; reasons: string[] } {
    const roots = rootsOf(this.log.tables, row, this.opts.places);
    // The recorded folder as written counts as the user's even when it is no root (a link).
    const folders = [
      ...new Set(
        [roots?.deliverablesFolder, rootsInputOf(this.log.tables, row)?.deliverablesFolder].filter(
          (f): f is string => f !== undefined,
        ),
      ),
    ];
    const verdict = classifyCommand(line, {
      workspace: roots?.workspace ?? cwd,
      cwd,
      ...(folders.length > 0 ? { userFolders: folders } : {}),
    });
    const warnings: string[] = [];
    for (const action of verdict.actions) {
      const text = WARNING_OF[action];
      if (text && !warnings.includes(text)) warnings.push(text);
    }
    if (verdict.unclassified) warnings.push('could not read all of it');
    const push = WARNING_OF.push!;
    if (!warnings.includes(push) && mentionsPush(line).length > 0) warnings.push(push);
    return { warnings, reasons: verdict.reasons };
  }

  /** The environment's keys a run of this deliverable gets (never their values). */
  private envKeys(deliverableId: Id): string[] {
    const env = this.supervisor.childEnv({
      agentId: runProcessKey('preview'),
      owner: { kind: 'run', id: 'preview' },
      command: '/bin/sh',
      cwd: '/',
      meta: { deliverableId },
    });
    return [...new Set([...Object.keys(env), LAUNCH_ID_ENV])].sort();
  }

  private capMessage(): string {
    const max = this.opts.settings().maxConcurrent;
    return `${max} runs are running already (the most at once): stop one first.`;
  }
}
