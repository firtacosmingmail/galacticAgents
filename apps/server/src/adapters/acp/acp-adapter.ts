import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import * as acp from '@agentclientprotocol/sdk';
import type {
  ClientCapabilities,
  ClientConnection,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type {
  Actor,
  AgentAdapter,
  AgentEvent,
  Id,
  PermissionGate,
  RuntimePreflight,
  SendOptions,
  SpawnHandle,
  SpawnOptions,
  StopOptions,
} from '@galactic/protocol';
import { EventQueue } from '../../lib/event-queue.js';
import type {
  ManagedProcess,
  ProcessOutcome,
  ProcessSupervisor,
} from '../../runtime/supervisor.js';
import { SERVER_VERSION } from '../../version.js';
import {
  BOOKKEEPING_KINDS,
  chooseOption,
  contentText,
  CostMeter,
  describeTool,
  formFields,
  gateCall,
  mergeTool,
  planProgress,
  toolResultText,
  type ToolState,
} from './mapping.js';
import { acpPreflight } from './preflight.js';

/**
 * The `acp` adapter (P8-07; TECHNOLOGY §3.2): GalacticAgents as an Agent Client Protocol
 * *client*, like an editor, driving any ACP agent — `claude-agent-acp`, `codex-acp`,
 * `gemini --acp` — over stdio JSON-RPC with the official TypeScript SDK
 * (`@agentclientprotocol/sdk`).
 *
 * **One agent process per session.** Every spawn starts the configured agent command through the
 * process supervisor (`adopt()`: own process group, PID table, the `GALACTIC_AGENT_ID` marker,
 * graceful stop), then `initialize` → `session/new` (or `session/load` to resume) on its stdio,
 * then the first `session/prompt`. A session's fate is its process's: the supervisor's outcome is
 * the one terminal event (`exited` → `agent.finished`, `crashed` → `agent.failed(crash)`,
 * `stopped` → `agent.stopped`).
 *
 * **The client capability set** (`CLIENT_CAPABILITIES`): `elicitation.form` only. Form elicitation
 * is how an ACP agent asks the user a question, and only a client that advertises it gets them.
 * `fs/*` and `terminal/*` are not advertised: the agent reads, writes and runs commands with its
 * own tools in its own cwd (the Steward's worktree), as it would alone, and reports them as tool
 * calls the gate decides; a headless server serving those methods would have to reimplement an
 * editor's buffers and terminals faithfully. Neither `elicitation.url`, `plan`, `session.*` nor
 * `auth.terminal` is advertised either (nothing here could show a URL or run a login).
 *
 * **Turns.** `send()` is one `session/prompt`; its response is the turn's end (`agent.idle`, with
 * the session's running cost). `session/update` streams become per-block `agent.output` (message
 * chunks are joined until the block ends: a thought, a tool call, the turn's end), plans become
 * `agent.progress`, tool calls `agent.tool_call` once the gate let them run. `interrupt()` is
 * `session/cancel`: every request the agent is waiting on is answered "cancelled" first, as the
 * protocol requires, and the turn ends with `stopReason: cancelled` → `agent.idle`.
 *
 * **Permissions.** `session/request_permission` is tool authorization, never a question for a
 * brain: the call is translated to the gate's vocabulary (`gateCall`) and checked once (which
 * also reserves it against the tool-call cap): `allow` answers with the `allow_once` option and
 * emits `agent.tool_call`, `deny` answers `reject_once` with the reason in the transcript, `ask`
 * opens `agent.needs_input(kind: permission)` with the call attached — the runtime decides it
 * again with the same gate (P2-04) and only an `ask` reaches the user. A tool call the agent runs
 * without asking (its own permission mode allowed it) is still checked when it starts: `allow`
 * reports it, `ask` reports it with a transcript warning, `deny` cancels the turn — the call is
 * not counted, and a cap refusal trips the cap as usual.
 *
 * **Questions.** `elicitation/create` in form mode → one `agent.needs_input(kind: clarification)`
 * per field (`formFields`), answered back as `accept` with the typed values; an interrupted or
 * stopped question is answered `cancel`, a URL elicitation `decline`.
 *
 * **Resume.** `sessionRef` is `acp:<the agent's session id>`. `resumeSession` starts a new process
 * and calls `session/load` when the agent advertises `loadSession`; the conversation the agent
 * replays while loading is not transcript. An agent without `loadSession` cannot resume: the
 * resume fails and the agent stays `interrupted` with its restart action (the PTY rule).
 *
 * **Pause** is `SIGSTOP`/`SIGCONT` on the process group (no ACP primitive), as in the SDK adapter.
 *
 * **Cost**, when the agent reports it: dollars from `usage_update.cost` (the session's cumulative
 * total, USD only), tokens from each prompt response's `usage` (added up). An agent that reports
 * none leaves `cost` off every event: budgets show "cost not reported" (P8-01).
 *
 * Brains do not run on ACP: their server-side tools would need an MCP bridge, so a spawn with
 * `tools` is refused, and `bare` (a Claude-only notion) too. A Steward's `systemPrompt` goes
 * before its first prompt (ACP has no system prompt).
 */

/** What the adapter advertises in `initialize` (documented in `adapters/README.md`). */
export const CLIENT_CAPABILITIES: ClientCapabilities = {
  elicitation: { form: {} },
};

/** The ACP agent the adapter starts for every session. */
export interface AcpAgentCommand {
  command: string;
  args?: string[];
  /** Extra environment for the agent (credentials it needs that the allow-list does not carry). */
  env?: Record<string, string | undefined>;
  /** Variables copied from the server's environment on top of the supervisor's allow-list. */
  passEnv?: string[];
}

export interface AcpAdapterOptions {
  supervisor: ProcessSupervisor;
  agent: AcpAgentCommand;
  /** How long `stop()` waits for the turn to end after `session/cancel` (default 10 s). */
  graceMs?: number;
  /** How long `initialize` + `session/new|load` may take before the spawn fails (default 60 s). */
  startTimeoutMs?: number;
  /** Longest tool-result excerpt kept in the transcript. */
  maxToolResultChars?: number;
  onError?: (error: unknown, context: string) => void;
  /** The runtime check (P25-01); default `acpPreflight(agent)`. */
  preflight?: () => Promise<RuntimePreflight>;
}

/** Credentials the known ACP agents read from the environment (Claude, OpenAI/Codex, Gemini). */
export const ACP_PASS_ENV: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_REGION',
  'AWS_PROFILE',
];

