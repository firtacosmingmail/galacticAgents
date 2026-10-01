import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PERMISSION_POLICY,
  type Actor,
  type Agent,
  type AgentAdapter,
  type AgentCaps,
  type AgentEvent,
  type AgentRole,
  type AgentRuntime as RuntimeName,
  type Event,
  type Id,
  type PermissionPolicy,
  type SpawnHandle,
  type SpawnOptions,
  type ToolDefinition,
} from '@galactic/protocol';
import type { CommandContext, EventLog } from '../domain/event-log.js';
import { createAgent, recordSpawned } from '../domain/agents.js';
import { answerQuestion, cancelQuestion, checkAnswer } from '../domain/questions.js';
import {
  endAgentQuestions,
  holdersNow,
  livingFromStatuses,
  logRouting,
  openFromNeedsInput,
  type QuestionRouting,
} from '../domain/question-service.js';
import { DomainError } from '../domain/errors.js';
import { AgentInbox, type InboxMessage } from './inbox.js';
import { CapsEnforcer, DEFAULT_CAPS } from './caps.js';
import { createPermissionGate } from './permission-gate.js';
import { redactEvent } from './redact.js';
import type { StatusStore } from './status-store.js';
import type { TranscriptPipeline } from './transcripts.js';

/**
 * The agent runtime: what ties an adapter's session to the rest of the server (P1-02, P1-05,
 * P1-07; TECHNOLOGY §3.4, §4, §6.2). For every agent it owns the inbox, the caps, the permission
 * gate, the adapter session, and the routing of the adapter's events:
 *
 *   agent.output  → transcript pipeline (redacted, batched) + status store `touch()`
 *   everything else → the event log (one write rule), whose subscribers include the status
 *                     store and, later, the brains' mailboxes
 *
 * Invariants the runtime enforces on the way to the log (P1-17):
 *   - every agent gets exactly one terminal event (`finished` | `failed` | `stopped`); a cap
 *     stop ends in `agent.failed(reason: cap)` and the adapter's own `agent.stopped` is folded
 *     into it, whichever arrives first;
 *   - events for an agent the runtime does not know (never spawned here, or already ended) never
 *     reach the log — the adapter is reporting a session the server no longer owns;
 *   - an agent's open questions are cancelled in the same command as its terminal or
 *     interrupted event, and when it goes idle without an answer (an interrupt withdrew them,
 *     P1-34); the questions it *held* move to the next living supervisor or the user (P2-03);
 *   - a stop that was asked for ends as a stop, even when a shutdown overtakes it (P1-32).
 *
 * `agent.spawned` is emitted here, not by adapters (they do not know bodies). The agent row is
 * created by `domain/agents.ts`; Phase 2's `spawnAgent` command composes the same functions.
 */

export interface SpawnRequest {
  role: AgentRole;
  runtime: RuntimeName;
  prompt: string;
  cwd: string;
  /** The project workspace for the policy engine; defaults to `cwd`. */
  workspace?: string;
  caps?: Partial<AgentCaps>;
  permissionPolicy?: PermissionPolicy;
  bodyId?: Id;
  supervisorId?: Id;
  taskId?: Id;
  projectId?: Id;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  bare?: boolean;
  /** A fixed agent id (tests, resume); default: generated. */
  agentId?: Id;
}

export type SpawnResult = { ok: true; agent: Agent } | { ok: false; reason: string };

export interface AgentRuntimeOptions {
  log: EventLog;
  adapters: AgentAdapter[];
  transcripts: TranscriptPipeline;
  statuses: StatusStore;
  caps?: { maxConcurrentAgents?: number; defaults?: AgentCaps };
  /** Delivered messages kept per inbox for inspection; the log has the full history. */
  inboxHistory?: number;
  now?: () => string;
  onError?: (error: unknown, context: string) => void;
  /** Question routing (P2-03); default: the log, with liveness from `statuses`. */
  questions?: QuestionRouting;
}

const TERMINAL = new Set<AgentEvent['type']>(['agent.finished', 'agent.failed', 'agent.stopped']);
type Terminal = 'agent.finished' | 'agent.failed' | 'agent.stopped' | 'agent.interrupted';

export interface RecoveryReport {
  /** Agents reopened from their session refs. */
  resumed: Id[];
  /** Agents left `interrupted`: no session ref, a runtime that cannot resume, or a failed resume. */
  needAttention: Id[];
}

const LIVE_STATES: ReadonlySet<string> = new Set([
  'starting',
  'working',
  'waiting_for_input',
  'idle',
  'stalled',
  'paused',
]);

