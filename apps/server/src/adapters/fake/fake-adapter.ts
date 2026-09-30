import { randomUUID } from 'node:crypto';
import type {
  Actor,
  AgentAdapter,
  AgentEvent,
  Id,
  SendOptions,
  SpawnHandle,
  SpawnOptions,
  StopOptions,
} from '@galactic/protocol';
import { EventQueue } from '../../runtime/event-queue.js';
import {
  echo,
  scenarioFromPrompt,
  SCENARIOS,
  type FakeScenario,
  type FakeStep,
} from './scenario.js';

/**
 * The fake adapter (P1-03): an in-process `AgentAdapter` that runs scripted scenarios instead of
 * a model. It exists so the runtime, the status store, the conformance suite (P1-04) and the ops
 * console (P1-11) can be built and exercised without Claude installed, and so every adapter
 * behaviour has a deterministic reference: questions block the turn until answered, messages
 * queue until idle unless they interrupt, pause holds the turn, stop is interrupt-then-stopped.
 *
 * Session refs are `fake:<scenario>:<nextStep>`; `resumeSession` continues from the step after
 * the last one completed when the adapter was given the same `sessionStore` (an in-process
 * restart, P1-14), and from the ref's step otherwise.
 */

export interface FakeAdapterOptions {
  scenarios?: Record<string, FakeScenario>;
  /** Multiplies every delay; `0` makes scenarios instantaneous (tests). Default 1. */
  speed?: number;
  /** Progress per session ref, shared between adapter instances to survive an in-process restart. */
  sessionStore?: Map<string, number>;
}

type Ended = 'finished' | 'failed' | 'stopped';

interface PendingQuestion {
  id: Id;
  step: Extract<FakeStep, { kind: 'ask' | 'permission' }>;
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
  readonly inbox: string[] = [];
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

  constructor(
    readonly agentId: Id,
    readonly scenarioName: string,
    readonly scenario: FakeScenario,
    startAt: number,
  ) {
    this.stepIndex = startAt;
  }

  get sessionRef(): string {
    return `fake:${this.scenarioName}:${this.stepIndex}`;
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
  private disposed = false;

  constructor(opts: FakeAdapterOptions = {}) {
    this.scenarios = opts.scenarios ?? SCENARIOS;
    this.speed = opts.speed ?? 1;
    this.sessionStore = opts.sessionStore ?? new Map();
  }

  /** The scenario names this adapter knows, for the ops console's spawn form. */
  scenarioNames(): string[] {
    return Object.keys(this.scenarios);
  }

  async spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    const { name, scenario } = scenarioFromPrompt(opts.prompt, this.scenarios);
    return this.start(opts.agentId, name, scenario, 0);
  }

  async resumeSession(sessionRef: string, opts: SpawnOptions): Promise<SpawnHandle> {
    const m = /^fake:([a-z0-9_-]+):(\d+)$/i.exec(sessionRef);
    if (!m) throw new Error(`not a fake session ref: ${sessionRef}`);
    const name = m[1]!;
    const scenario = this.scenarios[name];
    if (!scenario) throw new Error(`unknown fake scenario in session ref: ${name}`);
    const startAt = this.sessionStore.get(sessionRef) ?? Number(m[2]);
    return this.start(opts.agentId, name, scenario, startAt);
  }

  private start(agentId: Id, name: string, scenario: FakeScenario, startAt: number): SpawnHandle {
    if (this.disposed) throw new Error('adapter disposed');
    const session = new FakeSession(agentId, name, scenario, startAt);
    this.sessions.set(session.sessionId, session);
    const ref = session.sessionRef;
    this.sessionStore.set(ref, startAt);
    // The first turn starts on the next tick so the caller holds the handle before any event.
    queueMicrotask(() => this.runTurn(session, scenario.steps, startAt, ref));
    return { sessionId: session.sessionId, sessionRef: ref };
  }

  async send(sessionId: string, message: string, opts: SendOptions = {}): Promise<void> {
    const session = this.session(sessionId);
    if (session.ended) throw new Error(`session ${sessionId} has ${session.ended}`);
    if (opts.interrupt) {
      session.inbox.unshift(message);
      if (session.turn) this.cancelTurn(session);
      else this.deliverNext(session);
      return;
    }
    session.inbox.push(message);
    if (!session.turn) this.deliverNext(session);
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
    if (!session || session.ended) return;
    session.ended = 'stopped';
    if (session.turn) this.cancelTurn(session);
    session.paused = false;
    session.signal.fire();
    await session.turnDone;
    this.emit({ type: 'agent.stopped', agentId: session.agentId, by: SYSTEM });
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

  private deliverNext(session: FakeSession): void {
    const message = session.inbox.shift();
    if (message === undefined || session.ended) return;
    session.messageCount++;
    const steps = session.scenario.onMessage?.(message, session.messageCount) ?? echo(message);
    void this.runTurn(session, steps, 0, undefined);
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
        this.emit({ type: 'agent.idle', agentId: session.agentId });
        this.deliverNext(session);
      }
    })();
    session.turnDone = done;
    return done;
  }

  /** Waits `ms` (scaled), holding while paused and returning early when cancelled or ended. */
  private async delay(session: FakeSession, ms: number | undefined, turn: { cancelled: boolean }) {
    let remaining = (ms ?? session.scenario.stepDelayMs ?? 0) * this.speed;
    while (remaining > 0 && !turn.cancelled && !session.ended) {
      while (session.paused && !turn.cancelled && !session.ended) await session.signal.wait();
      if (turn.cancelled || session.ended) return;
      const started = Date.now();
      await Promise.race([
        new Promise<void>((r) => setTimeout(r, remaining)),
        session.signal.wait(),
      ]);
      remaining -= Date.now() - started;
    }
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
        this.emit({ type: 'agent.tool_call', agentId, toolName: step.toolName, input: step.input });
        return 'next';
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
        this.emit({ type: 'agent.stalled', agentId, silentForMs: step.silentForMs });
        return 'next';
      case 'idle':
        return 'idle';
      case 'ask': {
        const answer = await this.askQuestion(session, step, {
          text: step.text,
          ...(step.options ? { options: step.options } : {}),
        });
        if (answer === undefined) return 'cancelled';
        this.emit({ type: 'agent.output', agentId, kind: 'text', text: `answer: ${answer}` });
        return 'next';
      }
      case 'permission': {
        const answer = await this.askQuestion(session, step, {
          text: step.text ?? `May I run ${step.toolName}?`,
          toolCall: { toolName: step.toolName, input: step.input },
          permissionAction: step.permissionAction,
        });
        if (answer === undefined) return 'cancelled';
        if (/^(allow|yes|y|ok)$/i.test(answer.trim())) {
          this.emit({
            type: 'agent.tool_call',
            agentId,
            toolName: step.toolName,
            input: step.input,
          });
        } else {
          this.emit({
            type: 'agent.output',
            agentId,
            kind: 'text',
            text: `permission denied for ${step.toolName}, skipping`,
          });
        }
        return 'next';
      }
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

  private askQuestion(
    session: FakeSession,
    step: Extract<FakeStep, { kind: 'ask' | 'permission' }>,
    question: Extract<AgentEvent, { type: 'agent.needs_input' }>['question'],
  ): Promise<string | undefined> {
    const id = `q-${randomUUID()}`;
    return new Promise((resolve) => {
      session.pending = { id, step, resolve };
      this.byQuestion.set(id, session);
      this.emit({
        type: 'agent.needs_input',
        agentId: session.agentId,
        questionId: id,
        kind: step.kind === 'ask' ? 'clarification' : 'permission',
        question,
      });
    });
  }
}