const SYSTEM: Actor = { type: 'system' };
const ENDED_MEMORY = 256;
const SESSION_REF = /^acp:(\S{1,512})$/;
const ALLOW = /^(allow|yes|y|ok|approve|approved)$/i;

interface PendingQuestion {
  id: Id;
  resolve: (answer: string | undefined) => void;
}

type QuestionBody = Extract<AgentEvent, { type: 'agent.needs_input' }>['question'];

class Session {
  acpSessionId: string | undefined;
  process: ManagedProcess | undefined;
  conn: ClientConnection | undefined;
  /** Startup (`initialize` … `session/new|load`): failures throw from `spawn()`, no events. */
  starting = true;
  /** `session/load` in flight: the replayed conversation is not transcript. */
  loading = false;
  turnOpen = false;
  /** `session/cancel` was sent for the turn in flight: its `cancelled` end is not news. */
  interrupting = false;
  paused = false;
  stopping = false;
  terminal: 'finished' | 'failed' | 'stopped' | undefined;
  readonly pending = new Map<Id, PendingQuestion>();
  readonly tools = new Map<string, ToolState>();
  /** Tool calls reported as `agent.tool_call` (once each). */
  readonly reported = new Set<string>();
  /** Tool calls the gate already decided (through a permission request, or when they started). */
  readonly decided = new Set<string>();
  readonly meter = new CostMeter();
  lastResult: string | undefined;
  /** The message block being streamed: chunks joined until the block ends. */
  block: { kind: 'text' | 'thinking'; text: string } | undefined;
  /** The last text block of the turn, kept as the `result` of an `agent.finished`. */
  lastText = '';
  stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
  stopDone: Promise<void> | undefined;
  private turnWaiters: (() => void)[] = [];

