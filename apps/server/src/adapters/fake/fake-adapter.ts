import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type {
  Cost,
  Actor,
  AgentAdapter,
  AgentEvent,
  Id,
  PermissionAction,
  PermissionGate,
  RuntimePreflight,
  SendOptions,
  SlashCommand,
  SpawnHandle,
  SpawnOptions,
  StopOptions,
  ToolCall,
  ToolDefinition,
} from '@galactic/protocol';
import { normalizeSlashCommands } from '@galactic/protocol';
import { EventQueue } from '../../lib/event-queue.js';
import {
  echo,
  FakeTurnCancelled,
  scenarioFromPrompt,
  SCENARIOS,
  type FakeScenario,
  type FakeStep,
  type FakeToolResult,
  type FakeTurnIO,
} from './scenario.js';

/**
 * The fake adapter (P1-03): an in-process `AgentAdapter` that runs scripted scenarios instead of
 * a model. It exists so the runtime, the status store, the conformance suite (P1-04) and the ops
 * console (P1-11) can be built and exercised without Claude installed, and so every adapter
 * behaviour has a deterministic reference: questions block the turn until answered, every tool
 * call goes through the runtime's permission gate (allow runs it, ask blocks it behind a
 * permission question, deny skips it), pause holds the turn, stop is interrupt-then-stopped.
 *
 * Like every adapter it keeps no message queue (P1-19): `send()` starts a turn and rejects a
 * message that arrives mid-turn without `interrupt`; the runtime's inbox is what waits for idle.
 *
 * Session refs are `fake:<scenario>:<sessionId>:<nextStep>`; `resumeSession` continues from the step after
 * the last one completed when the adapter was given the same `sessionStore` (an in-process
 * restart, P1-14), and from the ref's step otherwise. A resumed *brain* (a spawn with server tools)
 * whose first turn was complete takes the resume prompt as a new turn, as the SDK does (P2-16); a
 * scenario this adapter instance never saw is asked of `scenarioFor` again.
 *
 * Failure modes a real runtime has, for the conformance suite (P1-38): with `checkCwd` a spawn in
 * a working directory that does not exist is refused (a real CLI cannot start there), and
 * `crash(agentId)` kills a session from outside (`agent.failed(reason: crash)`, like a process
 * killed by a signal). Every tool call carries a `toolUseId`, as the SDK's do.
 */

export interface FakeAdapterOptions {
  scenarios?: Record<string, FakeScenario>;
  /** Multiplies every delay; `0` makes scenarios instantaneous (tests). Default 1. */
  speed?: number;
  /** Progress per session ref, shared between adapter instances to survive an in-process restart. */
  sessionStore?: Map<string, number>;
  /**
   * Refuse a spawn (or resume) whose `cwd` is not an existing directory, as a real runtime's
   * process would fail to start. Off by default: unit tests spawn in made-up directories.
   */
  checkCwd?: boolean;
  /**
   * Picks the scenario of a spawn from its options instead of its prompt (P2-06: a scripted
   * brain answers its turn prompts with tool calls). `undefined` falls back to the prompt. The
   * scenario is remembered by name so `resumeSession` finds it too.
   */
  scenarioFor?: (opts: SpawnOptions) => { name: string; scenario: FakeScenario } | undefined;
  /**
   * A resume that fails after the handle came back, as the SDK's does (P2-16): `resumeSession`
   * returns a handle at once and the session then ends on its own — `failed` (a CLI that exits
   * with an error: the session file is gone or corrupt) or `finished` (it exits cleanly) — before
   * any turn. Return `undefined` to resume normally.
   */
  resumeFails?: (
    opts: SpawnOptions,
    sessionRef: string,
  ) => { ends: 'failed' | 'finished'; error?: string } | undefined;
  /**
   * The slash commands every session reports (P8-13), as a runtime would (normalised on the way
   * out), or per spawn. A scenario's own `commands` win. Default: none.
   */
  commands?: readonly unknown[] | ((opts: SpawnOptions) => readonly unknown[] | undefined);
}

type Ended = 'finished' | 'failed' | 'stopped';

