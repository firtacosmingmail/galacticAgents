import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { EventQueue } from '../../lib/event-queue.js';
import {
  INHERITED_ENV,
  type ManagedProcess,
  type ProcessOutcome,
  type ProcessSupervisor,
} from '../../runtime/supervisor.js';
import { dismissedClarification, isDismissed, type Dismissed } from '../dismissal.js';
import {
  globalEntriesProblem,
  installGlobalEntries,
  removeGlobalEntries,
} from './global-entries.js';
import {
  HOOK_TIMEOUT_S,
  mcpText,
  SECRET_ENV,
  URL_ENV,
  type HookBridge,
  type HookDecision,
  type McpCallResult,
} from './hook-bridge.js';
import { brainDir, copyNewImages, IMAGE_FOLDER, snapshotImages } from './images.js';
import { isQuotaError, isQuotaResult, LIMIT_ERROR, limitResetsAt, usageFrom } from './limits.js';
import { describeAgyCall, mapAgyCall } from './mapping.js';
import { agyPreflight, execAgy, parseModels, USAGE_ARGS } from './preflight.js';
import { ASK_USER_NOTE, ASK_USER_TOOL, createToolServer } from './tool-server.js';

/**
 * The `agy` adapter (P11-05; TECHNOLOGY §3.7): Stewards on Google's Antigravity CLI with a Google
 * subscription, driven headless (`agy -p <prompt> --output-format stream-json`), never with
 * `--dangerously-skip-permissions`. Shapes are the P11-01 spike's
 * (`docs/tasks/notes/P11-01-provider-spikes.md`, agy 1–8; its Ruling: full-tool mode).
 *
 * **One process per turn.** agy has no in-band control channel (a control message ends a stream
 * session), so every turn is its own `agy -p` run through the process supervisor (`adopt()`: own
 * process group, PID table, graceful stop); the first prints `init` with the conversation id, the
 * later ones continue it with `--conversation <id>`. A turn ends when its process exits (then
 * `agent.idle`). `interrupt()` is SIGINT to the turn's group (SIGKILL after the grace), `pause()`
 * SIGSTOP/SIGCONT, `stop()` the supervisor's graceful stop; an idle session has no process. The
 * session ref is `agy:<conversationId>`.
 *
 * **Every tool call is gated** by Mission Control's PreToolUse hook (`galactic-agy-hook.mjs`),
 * which agy runs from the managed entry in `~/.gemini/config/hooks.json` (`global-entries.ts`;
 * `--settings` cannot carry hooks) and which reaches this adapter through the hook bridge
 * (`hook-bridge.ts`, `POST /api/agy-hook`) with the session's secret from its environment. The
 * call is translated (`mapping.ts`) and judged once by the permission gate: `allow` → the hook
 * answers `auto_approve` + `agent.tool_call`; `deny` → `deny` with the reason (and a transcript
 * line); `ask` → `agent.needs_input(permission)`, the hook waiting (up to its 24 h timeout) until
 * `answer()`. agy fails closed on every hook failure (P11-01, agy 3), so a hook that cannot reach
 * Mission Control denies. Browser tools, agy's question tools, unknown tools, other MCP servers
 * and writes to `.agents/`/`.gemini/` are denied without asking; a workspace that ships its own
 * `.agents/hooks.json` or `mcp_config.json` is refused at spawn.
 *
 * **The server's tools** (`SpawnOptions.tools`) and the adapter's `ask_user` are served by
 * Mission Control's tool server (`tool-server.ts`, the managed `galactic` MCP entry): a call is
 * gated at the hook (`call_mcp_tool`) under the tool's bare name and then runs its handler.
 * `ask_user` becomes `agent.needs_input(clarification)`; the Steward is told about it in its
 * first prompt (agy has no system-prompt flag: `systemPrompt` leads the first prompt).
 *
 * **Images** the agent generates land in `~/.gemini/antigravity-cli/brain/<conversationId>/`;
 * the new ones are copied into `<cwd>/generated-images/` before the turn's end is reported.
 *
 * **Limits**: an exit 3 whose `AGY_ERROR` reports the quota reads `/usage` and ends the session
 * with `agent.failed{reason: 'limit', resetsAt}`. A Google subscription reports no dollars: no
 * `cost`. Brains do not run on agy (only Stewards, Global Constraints) and `bare` is refused. agy
 * is never given a publishing step in this phase (`canPublish: false`).
 */

/** Variables agy reads beyond the supervisor's allow-list. */
export const AGY_PASS_ENV: readonly string[] = [];

/** The flags of every turn (after `-p <prompt>`). */
export const TURN_FLAGS: readonly string[] = [
  '--output-format',
  'stream-json',
  // A prompt that starts with "/" is text, not one of agy's slash commands.
  '--disable-slash-commands',
  // Wait for the turn however long the user takes to answer a question.
  '--print-timeout',
  '0s',
];

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOOK_SCRIPT = 'galactic-agy-hook.mjs';
export const TOOLS_SCRIPT = 'galactic-agy-tools.mjs';

