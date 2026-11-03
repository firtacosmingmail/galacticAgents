import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type {
  Actor,
  AgentAdapter,
  AgentEvent,
  GateVerdict,
  Id,
  ModelInfo,
  PermissionGate,
  ProviderUsage,
  RuntimePreflight,
  SendOptions,
  SpawnHandle,
  SpawnOptions,
  StopOptions,
  ToolCall,
  ToolDefinition,
} from '@galactic/protocol';
import { SKIPPED_ANSWER } from '@galactic/protocol';
import { EventQueue } from '../../lib/event-queue.js';
import {
  INHERITED_ENV,
  type ManagedProcess,
  type ProcessOutcome,
  type ProcessSupervisor,
} from '../../runtime/supervisor.js';
import { SERVER_VERSION } from '../../version.js';
import { dismissedClarification, isDismissed, type Dismissed } from '../dismissal.js';
import { fitsQuestionSet, setTitle } from '../question-set.js';
import { LIMIT_ERROR, isUsageLimit, limitResetsAt, usageFrom } from './limits.js';
import {
  commandCall,
  describeCall,
  fileChangeCall,
  fileChanges,
  fileChangesCall,
  itemOutput,
  modelInfos,
  permissionsCall,
  planProgress,
  userQuestions,
  type UserQuestion,
} from './mapping.js';
import { defaultAuthSource, prepareCodexHome, type PreparedHome } from './home.js';
import { codexPreflight } from './preflight.js';
import {
  initializeParams,
  METHOD_NOT_FOUND,
  queryAppServer,
  RpcClosed,
  RpcError,
  RpcPeer,
  type ServerRequestReply,
} from './rpc.js';

/**
 * The `codex` adapter (P11-04; TECHNOLOGY §3.6): Stewards on OpenAI's Codex CLI with a ChatGPT
 * subscription, driven over `codex app-server` (JSON-RPC 2.0, one JSON object per line on stdio).
 * Shapes are the P11-01 spike's (`docs/tasks/notes/P11-01-provider-spikes.md`, Codex 1–8).
 *
 * **One app-server process per session**, started through the process supervisor (`adopt()`: own
 * process group, PID table, agent marker, graceful stop) with the risky features switched off on
 * its command line (`APP_SERVER_ARGS`), then `initialize` → `thread/start` (or `thread/resume`)
 * with the safe settings (`approvalPolicy: "untrusted"`, sandbox `workspace-write` with network
 * off, web search, MCP servers, apps/plugins and image generation off — `SAFE_THREAD_CONFIG`). The
 * process's outcome is the session's one terminal event.
 *
 * **Every action is gated.** Under `untrusted` Codex asks before every command and every file
 * change; each request is translated (`mapping.ts`) and checked once by the permission gate:
 * `allow` → `accept` + `agent.tool_call`, `deny` → `decline` + a transcript line, `ask` →
 * `agent.needs_input(permission)` with the call attached, answered when `answer()` arrives (no
 * timeout: P11-01 saw a 10-minute-late answer honoured). Never `acceptForSession`, never an
 * execpolicy or network amendment. A file change is judged per path (the paths are on the
 * `fileChange` item started before the request); every path must be allowed. A request for more
 * permissions is `codex:permissions` (the table's `unclassified` entry decides), granted for the
 * turn only. MCP elicitations are declined (MCP is off). The `node_repl` MCP tool `js` runs
 * without any approval under `untrusted` and cannot be switched off (P11-04, Ruling R5): it is
 * reported as an `agent.tool_call` for the log, never as approved.
 *
 * **The server's tools** (`SpawnOptions.tools`) are Codex dynamic tools (`thread/start
 * dynamicTools`, experimental API): a call arrives as `item/tool/call`, is checked by the gate
 * under its bare name (a server tool is allowed there), runs its handler, and answers with the
 * result as one JSON `inputText` item.
 *
 * **Questions**: `item/tool/requestUserInput` → one `agent.needs_input(clarification)` per
 * question (several at once as a question set, P8-20).
 *
 * **Turns**: `send()` is `turn/start`; `turn/completed` ends it (`agent.idle`; a failed turn says
 * why first). `interrupt()` is `turn/interrupt`. Finished items become one `agent.output` each
 * (deltas are never transcript), `turn/plan/updated` becomes `agent.progress`.
 *
 * **Limits**: an `error` with `codexErrorInfo: "usageLimitExceeded"` reads `account/rateLimits/read`
 * and ends the session with `agent.failed{reason: 'limit', resetsAt}`.
 *
 * **Resume**: `sessionRef` is `codex:<threadId>`; `resumeSession` starts a new process and calls
 * `thread/resume` with the same settings. **Pause** is `SIGSTOP`/`SIGCONT` on the process group.
 * A ChatGPT subscription reports no dollars: no `cost`. Brains do not run on Codex (only Stewards,
 * Global Constraints), and `bare` is a Claude-only notion: both are refused.
 */

/** Arguments after `app-server`: features off on the command line (P11-01 notes, Codex 1). */
export const APP_SERVER_ARGS: readonly string[] = [
  '--disable',
  'plugins',
  '--disable',
  'apps',
  '--disable',
  'image_generation',
  '--disable',
  'browser_use',
  '--disable',
  'computer_use',
  // Codex hooks (`PermissionRequest`) could answer an approval before Mission Control does.
  '--disable',
  'hooks',
  '-c',
  'web_search="disabled"',
];