interface Live {
  agent: Agent;
  adapter: AgentAdapter;
  /** Set once the adapter's `spawn`/`resumeSession` resolved. */
  handle: SpawnHandle | undefined;
  /** Events the adapter emitted before the handle came back: routed after `agent.spawned`. */
  early: AgentEvent[];
  inbox: AgentInbox;
  /** Question ids currently open for this agent (adapter-assigned). */
  questions: Set<Id>;
  paused: boolean;
  idle: boolean;
  /** A cap was hit: the stop under way ends in `agent.failed(cap)` with this reason. */
  capStop: string | undefined;
  /** A cap hit before the session handle existed: acted on once the handle arrives. */
  pendingCap: string | undefined;
  /** Someone asked for a stop that is still under way: it ends as `agent.stopped{by}`. */
  stopRequested: Actor | undefined;
  /** Questions whose answer is being handed to the adapter (not withdrawn by a racing idle). */
  answering: Set<Id>;
  /** The one terminal event routed for this agent. */
  terminal: Terminal | undefined;
  /** How the session was opened; `renewSession()` opens the next one the same way. */
  spec: SpawnRequest;
  /**
   * A brain's mailbox owns its messages (P2-06): `send()` only logs them and the brain runner
   * folds them into its next turn; only a `turn` message reaches the inbox.
   */
  mailbox: boolean;
}

const SYSTEM: Actor = { type: 'system' };

/** One agent's trace in the log, as recovery needs it. */
class AgentHistory {
  /** A `control.stop` after the agent's last (re)spawn that no terminal event answered. */
  stopRequested: Actor | undefined;
  readonly sent: { messageId: Id; text: string; sender: Actor }[] = [];
  readonly delivered = new Set<Id>();
  /** Messages the agent never received, in send order. */
  undelivered(): { messageId: Id; text: string; sender: Actor }[] {
    return this.sent.filter((m) => !this.delivered.has(m.messageId));
  }
}
/** How many ended agent ids are remembered so a straggling event is told apart from a stranger. */
const ENDED_MEMORY = 1_000;

export class AgentRuntime {
  private readonly adapters = new Map<RuntimeName, AgentAdapter>();
  private readonly live = new Map<Id, Live>();
  private readonly byQuestion = new Map<Id, Id>();
  /** Recently ended agents, oldest first. */
  private readonly ended = new Set<Id>();
  private readonly now: () => string;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly pumps: Promise<void>[] = [];
  readonly caps: CapsEnforcer;
  private readonly questions: QuestionRouting;
  private disposed = false;

  constructor(private readonly opts: AgentRuntimeOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onError = opts.onError ?? (() => {});
    this.questions = opts.questions ?? logRouting(opts.log, livingFromStatuses(opts.statuses));
    this.caps = new CapsEnforcer({
      maxConcurrentAgents: opts.caps?.maxConcurrentAgents ?? 4,
      defaults: opts.caps?.defaults ?? DEFAULT_CAPS,
      onCapHit: (agentId, reason) => void this.onCapHit(agentId, reason),
    });
    for (const adapter of opts.adapters) {
      this.adapters.set(adapter.runtime, adapter);
      this.pumps.push(this.pump(adapter));
    }
  }

  adapter(runtime: RuntimeName): AgentAdapter | undefined {
    return this.adapters.get(runtime);
  }

  /** Agents with a live adapter session. */
  liveAgents(): Agent[] {
    return [...this.live.values()].map((l) => l.agent);
  }

  inbox(agentId: Id): AgentInbox | undefined {
    return this.live.get(agentId)?.inbox;
  }

  /**
   * Creates the agent (row + `agent.spawned`) and starts its session. Refused before anything is
   * written when the runtime is unknown or the concurrency cap is reached: a refused spawn
   * leaves no row, no body and no event behind — the reason goes back to the caller.
   */
  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    if (this.disposed) throw new Error('runtime disposed');
    const adapter = this.adapters.get(req.runtime);
    if (!adapter) return { ok: false, reason: `no adapter for runtime ${req.runtime}` };
    const gate = this.caps.canSpawn();
    if (!gate.ok) return { ok: false, reason: gate.reason };

