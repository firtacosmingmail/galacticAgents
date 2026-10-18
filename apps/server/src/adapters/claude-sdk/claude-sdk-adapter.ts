import { randomUUID } from 'node:crypto';
import type {
  Actor,
  AgentAdapter,
  AgentEvent,
  Cost,
  GateVerdict,
  Id,
  PermissionGate,
  RuntimePreflight,
  SendOptions,
  SlashCommand,
  SpawnHandle,
  SpawnOptions,
  StopOptions,
  ToolCall,
} from '@galactic/protocol';
import { normalizeSlashCommands } from '@galactic/protocol';
import { EventQueue } from '../../lib/event-queue.js';
import {
  dismissedClarification,
  dismissedPermission,
  isDismissed,
  type Dismissed,
} from '../dismissal.js';
import { AGENT_SET_TITLE, fitsQuestionSet } from '../question-set.js';
import type {
  ManagedProcess,
  ProcessOutcome,
  ProcessSupervisor,
} from '../../runtime/supervisor.js';
import { jsonSchemaToZodShape } from './json-schema-to-zod.js';
import { claudePreflight } from './preflight.js';
import {
  loadSdk,
  type SdkCanUseToolOptions,
  type SdkCommandsChanged,
  type SdkContentBlock,
  type SdkHookOutput,
  type SdkMessage,
  type SdkPermissionResult,
  type SdkQuery,
  type SdkQueryOptions,
  type SdkRateLimitEvent,
  type SdkResultMessage,
  type SdkSurface,
  type SdkUsage,
  type SdkUserMessage,
} from './sdk-surface.js';

/**
 * The `claude-sdk` adapter (P1-09; TECHNOLOGY §3.1, shape fixed by the P1-08 spike). One
 * long-lived `query()` per session with streaming input: `send()` pushes the next user message
 * into the prompt iterable, every turn ends in a `result` that becomes `agent.idle(cost)`,
 * `interrupt()` is `query.interrupt()` (the cancelled turn's error result is also `agent.idle`).
 *
 * Permission flow: a `PreToolUse` hook asks the spawn's gate about every tool call — `allow`
 * lets it run (and emits `agent.tool_call`), `deny` refuses it with the reason, `ask` forwards
 * the call to `canUseTool`, which opens `agent.needs_input(kind: permission)` and blocks until
 * `answer()`. `AskUserQuestion` arrives in `canUseTool` too and becomes a clarification question
 * answered through `updatedInput.answers`.
 *
 * The CLI process is spawned by the server's supervisor through `spawnClaudeCodeProcess` (own
 * process group, PID table, graceful stop). Its fate reaches the adapter as a `ProcessOutcome`,
 * which the adapter maps to the session's single terminal event: `crashed`/`start_failed` →
 * `agent.failed`, `stopped` → `agent.stopped`, `exited` → `agent.finished`.
 *
 * The gate is asked once per `toolUseId`: the hook's verdict is remembered and `canUseTool`
 * reuses it (an `ask` goes to the user, an `allow` runs without a second check), and
 * `agent.tool_call` is emitted once per `toolUseId`. A gate that throws denies the call.
 *
 * Pause is `SIGSTOP` on the process group and resume `SIGCONT`: the turn in flight freezes in
 * place (tool, shell children and all) instead of being cancelled, which is what "pause" means
 * on the panel. `stop()` and `interrupt()` send `SIGCONT` first so a paused agent can still be
 * stopped or interrupted. The CLI's own timers (tool timeouts, API request timeouts) keep
 * counting while it is frozen, so a long pause can end the frozen tool call in a timeout.
 *
 * `AskUserQuestion` with several questions is one question set (P8-20, SPEC decision 141): every
 * question opens at once as an `agent.needs_input` sharing `question.set` (id `qs-<uuid>`, title
 * "Questions from the Steward"), `multiSelect` carried natively, and the call waits until every
 * row is resolved; a single question is asked alone. A `multiSelect` answer arrives as the card
 * renders it: the chosen labels joined with ", ".
 */

export interface ClaudeSdkAdapterOptions {
  supervisor: ProcessSupervisor;
  /** Injected in tests (`FakeSdk`); the real SDK is loaded lazily otherwise. */
  sdk?: SdkSurface | (() => Promise<SdkSurface>);
  /** Model for every spawn; the CLI's default when absent. */
  model?: string;
  /**
   * Which Claude Code settings a Steward session loads (decision 17: a normal session with the
   * repository's context). Default `['user', 'project', 'local']`. The real-Claude checks pass
   * `['project', 'local']`, so a developer's own global rules (a deny list, hooks) cannot decide
   * for the permission gate they are testing. Brains always load none.
   */
  stewardSettingSources?: ('user' | 'project' | 'local')[];
  /** Extra environment for the CLI, e.g. `ANTHROPIC_API_KEY` for `bare` spawns. */
  env?: Record<string, string | undefined>;
  /** Variables copied from the server's environment on top of the supervisor's allow-list. */
  passEnv?: string[];
  /** How long `stop()` waits for the turn to end after `interrupt()`. */
  graceMs?: number;
  /** How long `commands()` waits for the CLI's answer before giving `[]` (default 5 s; P8-13). */
  commandsTimeoutMs?: number;
  /** Longest tool-result excerpt kept in the transcript. */
  maxToolResultChars?: number;
  /**
   * When the message stream ends while the CLI still runs, how long to wait for its exit to
   * arrive before failing the session and stopping the process (default 2 s).
   */
  streamEndGraceMs?: number;
  onError?: (error: unknown, context: string) => void;
  /** The runtime check (P25-01); default `claudePreflight()` (runs `claude`). Tests inject one. */
  preflight?: () => Promise<RuntimePreflight>;
}