/** The thread `config` overrides every `thread/start` and `thread/resume` carries. */
export const SAFE_THREAD_CONFIG: Readonly<Record<string, unknown>> = {
  web_search: 'disabled',
  mcp_servers: {},
  sandbox_workspace_write: { network_access: false },
  features: {
    apps: false,
    plugins: false,
    image_generation: false,
    browser_use: false,
    computer_use: false,
  },
};

/** The sandbox of every turn: the workspace writable, no network. */
export const SANDBOX_POLICY: Readonly<Record<string, unknown>> = {
  type: 'workspaceWrite',
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};

/** Variables Codex reads beyond the supervisor's allow-list (its home, never a credential). */
export const CODEX_PASS_ENV: readonly string[] = ['CODEX_HOME'];

/**
 * The adapter's own dynamic tool on every thread (P11-04, ruling R6): Codex offers its
 * `request_user_input` only in plan mode, so a Steward asks the user through this one — a
 * `agent.needs_input(clarification)` that blocks until answered; the answer is the tool's result.
 */
export const ASK_USER_TOOL = 'ask_user';
export const ASK_USER_SPEC = {
  type: 'function',
  name: ASK_USER_TOOL,
  description:
    'Ask the user one question and wait for the answer (the answer text is the result). Use it ' +
    'whenever you need the user to decide or tell you something before you go on; offer `options` ' +
    'when the answer is one of a few choices.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, in plain words.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Choices, if any.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
} as const;

/** What the thread's developer instructions add about `ask_user` (after the Steward's prompt). */
export const ASK_USER_NOTE =
  'When you need the user to decide or tell you something, call the `ask_user` tool with your ' +
  'question (and `options` when there are a few choices) and wait for its answer. Do not end ' +
  'your turn with a question in your reply: nobody reads it as one.';

export interface CodexAdapterOptions {
  supervisor: ProcessSupervisor;
  /** The Codex CLI (default `codex`, found on the PATH). */
  command?: string;
  /** Arguments before the subcommand (tests: the fake CLI's script and options). */
  args?: string[];
  /** Extra environment for every Codex process. */
  env?: Record<string, string>;
  /** How long `stop()` waits for the turn to end after `turn/interrupt` (default 10 s). */
  graceMs?: number;
  /** How long `initialize` + `thread/start|resume` may take before the spawn fails (default 60 s). */
  startTimeoutMs?: number;
  /** Longest tool-result excerpt kept in the transcript. */
  maxToolResultChars?: number;
  onError?: (error: unknown, context: string) => void;
  /**
   * The Codex home Mission Control owns (ruling R7; production: `<data dir>/codex-home`): every
   * Codex process runs with `CODEX_HOME` set to it, a `config.toml` Mission Control writes and an
   * `auth.json` symlink to `authSource`. Absent: the user's own Codex home (tests of the fake CLI).
   */
  home?: string;
  /** The user's login file the managed home links to (default `defaultAuthSource()`). */
  authSource?: string;
}

const SYSTEM: Actor = { type: 'system' };
const ENDED_MEMORY = 256;
const SESSION_REF = /^codex:([\w.:-]{1,256})$/;
const ALLOW = /^(allow|yes|y|ok|approve|approved)$/i;

type QuestionBody = Extract<AgentEvent, { type: 'agent.needs_input' }>['question'];
type Decision = 'allow' | 'deny' | 'withdrawn';

interface PendingQuestion {
  id: Id;
  resolve: (answer: string | Dismissed | undefined) => void;
}

interface Failure {
  error: string;
  reason: 'runtime' | 'limit';
  resetsAt?: string;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

class Session {
  threadId: string | undefined;
  turnId: string | undefined;
  process: ManagedProcess | undefined;
  peer: RpcPeer | undefined;
  starting = true;
  turnOpen = false;
  interrupting = false;
  /** `interrupt()` came before `turn/start` answered with the turn's id. */
  interruptWanted = false;
  paused = false;
  stopping = false;
  /** A usage limit was reported: the turn's end is not an idle, the session is ending. */
  limit = false;
  terminal: 'finished' | 'failed' | 'stopped' | undefined;
  failure: Failure | undefined;
  readonly pending = new Map<Id, PendingQuestion>();
  /** Items as `item/started` reported them (a file change's paths are only there). */
  readonly items = new Map<string, unknown>();
  /** Tool uses reported as `agent.tool_call` (once each). */
  readonly reported = new Set<string>();
  /** The last rate-limit snapshot Codex pushed (`account/rateLimits/updated`). */
  lastRateLimits: unknown;
  lastText = '';
  lastResult: string | undefined;
  stopDone: Promise<void> | undefined;
  private turnWaiters: (() => void)[] = [];

  constructor(
    readonly sessionId: string,
    readonly agentId: Id,
    readonly gate: PermissionGate,
    readonly cwd: string,
    readonly model: string | undefined,
    readonly tools: ReadonlyMap<string, ToolDefinition>,
  ) {}

  settlePending(): void {
    for (const q of [...this.pending.values()]) q.resolve(undefined);
  }

  turnEnd(): Promise<void> {
    if (!this.turnOpen) return Promise.resolve();
    return new Promise((r) => this.turnWaiters.push(r));
  }