    const agent = this.opts.log.runCommand((ctx) =>
      createAgent(ctx, {
        role: req.role,
        runtime: req.runtime,
        caps: this.caps.resolve(req.caps),
        ...(req.bodyId ? { bodyId: req.bodyId } : {}),
        ...(req.supervisorId ? { supervisorId: req.supervisorId } : {}),
        ...(req.taskId ? { taskId: req.taskId } : {}),
        ...(req.projectId ? { projectId: req.projectId } : {}),
        ...(req.agentId ? { agentId: req.agentId } : {}),
        meta: {
          cwd: req.cwd,
          prompt: req.prompt,
          ...(req.workspace ? { workspace: req.workspace } : {}),
          ...(req.permissionPolicy ? { permissionPolicy: req.permissionPolicy } : {}),
          ...(req.bare ? { bare: true } : {}),
        },
      }),
    ).value;
    return this.start(agent, req, adapter, (opts) => adapter.spawn(opts), false);
  }

  /**
   * Re-opens a saved session (P1-14): the agent row exists, the adapter resumes from its ref.
   * Low level — callers outside the runtime use `recoverAgent()`, which checks the agent is
   * interrupted and takes the policy and the pending messages from the log.
   */
  private async resume(
    agent: Agent,
    req: Omit<SpawnRequest, 'role' | 'runtime'>,
  ): Promise<SpawnResult> {
    if (this.disposed) throw new Error('runtime disposed');
    if (this.live.has(agent.id)) return { ok: false, reason: `agent ${agent.id} is running` };
    const adapter = this.adapters.get(agent.runtime);
    if (!adapter) return { ok: false, reason: `no adapter for runtime ${agent.runtime}` };
    if (!adapter.resumeSession || !agent.sessionRef) {
      return { ok: false, reason: `runtime ${agent.runtime} cannot resume sessions` };
    }
    const gate = this.caps.canSpawn();
    if (!gate.ok) return { ok: false, reason: gate.reason };
    const ref = agent.sessionRef;
    this.ended.delete(agent.id);
    return this.start(
      agent,
      { ...req, role: agent.role, runtime: agent.runtime },
      adapter,
      (opts) => adapter.resumeSession!(ref, opts),
      true,
    );
  }

  private async start(
    agent: Agent,
    req: SpawnRequest,
    adapter: AgentAdapter,
    open: (opts: SpawnOptions) => Promise<SpawnHandle>,
    resuming: boolean,
  ): Promise<SpawnResult> {
    const caps = agent.caps;
    // Registered before the adapter runs: whatever it emits before the handle comes back is
    // buffered and routed after `agent.spawned`, and counts against the caps from the start.
    const live: Live = {
      agent,
      adapter,
      handle: undefined,
      early: [],
      inbox: new AgentInbox(agent.id, {
        deliver: async (m) => {
          // The agent is busy from the moment it has the message (P1-33): a pause/resume or a
          // second message right after must not find it "idle".
          live.idle = false;
          await adapter.send(this.session(live), m.text, { interrupt: m.interrupt });
          if (!live.terminal) {
            this.record({ type: 'message.delivered', messageId: m.id, agentId: agent.id });
          }
        },
        interrupt: () => adapter.interrupt(this.session(live)),
        now: this.now,
        onError: (e) => this.onError(e, `inbox ${agent.id}`),
        ...(this.opts.inboxHistory !== undefined ? { history: this.opts.inboxHistory } : {}),
      }),
      questions: new Set(),
      paused: false,
      idle: false,
      capStop: undefined,
      pendingCap: undefined,
      stopRequested: undefined,
      answering: new Set(),
      terminal: undefined,
      spec: req,
      mailbox: false,
    };
    this.live.set(agent.id, live);
    this.caps.track(agent.id, caps);
    const gate = createPermissionGate({
      agentId: agent.id,
      policy: req.permissionPolicy ?? DEFAULT_PERMISSION_POLICY,
      workspace: req.workspace ?? req.cwd,
      cwd: req.cwd,
      caps: this.caps,
      ...(req.tools ? { serverTools: req.tools.map((t) => t.name) } : {}),
    });
    let handle: SpawnHandle;
    try {
      handle = await open({
        agentId: agent.id,
        role: agent.role,
        cwd: req.cwd,
        prompt: req.prompt,
        gate,
        caps,
        ...(req.tools ? { tools: req.tools } : {}),
        ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
        ...(req.bare ? { bare: true } : {}),
      });
    } catch (error) {
      const message = (error as Error).message;
      if (resuming) {
        // A failed resume leaves the agent interrupted (the status store keeps that state):
        // the log says so too, rather than a failure the projection would ignore.
        this.recordEnd(
          live,
          { type: 'agent.interrupted', agentId: agent.id, reason: `resume failed: ${message}` },
          'agent.interrupted',
        );
      } else {
        this.recordEnd(
          live,
          { type: 'agent.failed', agentId: agent.id, error: message, reason: 'runtime' },
          'agent.failed',
        );
      }
      return { ok: false, reason: message };
    }
    live.handle = handle;
    // The row's session ref and `agent.spawned` in one transaction (one write rule).
    try {
      live.agent = this.opts.log.runCommand((ctx) =>
        recordSpawned(ctx, live.agent, handle.sessionRef),
      ).value;
    } catch (error) {
      this.onError(error, `record agent.spawned ${agent.id}`);
    }
    for (const event of live.early.splice(0)) this.route(event);
    if (live.pendingCap && !live.terminal) void this.onCapHit(agent.id, live.pendingCap);
    return { ok: true, agent: live.agent };
  }

  private session(live: Live): string {
    if (!live.handle) throw new Error(`agent ${live.agent.id} has no session yet`);
    return live.handle.sessionId;
  }

  /**
   * Queues a message; delivered when the agent is idle, or now with `interrupt`. Logged as
   * `message.sent` (P1-22) before it is queued, so a restart knows what was still pending.
   */
  send(
    agentId: Id,
    text: string,
    opts: { sender: Actor; interrupt?: boolean; turn?: boolean },
  ): InboxMessage {
    const live = this.must(agentId);
    if (live.capStop || live.stopRequested || live.inbox.currentState === 'ended') {
      throw new Error(`agent ${agentId} is stopping`);
    }
    const messageId = `m-${randomUUID()}`;
    this.record({
      type: 'message.sent',
      messageId,
      agentId,
      sender: opts.sender,
      text,
      interrupt: opts.interrupt ?? false,
    });
    if (live.mailbox && !opts.turn) {
      // Logged only: the brain's mailbox picks it up from the log and folds it into a turn.
      return {
        id: messageId,
        agentId,
        text,
        sender: opts.sender,
        interrupt: opts.interrupt ?? false,
        queuedAt: this.now(),
      };
    }
    return live.inbox.enqueue(text, {
      sender: opts.sender,
      interrupt: opts.interrupt ?? false,
      id: messageId,
    });
  }

  /**
   * Hands the agent's messages to its brain mailbox (P2-06): from now on `send()` without `turn`
   * logs `message.sent` and queues nothing, and the brain runner delivers whole turns.
   */
  attachMailbox(agentId: Id): void {
    this.must(agentId).mailbox = true;
  }

  /**
   * Replaces a live agent's adapter session with a fresh one on the same row (P2-06: a brain's
   * periodic session reset with a carried summary in `prompt`). The old session is logged
   * `agent.interrupted{reason}` and stopped; its stragglers are dropped; then the adapter spawns
   * a new session with the original options and `agent.spawned` reports the new `sessionRef`.
   * Messages still queued in the old inbox are not carried over (a brain's inbox is empty
   * between turns). Refused while a stop is under way.
   */
  async renewSession(agentId: Id, prompt: string, reason = 'session reset'): Promise<SpawnResult> {
    if (this.disposed) throw new Error('runtime disposed');
    const live = this.must(agentId);
    if (!live.handle) return { ok: false, reason: `agent ${agentId} has no session yet` };
    if (live.capStop || live.stopRequested || live.terminal) {
      return { ok: false, reason: `agent ${agentId} is stopping` };
    }
    const { adapter, spec, mailbox } = live;
    const sessionId = live.handle.sessionId;
    const pending = live.inbox.pending().map((m) => m.id);
    // Same agent row, new session: its held questions stay with it (it lives on).
    this.recordEnd(
      live,
      { type: 'agent.interrupted', agentId, reason, pending },
      'agent.interrupted',
      { keepHeld: true },
    );
    try {
      await adapter.stop(sessionId);
    } catch (error) {
      this.onError(error, `renew stop ${agentId}`);
    }
    // The old session's own `agent.stopped` travels through the event queue: let the pump drop
    // it as a straggler before the new session registers under the same id.
    await new Promise((resolve) => setImmediate(resolve));
    const agent = this.opts.log.tables.agents.get(agentId) ?? live.agent;
    const gate = this.caps.canSpawn();
    if (!gate.ok) return { ok: false, reason: gate.reason };
    this.ended.delete(agentId);
    const result = await this.start(
      agent,
      { ...spec, prompt },
      adapter,
      (opts) => adapter.spawn(opts),
      false,
    );
    const next = this.live.get(agentId);
    if (result.ok && next && mailbox) next.mailbox = true;
    return result;
  }

  /** Whether a live session asked `questionId` and waits for its answer through the adapter. */
  hasQuestion(questionId: Id): boolean {
    return this.byQuestion.has(questionId);
  }

  async answer(questionId: Id, answer: string, by: Actor): Promise<void> {
    const agentId = this.byQuestion.get(questionId);
    if (!agentId) throw new Error(`no open question ${questionId}`);
    const live = this.must(agentId);
    if (live.answering.has(questionId)) {
      throw new DomainError('stale', `question ${questionId} is already being answered`);
    }
    // The full check before the agent sees anything; afterwards the record only needs it open.
    const current = this.opts.log.tables.questions.get(questionId);
    if (!current) throw new Error(`no open question ${questionId}`);
    checkAnswer(current, { questionId, answer, answeredBy: by });
    // The adapter first: a question it no longer knows (re-asked after a resume) must not leave
    // an answer in the log that the agent never saw.
    live.answering.add(questionId);
    try {
      await live.adapter.answer(questionId, answer);
    } finally {
      live.answering.delete(questionId);
    }
    live.questions.delete(questionId);
    this.byQuestion.delete(questionId);
    // Not `command()`: a refused record (the question was cancelled meanwhile) reaches the caller.
    this.opts.log.runCommand((ctx) =>
      answerQuestion(ctx, {
        questionId,
        answer,
        answeredBy: by,
        holders: holdersNow(ctx, questionId, this.questions),
        delivered: true,
      }),
    );
  }

  async pause(agentId: Id, by: Actor): Promise<void> {
    const live = this.must(agentId);
    if (live.paused) return;
    const session = this.session(live); // no session yet: refused before anything is logged
    this.record({ type: 'control.pause', target: { kind: 'agent', id: agentId }, by });
    live.paused = true;
    live.inbox.paused();
    try {
      await live.adapter.pause(session);
    } catch (error) {
      // The adapter refused (nothing to freeze): the runtime is not paused either.
      live.paused = false;
      live.inbox.resumed(live.idle);
      throw error;
    }
  }

  async resumeAgent(agentId: Id, by: Actor): Promise<void> {
    const live = this.must(agentId);
    if (!live.paused) return;
    const session = this.session(live);
    this.record({ type: 'control.resume', target: { kind: 'agent', id: agentId }, by });
    await live.adapter.resume(session); // a failure leaves the agent paused, as the adapter is
    this.unpaused(live);
  }

  /** The runtime's side of a resume: delivery restarts (an interrupt queued meanwhile first). */
  private unpaused(live: Live): void {
    if (!live.paused) return;
    live.paused = false;
    live.inbox.resumed(live.idle);
  }

  /** Cancels the current turn. A paused agent is resumed first: a frozen one cannot end a turn. */
  async interrupt(agentId: Id): Promise<void> {
    const live = this.must(agentId);
    if (live.paused) await this.resumeAgent(agentId, SYSTEM);
    await live.adapter.interrupt(this.session(live));
  }

  /**
   * Graceful stop. Ends in exactly one terminal event: the adapter's `agent.stopped`, or — if
   * the adapter's stop resolved without one — `agent.stopped{by}` from the runtime, or
   * `agent.failed(runtime)` when the adapter's stop threw (P1-32: never an unkillable agent).
   */
  async stop(agentId: Id, by: Actor): Promise<void> {
    const live = this.live.get(agentId);
    if (!live || !live.handle || live.terminal) return;
    const sessionId = live.handle.sessionId;
    if (!live.stopRequested && !live.capStop) {
      live.stopRequested = by;
      this.record({ type: 'control.stop', target: { kind: 'agent', id: agentId }, by });
    }
    try {
      await live.adapter.stop(sessionId);
    } catch (error) {
      this.onError(error, `stop ${agentId}`);
      if (live.capStop) this.failForCap(live);
      else {
        this.recordEnd(
          live,
          {
            type: 'agent.failed',
            agentId,
            error: `stop failed: ${(error as Error).message}`,
            reason: 'runtime',
          },
          'agent.failed',
        );
      }
      return;
    }
    // The adapter's own `agent.stopped` travels through its event queue: let it arrive first.
    await new Promise((resolve) => setImmediate(resolve));
    if (live.terminal) return;
    if (live.capStop) this.failForCap(live);
    else this.recordEnd(live, { type: 'agent.stopped', agentId, by }, 'agent.stopped');
  }

  /**
   * Graceful shutdown (P1-14, P1-15, P1-32; SPEC decision 8). Every live agent's fate is logged
   * first — `agent.interrupted{pending}` (its session ref is already on the row), or, when a stop
   * or a cap stop was already under way, the `agent.stopped` / `agent.failed(cap)` it was heading
   * for, so the next start does not resume an agent the user stopped — and the transcripts are
   * flushed; then every process is stopped in parallel. Events the adapters emit afterwards are
   * dropped: the log already says how each agent ended.
   */
  async shutdown(reason = 'server shutdown'): Promise<Id[]> {
    const interrupted: Id[] = [];
    const stops: { live: Live; sessionId: string }[] = [];
    for (const live of [...this.live.values()]) {
      if (live.terminal) continue;
      const agentId = live.agent.id;
      if (live.capStop) this.failForCap(live);
      else if (live.stopRequested) {
        this.recordEnd(
          live,
          { type: 'agent.stopped', agentId, by: live.stopRequested },
          'agent.stopped',
        );
      } else {
        const pending = live.inbox.pending().map((m) => m.id);
        this.recordEnd(
          live,
          { type: 'agent.interrupted', agentId, reason, pending },
          'agent.interrupted',
        );
        interrupted.push(agentId);
      }
      if (live.handle) stops.push({ live, sessionId: live.handle.sessionId });
    }
    try {
      this.opts.transcripts.flush();
    } catch (error) {
      this.onError(error, 'shutdown flush');
    }
    const results = await Promise.allSettled(
      stops.map(({ live, sessionId }) => live.adapter.stop(sessionId)),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected')
        this.onError(r.reason, `shutdown stop ${stops[i]!.live.agent.id}`);
    });
    return interrupted;
  }

  /**
   * Startup recovery (P1-14, P1-29, P1-33). Agents whose last state is live died with the
   * previous server (nothing can re-attach to a live process): an agent with a stop under way is
   * marked `agent.stopped`, the others `agent.interrupted`. Every interrupted agent whose runtime
   * can resume is then reopened through `recoverAgent()`. The log is read once.
   */
  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { resumed: [], needAttention: [] };
    const histories = this.histories();
    for (const record of this.opts.statuses.all()) {
      if (!LIVE_STATES.has(record.state) || this.live.has(record.agentId)) continue;
      const stoppedBy = histories.get(record.agentId)?.stopRequested;
      this.command((ctx) => {
        ctx.emit(
          stoppedBy
            ? { type: 'agent.stopped', agentId: record.agentId, by: stoppedBy }
            : { type: 'agent.interrupted', agentId: record.agentId, reason: 'server restarted' },
        );
        endAgentQuestions(
          ctx,
          record.agentId,
          stoppedBy ? 'stopped' : 'interrupted',
          this.questions,
        );
      });
    }
    for (const record of this.opts.statuses.all()) {
      if (record.state !== 'interrupted') continue;
      const result = await this.recoverOne(record.agentId, histories.get(record.agentId));
      if (result.ok) report.resumed.push(record.agentId);
      else {
        this.onError(new Error(result.reason), `recover ${record.agentId}`);
        report.needAttention.push(record.agentId);
      }
    }
    return report;
  }

  /**
   * Reopens one interrupted agent from its session ref (the panel's "Resume session", P1-29):
   * refused unless the agent is `interrupted` and not running. The permission policy, workspace
   * and `bare` come from the agent's saved spawn options; every message sent to it that it never
   * received is delivered again, with its original id, before anything new.
   */
  async recoverAgent(agentId: Id): Promise<SpawnResult> {
    return this.recoverOne(agentId, this.histories(new Set([agentId])).get(agentId));
  }

  private async recoverOne(agentId: Id, history: AgentHistory | undefined): Promise<SpawnResult> {
    if (this.live.has(agentId)) return { ok: false, reason: `agent ${agentId} is running` };
    const state = this.opts.statuses.get(agentId)?.state;
    if (state !== 'interrupted') {
      return { ok: false, reason: `agent ${agentId} is ${state ?? 'unknown'}, not interrupted` };
    }
    const agent = this.opts.log.tables.agents.get(agentId);
    if (!agent) return { ok: false, reason: `no agent ${agentId}` };
    const meta = (agent.meta ?? {}) as {
      cwd?: string;
      prompt?: string;
      workspace?: string;
      permissionPolicy?: PermissionPolicy;
      bare?: boolean;
    };
    if (!meta.cwd) return { ok: false, reason: 'agent has no saved working directory' };
    const result = await this.resume(agent, {
      cwd: meta.cwd,
      prompt: meta.prompt ?? '',
      ...(meta.workspace ? { workspace: meta.workspace } : {}),
      ...(meta.permissionPolicy ? { permissionPolicy: meta.permissionPolicy } : {}),
      ...(meta.bare ? { bare: true } : {}),
    });
    if (!result.ok) return result;
    const live = this.live.get(agentId);
    for (const m of history?.undelivered() ?? []) {
      live?.inbox.enqueue(m.text, { sender: m.sender, id: m.messageId, interrupt: false });
    }
    return result;
  }

  /**
   * What the log says about agents (one pass, paged): whether a stop was under way when the
   * server died, and which `message.sent` messages never got a `message.delivered`.
   */
  private histories(only?: ReadonlySet<Id>): Map<Id, AgentHistory> {
    const out = new Map<Id, AgentHistory>();
    const of = (id: Id) => {
      let h = out.get(id);
      if (!h) out.set(id, (h = new AgentHistory()));
      return h;
    };
    const PAGE = 5_000;
    let since = 0;
    for (;;) {
      const page = this.opts.log.eventsSince(since, PAGE);
      for (const { seq, event: ev } of page) {
        since = seq;
        switch (ev.type) {
          case 'agent.spawned':
            if (!only || only.has(ev.agentId)) of(ev.agentId).stopRequested = undefined;
            break;
          case 'control.stop':
            if (ev.target.kind === 'agent' && (!only || only.has(ev.target.id))) {
              of(ev.target.id).stopRequested = ev.by;
            }
            break;
          case 'agent.stopped':
          case 'agent.finished':
          case 'agent.failed':
          case 'agent.interrupted':
            if (!only || only.has(ev.agentId)) of(ev.agentId).stopRequested = undefined;
            break;
          case 'message.sent':
            if (!only || only.has(ev.agentId)) of(ev.agentId).sent.push(ev);
            break;
          case 'message.delivered':
            if (!only || only.has(ev.agentId)) of(ev.agentId).delivered.add(ev.messageId);
            break;
          default:
            break;
        }
      }
      if (page.length < PAGE) break;
    }
    return out;
  }

  /** Stops every live agent (graceful) and closes the adapters. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const stops = await Promise.allSettled(this.liveAgents().map((a) => this.stop(a.id, SYSTEM)));
    for (const s of stops) if (s.status === 'rejected') this.onError(s.reason, 'dispose stop');
    const disposals = await Promise.allSettled([...this.adapters.values()].map((a) => a.dispose()));
    for (const d of disposals)
      if (d.status === 'rejected') this.onError(d.reason, 'dispose adapter');
    await Promise.allSettled(this.pumps);
    this.caps.dispose();
  }

  // ---------------------------------------------------------------------------

  private must(agentId: Id): Live {
    const live = this.live.get(agentId);
    if (!live) throw new Error(`agent ${agentId} is not running`);
    return live;
  }

  /** Appends an event under the one write rule; the status store sees it as a log subscriber. */
  private record(event: Event): void {
    this.command(({ emit }) => emit(event));
  }

  /** Runs a domain command; a failure is reported, never thrown into the adapter's stream. */
  private command<T>(fn: (ctx: CommandContext) => T): T | undefined {
    try {
      return this.opts.log.runCommand(fn).value;
    } catch (error) {
      this.onError(error, 'command');
      return undefined;
    }
  }

  private async pump(adapter: AgentAdapter): Promise<void> {
    try {
      for await (const event of adapter.events) {
        try {
          this.route(event);
        } catch (error) {
          // One bad event must not stop the stream: the next ones still reach the log.
          this.onError(error, `routing ${event.type} of ${event.agentId}`);
        }
      }
    } catch (error) {
      this.onError(error, `events of ${adapter.runtime}`);
    }
  }

  private route(raw: AgentEvent): void {
    const live = this.live.get(raw.agentId);
    if (!live) {
      // A straggler from an agent that already ended (its `agent.stopped` after a cap failure,
      // output after a crash) is expected and dropped; a stranger is an adapter bug.
      if (!this.ended.has(raw.agentId)) {
        this.onError(
          new Error(`${raw.type} for unknown agent ${raw.agentId}`),
          `routing ${raw.type}`,
        );
      }
      return;
    }
    if (!live.handle) {
      live.early.push(raw);
      return;
    }
    if (raw.type === 'agent.output') {
      // Raw text: the pipeline redacts with the context of the previous chunk (P1-31), which a
      // chunk redacted on its own would have lost.
      this.opts.transcripts.append(raw.agentId, raw.kind, raw.text);
      this.opts.statuses.touch(raw.agentId);
      if (!live.paused) live.idle = false;
      return;
    }
    const event = redactEvent(raw);
    if (TERMINAL.has(event.type)) {
      this.terminal(live, event as Extract<AgentEvent, { type: Terminal }>);
      return;
    }
    if (event.type === 'agent.needs_input') {
      // The question row and the event in one transaction: the server owns questions (§5.3),
      // routed to its holder by the question service (P2-03).
      this.command((ctx) => {
        ctx.emit(event);
        openFromNeedsInput(ctx, event, this.questions);
      });
    } else if (event.type === 'agent.idle' && live.questions.size > live.answering.size) {
      // Idle while a question is open: an interrupt withdrew it (P1-34). Cancelled with the event.
      const withdrawn = [...live.questions].filter((q) => !live.answering.has(q));
      this.command((ctx) => {
        ctx.emit(event);
        for (const q of withdrawn) {
          cancelQuestion(
            ctx,
            q,
            'withdrawn: the agent went idle without an answer',
            holdersNow(ctx, q, this.questions),
          );
        }
      });
      for (const q of withdrawn) {
        live.questions.delete(q);
        this.byQuestion.delete(q);
      }
    } else {
      this.record(event);
    }
    // Caps after the log so a tripping tool call precedes the stop it causes.
    this.caps.onEvent(event);
    switch (event.type) {
      case 'agent.idle':
        live.idle = true;
        if (!live.paused) live.inbox.idle();
        return;
      case 'agent.needs_input':
        live.questions.add(event.questionId);
        this.byQuestion.set(event.questionId, event.agentId);
        live.idle = false;
        live.inbox.working();
        return;
      case 'agent.tool_call':
      case 'agent.progress':
      case 'agent.stalled':
        live.idle = false;
        if (!live.paused) live.inbox.working();
        return;
      case 'agent.resumed':
        // The adapter thawed the agent itself (an interrupt while paused): so does the runtime.
        this.unpaused(live);
        return;
      default:
        return;
    }
  }

  /** The one terminal event: the adapter's verdict, or `failed(cap)` when a cap stop is under way. */
  private terminal(live: Live, event: Extract<AgentEvent, { type: Terminal }>): void {
    if (live.terminal) return;
    if (live.capStop && event.type === 'agent.stopped') {
      this.failForCap(live);
      return;
    }
    this.caps.onEvent(event);
    this.recordEnd(live, event, event.type);
  }

  private failForCap(live: Live): void {
    if (live.terminal) return;
    this.recordEnd(
      live,
      { type: 'agent.failed', agentId: live.agent.id, error: live.capStop ?? 'cap', reason: 'cap' },
      'agent.failed',
    );
  }

  /**
   * Logs how the agent ended, cancels its open questions and re-routes the ones it held (P2-03)
   * in the same command, then forgets it.
   */
  private recordEnd(
    live: Live,
    event: Event,
    terminal: Terminal,
    opts: { keepHeld?: boolean } = {},
  ): void {
    if (live.terminal) return;
    this.command((ctx) => {
      ctx.emit(event);
      endAgentQuestions(ctx, live.agent.id, terminal.slice('agent.'.length), this.questions, opts);
    });
    this.end(live, terminal);
  }

  private end(live: Live, terminal: Terminal): void {
    if (live.terminal) return;
    live.terminal = terminal;
    live.inbox.ended();
    for (const q of live.questions) this.byQuestion.delete(q);
    live.questions.clear();
    this.caps.release(live.agent.id);
    // The log and the status store keep the history; the runtime forgets the session.
    this.live.delete(live.agent.id);
    this.ended.add(live.agent.id);
    if (this.ended.size > ENDED_MEMORY) {
      const oldest = this.ended.values().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }
  }

  /**
   * Called by the caps enforcer: graceful stop, then `agent.failed(reason: cap)` — once,
   * whichever comes first: the adapter's `agent.stopped` (folded by `terminal()`) or the stop
   * call resolving. A verdict already on the wire (`finished`/`failed`) wins.
   */
  async onCapHit(agentId: Id, reason: string): Promise<void> {
    const live = this.live.get(agentId);
    if (!live || live.terminal) return;
    if (!live.handle) {
      live.pendingCap = reason; // acted on by start() once the session exists
      return;
    }
    if (live.capStop) return;
    live.capStop = reason;
    live.inbox.ended();
    this.record({ type: 'control.stop', target: { kind: 'agent', id: agentId }, by: SYSTEM });
    try {
      await live.adapter.stop(live.handle.sessionId);
    } catch (error) {
      this.onError(error, `cap stop ${agentId}`);
    }
    this.failForCap(live);
  }
}