/** Credentials and routing the CLI needs that the supervisor's allow-list does not carry. */
export const CLAUDE_PASS_ENV: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS',
];

interface PendingQuestion {
  id: Id;
  /** An answer, a dismissal (P9-14), or `undefined` when the turn ended before either. */
  resolve: (answer: string | Dismissed | undefined) => void;
}

/** A push-driven `AsyncIterable` of user messages: the SDK's streaming prompt. */
class Inbox implements AsyncIterable<SdkUserMessage> {
  private readonly queue: SdkUserMessage[] = [];
  private waiting: ((r: IteratorResult<SdkUserMessage>) => void) | undefined;
  private closed = false;

  push(message: SdkUserMessage): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: message, done: false });
    } else this.queue.push(message);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
    return {
      next: () => {
        if (this.queue.length > 0)
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

class Session {
  readonly inbox = new Inbox();
  readonly abort = new AbortController();
  query: SdkQuery | undefined;
  process: ManagedProcess | undefined;
  /** A turn is running: a user message went in and its result has not come back. */
  turnOpen = false;
  /** `interrupt()` was called for the turn in flight: its error result is not a failure. */
  interrupting = false;
  paused = false;
  stopping = false;
  /** The one terminal event was emitted; nothing else may follow. */
  terminal: 'finished' | 'failed' | 'stopped' | undefined;
  /**
   * Questions waiting for an answer, by question id. Several at once: the CLI asks `canUseTool`
   * for parallel tool calls concurrently (two WebSearch calls in one turn).
   */
  readonly pending = new Map<Id, PendingQuestion>();
  /** Settles every waiting question with no answer (interrupt, stop, end of session). */
  settlePending(): void {
    for (const q of [...this.pending.values()]) q.resolve(undefined);
  }
  lastCost: Cost | undefined;
  lastResult: string | undefined;
  /**
   * The open turn put text in the transcript (the model's words, a local command's output):
   * a successful result's text is then not repeated (P8-13 review S4).
   */
  turnSpoke = false;
  /** The session's slash commands as the CLI last reported them (P8-13); unknown until then. */
  commands: SlashCommand[] | undefined;
  /** A `supportedCommands()` call in flight (one at a time). */
  commandsFetch: Promise<SlashCommand[]> | undefined;
  /** The `PreToolUse` hook's verdict per `toolUseId`, reused by `canUseTool` (one gate check per call). */
  readonly verdicts = new Map<string, GateVerdict>();
  /** `toolUseId`s already reported as `agent.tool_call`. Cleared at every turn end. */
  readonly toolCalls = new Set<string>();
  /** Resolves when the message loop has exited. */
  loopDone: Promise<void> = Promise.resolve();
  stopDone: Promise<void> | undefined;
  /** Resolves with the next turn end (result message) after `turnEnd()` was armed. */
  private turnWaiters: (() => void)[] = [];

  constructor(
    readonly sessionId: string,
    readonly agentId: Id,
    readonly gate: PermissionGate,
    /** Opened with `resume` (the CLI must report this same session id). */
    readonly resumed: boolean,
  ) {}

  turnEnd(): Promise<void> {
    if (!this.turnOpen) return Promise.resolve();
    return new Promise((r) => this.turnWaiters.push(r));
  }

  closeTurn(): void {
    this.turnOpen = false;
    this.turnSpoke = false;
    this.verdicts.clear();
    this.toolCalls.clear();
    for (const w of this.turnWaiters.splice(0)) w();
  }
}

const SYSTEM: Actor = { type: 'system' };
/** How many ended sessions are remembered for "session … has stopped" errors. */
const ENDED_MEMORY = 256;

export class ClaudeSdkAdapter implements AgentAdapter {
  readonly runtime = 'claude-sdk' as const;
  readonly events = new EventQueue<AgentEvent>();
  private readonly sessions = new Map<string, Session>();
  private readonly byAgent = new Map<Id, Session>();
  private readonly byQuestion = new Map<Id, Session>();
  /** Ended sessions (freed from the maps above) → how they ended; bounded. */
  private readonly ended = new Map<string, NonNullable<Session['terminal']>>();
  private sdkPromise: Promise<SdkSurface> | undefined;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly maxToolResultChars: number;
  private readonly streamEndGraceMs: number;
  private disposed = false;

  constructor(private readonly opts: ClaudeSdkAdapterOptions) {
    this.onError = opts.onError ?? (() => {});
    this.maxToolResultChars = opts.maxToolResultChars ?? 2_000;
    this.streamEndGraceMs = opts.streamEndGraceMs ?? 2_000;
  }

  private sdk(): Promise<SdkSurface> {
    if (!this.sdkPromise) {
      const given = this.opts.sdk;
      this.sdkPromise = !given
        ? loadSdk()
        : typeof given === 'function'
          ? given()
          : Promise.resolve(given);
    }
    return this.sdkPromise;
  }

  async spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    return this.open(opts, undefined);
  }

  /** Installed, logged in, versions (P25-01): `claude --version` and `claude auth status`. */
  preflight(): Promise<RuntimePreflight> {
    return (this.opts.preflight ?? (() => claudePreflight()))();
  }

  async resumeSession(sessionRef: string, opts: SpawnOptions): Promise<SpawnHandle> {
    if (!/^[0-9a-f-]{8,}$/i.test(sessionRef))
      throw new Error(`not a claude-sdk session ref: ${sessionRef}`);
    return this.open(opts, sessionRef);
  }

  private async open(opts: SpawnOptions, resume: string | undefined): Promise<SpawnHandle> {
    if (this.disposed) throw new Error('adapter disposed');
    if (opts.bare && !this.env()['ANTHROPIC_API_KEY']) {
      throw new Error('bare mode needs ANTHROPIC_API_KEY (no subscription login in bare mode)');
    }
    const sdk = await this.sdk();
    const sessionId = resume ?? randomUUID();
    const session = new Session(sessionId, opts.agentId, opts.gate, resume !== undefined);
    this.ended.delete(sessionId);
    this.sessions.set(sessionId, session);
    this.byAgent.set(opts.agentId, session);

    const queryOptions = this.buildOptions(sdk, opts, session, resume);
    session.inbox.push(userMessage(sessionId, opts.prompt));
    session.turnOpen = true;
    try {
      session.query = sdk.query({ prompt: session.inbox, options: queryOptions });
    } catch (error) {
      this.forget(session);
      throw error;
    }
    session.loopDone = this.consume(session);
    return { sessionId, sessionRef: sessionId };
  }

  private buildOptions(
    sdk: SdkSurface,
    opts: SpawnOptions,
    session: Session,
    resume: string | undefined,
  ): SdkQueryOptions {
    const isBrain = opts.role !== 'steward';
    const options: SdkQueryOptions = {
      cwd: opts.cwd,
      ...(resume ? { resume } : { sessionId: session.sessionId }),
      ...(this.opts.model ? { model: this.opts.model } : {}),
      permissionMode: 'default',
      includePartialMessages: false,
      persistSession: true,
      abortController: session.abort,
      // Brains carry their own instructions and tools; Stewards get the repository's context.
      settingSources: isBrain
        ? []
        : (this.opts.stewardSettingSources ?? ['user', 'project', 'local']),
      ...(opts.systemPrompt
        ? {
            systemPrompt: isBrain
              ? opts.systemPrompt
              : { type: 'preset', preset: 'claude_code', append: opts.systemPrompt },
          }
        : {}),
      ...(opts.bare ? { extraArgs: { bare: null } } : {}),
      env: this.env(),
      // No SDK `stderr` callback: the supervisor captures the CLI's stderr (`onStderr`), so
      // every line is reported once.
      hooks: { PreToolUse: [{ hooks: [(input) => this.preToolUse(session, input)] }] },
      canUseTool: (toolName, input, o) => this.canUseTool(session, toolName, input, o),
      spawnClaudeCodeProcess: (o) => this.spawnProcess(session, o),
    };
    if (opts.tools && opts.tools.length > 0) {
      const server = sdk.createSdkMcpServer({
        name: 'galactic',
        version: '1',
        tools: opts.tools.map((t) =>
          sdk.tool(t.name, t.description, jsonSchemaToZodShape(t.inputSchema), async (args) => {
            const out = await t.handler(args);
            return {
              content: [
                { type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) },
              ],
            };
          }),
        ),
      });
      options.mcpServers = { galactic: server };
      // A brain has no use for any other server: none is loaded, so no configured server can
      // even share the name (a Steward keeps the repository's own, told apart by provenance).
      if (isBrain) options.strictMcpConfig = true;
      options.allowedTools = opts.tools.map((t) => `mcp__galactic__${t.name}`);
    }
    return options;
  }

  /** The CLI's environment: the supervisor's allow-list, the pass-through list, the adapter's own. */
  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const key of [...CLAUDE_PASS_ENV, ...(this.opts.passEnv ?? [])]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return { ...env, ...(this.opts.env ?? {}) };
  }

  // --- process ---------------------------------------------------------------

  private spawnProcess(
    session: Session,
    o: {
      command: string;
      args: string[];
      cwd?: string;
      env: Record<string, string | undefined>;
      signal?: AbortSignal;
    },
  ) {
    // The SDK's env is the server's plus its own additions: keep only what it added, and let
    // the supervisor's allow-list (plus our pass-through) decide what the child inherits.
    const added: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(o.env))
      if (v !== undefined && process.env[k] !== v) added[k] = v;
    const managed = this.opts.supervisor.adopt({
      agentId: session.agentId,
      command: o.command,
      args: o.args,
      cwd: o.cwd ?? process.cwd(),
      env: { ...this.env(), ...added },
      meta: { runtime: 'claude-sdk', sessionRef: session.sessionId },
      onStderr: (chunk) => {
        const line = chunk.trim();
        if (line) this.onError(new Error(line.slice(0, 500)), `cli stderr ${session.agentId}`);
      },
      // The supervisor's graceful stop, step 1 (raced with the grace period, so a wedged CLI
      // that never answers the interrupt still reaches SIGTERM).
      interrupt: async (proc) => {
        if (session.paused) {
          proc.signal('SIGCONT');
          session.paused = false;
        }
        if (session.turnOpen) {
          session.interrupting = true;
          await session.query?.interrupt().catch(() => {});
          await session.turnEnd();
        }
        // No turn left: close the input so the CLI exits on stdin EOF before any SIGTERM.
        session.inbox.close();
        proc.turnEnded();
      },
      onOutcome: (outcome) => this.onOutcome(session, outcome),
    });
    session.process = managed;
    // The SDK aborts the child itself on a clean close (stdin EOF, then this signal): not a crash.
    o.signal?.addEventListener('abort', () => managed.expectExit(), { once: true });
    return managed.child;
  }

  private onOutcome(session: Session, outcome: ProcessOutcome): void {
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
        this.terminal(session, {
          type: 'agent.failed',
          agentId: session.agentId,
          error: `claude exited unexpectedly (${outcome.exit.signal ?? `code ${outcome.exit.code}`})`,
          reason: 'crash',
          ...(session.lastCost ? { cost: session.lastCost } : {}),
        });
        return;
      case 'stopped':
        this.terminal(session, {
          type: 'agent.stopped',
          agentId: session.agentId,
          by: outcome.by ?? SYSTEM,
        });
        return;
      case 'exited':
        if (session.stopping) {
          this.terminal(session, { type: 'agent.stopped', agentId: session.agentId, by: SYSTEM });
        } else {
          this.terminal(session, {
            type: 'agent.finished',
            agentId: session.agentId,
            ...(session.lastResult !== undefined ? { result: session.lastResult } : {}),
            ...(session.lastCost ? { cost: session.lastCost } : {}),
          });
        }
        return;
      case 'restarting':
        this.emit(session, {
          type: 'agent.progress',
          agentId: session.agentId,
          summary: `restarting claude after a crash (${outcome.attempt}/${outcome.maxRestarts})`,
        });
        return;
    }
  }

  // --- message loop ------------------------------------------------------------

  private async consume(session: Session): Promise<void> {
    const query = session.query!;
    let failure: string | undefined;
    try {
      for await (const message of query) this.onMessage(session, message as SdkMessage);
      // The stream ended: the input was closed (stop) or the CLI went away.
    } catch (error) {
      // With streaming input the loop should end only when the child exits; a throw — also
      // one while interrupting — leaves a CLI nobody reads from.
      failure = (error as Error).message;
      if (!session.stopping) this.onError(error, `query ${session.agentId}`);
    } finally {
      session.closeTurn();
    }
    if (!session.process) {
      // No child ever reported (the SDK ran without our spawner): end the session here.
      this.terminal(
        session,
        session.stopping
          ? { type: 'agent.stopped', agentId: session.agentId, by: SYSTEM }
          : failure !== undefined
            ? { type: 'agent.failed', agentId: session.agentId, error: failure, reason: 'runtime' }
            : {
                type: 'agent.finished',
                agentId: session.agentId,
                ...(session.lastResult !== undefined ? { result: session.lastResult } : {}),
                ...(session.lastCost ? { cost: session.lastCost } : {}),
              },
      );
      return;
    }
    // The process outcome carries the terminal event when the CLI exits; give that exit a
    // moment to arrive (the stream may end a little before the supervisor settles it).
    const proc = session.process;
    if (session.terminal || session.stopping) return;
    if (proc.state !== 'exited') await settlesWithin(proc.exited, this.streamEndGraceMs);
    if (session.terminal || session.stopping || proc.state === 'exited') return;
    // The loop is over but the CLI still runs: nothing will ever end this session otherwise.
    this.terminal(session, {
      type: 'agent.failed',
      agentId: session.agentId,
      error: failure ?? 'the claude message stream ended while the CLI was still running',
      reason: 'runtime',
      ...(session.lastCost ? { cost: session.lastCost } : {}),
    });
    session.stopping = true;
    await this.opts.supervisor
      .stop(session.agentId, { graceMs: this.opts.graceMs ?? 10_000, by: SYSTEM })
      .catch((error: unknown) => this.onError(error, `stop ${session.agentId}`));
  }

  private onMessage(session: Session, message: SdkMessage): void {
    const agentId = session.agentId;
    switch (message.type) {
      case 'system': {
        const m = message as { subtype?: string; session_id?: unknown };
        if (m.subtype === 'commands_changed') {
          // The full list after a change (skills found in a subdirectory …): replaces the cache.
          const changed = message as unknown as SdkCommandsChanged;
          session.commands = normalizeSlashCommands(
            Array.isArray(changed.commands) ? changed.commands : [],
          );
          return;
        }
        // The CLI is up: read its commands now, so the composer's list is ready (P8-13).
        if (m.subtype === 'init' && session.commands === undefined)
          void this.fetchCommands(session);
        if (
          m.subtype === 'init' &&
          typeof m.session_id === 'string' &&
          m.session_id !== session.sessionId
        ) {
          this.onError(
            new Error(
              `claude reported session ${m.session_id}, expected ${session.sessionId}${session.resumed ? ' (resume)' : ''}`,
            ),
            `init ${agentId}`,
          );
        }
        return;
      }
      case 'assistant': {
        const m = message as Extract<SdkMessage, { type: 'assistant' }>;
        for (const block of m.message.content)
          this.onAssistantBlock(session, block, m.parent_tool_use_id);
        return;
      }
      case 'user': {
        const m = message as Extract<SdkMessage, { type: 'user' }>;
        // A local command's answer (`/context`, `/cost` …: the CLI runs it without the model)
        // comes back as a user message wrapped in `<local-command-stdout>` (P8-13 review S4).
        const local = localCommandOutput(m.message.content);
        if (local) {
          this.emit(session, { type: 'agent.output', agentId, kind: 'text', text: local });
          return;
        }
        if (m.isSynthetic || typeof m.message.content === 'string') return;
        for (const block of m.message.content) {
          if (block.type !== 'tool_result') continue;
          const text = toolResultText(block.content);
          if (text) {
            this.emit(session, {
              type: 'agent.output',
              agentId,
              kind: 'tool',
              text: `${block.is_error ? 'tool error' : 'tool result'}: ${text.slice(0, this.maxToolResultChars)}`,
            });
          }
        }
        return;
      }
      case 'rate_limit_event': {
        const summary = rateLimitSummary(message as SdkRateLimitEvent);
        // Only inside a turn: a progress event marks the agent working.
        if (summary && session.turnOpen)
          this.emit(session, { type: 'agent.progress', agentId, summary });
        return;
      }
      case 'result': {
        const m = message as SdkResultMessage;
        const cost = costOf(m);
        if (cost) session.lastCost = cost;
        // `is_error` also flags API, auth and prompt-too-long failures reported as `success`.
        const failed = m.subtype !== 'success' || m.is_error === true;
        if (!failed) {
          if (m.result !== undefined) session.lastResult = m.result;
          // A turn that said nothing else (a slash command the CLI answered itself): its result
          // text is the answer the user waits for (P8-13 review S4).
          const answer = m.result !== undefined ? stripLocalCommandTags(m.result) : '';
          if (answer && !session.turnSpoke)
            this.emit(session, { type: 'agent.output', agentId, kind: 'text', text: answer });
        } else if (!session.interrupting && !session.stopping) {
          const what = m.subtype === 'success' ? 'an error' : m.subtype;
          const detail = m.errors?.length ? m.errors.join('; ') : (m.result ?? '');
          this.emit(session, {
            type: 'agent.output',
            agentId,
            kind: 'text',
            text: `turn ended with ${what}${detail ? `: ${detail}` : ''}`,
          });
        }
        session.interrupting = false;
        session.closeTurn();
        session.process?.turnEnded();
        if (!session.stopping && !session.terminal) {
          this.emit(session, { type: 'agent.idle', agentId, ...(cost ? { cost } : {}) });
        }
        return;
      }
      default:
        return; // status, hooks, compaction …: not transcript
    }
  }

  private onAssistantBlock(
    session: Session,
    block: SdkContentBlock,
    parentToolUseId: string | null,
  ): void {
    const agentId = session.agentId;
    const prefix = parentToolUseId ? '[subagent] ' : '';
    switch (block.type) {
      case 'text':
        if (block.text)
          this.emit(session, {
            type: 'agent.output',
            agentId,
            kind: 'text',
            text: prefix + block.text,
          });
        return;
      case 'thinking':
        if (block.thinking)
          this.emit(session, {
            type: 'agent.output',
            agentId,
            kind: 'thinking',
            text: prefix + block.thinking,
          });
        return;
      case 'tool_use':
        // The call itself is reported from the PreToolUse hook, once the gate let it run.
        return;
      default:
        return;
    }
  }

  // --- permissions -------------------------------------------------------------

  /** `agent.tool_call` once per `toolUseId`, whichever of the hook and `canUseTool` lets it run. */
  private toolCall(
    session: Session,
    toolName: string,
    toolUseId: string | undefined,
    input: unknown,
  ): void {
    if (toolUseId !== undefined) {
      if (session.toolCalls.has(toolUseId)) return;
      session.toolCalls.add(toolUseId);
    }
    this.emit(session, {
      type: 'agent.tool_call',
      agentId: session.agentId,
      toolName,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      input,
    });
  }

  private async preToolUse(
    session: Session,
    input: {
      tool_name?: string;
      tool_input?: unknown;
      tool_use_id?: string;
      mcp_server?: { name: string; source: string };
    },
  ): Promise<SdkHookOutput> {
    const toolName = input.tool_name ?? 'unknown';
    try {
      if (toolName === 'AskUserQuestion') return {}; // a question, not a permission: canUseTool handles it
      // The tool's server and its provenance go to the gate: only the host's own in-process
      // `galactic` server (`source: 'sdk'`) is the server's tools (a repository's `.mcp.json`
      // server of the same name is not).
      const verdict = session.gate.check({
        toolName,
        input: input.tool_input,
        ...serverOf(input.mcp_server),
      });
      if (input.tool_use_id !== undefined) session.verdicts.set(input.tool_use_id, verdict);
      switch (verdict.decision) {
        case 'allow':
          this.toolCall(session, toolName, input.tool_use_id, input.tool_input);
          return hookDecision('allow');
        case 'deny':
          this.emit(session, {
            type: 'agent.output',
            agentId: session.agentId,
            kind: 'text',
            text: `permission denied for ${toolName}: ${verdict.reason}`,
          });
          return hookDecision('deny', verdict.reason);
        case 'ask':
          return hookDecision('ask', verdict.reasons.join('; ') || 'policy: ask the user');
      }
    } catch (error) {
      // Fail closed: a hook that throws would most likely let the CLI run the tool.
      this.onError(error, `PreToolUse ${session.agentId}`);
      return hookDecision('deny', `permission check failed: ${(error as Error).message}`);
    }
  }

  private async canUseTool(
    session: Session,
    toolName: string,
    input: Record<string, unknown>,
    options: SdkCanUseToolOptions,
  ): Promise<SdkPermissionResult> {
    try {
      if (toolName === 'AskUserQuestion')
        return await this.askUserQuestion(session, input, options);
      const call: ToolCall = { toolName, input, ...serverOf(options.mcpServer) };
      const id = options.toolUseID;
      // The hook already asked the gate about this call: reuse its verdict (one check, one
      // reservation against the tool-call cap). Without one, ask the gate here.
      const remembered = id !== undefined ? session.verdicts.get(id) : undefined;
      if (id !== undefined) session.verdicts.delete(id);
      const verdict = remembered ?? session.gate.check(call);
      if (verdict.decision === 'allow') {
        this.toolCall(session, toolName, id, input);
        return { behavior: 'allow', updatedInput: input };
      }
      if (verdict.decision === 'deny') {
        return { behavior: 'deny', message: verdict.reason };
      }
      const why =
        verdict.reasons.length > 0 ? verdict.reasons.join('; ') : (options.decisionReason ?? '');
      const text = options.title ?? `May ${toolName} run?${why ? ` (${why})` : ''}`;
      const answer = await this.ask(
        session,
        'permission',
        {
          text,
          toolCall: call,
          ...(verdict.action ? { permissionAction: verdict.action } : {}),
        },
        options.signal,
      );
      if (answer === undefined) return interruptedBeforeAnswer();
      // Dismissed (P9-14): a refusal, never an allow.
      if (isDismissed(answer))
        return { behavior: 'deny', message: dismissedPermission(answer.dismissed) };
      if (/^(allow|yes|y|ok|approve|approved)$/i.test(answer.trim())) {
        this.toolCall(session, toolName, id, input);
        return { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: `The user refused: ${answer}` };
    } catch (error) {
      this.onError(error, `canUseTool ${session.agentId}`);
      return { behavior: 'deny', message: `permission check failed: ${(error as Error).message}` };
    }
  }

  /**
   * The questions of an `AskUserQuestion` call, answered back keyed by the question text as the
   * tool expects. One question is asked alone (a `multiSelect` one says how to answer); several
   * are one question set (P8-20): all opened at once, the call held until every row is resolved.
   * Any row dismissed refuses the whole call; an interrupt withdraws them all. The call waits for
   * every row even after a dismissal: that relies on `dismissQuestionSet` dismissing every open row
   * of the set (no path dismisses a single set row), so the Steward is never held by the rest.
   */
  private async askUserQuestion(
    session: Session,
    input: Record<string, unknown>,
    options: SdkCanUseToolOptions,
  ): Promise<SdkPermissionResult> {
    const questions =
      (input['questions'] as
        { question: string; options?: { label: string }[]; multiSelect?: boolean }[] | undefined) ??
      [];
    if (questions.length === 0) {
      const answer = await this.ask(
        session,
        'clarification',
        { text: 'The agent has a question.' },
        options.signal,
      );
      if (answer === undefined) return interruptedBeforeAnswer();
      if (isDismissed(answer)) return dismissedQuestion(answer);
      return { behavior: 'allow', updatedInput: { ...input, answers: {} } };
    }
    const labelsOf = (q: (typeof questions)[number]) => q.options?.map((o) => o.label) ?? [];
    const answers: Record<string, string> = {};
    if (fitsQuestionSet(questions.map((q) => labelsOf(q).length))) {
      const id = `qs-${randomUUID()}`;
      const total = questions.length;
      const replies = await Promise.all(
        questions.map((q, index) => {
          const labels = labelsOf(q);
          return this.ask(
            session,
            'clarification',
            {
              text: q.question,
              ...(labels.length ? { options: labels } : {}),
              ...(q.multiSelect ? { multiSelect: true } : {}),
              set: { id, index, total, title: AGENT_SET_TITLE },
            },
            options.signal,
          );
        }),
      );
      if (replies.some((r) => r === undefined)) return interruptedBeforeAnswer();
      // Dismissed (P9-14): the whole tool call is refused with what the user did.
      const dismissed = replies.find(isDismissed);
      if (dismissed) return dismissedQuestion(dismissed);
      questions.forEach((q, i) => (answers[q.question] = replies[i] as string));
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    // One question (or a call too large for a set): asked in turn, as before.
    for (const q of questions) {
      const labels = labelsOf(q);
      const text = q.multiSelect
        ? `${q.question} (one or more: separate the labels with commas)`
        : q.question;
      const answer = await this.ask(
        session,
        'clarification',
        { text, ...(labels.length ? { options: labels } : {}) },
        options.signal,
      );
      if (answer === undefined) return interruptedBeforeAnswer();
      if (isDismissed(answer)) return dismissedQuestion(answer);
      answers[q.question] = answer;
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  private ask(
    session: Session,
    kind: 'clarification' | 'permission',
    question: Extract<AgentEvent, { type: 'agent.needs_input' }>['question'],
    signal: AbortSignal,
  ): Promise<string | Dismissed | undefined> {
    if (signal.aborted || session.terminal) return Promise.resolve(undefined);
    const id = `q-${randomUUID()}`;
    return new Promise((resolve) => {
      const done = (answer: string | Dismissed | undefined) => {
        session.pending.delete(id);
        this.byQuestion.delete(id);
        signal.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      const onAbort = () => done(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
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

  // --- slash commands (P8-13) ----------------------------------------------------

  /**
   * The session's slash commands: the cached list, else `supportedCommands()` (once at a time,
   * bounded by `commandsTimeoutMs`). `[]` for an ended or unknown session, an SDK without the
   * call, a call that fails (reported, not cached: the next call asks again) or a slow one.
   */
  async commands(sessionId: string): Promise<SlashCommand[]> {
    const session = this.sessions.get(sessionId);
    if (!session || session.terminal) return [];
    if (session.commands) return session.commands;
    return withTimeout(this.fetchCommands(session), this.opts.commandsTimeoutMs ?? 5_000, []);
  }

  private fetchCommands(session: Session): Promise<SlashCommand[]> {
    const query = session.query;
    if (session.commands) return Promise.resolve(session.commands);
    if (!query?.supportedCommands || session.terminal) return Promise.resolve([]);
    session.commandsFetch ??= query
      .supportedCommands()
      .then(
        (raw) => {
          // A `commands_changed` push that arrived meanwhile is newer: keep it.
          session.commands ??= normalizeSlashCommands(Array.isArray(raw) ? raw : []);
          return session.commands;
        },
        (error: unknown) => {
          if (!session.terminal) this.onError(error, `supportedCommands ${session.agentId}`);
          return [] as SlashCommand[];
        },
      )
      .finally(() => {
        session.commandsFetch = undefined;
      });
    return session.commandsFetch;
  }

  // --- control -----------------------------------------------------------------

  async send(sessionId: string, message: string, opts: SendOptions = {}): Promise<void> {
    const session = this.session(sessionId);
    if (session.terminal) throw new Error(`session ${sessionId} has ${session.terminal}`);
    if (session.turnOpen) {
      if (!opts.interrupt)
        throw new Error(
          `session ${sessionId} is mid-turn: the runtime delivers messages only when idle`,
        );
      await this.interrupt(sessionId);
      await session.turnEnd();
    }
    session.turnOpen = true;
    session.inbox.push(userMessage(sessionId, message));
  }

  async answer(questionId: Id, answer: string): Promise<void> {
    const session = this.byQuestion.get(questionId);
    const pending = session?.pending.get(questionId);
    if (!pending) throw new Error(`no pending question ${questionId}`);
    pending.resolve(answer);
  }

  /**
   * The user dismissed the question (P9-14): an `AskUserQuestion` call is refused with a result
   * that says so (the agent carries on or asks again), a permission request is denied.
   */
  async dismiss(questionId: Id, reason: string): Promise<void> {
    const session = this.byQuestion.get(questionId);
    const pending = session?.pending.get(questionId);
    if (!pending) throw new Error(`no pending question ${questionId}`);
    pending.resolve({ dismissed: reason });
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || !session.turnOpen || session.terminal) return;
    // A frozen CLI cannot read the control request: thaw it first.
    if (session.paused) this.thaw(session);
    session.interrupting = true;
    session.settlePending();
    try {
      await session.query?.interrupt();
    } catch (error) {
      this.onError(error, `interrupt ${sessionId}`);
    }
  }

  async pause(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || session.paused) return;
    if (!session.process || session.process.state === 'exited') {
      throw new Error(`cannot pause session ${sessionId}: no claude process to freeze`);
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
      if (session.process) {
        // The supervisor runs the sequence: our interrupt hook (turn end, then the input is
        // closed so the CLI can exit on its own) → SIGTERM → SIGKILL.
        await this.opts.supervisor.stop(session.agentId, {
          graceMs: opts.graceMs ?? this.opts.graceMs ?? 10_000,
          by: SYSTEM,
        });
        session.inbox.close();
      } else {
        // No child yet (spawn still starting, or a scripted SDK): close the input and abort.
        await this.interrupt(sessionId).catch(() => {});
        session.inbox.close();
        session.abort.abort();
      }
      await session.loopDone.catch(() => {});
      if (!session.terminal)
        this.terminal(session, { type: 'agent.stopped', agentId: session.agentId, by: SYSTEM });
    })();
    return session.stopDone;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
    this.events.close();
  }

  // --- helpers -----------------------------------------------------------------

  private session(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (s) return s;
    const ended = this.ended.get(sessionId);
    if (ended) throw new Error(`session ${sessionId} has ${ended}`);
    throw new Error(`unknown claude-sdk session ${sessionId}`);
  }

  /** The session, or `undefined` for one that already ended (control calls are no-ops then). */
  private live(sessionId: string): Session | undefined {
    if (!this.sessions.has(sessionId) && this.ended.has(sessionId)) return undefined;
    return this.session(sessionId);
  }

  /** Whether this session is still the agent's current one (a resume replaces it). */
  private current(session: Session): boolean {
    return this.byAgent.get(session.agentId) === session;
  }

  private emit(session: Session, event: AgentEvent): void {
    // One terminal event per session and nothing after it; a replaced session is silent.
    if (session.terminal || !this.current(session)) return;
    if (event.type === 'agent.output' && event.kind === 'text') session.turnSpoke = true;
    this.events.push(event);
  }

  private terminal(
    session: Session,
    event: Extract<AgentEvent, { type: 'agent.finished' | 'agent.failed' | 'agent.stopped' }>,
  ): void {
    if (session.terminal) return;
    // A session replaced by a same-agent resume must not end the new one.
    if (this.current(session)) this.events.push(event);
    session.terminal =
      event.type === 'agent.finished'
        ? 'finished'
        : event.type === 'agent.failed'
          ? 'failed'
          : 'stopped';
    session.settlePending();
    session.closeTurn();
    session.inbox.close();
    this.forget(session);
  }

  /** Frees an ended session; only a bounded "how it ended" note stays for error messages. */
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

/** The CLI's `mcp_server` provenance as the gate's `ToolCall.mcpServer` (absent when not sent). */
function serverOf(server: { name?: unknown; source?: unknown } | undefined): {
  mcpServer?: { name: string; source: string };
} {
  return server && typeof server.name === 'string' && typeof server.source === 'string'
    ? { mcpServer: { name: server.name, source: server.source } }
    : {};
}

function hookDecision(decision: 'allow' | 'deny' | 'ask', reason?: string): SdkHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason !== undefined ? { permissionDecisionReason: reason } : {}),
    },
  };
}

/** An `AskUserQuestion` the user dismissed (P9-14): refused, with what the agent should do. */
function dismissedQuestion(d: Dismissed): SdkPermissionResult {
  return { behavior: 'deny', message: dismissedClarification(d.dismissed) };
}

function interruptedBeforeAnswer(): SdkPermissionResult {
  return {
    behavior: 'deny',
    message: 'The turn was interrupted before the user answered.',
    interrupt: true,
  };
}

/** A readable progress line for a subscription rate-limit event; none while all is well. */
function rateLimitSummary(m: SdkRateLimitEvent): string | undefined {
  const info = m.rate_limit_info;
  if (!info || info.status === 'allowed') return undefined;
  const which = info.rateLimitType ? `${info.rateLimitType.replace(/_/g, ' ')} ` : '';
  const until =
    info.resetsAt !== undefined
      ? ` until ${new Date(info.resetsAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}`
      : '';
  if (info.status === 'rejected') return `waiting on the ${which}rate limit${until}`;
  const used =
    info.utilization !== undefined ? ` (${Math.round(info.utilization * 100)}% used)` : '';
  return `close to the ${which}rate limit${used}`;
}

/** `p`'s value, or `fallback` when it has not settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((r) => {
    timer = setTimeout(() => r(fallback), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Resolves `true` when `p` settles within `ms`, `false` otherwise. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  return Promise.race([p.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

function userMessage(sessionId: string, text: string): SdkUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/**
 * The protocol's `Cost` has one input count, so prompt-cache reads and writes are folded into
 * `inputTokens` (they are input the model processed; most of a long session's input is cached).
 */
function costOf(m: { total_cost_usd?: number; usage?: SdkUsage }): Cost | undefined {
  if (m.total_cost_usd === undefined && !m.usage) return undefined;
  const u = m.usage;
  const input =
    u &&
    (u.input_tokens !== undefined ||
      u.cache_read_input_tokens !== undefined ||
      u.cache_creation_input_tokens !== undefined)
      ? (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0)
      : undefined;
  return {
    ...(m.total_cost_usd !== undefined ? { usd: m.total_cost_usd } : {}),
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(u?.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
  };
}

const LOCAL_COMMAND = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g;
const LOCAL_CAVEAT = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g;

/**
 * The text of a local command's output in a user message (P8-13 review S4): what the CLI wrapped
 * in `<local-command-stdout>` / `<local-command-stderr>`, tags removed, or `''` when there is
 * none. The shape is what the SDK's bundled CLI (0.3.285) names; a real run must confirm where
 * `/context` and `/cost` put it (a string content or a text block).
 */
function localCommandOutput(content: unknown): string {
  const text = toolResultText(content);
  if (!text.includes('<local-command-std')) return '';
  return [...text.matchAll(LOCAL_COMMAND)]
    .map((match) => match[2]!.trim())
    .filter(Boolean)
    .join('\n');
}

/** `text` without the CLI's local-command wrappers (a result may carry them), trimmed. */
function stripLocalCommandTags(text: string): string {
  return text
    .replace(LOCAL_CAVEAT, '')
    .replace(LOCAL_COMMAND, (_m, _s, inner: string) => inner)
    .trim();
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => (c.type === 'text' && c.text ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