  closeTurn(): void {
    this.turnOpen = false;
    this.turnId = undefined;
    this.interruptWanted = false;
    this.items.clear();
    this.reported.clear();
    for (const w of this.turnWaiters.splice(0)) w();
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly runtime = 'codex' as const;
  readonly canPublish = true;
  readonly events = new EventQueue<AgentEvent>();
  private readonly sessions = new Map<string, Session>();
  private readonly byAgent = new Map<Id, Session>();
  private readonly byQuestion = new Map<Id, Session>();
  private readonly ended = new Map<string, NonNullable<Session['terminal']>>();
  private readonly onError: (error: unknown, context: string) => void;
  private readonly maxToolResultChars: number;
  private readonly command: string;
  private readonly args: string[];
  private disposed = false;

  constructor(private readonly opts: CodexAdapterOptions) {
    this.command = opts.command ?? 'codex';
    this.args = opts.args ?? [];
    this.onError = opts.onError ?? (() => {});
    this.maxToolResultChars = opts.maxToolResultChars ?? 2_000;
  }

  // --- provider ------------------------------------------------------------------

  async preflight(): Promise<RuntimePreflight> {
    let home: PreparedHome | undefined;
    try {
      home = this.prepareHome();
    } catch (error) {
      return {
        runtime: 'codex',
        provider: 'chatgpt',
        ok: false,
        installed: true,
        problems: [
          {
            code: 'check_failed',
            severity: 'error',
            message: `GalacticAgents could not prepare its Codex home: ${(error as Error).message}`,
            fix: `Check that ${this.opts.home} can be written`,
          },
        ],
      };
    }
    return codexPreflight({
      command: this.command,
      args: this.args,
      env: this.fullEnv(),
      ...(home && !home.authPresent ? { authMissing: true } : {}),
    });
  }

  /**
   * Creates or refreshes the managed Codex home (ruling R7) before any Codex process starts;
   * `undefined` without one. Throws when it cannot be written.
   */
  private prepareHome(): PreparedHome | undefined {
    if (!this.opts.home) return undefined;
    const prepared = prepareCodexHome(this.opts.home, this.opts.authSource ?? defaultAuthSource());
    if (prepared.replacedLink) {
      this.onError(
        new Error(
          'the managed Codex home held a regular auth.json (Codex refreshed the login): moved over your own auth.json, unread, and linked again',
        ),
        'codex home',
      );
    }
    return prepared;
  }

  /** `model/list`: the visible models, text only. Never throws (`[]`). */
  async models(): Promise<ModelInfo[]> {
    try {
      return await queryAppServer(this.queryOptions(), async (peer) => {
        const out: ModelInfo[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const result = await peer.request('model/list', cursor ? { cursor } : {});
          out.push(...modelInfos(result));
          const next = asRecord(result)['nextCursor'];
          if (typeof next !== 'string' || !next) break;
          cursor = next;
        }
        return out;
      });
    } catch (error) {
      this.onError(error, 'codex model/list');
      return [];
    }
  }

  /** `account/rateLimits/read` + `account/read`: the plan and its windows. Never throws. */
  async usage(): Promise<ProviderUsage | undefined> {
    try {
      return await queryAppServer(this.queryOptions(), async (peer) => {
        const [limits, account] = await Promise.all([
          peer.request('account/rateLimits/read'),
          peer.request('account/read', { refreshToken: false }),
        ]);
        return usageFrom(limits, account);
      });
    } catch (error) {
      this.onError(error, 'codex usage');
      return undefined;
    }
  }

  private queryOptions() {
    this.prepareHome();
    return {
      command: this.command,
      args: this.args,
      appServerArgs: [...APP_SERVER_ARGS],
      env: this.fullEnv(),
      version: SERVER_VERSION,
    };
  }

  /** The environment a Codex process gets on top of the supervisor's allow-list. */
  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const key of CODEX_PASS_ENV) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    if (this.opts.home) env['CODEX_HOME'] = this.opts.home;
    return { ...env, ...(this.opts.env ?? {}) };
  }