  constructor(
    readonly sessionId: string,
    readonly agentId: Id,
    readonly gate: PermissionGate,
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
    this.tools.clear();
    this.reported.clear();
    this.decided.clear();
    for (const w of this.turnWaiters.splice(0)) w();
  }
}

export class AcpAdapter implements AgentAdapter {
  readonly runtime = 'acp' as const;
  readonly events = new EventQueue<AgentEvent>();
  private readonly sessions = new Map<string, Session>();
  private readonly byAgent = new Map<Id, Session>();
  private readonly byQuestion = new Map<Id, Session>();
  private readonly ended = new Map<string, NonNullable<Session['terminal']>>();
  private readonly onError: (error: unknown, context: string) => void;
  private readonly maxToolResultChars: number;
  private disposed = false;

  constructor(private readonly opts: AcpAdapterOptions) {
    this.onError = opts.onError ?? (() => {});
    this.maxToolResultChars = opts.maxToolResultChars ?? 2_000;
  }

  preflight(): Promise<RuntimePreflight> {
    return (this.opts.preflight ?? (() => acpPreflight(this.opts.agent)))();
  }

  spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    return this.open(opts, undefined);
  }

  async resumeSession(sessionRef: string, opts: SpawnOptions): Promise<SpawnHandle> {
    const m = SESSION_REF.exec(sessionRef);
    if (!m) throw new Error(`not an acp session ref: ${sessionRef}`);
    return this.open(opts, m[1]!);
  }

  // --- startup -----------------------------------------------------------------

  private async open(opts: SpawnOptions, resume: string | undefined): Promise<SpawnHandle> {
    if (this.disposed) throw new Error('adapter disposed');
    if (opts.bare) throw new Error('bare mode is a claude-sdk option; the acp runtime has none');
    if (opts.tools && opts.tools.length > 0) {
      throw new Error(
        'brains need the claude-sdk runtime: the acp adapter cannot serve their tools',
      );
    }
    if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
      throw new Error(`the working directory does not exist: ${opts.cwd}`);
    }
    const session = new Session(randomUUID(), opts.agentId, opts.gate);
    this.sessions.set(session.sessionId, session);
    this.byAgent.set(opts.agentId, session);
    try {
      const conn = this.connect(session, opts.cwd);
      const init = await this.during(
        session,
        conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: 'galactic-agents', title: 'GalacticAgents', version: SERVER_VERSION },
        }),
        'initialize',
      );
      if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(
          `the ACP agent speaks protocol version ${init.protocolVersion}; this server speaks ${acp.PROTOCOL_VERSION}`,
        );
      }
      if (resume !== undefined) {
        if (!init.agentCapabilities?.loadSession) {
          throw new Error(
            'this ACP agent cannot resume sessions (no loadSession capability): restart the task',
          );
        }
        session.loading = true;
        await this.during(
          session,
          conn.agent.request(acp.methods.agent.session.load, {
            sessionId: resume,
            cwd: opts.cwd,
            mcpServers: [],
          }),
          'session/load',
        );
        session.loading = false;
        session.acpSessionId = resume;
      } else {
        const created = await this.during(
          session,
          conn.agent.request(acp.methods.agent.session.new, { cwd: opts.cwd, mcpServers: [] }),
          'session/new',
        );
        session.acpSessionId = created.sessionId;
      }
    } catch (error) {
      await this.abandon(session);
      throw error;
    }
    session.starting = false;
    const first =
      opts.systemPrompt && resume === undefined
        ? `${opts.systemPrompt}\n\n${opts.prompt}`
        : opts.prompt;
    this.startTurn(session, first);
    return { sessionId: session.sessionId, sessionRef: `acp:${session.acpSessionId}` };
  }

  /** Starts the agent process and the ACP connection over its stdio. */
  private connect(session: Session, cwd: string): ClientConnection {
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        session.stdout = controller;
      },
    });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        session.process?.write(decoder.decode(chunk, { stream: true }));
      },
    });
    const { agent } = this.opts;
    session.process = this.opts.supervisor.adopt({
      agentId: session.agentId,
      command: agent.command,
      args: agent.args ?? [],
      cwd,
      env: this.env(),
      meta: { runtime: 'acp', command: agent.command },
      onStdout: (chunk) => {
        try {
          session.stdout?.enqueue(encoder.encode(chunk));
        } catch {
          // closed: the process is going away
        }
      },
      onStderr: (chunk) => {
        const line = chunk.trim();
        if (line) this.onError(new Error(line.slice(0, 500)), `acp stderr ${session.agentId}`);
      },
      interrupt: (proc) => this.stopHook(session, proc),
      onOutcome: (outcome) => this.onOutcome(session, outcome),
    });
    const conn = acp
      .client({ name: 'galactic-agents' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.requestPermission(session, ctx.params, ctx.signal),
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        this.elicit(session, ctx.params, ctx.signal),
      )
      .onNotification(acp.methods.client.session.update, (ctx) =>
        this.onUpdate(session, ctx.params),
      )
      .connect(acp.ndJsonStream(writable, readable));
    session.conn = conn;
    return conn;
  }

  /** A startup request raced with the process ending and the start timeout. */
  private async during<T>(session: Session, request: Promise<T>, what: string): Promise<T> {
    const proc = session.process!;
    let timer: NodeJS.Timeout | undefined;
    const exited = proc.exited.then((exit) => {
      throw new Error(
        `the ACP agent (${this.opts.agent.command}) exited during ${what}` +
          ` (${exit.signal ?? `code ${exit.code}`})`,
      );
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the ACP agent did not answer ${what} in time`)),
        this.opts.startTimeoutMs ?? 60_000,
      );
    });
    try {
      return await Promise.race([request, exited, timeout]);
    } catch (error) {
      if (error instanceof acp.RequestError) {
        throw new Error(`${what} failed: ${error.message}`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A start that failed: no event (the runtime reports the failed spawn), no process left. */
  private async abandon(session: Session): Promise<void> {
    session.terminal = 'failed';
    session.settlePending();
    session.conn?.close();
    this.forget(session);
    if (session.process && session.process.state !== 'exited') {
      await this.opts.supervisor.kill(session.agentId).catch(() => {});
    }
  }

  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const key of [...ACP_PASS_ENV, ...(this.opts.agent.passEnv ?? [])]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return { ...env, ...(this.opts.agent.env ?? {}) };
  }

  // --- process -----------------------------------------------------------------

  /**
   * The supervisor's graceful stop, step 1: thaw, cancel the turn and wait for its end, then close
   * stdin so the agent can exit on its own before any SIGTERM.
   */
  private async stopHook(session: Session, proc: ManagedProcess): Promise<void> {
    if (session.paused) {
      proc.signal('SIGCONT');
      session.paused = false;
    }
    if (session.turnOpen && !session.starting) {
      session.interrupting = true;
      session.settlePending();
      await this.cancel(session);
      await session.turnEnd();
    }
    proc.expectExit();
    proc.child.stdin?.end();
    proc.turnEnded();
  }

  private onOutcome(session: Session, outcome: ProcessOutcome): void {
    if (outcome.kind !== 'restarting') {
      try {
        session.stdout?.close();
      } catch {
        // already closed
      }
    }
    if (session.starting) return; // `spawn()` throws; the runtime reports it
    this.flush(session);
    const cost = session.meter.cost;
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
          error: `the ACP agent exited unexpectedly (${outcome.exit.signal ?? `code ${outcome.exit.code}`})`,
          reason: 'crash',
          ...(cost ? { cost } : {}),
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
            ...(cost ? { cost } : {}),
          });
        }
        return;
      case 'restarting':
        return; // adopt() has no restart policy
    }
  }

  // --- turns -------------------------------------------------------------------

  private startTurn(session: Session, text: string): void {
    session.turnOpen = true;
    session.lastText = '';
    const conn = session.conn!;
    conn.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId: session.acpSessionId!,
        prompt: [{ type: 'text', text }],
      })
      .then(
        // The SDK runs notification handlers through an async chain but settles a response at
        // once, so the turn's last `session/update`s (its usage, its final chunks) may still be
        // on their way when the prompt's response arrives: end the turn a macrotask later, once
        // every handler already under way has run.
        (response) => setImmediate(() => this.turnDone(session, response)),
        (error: unknown) => setImmediate(() => this.turnFailed(session, error)),
      );
  }

  private turnDone(session: Session, response: PromptResponse): void {
    if (session.terminal) return;
    this.flush(session);
    session.meter.turn(response.usage);
    const cancelled = response.stopReason === 'cancelled';
    if (!cancelled && response.stopReason !== 'end_turn' && !session.stopping) {
      this.output(session, 'text', `turn ended: ${response.stopReason.replace(/_/g, ' ')}`);
    }
    if (session.lastText) session.lastResult = session.lastText;
    this.endTurn(session);
  }

  private turnFailed(session: Session, error: unknown): void {
    if (session.terminal) return;
    this.flush(session);
    const closed = session.conn?.signal.aborted === true;
    if (closed) {
      // The process went away mid-turn: its outcome ends the session.
      session.closeTurn();
      session.process?.turnEnded();
      return;
    }
    if (!session.interrupting && !session.stopping) {
      this.output(session, 'text', `turn ended with an error: ${(error as Error).message}`);
    }
    this.endTurn(session);
  }

  private endTurn(session: Session): void {
    session.interrupting = false;
    session.settlePending();
    session.closeTurn();
    session.process?.turnEnded();
    if (!session.stopping && !session.terminal) {
      const cost = session.meter.cost;
      this.emit(session, {
        type: 'agent.idle',
        agentId: session.agentId,
        ...(cost ? { cost } : {}),
      });
    }
  }

  private cancel(session: Session): Promise<void> {
    if (!session.conn || !session.acpSessionId) return Promise.resolve();
    return session.conn.agent
      .notify(acp.methods.agent.session.cancel, { sessionId: session.acpSessionId })
      .catch((error: unknown) => this.onError(error, `session/cancel ${session.agentId}`));
  }

  // --- session/update ------------------------------------------------------------

  private onUpdate(session: Session, n: SessionNotification): void {
    if (session.loading || session.terminal) return; // a load replays history: not news
    if (session.acpSessionId !== undefined && n.sessionId !== session.acpSessionId) return;
    const u = n.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        this.chunk(session, 'text', contentText(u.content));
        return;
      case 'agent_thought_chunk':
        this.chunk(session, 'thinking', contentText(u.content));
        return;
      case 'tool_call':
      case 'tool_call_update': {
        this.flush(session);
        const tool = mergeTool(session.tools.get(u.toolCallId), u);
        session.tools.set(u.toolCallId, tool);
        this.onToolStatus(session, tool);
        return;
      }
      case 'plan': {
        if (!session.turnOpen) return; // progress marks the agent working
        this.flush(session);
        const { summary, progress } = planProgress(u);
        this.emit(session, { type: 'agent.progress', agentId: session.agentId, summary, progress });
        return;
      }
      case 'usage_update':
        session.meter.sessionCost(u.cost);
        return;
      case 'notice':
        this.flush(session);
        this.output(
          session,
          'text',
          `${u.severity}: ${u.title}${u.description ? ` — ${u.description}` : ''}`,
        );
        return;
      default:
        // user_message_chunk (our own prompt echoed), commands, modes, config, session info,
        // compaction, subagents, session messages: not transcript.
        return;
    }
  }

  private chunk(session: Session, kind: 'text' | 'thinking', text: string): void {
    if (!text) return;
    if (session.block && session.block.kind !== kind) this.flush(session);
    if (!session.block) session.block = { kind, text: '' };
    session.block.text += text;
  }

  /** Ends the block being streamed: one `agent.output` per block, never per chunk. */
  private flush(session: Session): void {
    const block = session.block;
    session.block = undefined;
    if (!block || !block.text.trim()) return;
    if (block.kind === 'text') session.lastText = block.text;
    this.output(session, block.kind, block.text);
  }

  private onToolStatus(session: Session, tool: ToolState): void {
    const id = tool.toolCallId;
    const status = tool.status ?? 'pending';
    const bookkeeping =
      tool.kind !== undefined && tool.kind !== null && BOOKKEEPING_KINDS.has(tool.kind);
    if (
      (status === 'in_progress' || status === 'completed') &&
      !bookkeeping &&
      !session.decided.has(id)
    ) {
      // The agent runs a call it did not ask about: the gate still judges it.
      session.decided.add(id);
      this.unaskedCall(session, tool);
    }
    if (status === 'completed' || status === 'failed') {
      const text = toolResultText(tool, this.maxToolResultChars);
      if (text || status === 'failed') {
        this.output(
          session,
          'tool',
          `${status === 'failed' ? 'tool failed' : 'tool result'} (${describeTool(tool)})${text ? `: ${text}` : ''}`,
        );
      }
    }
  }

  private unaskedCall(session: Session, tool: ToolState): void {
    const call = gateCall(tool);
    let verdict;
    try {
      verdict = session.gate.check(call);
    } catch (error) {
      this.onError(error, `gate ${session.agentId}`);
      verdict = {
        decision: 'deny' as const,
        reason: `permission check failed: ${(error as Error).message}`,
      };
    }
    if (verdict.decision === 'deny') {
      this.output(
        session,
        'text',
        `permission denied for ${describeTool(tool)}: ${verdict.reason} — the agent ran it without asking, so the turn is cancelled`,
      );
      if (session.turnOpen && !session.interrupting) {
        session.interrupting = true;
        session.settlePending();
        void this.cancel(session);
      }
      return;
    }
    this.toolCall(session, tool, call);
    if (verdict.decision === 'ask') {
      this.output(
        session,
        'text',
        `warning: the agent ran ${describeTool(tool)} without asking; the permission table would have asked` +
          (verdict.reasons.length ? ` (${verdict.reasons.join('; ')})` : ''),
      );
    }
  }

  private toolCall(session: Session, tool: ToolState, call: ReturnType<typeof gateCall>): void {
    if (session.reported.has(tool.toolCallId)) return;
    session.reported.add(tool.toolCallId);
    this.emit(session, {
      type: 'agent.tool_call',
      agentId: session.agentId,
      toolName: call.toolName,
      toolUseId: tool.toolCallId,
      input: call.input,
    });
  }

  // --- permissions and questions -------------------------------------------------

  private async requestPermission(
    session: Session,
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (session.terminal || session.stopping || session.interrupting) return cancelled;
    this.flush(session);
    const tool = mergeTool(session.tools.get(params.toolCall.toolCallId), params.toolCall);
    session.tools.set(tool.toolCallId, tool);
    session.decided.add(tool.toolCallId);
    const call = gateCall(tool);
    const answerWith = (allow: boolean): RequestPermissionResponse => {
      const option = chooseOption(params.options, allow);
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled;
    };
    try {
      const verdict = session.gate.check(call);
      if (verdict.decision === 'allow') {
        this.toolCall(session, tool, call);
        return answerWith(true);
      }
      if (verdict.decision === 'deny') {
        this.output(
          session,
          'text',
          `permission denied for ${describeTool(tool)}: ${verdict.reason}`,
        );
        return answerWith(false);
      }
      const why = verdict.reasons.join('; ');
      const answer = await this.ask(
        session,
        'permission',
        {
          text: `May the agent run ${describeTool(tool)}?${why ? ` (${why})` : ''}`,
          toolCall: call,
          ...(verdict.action ? { permissionAction: verdict.action } : {}),
        },
        signal,
      );
      if (answer === undefined) return cancelled;
      if (ALLOW.test(answer.trim())) {
        this.toolCall(session, tool, call);
        return answerWith(true);
      }
      this.output(session, 'text', `permission denied for ${describeTool(tool)}: ${answer}`);
      return answerWith(false);
    } catch (error) {
      this.onError(error, `request_permission ${session.agentId}`);
      this.output(
        session,
        'text',
        `permission denied for ${describeTool(tool)}: permission check failed: ${(error as Error).message}`,
      );
      return answerWith(false);
    }
  }

  private async elicit(
    session: Session,
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    if (session.terminal || session.stopping || session.interrupting) return { action: 'cancel' };
    if (params.mode !== 'form' || !('requestedSchema' in params)) return { action: 'decline' };
    this.flush(session);
    const schema = params.requestedSchema as {
      properties?: Record<string, ElicitationPropertySchema>;
      required?: string[] | null;
    };
    const fields = formFields(params.message, schema.properties ?? {}, schema.required ?? []);
    if (fields.length === 0) {
      const answer = await this.ask(session, 'clarification', { text: params.message }, signal);
      return answer === undefined ? { action: 'cancel' } : { action: 'accept', content: {} };
    }
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const field of fields) {
      let value: string | number | boolean | string[] | undefined;
      let text = field.text;
      // A typed field asks again until the answer reads (a number, yes/no).
      for (let attempt = 0; value === undefined && attempt < 3; attempt++) {
        const answer = await this.ask(
          session,
          'clarification',
          { text, ...(field.options ? { options: field.options } : {}) },
          signal,
        );
        if (answer === undefined) return { action: 'cancel' };
        value = field.parse(answer);
        text = `${field.text} (could not read "${answer}"; please answer again)`;
      }
      if (value === undefined) return { action: 'decline' };
      content[field.key] = value;
    }
    return { action: 'accept', content };
  }

  private ask(
    session: Session,
    kind: 'clarification' | 'permission',
    question: QuestionBody,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (signal.aborted || session.terminal || session.stopping) return Promise.resolve(undefined);
    const id = `q-${randomUUID()}`;
    return new Promise((resolve) => {
      const done = (answer: string | undefined) => {
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

  async interrupt(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || !session.turnOpen || session.terminal) return;
    if (session.paused) this.thaw(session); // a frozen agent cannot read the cancel
    session.interrupting = true;
    session.settlePending();
    await this.cancel(session);
  }

  async pause(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || session.paused) return;
    if (!session.process || session.process.state === 'exited') {
      throw new Error(`cannot pause session ${sessionId}: no ACP agent process to freeze`);
    }
    this.flush(session);
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
        // The supervisor runs the sequence: our hook (cancel, turn end, stdin closed) → SIGTERM
        // → SIGKILL; its `stopped` outcome is the terminal event.
        await this.opts.supervisor.stop(session.agentId, {
          graceMs: opts.graceMs ?? this.opts.graceMs ?? 10_000,
          by: SYSTEM,
        });
      }
      if (!session.terminal) {
        this.terminal(session, { type: 'agent.stopped', agentId: session.agentId, by: SYSTEM });
      }
    })();
    return session.stopDone;
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
    throw new Error(`unknown acp session ${sessionId}`);
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
    session.conn?.close();
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