export interface AgyAdapterOptions {
  supervisor: ProcessSupervisor;
  /** The Antigravity CLI (default `agy`, found on the PATH). */
  command?: string;
  /** Arguments before agy's own (tests: the fake CLI's script). */
  args?: string[];
  /** The hook bridge's URL (`http://127.0.0.1:<port>/api/agy-hook`), read at each turn. */
  hookUrl: () => string;
  bridge: HookBridge;
  /** The user's home, where agy keeps its configuration (default `os.homedir()`). */
  home?: string;
  /**
   * Mission Control's own folder for agy (production: `<data dir>/agy`): the hook and tool-server
   * scripts are copied there (the global entries point at them) and the original bytes of the
   * global files are kept there. Default: a folder under the temp directory.
   */
  stateDir?: string;
  /** Extra environment for every agy process. */
  env?: Record<string, string>;
  /** How long an interrupt or a stop waits for the turn's process before killing it (10 s). */
  graceMs?: number;
  /** How long a spawn waits for agy's `init` (default 60 s). */
  startTimeoutMs?: number;
  /**
   * How long an `ask_user` MCP call waits for the answer before returning and letting the
   * question outlive the agy run (default 150 s: agy cuts an MCP call off after 3 minutes).
   */
  askHoldMs?: number;
  /** Longest tool-output excerpt kept in the transcript. */
  maxToolResultChars?: number;
  onError?: (error: unknown, context: string) => void;
}

const SYSTEM: Actor = { type: 'system' };
/** agy's MCP `tools/call` deadline is 3 minutes (P11-05 probe): `ask_user` holds less. */
export const ASK_HOLD_MS = 150_000;
const DEFERRED = Symbol('deferred');
/** What `ask_user` returns when the user has not answered within the hold. */
export const DEFERRED_NOTE =
  'The user has not answered yet. Their answer will reach you as your next message: end your ' +
  'turn now, without guessing the answer or asking again.';
/** What a second `ask_user` gets while one question waits (it never replaces the first). */
export const ASK_WAITING_NOTE =
  'A question is already waiting for the user: do not ask another. Its answer will reach you as ' +
  'your next message: end your turn now.';
const ENDED_MEMORY = 256;
const SESSION_REF = /^agy:([\w-]{1,128})$/;
const ALLOW = /^(allow|yes|y|ok|approve|approved)$/i;

type QuestionBody = Extract<AgentEvent, { type: 'agent.needs_input' }>['question'];
/** A gate decision; a denial carries the reason the agent reads. */
type Decision = 'allow' | 'withdrawn' | { deny: string };

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
  conversationId: string | undefined;
  readonly secret = randomBytes(32).toString('hex');
  process: ManagedProcess | undefined;
  /** Until the first `init`: events are not reported, a failure rejects the spawn. */
  starting = true;
  turnOpen = false;
  interrupting = false;
  paused = false;
  stopping = false;
  limit = false;
  /** The turn's `result` reported the quota (whatever the exit status). */
  quota = false;
  terminal: 'finished' | 'failed' | 'stopped' | undefined;
  failure: Failure | undefined;
  readonly pending = new Map<Id, PendingQuestion>();
  /** Calls of Mission Control's tools the hook let through, not yet run (per tool name). */
  readonly passes = new Map<string, number>();
  /** Agent text per step, until the step is done. */
  readonly steps = new Map<number, string>();
  /** The brain directory's images when the turn started. */
  images: Map<string, number> | undefined;
  /** Waits for the current turn's `init` (the spawn, and hook calls racing it). */
  initWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  lineBuffer = '';
  stderr = '';
  lastText = '';
  lastResult: string | undefined;
  killTimer: NodeJS.Timeout | undefined;
  stopDone: Promise<void> | undefined;
  /**
   * An `ask_user` question still unanswered when its MCP call had to return (agy cuts a tool call
   * off after 3 minutes): it stays open past the agy process, and its answer starts the next run.
   */
  deferred:
    { id: Id; question: string; answer: Promise<string | Dismissed | undefined> } | undefined;
  /**
   * A deferred answer that arrived while the session was paused with no process (P11-14): the
   * turn is closed (no idle: the Steward is not done), and this is its next run's prompt, started
   * on resume. An interrupt has nothing to cut; a message sent meanwhile joins it.
   */
  queued: string | undefined;
  /**
   * The prompt of a run started from `queued`, until that run's `init` (review I1): the runtime
   * resumes a paused agent before interrupting it, so the resume starts the answer's run and the
   * interrupt lands on it at once. An interrupt before `init` puts the prompt back in `queued`,
   * and the next message carries it first.
   */
  queuedRun: string | undefined;
  /** An `ask_user` call is holding for its answer right now (one question at a time). */
  asking = false;
  readonly ready: Promise<void>;
  markReady!: () => void;
  private turnWaiters: (() => void)[] = [];

  constructor(
    readonly sessionId: string,
    readonly agentId: Id,
    readonly gate: PermissionGate,
    readonly cwd: string,
    readonly model: string | undefined,
    readonly tools: ReadonlyMap<string, ToolDefinition>,
  ) {
    this.ready = new Promise((r) => (this.markReady = r));
  }

  /** Withdraws every pending question (but `keep`, a deferred `ask_user` that outlives the turn). */
  settlePending(keep?: Id): void {
    for (const q of [...this.pending.values()]) if (q.id !== keep) q.resolve(undefined);
  }

  turnEnd(): Promise<void> {
    if (!this.turnOpen) return Promise.resolve();
    return new Promise((r) => this.turnWaiters.push(r));
  }

  closeTurn(): void {
    this.turnOpen = false;
    this.steps.clear();
    for (const w of this.turnWaiters.splice(0)) w();
  }
}

