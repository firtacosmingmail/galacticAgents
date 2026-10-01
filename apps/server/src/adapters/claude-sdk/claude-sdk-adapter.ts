import { randomUUID } from 'node:crypto';
import type {
  Actor,
  AgentAdapter,
  AgentEvent,
  Cost,
  Id,
  PermissionGate,
  SendOptions,
  SpawnHandle,
  SpawnOptions,
  StopOptions,
  ToolCall,
} from '@galactic/protocol';
import { EventQueue } from '../../lib/event-queue.js';
import type {
  ManagedProcess,
  ProcessOutcome,
  ProcessSupervisor,
} from '../../runtime/supervisor.js';
import { jsonSchemaToZodShape } from './json-schema-to-zod.js';
import {
  loadSdk,
  type SdkCanUseToolOptions,
  type SdkContentBlock,
  type SdkMessage,
  type SdkPermissionResult,
  type SdkQuery,
  type SdkQueryOptions,
  type SdkSurface,
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
 * Pause is `SIGSTOP` on the process group and resume `SIGCONT`: the turn in flight freezes in
 * place (tool, shell children and all) instead of being cancelled, which is what "pause" means
 * on the panel; `stop()` sends `SIGCONT` first so a paused agent can still be stopped gracefully.
 */

export interface ClaudeSdkAdapterOptions {
  supervisor: ProcessSupervisor;
  /** Injected in tests (`FakeSdk`); the real SDK is loaded lazily otherwise. */
  sdk?: SdkSurface | (() => Promise<SdkSurface>);
  /** Model for every spawn; the CLI's default when absent. */
  model?: string;
  /** Extra environment for the CLI, e.g. `ANTHROPIC_API_KEY` for `bare` spawns. */
  env?: Record<string, string | undefined>;
  /** Variables copied from the server's environment on top of the supervisor's allow-list. */
  passEnv?: string[];
  /** How long `stop()` waits for the turn to end after `interrupt()`. */
  graceMs?: number;
  /** Longest tool-result excerpt kept in the transcript. */
  maxToolResultChars?: number;
  onError?: (error: unknown, context: string) => void;
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
  resolve: (answer: string | undefined) => void;
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
  pending: PendingQuestion | undefined;
  lastCost: Cost | undefined;
  lastResult: string | undefined;
  /** Resolves when the message loop has exited. */
  loopDone: Promise<void> = Promise.resolve();
  stopDone: Promise<void> | undefined;
  /** Resolves with the next turn end (result message) after `turnEnd()` was armed. */
  private turnWaiters: (() => void)[] = [];

  constructor(
    readonly sessionId: string,
    readonly agentId: Id,
    readonly gate: PermissionGate,
  ) {}

  turnEnd(): Promise<void> {
    if (!this.turnOpen) return Promise.resolve();
    return new Promise((r) => this.turnWaiters.push(r));
  }

  closeTurn(): void {
    this.turnOpen = false;
    for (const w of this.turnWaiters.splice(0)) w();
  }
}

const SYSTEM: Actor = { type: 'system' };

export class ClaudeSdkAdapter implements AgentAdapter {
  readonly runtime = 'claude-sdk' as const;
  readonly events = new EventQueue<AgentEvent>();
  private readonly sessions = new Map<string, Session>();
  private readonly byAgent = new Map<Id, Session>();
  private readonly byQuestion = new Map<Id, Session>();
  private sdkPromise: Promise<SdkSurface> | undefined;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly maxToolResultChars: number;
  private disposed = false;

  constructor(private readonly opts: ClaudeSdkAdapterOptions) {
    this.onError = opts.onError ?? (() => {});
    this.maxToolResultChars = opts.maxToolResultChars ?? 2_000;
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
    const session = new Session(sessionId, opts.agentId, opts.gate);
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
      settingSources: isBrain ? [] : ['user', 'project', 'local'],
      ...(opts.systemPrompt
        ? {
            systemPrompt: isBrain
              ? opts.systemPrompt
              : { type: 'preset', preset: 'claude_code', append: opts.systemPrompt },
          }
        : {}),
      ...(opts.bare ? { extraArgs: { bare: null } } : {}),
      env: this.env(),
      stderr: (data) => this.onError(new Error(data.trim()), `stderr ${opts.agentId}`),
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
      interrupt: async (proc) => {
        if (session.paused) proc.signal('SIGCONT');
        if (!session.turnOpen) {
          proc.turnEnded();
          return;
        }
        session.interrupting = true;
        await session.query?.interrupt().catch(() => {});
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
        this.emit({
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
    try {
      for await (const message of query) this.onMessage(session, message as SdkMessage);
      // The stream ended: the input was closed (stop) or the CLI went away; the outcome decides.
    } catch (error) {
      // After `interrupt()` in single-prompt mode the SDK throws on the error result; with
      // streaming input the loop normally ends only when the child exits. Either way the
      // process outcome (or the stop in progress) carries the terminal event; an error here
      // with a live process is a genuine failure.
      const message = (error as Error).message;
      if (!session.stopping && !session.interrupting && session.process?.state === 'running') {
        this.onError(error, `query ${session.agentId}`);
        session.process.expectExit();
        this.terminal(session, {
          type: 'agent.failed',
          agentId: session.agentId,
          error: message,
          reason: 'runtime',
        });
      }
    } finally {
      session.closeTurn();
      if (!session.process) {
        // No child ever reported (the SDK ran without our spawner): end the session here.
        this.terminal(
          session,
          session.stopping
            ? { type: 'agent.stopped', agentId: session.agentId, by: SYSTEM }
            : {
                type: 'agent.finished',
                agentId: session.agentId,
                ...(session.lastResult !== undefined ? { result: session.lastResult } : {}),
                ...(session.lastCost ? { cost: session.lastCost } : {}),
              },
        );
      }
    }
  }

  private onMessage(session: Session, message: SdkMessage): void {
    const agentId = session.agentId;
    switch (message.type) {
      case 'assistant': {
        const m = message as Extract<SdkMessage, { type: 'assistant' }>;
        for (const block of m.message.content)
          this.onAssistantBlock(session, block, m.parent_tool_use_id);
        return;
      }
      case 'user': {
        const m = message as Extract<SdkMessage, { type: 'user' }>;
        if (m.isSynthetic || typeof m.message.content === 'string') return;
        for (const block of m.message.content) {
          if (block.type !== 'tool_result') continue;
          const text = toolResultText(block.content);
          if (text) {
            this.emit({
              type: 'agent.output',
              agentId,
              kind: 'tool',
              text: `${block.is_error ? 'tool error' : 'tool result'}: ${text.slice(0, this.maxToolResultChars)}`,
            });
          }
        }
        return;
      }
      case 'result': {
        const m = message as Extract<SdkMessage, { type: 'result' }>;
        const cost = costOf(m);
        if (cost) session.lastCost = cost;
        if (m.subtype === 'success') {
          if (m.result !== undefined) session.lastResult = m.result;
        } else if (!session.interrupting && !session.stopping) {
          this.emit({
            type: 'agent.output',
            agentId,
            kind: 'text',
            text: `turn ended with ${m.subtype}${m.errors?.length ? `: ${m.errors.join('; ')}` : ''}`,
          });
        }
        session.interrupting = false;
        session.closeTurn();
        session.process?.turnEnded();
        if (!session.stopping && !session.terminal) {
          this.emit({ type: 'agent.idle', agentId, ...(cost ? { cost } : {}) });
        }
        return;
      }
      default:
        return; // init, status, rate limits, hooks, compaction …: not transcript
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
          this.emit({ type: 'agent.output', agentId, kind: 'text', text: prefix + block.text });
        return;
      case 'thinking':
        if (block.thinking)
          this.emit({
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

  private async preToolUse(
    session: Session,
    input: { tool_name?: string; tool_input?: unknown; tool_use_id?: string },
  ) {
    const toolName = input.tool_name ?? 'unknown';
    if (toolName === 'AskUserQuestion') return {}; // a question, not a permission: canUseTool handles it
    const call: ToolCall = { toolName, input: input.tool_input };
    const verdict = session.gate.check(call);
    switch (verdict.decision) {
      case 'allow':
        this.emit({
          type: 'agent.tool_call',
          agentId: session.agentId,
          toolName,
          ...(input.tool_use_id ? { toolUseId: input.tool_use_id } : {}),
          input: input.tool_input,
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
          },
        };
      case 'deny':
        this.emit({
          type: 'agent.output',
          agentId: session.agentId,
          kind: 'text',
          text: `permission denied for ${toolName}: ${verdict.reason}`,
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: verdict.reason,
          },
        };
      case 'ask':
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'ask' as const,
            permissionDecisionReason: verdict.reasons.join('; ') || 'policy: ask the user',
          },
        };
    }
  }

  private async canUseTool(
    session: Session,
    toolName: string,
    input: Record<string, unknown>,
    options: SdkCanUseToolOptions,
  ): Promise<SdkPermissionResult> {
    if (toolName === 'AskUserQuestion') return this.askUserQuestion(session, input, options);
    const call: ToolCall = { toolName, input };
    const verdict = session.gate.check(call);
    if (verdict.decision === 'allow') {
      this.emit({
        type: 'agent.tool_call',
        agentId: session.agentId,
        toolName,
        ...(options.toolUseID ? { toolUseId: options.toolUseID } : {}),
        input,
      });
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
    if (answer === undefined)
      return {
        behavior: 'deny',
        message: 'The turn was interrupted before the user answered.',
        interrupt: true,
      };
    if (/^(allow|yes|y|ok|approve|approved)$/i.test(answer.trim())) {
      this.emit({
        type: 'agent.tool_call',
        agentId: session.agentId,
        toolName,
        ...(options.toolUseID ? { toolUseId: options.toolUseID } : {}),
        input,
      });
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: `The user refused: ${answer}` };
  }

  private async askUserQuestion(
    session: Session,
    input: Record<string, unknown>,
    options: SdkCanUseToolOptions,
  ): Promise<SdkPermissionResult> {
    const questions =
      (input['questions'] as { question: string; options?: { label: string }[] }[] | undefined) ??
      [];
    const first = questions[0];
    const text = first?.question ?? 'The agent has a question.';
    const labels = first?.options?.map((o) => o.label) ?? [];
    const answer = await this.ask(
      session,
      'clarification',
      { text, ...(labels.length ? { options: labels } : {}) },
      options.signal,
    );
    if (answer === undefined)
      return {
        behavior: 'deny',
        message: 'The turn was interrupted before the user answered.',
        interrupt: true,
      };
    const answers = Object.fromEntries(
      questions.map((q, i) => [q.question, i === 0 ? answer : answer]),
    );
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  private ask(
    session: Session,
    kind: 'clarification' | 'permission',
    question: Extract<AgentEvent, { type: 'agent.needs_input' }>['question'],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const id = `q-${randomUUID()}`;
    return new Promise((resolve) => {
      const done = (answer: string | undefined) => {
        if (session.pending?.id === id) session.pending = undefined;
        this.byQuestion.delete(id);
        signal.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      const onAbort = () => done(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      session.pending = { id, resolve: done };
      this.byQuestion.set(id, session);
      this.emit({
        type: 'agent.needs_input',
        agentId: session.agentId,
        questionId: id,
        kind,
        question,
      });
    });
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
    if (!session || session.pending?.id !== questionId)
      throw new Error(`no pending question ${questionId}`);
    session.pending.resolve(answer);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    if (!session.turnOpen || session.terminal) return;
    session.interrupting = true;
    session.pending?.resolve(undefined);
    try {
      await session.query?.interrupt();
    } catch (error) {
      this.onError(error, `interrupt ${sessionId}`);
    }
  }

  async pause(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    if (session.terminal || session.paused) return;
    session.paused = true;
    session.process?.signal('SIGSTOP');
    this.emit({ type: 'agent.paused', agentId: session.agentId, by: SYSTEM });
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    if (session.terminal || !session.paused) return;
    session.paused = false;
    session.process?.signal('SIGCONT');
    this.emit({ type: 'agent.resumed', agentId: session.agentId, by: SYSTEM });
  }

  async stop(sessionId: string, opts: StopOptions = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.terminal) return;
    if (session.stopDone) return session.stopDone;
    session.stopping = true;
    session.stopDone = (async () => {
      session.pending?.resolve(undefined);
      if (session.process) {
        // The supervisor runs the sequence: our interrupt hook → turn end → SIGTERM → SIGKILL.
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
    if (!s) throw new Error(`unknown claude-sdk session ${sessionId}`);
    return s;
  }

  private emit(event: AgentEvent): void {
    const session = this.byAgent.get(event.agentId);
    if (session?.terminal) return; // one terminal event per session, nothing after it
    this.events.push(event);
  }

  private terminal(
    session: Session,
    event: Extract<AgentEvent, { type: 'agent.finished' | 'agent.failed' | 'agent.stopped' }>,
  ): void {
    if (session.terminal) return;
    this.events.push(event);
    session.terminal =
      event.type === 'agent.finished'
        ? 'finished'
        : event.type === 'agent.failed'
          ? 'failed'
          : 'stopped';
    session.pending?.resolve(undefined);
    session.closeTurn();
    session.inbox.close();
    this.forget(session);
  }

  private forget(session: Session): void {
    this.byQuestion.forEach((s, id) => {
      if (s === session) this.byQuestion.delete(id);
    });
    // The session object stays reachable for `stop()`/`send()` error messages until disposed.
  }
}

function userMessage(sessionId: string, text: string): SdkUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

function costOf(m: {
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}): Cost | undefined {
  if (m.total_cost_usd === undefined && !m.usage) return undefined;
  return {
    ...(m.total_cost_usd !== undefined ? { usd: m.total_cost_usd } : {}),
    ...(m.usage?.input_tokens !== undefined ? { inputTokens: m.usage.input_tokens } : {}),
    ...(m.usage?.output_tokens !== undefined ? { outputTokens: m.usage.output_tokens } : {}),
  };
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