  /** The whole environment of a query or preflight process (no supervisor builds it). */
  private fullEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of INHERITED_ENV) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    for (const [k, v] of Object.entries(this.env())) if (v !== undefined) env[k] = v;
    return env;
  }

  // --- startup -------------------------------------------------------------------

  spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    return this.open(opts, undefined);
  }

  async resumeSession(sessionRef: string, opts: SpawnOptions): Promise<SpawnHandle> {
    const m = SESSION_REF.exec(sessionRef);
    if (!m) throw new Error(`not a codex session ref: ${sessionRef}`);
    return this.open(opts, m[1]!);
  }

  private async open(opts: SpawnOptions, resume: string | undefined): Promise<SpawnHandle> {
    if (this.disposed) throw new Error('adapter disposed');
    if (opts.bare) throw new Error('bare mode is a claude-sdk option; the codex runtime has none');
    if (opts.role !== 'steward') {
      throw new Error('the codex runtime runs Stewards only: brains run on claude-sdk');
    }
    if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
      throw new Error(`the working directory does not exist: ${opts.cwd}`);
    }
    const tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    const session = new Session(randomUUID(), opts.agentId, opts.gate, opts.cwd, opts.model, tools);
    this.sessions.set(session.sessionId, session);
    this.byAgent.set(opts.agentId, session);
    try {
      this.prepareHome();
      const peer = this.connect(session);
      await this.during(
        session,
        peer.request('initialize', initializeParams(SERVER_VERSION)),
        'initialize',
      );
      peer.notify('initialized');
      const settings = {
        cwd: opts.cwd,
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        config: SAFE_THREAD_CONFIG,
        ...(opts.model ? { model: opts.model } : {}),
      };
      if (resume !== undefined) {
        const resumed = await this.during(
          session,
          peer.request('thread/resume', { threadId: resume, ...settings }),
          'thread/resume',
        );
        session.threadId = threadIdOf(resumed) ?? resume;
      } else {
        const started = await this.during(
          session,
          peer.request('thread/start', {
            ...settings,
            developerInstructions: [opts.systemPrompt, ASK_USER_NOTE].filter(Boolean).join('\n\n'),
            // Kept with the thread: `thread/resume` has no `dynamicTools` (it ignores the field)
            // and a resumed thread still calls them (checked against Codex 0.166, P11-04).
            dynamicTools: [
              ...[...tools.values()].map((t) => ({
                type: 'function',
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
              ...(tools.has(ASK_USER_TOOL) ? [] : [ASK_USER_SPEC]),
            ],
          }),
          'thread/start',
        );
        const id = threadIdOf(started);
        if (!id) throw new Error('thread/start answered without a thread id');
        session.threadId = id;
      }
    } catch (error) {
      await this.abandon(session);
      throw error;
    }
    session.starting = false;
    this.startTurn(session, opts.prompt);
    return { sessionId: session.sessionId, sessionRef: `codex:${session.threadId}` };
  }

  private connect(session: Session): RpcPeer {
    const peer = new RpcPeer({
      write: (line) => session.process?.write(line),
      onRequest: (method, params) => this.serverRequest(session, method, params),
      onNotification: (method, params) => this.onNotification(session, method, params),
      onError: (error) => this.onError(error, `codex rpc ${session.agentId}`),
    });
    session.peer = peer;
    session.process = this.opts.supervisor.adopt({
      agentId: session.agentId,
      command: this.command,
      args: [...this.args, 'app-server', ...APP_SERVER_ARGS],
      cwd: session.cwd,
      env: this.env(),
      meta: { runtime: 'codex', command: this.command },
      onStdout: (chunk) => peer.receive(chunk),
      onStderr: (chunk) => {
        const line = chunk.trim();
        if (line) this.onError(new Error(line.slice(0, 500)), `codex stderr ${session.agentId}`);
      },
      interrupt: (proc) => this.stopHook(session, proc),
      onOutcome: (outcome) => this.onOutcome(session, outcome),
    });
    return peer;
  }

  /** A startup request raced with the process ending and the start timeout. */
  private async during<T>(session: Session, request: Promise<T>, what: string): Promise<T> {
    const proc = session.process!;
    let timer: NodeJS.Timeout | undefined;
    const exited = proc.exited.then((exit) => {
      throw new Error(
        `codex app-server (${this.command}) exited during ${what} (${exit.signal ?? `code ${exit.code}`})`,
      );
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`codex app-server did not answer ${what} in time`)),
        this.opts.startTimeoutMs ?? 60_000,
      );
    });
    try {
      return await Promise.race([request, exited, timeout]);
    } catch (error) {
      if (error instanceof RpcError) throw new Error(error.message, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A start that failed: no event (the runtime reports the failed spawn), no process left. */
  private async abandon(session: Session): Promise<void> {
    session.terminal = 'failed';
    session.settlePending();
    session.peer?.close();
    this.forget(session);
    if (session.process && session.process.state !== 'exited') {
      await this.opts.supervisor.kill(session.agentId).catch(() => {});
    }
  }

  // --- process -------------------------------------------------------------------

  /** The supervisor's graceful stop, step 1: thaw, interrupt the turn, wait for it, close stdin. */
  private async stopHook(session: Session, proc: ManagedProcess): Promise<void> {
    if (session.paused) {
      proc.signal('SIGCONT');
      session.paused = false;
    }
    if (session.turnOpen && !session.starting) {
      session.interrupting = true;
      session.settlePending();
      this.sendInterrupt(session);
      await session.turnEnd();
    }
    proc.expectExit();
    proc.child.stdin?.end();
    proc.turnEnded();
  }

  private onOutcome(session: Session, outcome: ProcessOutcome): void {
    if (outcome.kind !== 'restarting') session.peer?.close();
    if (session.starting) return; // `spawn()` throws; the runtime reports it
    switch (outcome.kind) {
      case 'start_failed':
        this.terminal(session, {
          type: 'agent.failed',
          agentId: session.agentId,
          error: outcome.error,
          reason: 'runtime',
        });
        return;
      case 'crashed':
        if (session.limit) {
          // The process went away while the limit's reset was being read: still the limit.
          this.limitEnded(session);
          return;
        }
        this.terminal(session, {
          type: 'agent.failed',
          agentId: session.agentId,
          error: `codex app-server exited unexpectedly (${outcome.exit.signal ?? `code ${outcome.exit.code}`})`,
          reason: 'crash',
        });
        return;
      case 'stopped':
        this.terminal(session, this.stoppedEvent(session, outcome.by ?? SYSTEM));
        return;
      case 'exited':
        if (session.limit && !session.failure) {
          this.limitEnded(session);
        } else if (session.stopping || session.failure) {
          this.terminal(session, this.stoppedEvent(session, SYSTEM));
        } else {
          this.terminal(session, {
            type: 'agent.finished',
            agentId: session.agentId,
            ...(session.lastResult !== undefined ? { result: session.lastResult } : {}),
          });
        }
        return;
      case 'restarting':
        return; // adopt() has no restart policy
    }
  }

  // --- turns ---------------------------------------------------------------------

  private startTurn(session: Session, text: string): void {
    session.turnOpen = true;
    session.lastText = '';
    session
      .peer!.request('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        approvalPolicy: 'untrusted',
        sandboxPolicy: SANDBOX_POLICY,
        ...(session.model ? { model: session.model } : {}),
      })
      .then(
        (result) => {
          const id = asRecord(asRecord(result)['turn'])['id'];
          if (typeof id === 'string' && session.turnOpen && session.turnId === undefined) {
            session.turnId = id;
          }
          if (session.interruptWanted) this.sendInterrupt(session);
        },
        (error: unknown) => {
          if (session.terminal || error instanceof RpcClosed) return;
          // The turn never started: say why and go idle.
          if (!session.interrupting && !session.stopping) {
            this.output(session, 'text', `turn ended with an error: ${(error as Error).message}`);
          }
          this.endTurn(session);
        },
      );
  }

  private sendInterrupt(session: Session): void {
    if (!session.turnId) {
      session.interruptWanted = true;
      return;
    }
    session.interruptWanted = false;
    session.peer
      ?.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId })
      .catch((error: unknown) => {
        if (!(error instanceof RpcClosed)) this.onError(error, `turn/interrupt ${session.agentId}`);
      });
  }

  private turnCompleted(session: Session, params: Record<string, unknown>): void {
    if (!session.turnOpen) return;
    const turn = asRecord(params['turn']);
    if (session.turnId !== undefined && turn['id'] !== session.turnId) return;
    if (
      turn['status'] === 'failed' &&
      !session.limit &&
      !session.interrupting &&
      !session.stopping
    ) {
      const message = asRecord(turn['error'])['message'];
      this.output(
        session,
        'text',
        `turn failed${typeof message === 'string' && message ? `: ${message}` : ''}`,
      );
    }
    if (session.lastText) session.lastResult = session.lastText;
    this.endTurn(session);
  }

  private endTurn(session: Session): void {
    session.interrupting = false;
    session.settlePending();
    session.closeTurn();
    session.process?.turnEnded();
    if (!session.stopping && !session.terminal && !session.limit && !session.failure) {
      this.emit(session, { type: 'agent.idle', agentId: session.agentId });
    }
  }

  // --- notifications -------------------------------------------------------------

  private onNotification(session: Session, method: string, raw: unknown): void {
    if (session.terminal) return;
    const params = asRecord(raw);
    const thread = params['threadId'];
    // A subagent's thread: its approvals still reach us (as requests), its traffic is not ours.
    if (
      typeof thread === 'string' &&
      session.threadId !== undefined &&
      thread !== session.threadId
    ) {
      return;
    }
    switch (method) {
      case 'turn/started': {
        const id = asRecord(params['turn'])['id'];
        if (session.turnOpen && session.turnId === undefined && typeof id === 'string') {
          session.turnId = id;
          if (session.interruptWanted) this.sendInterrupt(session);
        }
        return;
      }
      case 'turn/completed':
        this.turnCompleted(session, params);
        return;
      case 'item/started': {
        const item = asRecord(params['item']);
        if (typeof item['id'] === 'string') session.items.set(item['id'], item);
        if (item['type'] === 'mcpToolCall') this.unaskedMcpCall(session, item);
        return;
      }
      case 'item/completed': {
        const item = params['item'];
        for (const line of itemOutput(item, this.maxToolResultChars)) {
          if (line.kind === 'text') session.lastText = line.text;
          this.output(session, line.kind, line.text);
        }
        return;
      }
      case 'turn/plan/updated': {
        if (!session.turnOpen) return;
        const { summary, progress } = planProgress(params);
        this.emit(session, { type: 'agent.progress', agentId: session.agentId, summary, progress });
        return;
      }
      case 'account/rateLimits/updated':
        session.lastRateLimits = params;
        return;
      case 'error':
        this.onErrorNotification(session, params);
        return;
      default:
        // deltas, token usage, status changes, MCP startup, diffs: not transcript.
        return;
    }
  }

  private onErrorNotification(session: Session, params: Record<string, unknown>): void {
    if (isUsageLimit(params)) {
      void this.limitReached(session);
      return;
    }
    const message = asRecord(params['error'])['message'];
    if (typeof message !== 'string' || !message) return;
    this.output(
      session,
      'text',
      params['willRetry'] === true ? `Codex: ${message} (retrying)` : `error: ${message}`,
    );
  }

  /**
   * The subscription's usage limit: the reset time is read from `account/rateLimits/read` (the
   * error does not carry it; Codex's last pushed snapshot is the fallback), then the session ends
   * with `agent.failed{reason: 'limit'}` — the one terminal event.
   */
  private async limitReached(session: Session): Promise<void> {
    if (session.limit || session.terminal) return;
    session.limit = true;
    let resetsAt: string | undefined;
    try {
      const fresh = await Promise.race([
        session.peer!.request('account/rateLimits/read'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('account/rateLimits/read timed out')), 5_000),
        ),
      ]);
      resetsAt = limitResetsAt(fresh);
    } catch (error) {
      this.onError(error, `codex rate limits ${session.agentId}`);
    }
    resetsAt ??= limitResetsAt(session.lastRateLimits);
    this.fail(session, { error: LIMIT_ERROR, reason: 'limit', ...(resetsAt ? { resetsAt } : {}) });
  }

  /** The session ends on its usage limit without a fresh reset time (the process is gone). */
  private limitEnded(session: Session): void {
    if (!session.failure) {
      const resetsAt = limitResetsAt(session.lastRateLimits);
      session.failure = { error: LIMIT_ERROR, reason: 'limit', ...(resetsAt ? { resetsAt } : {}) };
      this.output(session, 'text', LIMIT_ERROR);
    }
    this.terminal(session, this.stoppedEvent(session, SYSTEM));
  }

  /**
   * An MCP tool call Codex ran without asking (the `node_repl` server's `js`, Ruling R5): reported
   * for the log and the tool-call cap, never as something the gate or the user approved.
   */
  private unaskedMcpCall(session: Session, item: Record<string, unknown>): void {
    const id = typeof item['id'] === 'string' ? item['id'] : randomUUID();
    if (session.reported.has(id)) return;
    session.reported.add(id);
    const server = typeof item['server'] === 'string' ? item['server'] : 'mcp';
    const tool = typeof item['tool'] === 'string' ? item['tool'] : 'tool';
    this.emit(session, {
      type: 'agent.tool_call',
      agentId: session.agentId,
      toolName: `mcp__${server}__${tool}`,
      toolUseId: id,
      input: item['arguments'] ?? {},
    });
  }

  // --- server requests -----------------------------------------------------------

  private async serverRequest(
    session: Session,
    method: string,
    raw: unknown,
  ): Promise<ServerRequestReply> {
    const params = asRecord(raw);
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const call = commandCall(params, session.cwd);
        const d = await this.decide(session, call, itemIdOf(params));
        return { result: { decision: codexDecision(d) } };
      }
      case 'item/fileChange/requestApproval':
        return {
          result: { decision: codexDecision(await this.decideFileChange(session, params)) },
        };
      case 'item/permissions/requestApproval': {
        const d = await this.decide(session, permissionsCall(params), itemIdOf(params));
        return {
          result: {
            permissions: d === 'allow' ? grantedPermissions(params['permissions']) : {},
            scope: 'turn',
          },
        };
      }
      case 'mcpServer/elicitation/request':
        this.output(
          session,
          'text',
          `declined a question from the MCP server "${String(params['serverName'] ?? '?')}" (MCP servers are off)`,
        );
        return { result: { action: 'decline', content: null, _meta: null } };
      case 'item/tool/call':
        return { result: await this.serveTool(session, params) };
      case 'item/tool/requestUserInput':
        return { result: { answers: await this.askUser(session, userQuestions(params)) } };
      case 'currentTime/read':
        return { result: { currentTimeAt: Math.floor(Date.now() / 1000) } };
      case 'execCommandApproval':
      case 'applyPatchApproval':
        // The v1 approval API: never used by a v2 thread; refused, never approved.
        return {
          result: { decision: { denied: { rejection: 'not supported by GalacticAgents' } } },
        };
      default:
        return { error: { code: METHOD_NOT_FOUND, message: `${method} is not supported` } };
    }
  }

  /** The gate's verdict; a check that throws is a `deny` (fail closed). */
  private check(session: Session, call: ToolCall, reserve: boolean): GateVerdict {
    try {
      return session.gate.check(call, reserve ? undefined : { reserve: false });
    } catch (error) {
      this.onError(error, `gate ${session.agentId}`);
      return { decision: 'deny', reason: `permission check failed: ${(error as Error).message}` };
    }
  }

  /**
   * One call through the gate: `allow` reports it and lets it run, `deny` refuses it with a line,
   * `ask` waits for the answer (no timeout). `withdrawn`: the turn or the session is ending.
   */
  private async decide(
    session: Session,
    call: ToolCall,
    toolUseId: string | undefined,
    verdict: GateVerdict = this.check(session, call, true),
  ): Promise<Decision> {
    if (session.terminal || session.stopping || session.interrupting || session.limit) {
      return 'withdrawn';
    }
    const what = describeCall(call);
    if (verdict.decision === 'allow') {
      this.toolCall(session, call, toolUseId);
      return 'allow';
    }
    if (verdict.decision === 'deny') {
      this.output(session, 'text', `permission denied for ${what}: ${verdict.reason}`);
      return 'deny';
    }
    const why = verdict.reasons.join('; ');
    const answer = await this.ask(session, 'permission', {
      text: `May the agent run ${what}?${why ? ` (${why})` : ''}`,
      toolCall: call,
      ...(verdict.action ? { permissionAction: verdict.action } : {}),
    });
    if (answer === undefined) return 'withdrawn';
    if (isDismissed(answer)) {
      this.output(session, 'text', `permission denied for ${what}: ${answer.dismissed}`);
      return 'deny';
    }
    if (ALLOW.test(answer.trim())) {
      this.toolCall(session, call, toolUseId);
      return 'allow';
    }
    this.output(session, 'text', `permission denied for ${what}: ${answer}`);
    return 'deny';
  }

  /**
   * A file change: every path judged (the first check reserves the call against the cap, the
   * others do not — it is one tool use). Any `deny` declines it; all `allow` accept it; otherwise
   * one question about the whole change.
   */
  private async decideFileChange(
    session: Session,
    params: Record<string, unknown>,
  ): Promise<Decision> {
    const itemId = itemIdOf(params);
    const changes = fileChanges(itemId !== undefined ? session.items.get(itemId) : undefined);
    if (changes.length === 0) {
      // The paths are unknown: a call the table cannot place, so its `unclassified` entry decides.
      return this.decide(
        session,
        {
          toolName: 'codex:fileChange',
          input: { reason: params['reason'] ?? null, grantRoot: params['grantRoot'] ?? null },
        },
        itemId,
      );
    }
    const whole = fileChangesCall(changes);
    let ask: Extract<GateVerdict, { decision: 'ask' }> | undefined;
    for (const [i, change] of changes.entries()) {
      const verdict = this.check(session, fileChangeCall(change), i === 0);
      if (verdict.decision === 'deny') return this.decide(session, whole, itemId, verdict);
      if (verdict.decision === 'ask') {
        ask = ask
          ? { ...ask, reasons: [...new Set([...ask.reasons, ...verdict.reasons])] }
          : verdict;
      }
    }
    return this.decide(session, whole, itemId, ask ?? { decision: 'allow' });
  }

  private toolCall(session: Session, call: ToolCall, toolUseId: string | undefined): void {
    if (toolUseId !== undefined) {
      if (session.reported.has(toolUseId)) return;
      session.reported.add(toolUseId);
    }
    this.emit(session, {
      type: 'agent.tool_call',
      agentId: session.agentId,
      toolName: call.toolName,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      input: call.input,
    });
  }

  /** A dynamic tool call: one of the server's tools, gated under its bare name, then run. */
  private async serveTool(
    session: Session,
    params: Record<string, unknown>,
  ): Promise<{ contentItems: { type: 'inputText'; text: string }[]; success: boolean }> {
    const reply = (text: string, success: boolean) => ({
      contentItems: [{ type: 'inputText' as const, text }],
      success,
    });
    const name = typeof params['tool'] === 'string' ? params['tool'] : '';
    const noNamespace = params['namespace'] === null || params['namespace'] === undefined;
    if (name === ASK_USER_TOOL && noNamespace && !session.tools.has(name)) {
      return this.askUserTool(session, params['arguments']);
    }
    const tool = session.tools.get(name);
    if (!tool || (params['namespace'] !== null && params['namespace'] !== undefined)) {
      return reply(`unknown tool: ${name}`, false);
    }
    const input = params['arguments'] ?? {};
    const callId = typeof params['callId'] === 'string' ? params['callId'] : undefined;
    const d = await this.decide(session, { toolName: name, input }, callId);
    if (d !== 'allow') return reply(`the call to ${name} was refused`, false);
    try {
      const result = await tool.handler(input);
      return reply(typeof result === 'string' ? result : JSON.stringify(result ?? null), true);
    } catch (error) {
      return reply((error as Error).message || String(error), false);
    }
  }

  /**
   * The adapter's `ask_user` tool (ruling R6): a clarification question, not an action — no gate,
   * no `agent.tool_call`. The answer (or what a dismissal tells the agent) is the result.
   */
  private async askUserTool(
    session: Session,
    raw: unknown,
  ): Promise<{ contentItems: { type: 'inputText'; text: string }[]; success: boolean }> {
    const reply = (text: string, success: boolean) => ({
      contentItems: [{ type: 'inputText' as const, text }],
      success,
    });
    const args = asRecord(raw);
    const text = typeof args['question'] === 'string' ? args['question'].trim() : '';
    if (!text) return reply('ask_user needs a question', false);
    const options = (Array.isArray(args['options']) ? args['options'] : [])
      .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      .slice(0, 8);
    const answer = await this.ask(session, 'clarification', {
      text,
      ...(options.length > 0 ? { options } : {}),
    });
    if (answer === undefined) return reply('The question was withdrawn: no answer.', false);
    if (isDismissed(answer)) return reply(dismissedClarification(answer.dismissed), true);
    return reply(answer, true);
  }

  /**
   * `request_user_input`: one clarification per question, several at once as a question set;
   * the answers go back by question id. A withdrawn question answers nothing.
   */
  private async askUser(
    session: Session,
    questions: UserQuestion[],
  ): Promise<Record<string, { answers: string[] }>> {
    const answers: Record<string, { answers: string[] }> = {};
    const put = (q: UserQuestion, answer: string | Dismissed | undefined) => {
      if (answer === undefined) return;
      const text = isDismissed(answer) ? dismissedClarification(answer.dismissed) : answer.trim();
      if (text === SKIPPED_ANSWER) return;
      answers[q.id] = { answers: [text] };
    };
    if (questions.length > 1 && fitsQuestionSet(questions.map((q) => q.options?.length ?? 0))) {
      const id = `qs-${randomUUID()}`;
      const title = setTitle(undefined);
      const replies = await Promise.all(
        questions.map((q, index) =>
          this.ask(session, 'clarification', {
            text: q.text,
            ...(q.options ? { options: q.options } : {}),
            set: { id, index, total: questions.length, title },
          }),
        ),
      );
      questions.forEach((q, i) => put(q, replies[i]));
      return answers;
    }
    for (const q of questions) {
      const answer = await this.ask(session, 'clarification', {
        text: q.text,
        ...(q.options ? { options: q.options } : {}),
      });
      if (answer === undefined) break;
      put(q, answer);
    }
    return answers;
  }

  private ask(
    session: Session,
    kind: 'clarification' | 'permission',
    question: QuestionBody,
  ): Promise<string | Dismissed | undefined> {
    if (session.terminal || session.stopping || session.interrupting) {
      return Promise.resolve(undefined);
    }
    const id = `q-${randomUUID()}`;
    return new Promise((resolve) => {
      const done = (answer: string | Dismissed | undefined) => {
        session.pending.delete(id);
        this.byQuestion.delete(id);
        resolve(answer);
      };
      session.pending.set(id, { id, resolve: done });
      this.byQuestion.set(id, session);
      this.emit(session, {
        type: 'agent.needs_input',
        agentId: session.agentId,
        questionId: id,
        kind,
        question,
      });
    });
  }

  // --- control -------------------------------------------------------------------

  async send(sessionId: string, message: string, opts: SendOptions = {}): Promise<void> {
    const session = this.session(sessionId);
    if (session.terminal) throw new Error(`session ${sessionId} has ${session.terminal}`);
    if (session.stopping) throw new Error(`session ${sessionId} is stopping`);
    if (session.turnOpen) {
      if (!opts.interrupt) {
        throw new Error(
          `session ${sessionId} is mid-turn: the runtime delivers messages only when idle`,
        );
      }
      await this.interrupt(sessionId);
      await session.turnEnd();
    }
    if (session.terminal) throw new Error(`session ${sessionId} has ${session.terminal}`);
    this.startTurn(session, message);
  }

  async answer(questionId: Id, answer: string): Promise<void> {
    const pending = this.byQuestion.get(questionId)?.pending.get(questionId);
    if (!pending) throw new Error(`no pending question ${questionId}`);
    pending.resolve(answer);
  }

  /** The user dismissed the question (P9-14): a permission is declined, a question told so. */
  async dismiss(questionId: Id, reason: string): Promise<void> {
    const pending = this.byQuestion.get(questionId)?.pending.get(questionId);
    if (!pending) throw new Error(`no pending question ${questionId}`);
    pending.resolve({ dismissed: reason });
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || !session.turnOpen) return;
    if (session.paused) this.thaw(session); // a frozen process cannot end its turn
    session.interrupting = true;
    session.settlePending();
    this.sendInterrupt(session);
  }

  async pause(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || session.paused) return;
    if (!session.process || session.process.state === 'exited') {
      throw new Error(`cannot pause session ${sessionId}: no codex process to freeze`);
    }
    session.paused = true;
    session.process.signal('SIGSTOP');
    this.emit(session, { type: 'agent.paused', agentId: session.agentId, by: SYSTEM });
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || !session.paused) return;
    this.thaw(session);
  }

  private thaw(session: Session): void {
    session.paused = false;
    session.process?.signal('SIGCONT');
    this.emit(session, { type: 'agent.resumed', agentId: session.agentId, by: SYSTEM });
  }

  async stop(sessionId: string, opts: StopOptions = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.terminal) return;
    if (session.stopDone) return session.stopDone;
    session.stopping = true;
    session.stopDone = (async () => {
      session.settlePending();
      if (session.process && session.process.state !== 'exited') {
        await this.opts.supervisor.stop(session.agentId, {
          graceMs: opts.graceMs ?? this.opts.graceMs ?? 10_000,
          by: SYSTEM,
        });
      }
      if (!session.terminal) this.terminal(session, this.stoppedEvent(session, SYSTEM));
    })();
    return session.stopDone;
  }

  /** A stopped session's terminal event: `agent.stopped`, or the failure the adapter ended it for. */
  private stoppedEvent(
    session: Session,
    by: Actor,
  ): Extract<AgentEvent, { type: 'agent.stopped' | 'agent.failed' }> {
    const f = session.failure;
    if (!f) return { type: 'agent.stopped', agentId: session.agentId, by };
    return {
      type: 'agent.failed',
      agentId: session.agentId,
      error: f.error,
      reason: f.reason,
      ...(f.resetsAt ? { resetsAt: f.resetsAt } : {}),
    };
  }

  /** Ends the session on the adapter's own account (a usage limit): said, then stopped. */
  private fail(session: Session, failure: Failure): void {
    if (session.terminal || session.failure) return;
    session.failure = failure;
    this.output(session, 'text', failure.error);
    this.stop(session.sessionId).catch((error: unknown) =>
      this.onError(error, `stop ${session.agentId}`),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
    this.events.close();
  }

  // --- helpers -------------------------------------------------------------------

  private session(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (s) return s;
    const ended = this.ended.get(sessionId);
    if (ended) throw new Error(`session ${sessionId} has ${ended}`);
    throw new Error(`unknown codex session ${sessionId}`);
  }

  private live(sessionId: string): Session | undefined {
    if (!this.sessions.has(sessionId) && this.ended.has(sessionId)) return undefined;
    return this.session(sessionId);
  }

  private current(session: Session): boolean {
    return this.byAgent.get(session.agentId) === session;
  }

  private output(session: Session, kind: 'text' | 'thinking' | 'tool', text: string): void {
    this.emit(session, { type: 'agent.output', agentId: session.agentId, kind, text });
  }

  private emit(session: Session, event: AgentEvent): void {
    if (session.terminal || session.starting || !this.current(session)) return;
    this.events.push(event);
  }

  private terminal(
    session: Session,
    event: Extract<AgentEvent, { type: 'agent.finished' | 'agent.failed' | 'agent.stopped' }>,
  ): void {
    if (session.terminal) return;
    if (this.current(session) && !session.starting) this.events.push(event);
    session.terminal =
      event.type === 'agent.finished'
        ? 'finished'
        : event.type === 'agent.failed'
          ? 'failed'
          : 'stopped';
    session.settlePending();
    session.closeTurn();
    session.peer?.close();
    this.forget(session);
  }

  private forget(session: Session): void {
    this.byQuestion.forEach((s, id) => {
      if (s === session) this.byQuestion.delete(id);
    });
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    if (this.current(session)) this.byAgent.delete(session.agentId);
    if (session.terminal) {
      this.ended.set(session.sessionId, session.terminal);
      if (this.ended.size > ENDED_MEMORY) this.ended.delete(this.ended.keys().next().value!);
    }
  }

  /** Live session count (tests: ended sessions are freed). */
  get sessionCount(): number {
    return this.sessions.size;
  }
}

/** The gate's decision in Codex's words: never `acceptForSession`, never an amendment. */
function codexDecision(d: Decision): 'accept' | 'decline' | 'cancel' {
  return d === 'allow' ? 'accept' : d === 'deny' ? 'decline' : 'cancel';
}

const itemIdOf = (params: Record<string, unknown>): string | undefined =>
  typeof params['itemId'] === 'string' ? params['itemId'] : undefined;

const threadIdOf = (result: unknown): string | undefined => {
  const id = asRecord(asRecord(result)['thread'])['id'];
  return typeof id === 'string' && id ? id : undefined;
};

/** What a granted permissions request gets: exactly what was asked, for this turn. */
function grantedPermissions(requested: unknown): Record<string, unknown> {
  const r = asRecord(requested);
  return {
    ...(r['network'] ? { network: r['network'] } : {}),
    ...(r['fileSystem'] ? { fileSystem: r['fileSystem'] } : {}),
  };
}