export class AgyAdapter implements AgentAdapter {
  readonly runtime = 'agy' as const;
  readonly canPublish = false;
  readonly events = new EventQueue<AgentEvent>();
  private readonly sessions = new Map<string, Session>();
  private readonly byAgent = new Map<Id, Session>();
  private readonly byQuestion = new Map<Id, Session>();
  private readonly ended = new Map<string, NonNullable<Session['terminal']>>();
  private readonly onError: (error: unknown, context: string) => void;
  private readonly command: string;
  private readonly args: string[];
  private readonly home: string;
  private readonly stateDir: string;
  private readonly graceMs: number;
  private readonly askHoldMs: number;
  private readonly maxToolResultChars: number;
  private installed = false;
  private disposed = false;

  constructor(private readonly opts: AgyAdapterOptions) {
    this.command = opts.command ?? 'agy';
    this.args = opts.args ?? [];
    this.home = opts.home ?? homedir();
    this.stateDir = opts.stateDir ?? join(tmpdir(), 'galactic-agy');
    this.graceMs = opts.graceMs ?? 10_000;
    this.askHoldMs = opts.askHoldMs ?? ASK_HOLD_MS;
    this.onError = opts.onError ?? (() => {});
    this.maxToolResultChars = opts.maxToolResultChars ?? 2_000;
  }

  // --- provider ------------------------------------------------------------------

  async preflight(): Promise<RuntimePreflight> {
    const problem = globalEntriesProblem(this.home);
    return agyPreflight({
      command: this.command,
      args: this.args,
      env: this.queryEnv(),
      ...(problem ? { entriesProblem: problem } : {}),
    });
  }

  /** `agy models`. Never throws (`[]`). */
  async models(): Promise<ModelInfo[]> {
    try {
      const run = await execAgy(this.command, [...this.args, 'models'], this.queryEnv(), 30_000);
      if (run.code !== 0) throw new Error(`agy models: exit ${run.code}: ${run.stderr.trim()}`);
      return parseModels(run.stdout);
    } catch (error) {
      this.onError(error, 'agy models');
      return [];
    }
  }

  /** `agy -p /usage`: the subscription's weekly buckets. Never throws. */
  async usage(): Promise<ProviderUsage | undefined> {
    try {
      return usageFrom(await this.readUsage());
    } catch (error) {
      this.onError(error, 'agy usage');
      return undefined;
    }
  }

  private async readUsage(): Promise<string> {
    const run = await execAgy(this.command, [...this.args, ...USAGE_ARGS], this.queryEnv());
    if (run.code !== 0) throw new Error(`agy /usage: exit ${run.code}: ${run.stderr.trim()}`);
    return run.stdout;
  }