interface PendingQuestion {
  id: Id;
  resolve: (answer: string | undefined) => void;
}

/** One deferred that anything can wake: an answer, a resume, an interrupt, a stop. */
class Signal {
  private waiters: (() => void)[] = [];
  wait(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }
  fire(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

class FakeSession {
  readonly sessionId = randomUUID();
  readonly signal = new Signal();
  /** Index of the next scenario step to run (only meaningful during the first turn). */
  stepIndex: number;
  messageCount = 0;
  /** Set while a turn runs; `cancelled` makes the loop stop at the next boundary. */
  turn: { cancelled: boolean } | undefined;
  paused = false;
  ended: Ended | undefined;
  pending: PendingQuestion | undefined;
  /** Resolves when the current turn loop has exited. */
  turnDone: Promise<void> = Promise.resolve();
  /** Set by the first `stop()`; later calls share it. */
  stopping: Promise<void> | undefined;
  /** The session's running cost, set by `cost` steps (P8-01); every later idle reports it. */
  cost: Cost | undefined;
  /** What `commands()` reports (P8-13). */
  commands: SlashCommand[] = [];

  constructor(
    readonly agentId: Id,
    readonly scenarioName: string,
    readonly scenario: FakeScenario,
    readonly gate: PermissionGate,
    startAt: number,
    /** The server's tools (a brain's): a scripted call to one runs its handler. */
    readonly tools: ReadonlyMap<string, ToolDefinition>,
  ) {
    this.stepIndex = startAt;
  }

  get sessionRef(): string {
    return `fake:${this.scenarioName}:${this.sessionId}:${this.stepIndex}`;
  }
}

const SYSTEM: Actor = { type: 'system' };

export class FakeAdapter implements AgentAdapter {
  readonly runtime = 'fake' as const;
  readonly events = new EventQueue<AgentEvent>();
  private readonly sessions = new Map<string, FakeSession>();
  private readonly byQuestion = new Map<Id, FakeSession>();
  private readonly scenarios: Record<string, FakeScenario>;
  private readonly speed: number;
  private readonly sessionStore: Map<string, number>;
  private readonly checkCwd: boolean;
  private readonly scenarioFor: FakeAdapterOptions['scenarioFor'];
  /** Scenarios chosen by `scenarioFor`, by name, for `resumeSession`. */
  private readonly picked = new Map<string, FakeScenario>();
  private readonly resumeFails: FakeAdapterOptions['resumeFails'];
  private readonly commandsFor: FakeAdapterOptions['commands'];
  private disposed = false;

  constructor(opts: FakeAdapterOptions = {}) {
    this.scenarios = opts.scenarios ?? SCENARIOS;
    this.speed = opts.speed ?? 1;
    this.sessionStore = opts.sessionStore ?? new Map();
    this.checkCwd = opts.checkCwd ?? false;
    this.scenarioFor = opts.scenarioFor;
    this.resumeFails = opts.resumeFails;
    this.commandsFor = opts.commands;
  }

  /** The scenario names this adapter knows, for the ops console's spawn form. */
  scenarioNames(): string[] {
    return Object.keys(this.scenarios);
  }

  async spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    const chosen = this.scenarioFor?.(opts);
    if (chosen) this.picked.set(chosen.name.toLowerCase(), chosen.scenario);
    const { name, scenario } = chosen ?? scenarioFromPrompt(opts.prompt, this.scenarios);
    return this.start(opts, name.toLowerCase(), scenario, 0);
  }

  async resumeSession(sessionRef: string, opts: SpawnOptions): Promise<SpawnHandle> {
    const m = /^fake:([a-z0-9_-]+):([0-9a-f-]+):(\d+)$/i.exec(sessionRef);
    if (!m) throw new Error(`not a fake session ref: ${sessionRef}`);
    let name = m[1]!.toLowerCase();
    let scenario = this.scenarios[name] ?? this.picked.get(name);
    if (!scenario) {
      // A scripted brain from an earlier adapter instance (a restart): its script picks it again.
      const chosen = this.scenarioFor?.(opts);
      if (chosen) {
        name = chosen.name.toLowerCase();
        scenario = chosen.scenario;
        this.picked.set(name, scenario);
      }
    }
    if (!scenario) throw new Error(`unknown fake scenario in session ref: ${m[1]!.toLowerCase()}`);
    const startAt = this.sessionStore.get(sessionRef) ?? Number(m[3]);
    const fails = this.resumeFails?.(opts, sessionRef);
    if (fails) return this.lostSession(opts, name, scenario, startAt, fails);
    return this.start(opts, name, scenario, startAt, true);
  }

  /** A resumed session that ends on its own before its first turn (`resumeFails`). */
  private lostSession(
    opts: SpawnOptions,
    name: string,
    scenario: FakeScenario,
    startAt: number,
    fails: { ends: 'failed' | 'finished'; error?: string },
  ): SpawnHandle {
    if (this.disposed) throw new Error('adapter disposed');
    const tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    const session = new FakeSession(opts.agentId, name, scenario, opts.gate, startAt, tools);
    this.sessions.set(session.sessionId, session);
    session.ended = fails.ends;
    // Later, as a CLI that exits after it started: the caller holds the handle first.
    setImmediate(() => {
      this.emit(
        fails.ends === 'failed'
          ? {
              type: 'agent.failed',
              agentId: opts.agentId,
              error: fails.error ?? 'No conversation found with this session ID',
              reason: 'crash',
            }
          : { type: 'agent.finished', agentId: opts.agentId },
      );
    });
    return { sessionId: session.sessionId, sessionRef: session.sessionRef };
  }

  private start(
    opts: SpawnOptions,
    name: string,
    scenario: FakeScenario,
    startAt: number,
    resumed = false,
  ): SpawnHandle {
    if (this.disposed) throw new Error('adapter disposed');
    if (this.checkCwd && !isDirectory(opts.cwd)) {
      throw new Error(`working directory does not exist: ${opts.cwd}`);
    }
    const tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    const session = new FakeSession(opts.agentId, name, scenario, opts.gate, startAt, tools);
    const given =
      scenario.commands ??
      (typeof this.commandsFor === 'function' ? this.commandsFor(opts) : this.commandsFor);
    session.commands = normalizeSlashCommands(given);
    this.sessions.set(session.sessionId, session);
    const ref = session.sessionRef;
    this.sessionStore.set(ref, startAt);
    // A resumed brain whose first turn was done: the resume prompt is its next turn (P2-16).
    if (resumed && tools.size > 0 && startAt >= scenario.steps.length && opts.prompt) {
      session.messageCount++;
      const steps = scenario.onMessage?.(opts.prompt, session.messageCount) ?? echo(opts.prompt);
      queueMicrotask(() => void this.runTurn(session, steps, 0, undefined));
      return { sessionId: session.sessionId, sessionRef: ref };
    }
    // The first turn starts on the next tick so the caller holds the handle before any event.
    queueMicrotask(() => this.runTurn(session, scenario.steps, startAt, ref));
    return { sessionId: session.sessionId, sessionRef: ref };
  }

  async send(sessionId: string, message: string, opts: SendOptions = {}): Promise<void> {
    const session = this.session(sessionId);
    if (session.ended) throw new Error(`session ${sessionId} has ${session.ended}`);
    if (session.turn) {
      if (!opts.interrupt) {
        throw new Error(
          `session ${sessionId} is mid-turn: the runtime delivers messages only when idle`,
        );
      }
      this.cancelTurn(session);
      await session.turnDone;
      if (session.ended) throw new Error(`session ${sessionId} has ${session.ended}`);
    }
    session.messageCount++;
    const steps = session.scenario.onMessage?.(message, session.messageCount) ?? echo(message);
    void this.runTurn(session, steps, 0, undefined);
  }

  /** The session's scripted slash commands (P8-13); `[]` for an ended or unknown one. */
  async commands(sessionId: string): Promise<SlashCommand[]> {
    const session = this.sessions.get(sessionId);
    return session && !session.ended ? session.commands : [];
  }

  async answer(questionId: Id, answer: string): Promise<void> {
    const session = this.byQuestion.get(questionId);
    if (!session || session.pending?.id !== questionId) {
      throw new Error(`no pending question ${questionId}`);
    }
    const pending = session.pending;
    session.pending = undefined;
    this.byQuestion.delete(questionId);
    pending.resolve(answer);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    if (session.turn) this.cancelTurn(session);
  }

  async pause(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    if (session.ended || session.paused) return;
    session.paused = true;
    this.emit({ type: 'agent.paused', agentId: session.agentId, by: SYSTEM });
    session.signal.fire();
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    if (session.ended || !session.paused) return;
    session.paused = false;
    this.emit({ type: 'agent.resumed', agentId: session.agentId, by: SYSTEM });
    session.signal.fire();
  }

  async stop(sessionId: string, _opts: StopOptions = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.stopping) return session.stopping;
    if (session.ended) return;
    session.ended = 'stopped';
    if (session.turn) this.cancelTurn(session);
    session.paused = false;
    session.signal.fire();
    session.stopping = session.turnDone.then(() => {
      this.emit({ type: 'agent.stopped', agentId: session.agentId, by: SYSTEM });
    });
    return session.stopping;
  }

  /**
   * Kills the agent's session from outside, the way a crashed or externally killed process ends:
   * the turn is abandoned (a pending question withdrawn) and `agent.failed(reason: crash)` is the
   * session's one terminal event. A no-op for an unknown agent or a session that already ended.
   * Test-only: nothing in the server calls it.
   */
  async crash(agentId: Id, error = 'the fake agent process was killed (SIGKILL)'): Promise<void> {
    const session = [...this.sessions.values()].find((s) => s.agentId === agentId && !s.ended);
    if (!session) return;
    session.ended = 'failed';
    if (session.turn) this.cancelTurn(session);
    session.paused = false;
    session.signal.fire();
    await session.turnDone;
    this.emit({ type: 'agent.failed', agentId, error, reason: 'crash' });
  }

  /** Always ready: nothing to install or log in to (P25-01). */
  preflight(): Promise<RuntimePreflight> {
    return Promise.resolve({ runtime: 'fake', ok: true, installed: true, problems: [] });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
    this.events.close();
  }

  // ---------------------------------------------------------------------------

  private session(sessionId: string): FakeSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown fake session ${sessionId}`);
    return s;
  }

  private emit(event: AgentEvent): void {
    this.events.push(event);
  }

  private cancelTurn(session: FakeSession): void {
    if (session.turn) session.turn.cancelled = true;
    if (session.pending) {
      const pending = session.pending;
      session.pending = undefined;
      this.byQuestion.delete(pending.id);
      pending.resolve(undefined);
    }
    session.signal.fire();
  }

  /**
   * Runs one turn. `trackRef` is set for the first (scenario) turn so the session's progress is
   * saved after every step for `resumeSession`.
   */
  private runTurn(
    session: FakeSession,
    steps: FakeStep[],
    from: number,
    trackRef: string | undefined,
  ): Promise<void> {
    const turn = { cancelled: false };
    session.turn = turn;
    const done = (async () => {
      let i = from;
      try {
        while (i < steps.length && !turn.cancelled && !session.ended) {
          while (session.paused && !turn.cancelled && !session.ended) await session.signal.wait();
          if (turn.cancelled || session.ended) break;
          const step = steps[i]!;
          const outcome = await this.execute(session, step, turn);
          if (outcome === 'cancelled') break;
          i++;
          if (trackRef) {
            session.stepIndex = i;
            this.sessionStore.set(trackRef, i);
          }
          if (outcome === 'idle' || outcome === 'ended') break;
        }
      } finally {
        session.turn = undefined;
      }
      if (!session.ended) {
        this.emit({
          type: 'agent.idle',
          agentId: session.agentId,
          ...(session.cost ? { cost: session.cost } : {}),
        });
      }
    })();
    session.turnDone = done;
    return done;
  }

  /** Waits `ms` (scaled), holding while paused and returning early when cancelled or ended. */
  private async delay(session: FakeSession, ms: number | undefined, turn: { cancelled: boolean }) {
    let remaining = (ms ?? session.scenario.stepDelayMs ?? 0) * this.speed;
    while ((remaining > 0 || session.paused) && !turn.cancelled && !session.ended) {
      await this.holdWhilePaused(session, turn);
      if (turn.cancelled || session.ended || remaining <= 0) return;
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          new Promise<void>((r) => {
            timer = setTimeout(r, remaining);
          }),
          session.signal.wait(),
        ]);
      } finally {
        clearTimeout(timer);
      }
      remaining -= Date.now() - started;
    }
  }

  /** Nothing is emitted while paused: every step waits here right before it emits. */
  private async holdWhilePaused(session: FakeSession, turn: { cancelled: boolean }) {
    while (session.paused && !turn.cancelled && !session.ended) await session.signal.wait();
  }

  private async execute(
    session: FakeSession,
    step: FakeStep,
    turn: { cancelled: boolean },
  ): Promise<'next' | 'idle' | 'ended' | 'cancelled'> {
    const agentId = session.agentId;
    switch (step.kind) {
      case 'output':
        await this.delay(session, step.delayMs, turn);
        if (turn.cancelled) return 'cancelled';
        this.emit({ type: 'agent.output', agentId, kind: step.output ?? 'text', text: step.text });
        return 'next';
      case 'tool_call':
        await this.delay(session, step.delayMs, turn);
        if (turn.cancelled) return 'cancelled';
        return (await this.toolCall(session, turn, { toolName: step.toolName, input: step.input }))
          .outcome;
      case 'progress':
        await this.delay(session, step.delayMs, turn);
        if (turn.cancelled) return 'cancelled';
        this.emit({
          type: 'agent.progress',
          agentId,
          summary: step.summary,
          ...(step.progress ? { progress: step.progress } : {}),
        });
        return 'next';
      case 'silence':
        await this.delay(session, step.ms, turn);
        return 'next';
      case 'stall':
        await this.holdWhilePaused(session, turn);
        if (turn.cancelled) return 'cancelled';
        this.emit({ type: 'agent.stalled', agentId, silentForMs: step.silentForMs });
        return 'next';
      case 'idle':
        return 'idle';
      case 'cost':
        session.cost = step.cost;
        return 'next';
      case 'ask': {
        const answer = await this.askQuestion(session, 'clarification', {
          text: step.text,
          ...(step.options ? { options: step.options } : {}),
        });
        if (answer === undefined) return 'cancelled';
        await this.holdWhilePaused(session, turn);
        if (turn.cancelled) return 'cancelled';
        this.emit({ type: 'agent.output', agentId, kind: 'text', text: `answer: ${answer}` });
        return 'next';
      }
      case 'permission':
        await this.holdWhilePaused(session, turn);
        if (turn.cancelled) return 'cancelled';
        return (
          await this.toolCall(
            session,
            turn,
            { toolName: step.toolName, input: step.input },
            {
              ...(step.text !== undefined ? { text: step.text } : {}),
              action: step.permissionAction,
            },
          )
        ).outcome;
      case 'script':
        return this.script(session, step.run, turn);
      case 'finish':
        await this.delay(session, step.delayMs, turn);
        if (turn.cancelled) return 'cancelled';
        session.ended = 'finished';
        this.emit({
          type: 'agent.finished',
          agentId,
          ...(step.result !== undefined ? { result: step.result } : {}),
          ...(step.cost ? { cost: step.cost } : {}),
        });
        return 'ended';
      case 'fail':
        await this.holdWhilePaused(session, turn);
        if (turn.cancelled) return 'cancelled';
        session.ended = 'failed';
        this.emit({
          type: 'agent.failed',
          agentId,
          error: step.error,
          reason: step.reason,
          ...(step.cost ? { cost: step.cost } : {}),
        });
        return 'ended';
    }
  }

  /**
   * A `script` step (P2-07): its body calls tools and reads their results in turn order. A call
   * after the turn was cancelled rejects with `FakeTurnCancelled`; any other error of the body is
   * reported as output and the turn goes on.
   */
  private async script(
    session: FakeSession,
    run: (io: FakeTurnIO) => Promise<void>,
    turn: { cancelled: boolean },
  ): Promise<'next' | 'cancelled'> {
    const live = () => {
      if (turn.cancelled || session.ended) throw new FakeTurnCancelled();
    };
    const io: FakeTurnIO = {
      toolCall: async (toolName, input) => {
        live();
        await this.holdWhilePaused(session, turn);
        live();
        const { outcome, result } = await this.toolCall(session, turn, { toolName, input });
        if (outcome === 'cancelled' || !result) throw new FakeTurnCancelled();
        return result;
      },
      output: (text, kind = 'text') => {
        live();
        this.emit({ type: 'agent.output', agentId: session.agentId, kind, text });
      },
    };
    try {
      await run(io);
    } catch (error) {
      if (error instanceof FakeTurnCancelled || turn.cancelled) return 'cancelled';
      if (session.ended) return 'cancelled';
      this.emit({
        type: 'agent.output',
        agentId: session.agentId,
        kind: 'text',
        text: `script error: ${(error as Error).message}`,
      });
    }
    return turn.cancelled ? 'cancelled' : 'next';
  }

  /**
   * One tool call through the runtime's gate, the way a real adapter's permission hook does it:
   * `allow` runs it (an `agent.tool_call` follows), `ask` blocks behind a permission question and
   * runs it on `allow`/`yes`, `deny` skips it with an output line carrying the reason.
   */
  private async toolCall(
    session: FakeSession,
    turn: { cancelled: boolean },
    call: ToolCall,
    ask: { text?: string; action?: PermissionAction } = {},
  ): Promise<{ outcome: 'next' | 'cancelled'; result?: FakeToolResult }> {
    const agentId = session.agentId;
    const toolUseId = `toolu_fake_${randomUUID()}`;
    const run = async (): Promise<FakeToolResult> => {
      this.emit({
        type: 'agent.tool_call',
        agentId,
        toolName: call.toolName,
        toolUseId,
        input: call.input,
      });
      // A server tool (a brain's) runs its handler, as the SDK's in-process MCP server does; the
      // result comes back to the "model" as tool output.
      const tool = session.tools.get(call.toolName);
      if (!tool) return { status: 'ran' };
      let text: string;
      let output: unknown;
      try {
        output = await tool.handler(call.input ?? {});
        text = typeof output === 'string' ? output : JSON.stringify(output);
      } catch (error) {
        text = `tool error: ${(error as Error).message}`;
        output = { error: 'error', message: (error as Error).message };
      }
      this.emit({ type: 'agent.output', agentId, kind: 'tool', text: text ?? '' });
      return { status: 'ran', output, text: text ?? '' };
    };
    const skip = (why: string): FakeToolResult => {
      this.emit({
        type: 'agent.output',
        agentId,
        kind: 'text',
        text: `permission denied for ${call.toolName} (${why}), skipping`,
      });
      return { status: 'denied', reason: why };
    };
    const verdict = session.gate.check(call);
    if (verdict.decision === 'allow') return { outcome: 'next', result: await run() };
    if (verdict.decision === 'deny') return { outcome: 'next', result: skip(verdict.reason) };
    const action = verdict.action ?? ask.action;
    const why = verdict.reasons.length > 0 ? ` ${verdict.reasons.join('; ')}` : '';
    const answer = await this.askQuestion(session, 'permission', {
      text: ask.text ?? `May I run ${call.toolName}?${why}`,
      toolCall: call,
      ...(action ? { permissionAction: action } : {}),
    });
    if (answer === undefined) return { outcome: 'cancelled' };
    await this.holdWhilePaused(session, turn);
    if (turn.cancelled) return { outcome: 'cancelled' };
    const result = /^(allow|yes|y|ok)$/i.test(answer.trim()) ? await run() : skip('answered no');
    return { outcome: 'next', result };
  }

  private askQuestion(
    session: FakeSession,
    kind: 'clarification' | 'permission',
    question: Extract<AgentEvent, { type: 'agent.needs_input' }>['question'],
  ): Promise<string | undefined> {
    const id = `q-${randomUUID()}`;
    return new Promise((resolve) => {
      session.pending = { id, resolve };
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
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