  /** The environment of a query (models, usage, preflight): no session secret. */
  private queryEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of [...INHERITED_ENV, ...AGY_PASS_ENV]) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    env['HOME'] = this.home;
    return { ...env, ...(this.opts.env ?? {}) };
  }

  /** The environment a turn gets on top of the supervisor's allow-list. */
  private turnEnv(session: Session): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const key of AGY_PASS_ENV) env[key] = process.env[key];
    return {
      ...env,
      HOME: this.home,
      [SECRET_ENV]: session.secret,
      [URL_ENV]: this.opts.hookUrl(),
      ...(this.opts.env ?? {}),
    };
  }

  // --- the global entries ----------------------------------------------------------

  /** Copies the scripts into the state folder and adds (or refreshes) the global entries. */
  private ensureInstalled(): void {
    mkdirSync(this.stateDir, { recursive: true });
    for (const script of [HOOK_SCRIPT, TOOLS_SCRIPT]) {
      const from = join(HERE, script);
      const to = join(this.stateDir, script);
      if (!existsSync(to) || !readFileSync(to).equals(readFileSync(from))) copyFileSync(from, to);
    }
    installGlobalEntries({
      home: this.home,
      stateFile: join(this.stateDir, 'global-entries.json'),
      hookCommand: `${shellQuote(process.execPath)} ${shellQuote(join(this.stateDir, HOOK_SCRIPT))}`,
      hookTimeoutS: HOOK_TIMEOUT_S,
      toolCommand: process.execPath,
      toolArgs: [join(this.stateDir, TOOLS_SCRIPT)],
    });
    this.installed = true;
  }

  // --- startup -------------------------------------------------------------------

  spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    return this.open(opts, undefined);
  }

  async resumeSession(sessionRef: string, opts: SpawnOptions): Promise<SpawnHandle> {
    const m = SESSION_REF.exec(sessionRef);
    if (!m) throw new Error(`not an agy session ref: ${sessionRef}`);
    return this.open(opts, m[1]!);
  }

  private async open(opts: SpawnOptions, resume: string | undefined): Promise<SpawnHandle> {
    if (this.disposed) throw new Error('adapter disposed');
    if (opts.bare) throw new Error('bare mode is a claude-sdk option; the agy runtime has none');
    if (opts.role !== 'steward') {
      throw new Error('the agy runtime runs Stewards only: brains run on claude-sdk');
    }
    if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
      throw new Error(`the working directory does not exist: ${opts.cwd}`);
    }
    refuseWorkspaceConfig(opts.cwd);
    this.ensureInstalled();
    const tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    const session = new Session(randomUUID(), opts.agentId, opts.gate, opts.cwd, opts.model, tools);
    session.conversationId = resume;
    this.sessions.set(session.sessionId, session);
    this.byAgent.set(opts.agentId, session);
    this.opts.bridge.register(
      session.secret,
      (call, payload) => this.decide(session, call, payload),
      createToolServer({
        tools,
        askUser: (args) => this.askUserTool(session, args),
        allowed: (name, args) => takePass(session, name, args),
      }),
    );
    const prompt =
      resume === undefined
        ? [opts.systemPrompt, ASK_USER_NOTE, opts.prompt].filter(Boolean).join('\n\n')
        : opts.prompt;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.startTurn(session, prompt),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`agy (${this.command}) did not start its turn in time`)),
            this.opts.startTimeoutMs ?? 60_000,
          );
        }),
      ]);
    } catch (error) {
      await this.abandon(session);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!session.conversationId) {
      await this.abandon(session);
      throw new Error('agy started without a conversation id');
    }
    return { sessionId: session.sessionId, sessionRef: `agy:${session.conversationId}` };
  }

  /** A start that failed: no event (the runtime reports the failed spawn), no process left. */
  private async abandon(session: Session): Promise<void> {
    session.terminal = 'failed';
    session.settlePending();
    this.opts.bridge.unregister(session.secret);
    this.forget(session);
    if (session.process && session.process.state !== 'exited') {
      await this.opts.supervisor.kill(session.agentId).catch(() => {});
    }
  }

  // --- turns ---------------------------------------------------------------------

  /** Starts one turn's process; resolves on its `init`, rejects when it ends before one. */
  private startTurn(session: Session, text: string): Promise<void> {
    // Every turn is a new agy process that loads the workspace's `.agents/` files again: one that
    // appeared since the last turn (an approved write, a merged branch) ends the session.
    try {
      refuseWorkspaceConfig(session.cwd);
    } catch (error) {
      if (!session.starting) {
        const message = (error as Error).message;
        session.failure = { error: message, reason: 'runtime' };
        this.output(session, 'text', message);
        this.terminal(session, this.stoppedEvent(session, SYSTEM));
      }
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    session.turnOpen = true;
    session.lastText = '';
    session.stderr = '';
    session.lineBuffer = '';
    session.quota = false;
    session.steps.clear();
    const args = [
      ...this.args,
      '-p',
      text,
      ...TURN_FLAGS,
      ...(session.model ? ['--model', session.model] : []),
      ...(session.conversationId ? ['--conversation', session.conversationId] : []),
    ];
    return new Promise<void>((resolve, reject) => {
      session.initWaiter = { resolve, reject };
      let proc: ManagedProcess;
      try {
        proc = this.opts.supervisor.adopt({
          agentId: session.agentId,
          command: this.command,
          args,
          cwd: session.cwd,
          env: this.turnEnv(session),
          meta: { runtime: 'agy', command: this.command },
          onStdout: (chunk) => this.onStdout(session, chunk),
          onStderr: (chunk) => {
            session.stderr = (session.stderr + chunk).slice(-16_000);
          },
          interrupt: (p) => this.stopHook(session, p),
          onOutcome: (outcome) => this.onOutcome(session, proc, outcome),
        });
      } catch (error) {
        if (session.initWaiter?.reject === reject) session.initWaiter = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      session.process = proc;
      // The prompt is on the command line; an open stdin could be read as more prompt.
      proc.child.stdin?.end();
    });
  }

  private onStdout(session: Session, chunk: string): void {
    session.lineBuffer += chunk;
    let nl: number;
    while ((nl = session.lineBuffer.indexOf('\n')) >= 0) {
      const line = session.lineBuffer.slice(0, nl).trim();
      session.lineBuffer = session.lineBuffer.slice(nl + 1);
      if (line) this.onLine(session, line);
    }
  }

  private onLine(session: Session, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = asRecord(JSON.parse(line));
    } catch {
      return; // not stream-json (a CLI notice)
    }
    switch (msg['event']) {
      case 'init':
        this.onInit(session, msg);
        return;
      case 'step_update':
        this.onStep(session, asRecord(msg['step_update']));
        return;
      case 'result': {
        const result = asRecord(msg['result']);
        const response = result['response'];
        if (typeof response === 'string' && response.trim()) session.lastResult = response.trim();
        if (isQuotaResult(result)) session.quota = true;
        return;
      }
      default:
        return;
    }
  }

  private onInit(session: Session, msg: Record<string, unknown>): void {
    const id = msg['conversation_id'] ?? asRecord(msg['init'])['conversation_id'];
    // The id becomes the session ref and a folder name: only the shape a resume accepts.
    if (!session.conversationId && typeof id === 'string' && SESSION_REF.test(`agy:${id}`)) {
      session.conversationId = id;
    }
    if (session.conversationId) {
      session.images = snapshotImages(brainDir(this.home, session.conversationId));
    }
    session.starting = false;
    session.queuedRun = undefined; // agy has the prompt
    session.markReady();
    const waiter = session.initWaiter;
    session.initWaiter = undefined;
    waiter?.resolve();
  }

  private onStep(session: Session, step: Record<string, unknown>): void {
    const conversation = step['conversation_id'];
    // A subagent's own steps: its tool calls reached the hook; its traffic is not transcript.
    if (
      typeof conversation === 'string' &&
      session.conversationId !== undefined &&
      conversation !== session.conversationId
    ) {
      return;
    }
    const index = typeof step['step_index'] === 'number' ? step['step_index'] : -1;
    const state = step['state'];
    const ended = state === 'DONE' || state === 'ERROR';
    switch (step['step_type']) {
      case 'agent_response': {
        const delta = step['text_delta'];
        if (typeof delta === 'string') {
          session.steps.set(index, (session.steps.get(index) ?? '') + delta);
        }
        if (ended) {
          const text = (session.steps.get(index) ?? '').trim();
          session.steps.delete(index);
          if (text) {
            session.lastText = text;
            this.output(session, 'text', text);
          }
        }
        return;
      }
      case 'tool': {
        if (!ended) return;
        const name = typeof step['tool_name'] === 'string' ? step['tool_name'] : 'tool';
        const info = asRecord(step['tool_info']);
        if (state === 'ERROR') {
          const message = asRecord(info['error'])['message'];
          this.output(
            session,
            'tool',
            `${name} failed: ${typeof message === 'string' ? message.slice(0, this.maxToolResultChars) : 'error'}`,
          );
          return;
        }
        const out = info['output'];
        const text = typeof out === 'string' ? out : out === undefined ? '' : JSON.stringify(out);
        this.output(
          session,
          'tool',
          text ? `${name}: ${text.slice(0, this.maxToolResultChars)}` : `${name}: done`,
        );
        return;
      }
      default:
        return;
    }
  }

  private onOutcome(session: Session, proc: ManagedProcess, outcome: ProcessOutcome): void {
    if (outcome.kind === 'restarting') return; // adopt() has no restart policy
    if (session.process !== undefined && session.process !== proc) return; // an older turn's
    session.process = undefined;
    clearTimeout(session.killTimer);
    if (session.lineBuffer.trim()) this.onStdout(session, '\n');
    const waiter = session.initWaiter;
    session.initWaiter = undefined;
    if (waiter && session.starting) {
      waiter.reject(new Error(this.exitText(outcome)));
      return; // `spawn()` throws; the runtime reports it
    }
    if (session.terminal) return;
    switch (outcome.kind) {
      case 'stopped':
        this.terminal(session, this.stoppedEvent(session, outcome.by ?? SYSTEM));
        return;
      case 'start_failed':
        if (session.stopping) {
          this.terminal(session, this.stoppedEvent(session, SYSTEM));
          return;
        }
        this.terminal(session, {
          type: 'agent.failed',
          agentId: session.agentId,
          error: outcome.error,
          reason: 'runtime',
        });
        return;
      case 'crashed':
        if (session.stopping) {
          this.terminal(session, this.stoppedEvent(session, SYSTEM));
          return;
        }
        if (!session.interrupting) {
          if (outcome.exit.signal) {
            this.terminal(session, {
              type: 'agent.failed',
              agentId: session.agentId,
              error: `agy exited unexpectedly (${outcome.exit.signal})`,
              reason: 'crash',
            });
            return;
          }
          if (session.quota || (outcome.exit.code === 3 && isQuotaError(session.stderr))) {
            void this.limitReached(session);
            return;
          }
          this.output(session, 'text', `turn failed: ${this.exitText(outcome)}`);
        }
        void this.endTurn(session);
        return;
      case 'exited':
        if (session.stopping) {
          this.terminal(session, this.stoppedEvent(session, SYSTEM));
          return;
        }
        if (session.quota && !session.interrupting) {
          void this.limitReached(session);
          return;
        }
        void this.endTurn(session);
        return;
    }
  }

  private exitText(outcome: ProcessOutcome): string {
    const what =
      outcome.kind === 'start_failed'
        ? outcome.error
        : outcome.kind === 'restarting'
          ? 'restarting'
          : `agy (${this.command}) exited with ${outcome.exit.signal ?? `code ${outcome.exit.code}`}`;
    return what;
  }

  /**
   * The turn's process ended: copy the new images, then report the turn's end — unless an
   * `ask_user` question is still open (deferred): then the turn stays open, the question with it,
   * and its answer is the prompt of a new agy run in the same conversation (P11-05, ruling R12).
   */
  private async endTurn(session: Session): Promise<void> {
    session.queuedRun = undefined;
    const deferred =
      session.deferred && !session.interrupting && !session.stopping ? session.deferred : undefined;
    session.deferred = undefined;
    session.settlePending(deferred?.id);
    if (session.lastText) session.lastResult = session.lastText;
    await this.copyImages(session);
    if (deferred && !session.terminal) {
      const answer = await deferred.answer; // `undefined`: withdrawn by an interrupt or a stop
      if (answer !== undefined && !session.terminal && !session.stopping && !session.interrupting) {
        const prompt = isDismissed(answer)
          ? dismissedClarification(answer.dismissed)
          : `The user answered your question ("${deferred.question}"): ${answer}`;
        if (session.paused) {
          // No process to freeze and nothing to interrupt: the answer waits for the resume, the
          // turn is closed meanwhile so an interrupt or a message never waits on it (P11-14).
          session.queued = prompt;
          session.closeTurn();
          return;
        }
        this.startTurn(session, prompt).catch((error: unknown) =>
          this.onError(error, `agy turn ${session.agentId}`),
        );
        return;
      }
    }
    session.interrupting = false;
    session.closeTurn();
    if (!session.stopping && !session.terminal && !session.limit && !session.failure) {
      this.emit(session, { type: 'agent.idle', agentId: session.agentId });
    }
  }

  private async copyImages(session: Session): Promise<void> {
    if (!session.conversationId || !session.images) return;
    const dir = brainDir(this.home, session.conversationId);
    try {
      const copied = await copyNewImages(dir, session.images, session.cwd);
      session.images = snapshotImages(dir);
      if (copied.length > 0) {
        this.output(
          session,
          'text',
          `Copied ${copied.length === 1 ? 'a generated image' : `${copied.length} generated images`} into ${IMAGE_FOLDER}/: ${copied.join(', ')}`,
        );
      }
    } catch (error) {
      this.onError(error, `agy images ${session.agentId}`);
    }
  }

  /**
   * The subscription's quota: the reset time comes from `/usage` (the error does not carry it),
   * then the session ends with `agent.failed{reason: 'limit'}` — its one terminal event.
   */
  private async limitReached(session: Session): Promise<void> {
    if (session.limit || session.terminal) return;
    session.limit = true;
    session.settlePending();
    let resetsAt: string | undefined;
    try {
      resetsAt = limitResetsAt(await this.readUsage(), session.model);
    } catch (error) {
      this.onError(error, `agy usage ${session.agentId}`);
    }
    session.failure = { error: LIMIT_ERROR, reason: 'limit', ...(resetsAt ? { resetsAt } : {}) };
    this.output(session, 'text', LIMIT_ERROR);
    this.terminal(session, this.stoppedEvent(session, SYSTEM));
  }

  // --- the hook ------------------------------------------------------------------

  /** One tool call from the hook: the fixed verdicts, else the gate (which may ask the user). */
  private async decide(
    session: Session,
    call: ToolCall,
    payload: Record<string, unknown>,
  ): Promise<HookDecision> {
    await Promise.race([session.ready, new Promise((r) => setTimeout(r, 5_000))]);
    if (session.terminal || session.stopping || session.interrupting || session.limit) {
      return { decision: 'deny', reason: 'the turn is ending' };
    }
    const verdict = mapAgyCall(call, {
      cwd: session.cwd,
      home: this.home,
      serverTools: new Set(session.tools.keys()),
    });
    const toolUseId = toolUseIdOf(payload);
    switch (verdict.kind) {
      case 'deny':
        this.output(session, 'text', `permission denied for ${call.toolName}: ${verdict.reason}`);
        return { decision: 'deny', reason: verdict.reason };
      case 'allow':
        if (verdict.report) this.toolCall(session, verdict.report, toolUseId);
        return { decision: 'allow' };
      case 'ask_user':
        givePass(session, ASK_USER_TOOL, asRecord(call.input)['Arguments']);
        return { decision: 'allow' };
      case 'gate': {
        const d = await this.gateDecide(session, verdict.call, toolUseId);
        if (d === 'allow') {
          if (verdict.mcpTool) givePass(session, verdict.mcpTool, verdict.call.input);
          return { decision: 'allow' };
        }
        return { decision: 'deny', reason: d === 'withdrawn' ? 'the turn is ending' : d.deny };
      }
    }
  }

  /** The gate's verdict; a check that throws is a `deny` (fail closed). */
  private check(session: Session, call: ToolCall): GateVerdict {
    try {
      return session.gate.check(call);
    } catch (error) {
      this.onError(error, `gate ${session.agentId}`);
      return { decision: 'deny', reason: `permission check failed: ${(error as Error).message}` };
    }
  }

  /**
   * One call through the gate: `allow` reports it, `deny` refuses it with a line, `ask` waits for
   * the answer (the hook's timeout is the limit). `withdrawn`: the turn or the session is ending.
   */
  private async gateDecide(session: Session, call: ToolCall, toolUseId: string): Promise<Decision> {
    const verdict = this.check(session, call);
    const what = describeAgyCall(call);
    if (verdict.decision === 'allow') {
      this.toolCall(session, call, toolUseId);
      return 'allow';
    }
    if (verdict.decision === 'deny') {
      this.output(session, 'text', `permission denied for ${what}: ${verdict.reason}`);
      return { deny: `${verdict.reason}. Do not try another way to do this.` };
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
      return { deny: `the user refused: the permission request was ${answer.dismissed}` };
    }
    if (ALLOW.test(answer.trim())) {
      this.toolCall(session, call, toolUseId);
      return 'allow';
    }
    this.output(session, 'text', `permission denied for ${what}: ${answer}`);
    return { deny: 'the user refused. Do not try another way to do this.' };
  }

  private toolCall(session: Session, call: ToolCall, toolUseId: string): void {
    this.emit(session, {
      type: 'agent.tool_call',
      agentId: session.agentId,
      toolName: call.toolName,
      toolUseId,
      input: call.input,
    });
  }

  /**
   * The adapter's `ask_user` tool (ruling R6): a clarification question, not an action — no gate,
   * no `agent.tool_call`. The answer (or what a dismissal tells the agent) is the result.
   */
  private async askUserTool(session: Session, raw: unknown): Promise<McpCallResult> {
    const args = asRecord(raw);
    const text = typeof args['question'] === 'string' ? args['question'].trim() : '';
    if (!text) return mcpText('ask_user needs a question', true);
    // One question at a time (final review): a second one would replace the waiting one's
    // deferred answer, leaving its card stale and its answer lost.
    if (session.asking || session.deferred) return mcpText(ASK_WAITING_NOTE, true);
    const options = (Array.isArray(args['options']) ? args['options'] : [])
      .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      .slice(0, 8);
    const { id, answer: pending } = this.openQuestion(session, 'clarification', {
      text,
      ...(options.length > 0 ? { options } : {}),
    });
    // agy gives up on an MCP call after 3 minutes (measured, P11-05): wait less, then let the
    // question outlive the call — the answer comes back as the Steward's next message.
    let timer: NodeJS.Timeout | undefined;
    session.asking = true;
    let held: Awaited<typeof pending> | typeof DEFERRED;
    try {
      held = await Promise.race([
        pending,
        new Promise<typeof DEFERRED>(
          (r) => (timer = setTimeout(() => r(DEFERRED), this.askHoldMs)),
        ),
      ]);
    } finally {
      session.asking = false;
      clearTimeout(timer);
    }
    if (held === DEFERRED) {
      session.deferred = { id: id!, question: text, answer: pending };
      return mcpText(DEFERRED_NOTE);
    }
    const answer = held;
    if (answer === undefined) return mcpText('The question was withdrawn: no answer.', true);
    if (isDismissed(answer)) return mcpText(dismissedClarification(answer.dismissed));
    return mcpText(answer);
  }

  private ask(
    session: Session,
    kind: 'clarification' | 'permission',
    question: QuestionBody,
  ): Promise<string | Dismissed | undefined> {
    return this.openQuestion(session, kind, question).answer;
  }

  /** Opens a question; `id` is absent when the session is ending (the answer is then `undefined`). */
  private openQuestion(
    session: Session,
    kind: 'clarification' | 'permission',
    question: QuestionBody,
  ): { id: Id | undefined; answer: Promise<string | Dismissed | undefined> } {
    if (session.terminal || session.stopping || session.interrupting || session.limit) {
      return { id: undefined, answer: Promise.resolve(undefined) };
    }
    const id = `q-${randomUUID()}`;
    const answer = new Promise<string | Dismissed | undefined>((resolve) => {
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
    return { id, answer };
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
    let prompt = message;
    if (session.queued !== undefined) {
      // A paused answer waits for the resume: the message joins it, delivered after it.
      prompt = `${session.queued}\n\n${message}`;
      session.queued = prompt;
      if (session.paused) return;
      session.queued = undefined;
      this.runQueued(session, prompt);
      return;
    }
    // The turn's start is reported through its events; a process that ends at once ends the turn.
    this.startTurn(session, prompt).catch((error: unknown) =>
      this.onError(error, `agy turn ${session.agentId}`),
    );
  }

  /** Starts the run of a queued answer, kept until its `init` so an interrupt cannot lose it. */
  private runQueued(session: Session, prompt: string): void {
    session.queuedRun = prompt;
    this.startTurn(session, prompt).catch((error: unknown) =>
      this.onError(error, `agy turn ${session.agentId}`),
    );
  }

  async answer(questionId: Id, answer: string): Promise<void> {
    const pending = this.byQuestion.get(questionId)?.pending.get(questionId);
    if (!pending) throw new Error(`no pending question ${questionId}`);
    pending.resolve(answer);
  }

  /** The user dismissed the question (P9-14): a permission is refused, a question told so. */
  async dismiss(questionId: Id, reason: string): Promise<void> {
    const pending = this.byQuestion.get(questionId)?.pending.get(questionId);
    if (!pending) throw new Error(`no pending question ${questionId}`);
    pending.resolve({ dismissed: reason });
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || !session.turnOpen) return;
    session.interrupting = true;
    if (session.queuedRun !== undefined) {
      // The queued answer's run has not started yet: the answer waits for the next message.
      session.queued = session.queuedRun;
      session.queuedRun = undefined;
    }
    const proc = session.process;
    if (proc && proc.state !== 'exited') {
      if (session.paused) this.thaw(session); // a frozen process cannot end its turn
      // The signal first: the agent must not read a withdrawn answer as the user's.
      proc.signal('SIGINT');
      clearTimeout(session.killTimer);
      session.killTimer = setTimeout(() => {
        if (session.process === proc && proc.state !== 'exited') proc.signal('SIGKILL');
      }, this.graceMs);
    }
    session.settlePending();
  }

  async pause(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || session.paused) return;
    session.paused = true;
    if (session.process && session.process.state !== 'exited') session.process.signal('SIGSTOP');
    this.emit(session, { type: 'agent.paused', agentId: session.agentId, by: SYSTEM });
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || !session.paused) return;
    this.thaw(session);
  }

  private thaw(session: Session): void {
    session.paused = false;
    if (session.process && session.process.state !== 'exited') session.process.signal('SIGCONT');
    this.emit(session, { type: 'agent.resumed', agentId: session.agentId, by: SYSTEM });
    const queued = session.queued;
    if (queued !== undefined && !session.turnOpen && !session.stopping && !session.terminal) {
      session.queued = undefined;
      this.runQueued(session, queued);
    }
  }

  /** The supervisor's graceful stop, step 1: thaw, interrupt the turn's process. */
  private stopHook(session: Session, proc: ManagedProcess): void {
    if (session.paused) {
      proc.signal('SIGCONT');
      session.paused = false;
    }
    proc.signal('SIGINT');
    session.settlePending();
  }

  async stop(sessionId: string, opts: StopOptions = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.terminal) return;
    if (session.stopDone) return session.stopDone;
    session.stopping = true;
    session.stopDone = (async () => {
      const proc = session.process;
      if (proc && proc.state !== 'exited') {
        await this.opts.supervisor.stop(session.agentId, {
          graceMs: opts.graceMs ?? this.graceMs,
          by: SYSTEM,
        });
      }
      session.settlePending();
      if (!session.terminal) this.terminal(session, this.stoppedEvent(session, SYSTEM));
    })();
    return session.stopDone;
  }

  /** A stopped session's terminal event: `agent.stopped`, or the failure that ended it. */
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

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
    this.events.close();
    if (this.installed) {
      removeGlobalEntries({
        home: this.home,
        stateFile: join(this.stateDir, 'global-entries.json'),
      });
      this.installed = false;
    }
  }

  // --- helpers -------------------------------------------------------------------

  private session(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (s) return s;
    const ended = this.ended.get(sessionId);
    if (ended) throw new Error(`session ${sessionId} has ${ended}`);
    throw new Error(`unknown agy session ${sessionId}`);
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
    clearTimeout(session.killTimer);
    this.opts.bridge.unregister(session.secret);
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

/**
 * A pass is bound to one exact call — the tool and a canonical form of its arguments — so a
 * pass the gate gave one call cannot run a different call of the same tool.
 */
function passKey(name: string, args: unknown): string {
  return `${name}\u0000${canonicalJson(args ?? {})}`;
}

/** JSON with object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function givePass(session: Session, name: string, args: unknown): void {
  const key = passKey(name, args);
  session.passes.set(key, (session.passes.get(key) ?? 0) + 1);
}

function takePass(session: Session, name: string, args: unknown): boolean {
  const key = passKey(name, args);
  const n = session.passes.get(key) ?? 0;
  if (n <= 0) return false;
  if (n === 1) session.passes.delete(key);
  else session.passes.set(key, n - 1);
  return true;
}

/** One id per hook call (its conversation and step; a random one when agy sends neither). */
function toolUseIdOf(payload: Record<string, unknown>): string {
  const conversation = payload['conversationId'];
  const step = payload['stepIdx'];
  return typeof conversation === 'string' && typeof step === 'number'
    ? `${conversation}:${step}:${randomUUID().slice(0, 8)}`
    : randomUUID();
}

/** A word for `sh -c`: single-quoted. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A workspace that would load hooks or MCP servers of its own into agy (`.agents/hooks.json`,
 * `.agents/mcp_config.json` in the worktree or above it): such a file could approve tool calls or
 * start a server before Mission Control's hook sees anything, so the spawn is refused.
 */
function refuseWorkspaceConfig(cwd: string): void {
  let dir = cwd;
  for (;;) {
    for (const file of ['hooks.json', 'mcp_config.json']) {
      const p = join(dir, '.agents', file);
      // lstat: a symlink counts, even a dangling one (agy may follow it, or it may be filled).
      if (lstatExists(p)) {
        throw new Error(
          `${p} would load its own hooks or MCP servers into agy: GalacticAgents does not run Gemini Stewards there (remove or rename it)`,
        );
      }
    }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}
