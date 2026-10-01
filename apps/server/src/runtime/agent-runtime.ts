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
import { answerQuestion, openQuestion } from '../domain/questions.js';
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
 *     reach the log — the adapter is reporting a session the server no longer owns.
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
  /** The one terminal event routed for this agent. */
  terminal: Terminal | undefined;
}

const SYSTEM: Actor = { type: 'system' };
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
  private disposed = false;

  constructor(private readonly opts: AgentRuntimeOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onError = opts.onError ?? (() => {});
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
        now: this.now(),
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
    return this.start(agent, req, adapter, (opts) => adapter.spawn(opts));
  }

  /** Re-opens a saved session (P1-14): the agent row exists, the adapter resumes from its ref. */
  async resume(agent: Agent, req: Omit<SpawnRequest, 'role' | 'runtime'>): Promise<SpawnResult> {
    if (this.disposed) throw new Error('runtime disposed');
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
    );
  }

  private async start(
    agent: Agent,
    req: SpawnRequest,
    adapter: AgentAdapter,
    open: (opts: SpawnOptions) => Promise<SpawnHandle>,
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
        deliver: (m) => adapter.send(this.session(live), m.text, { interrupt: m.interrupt }),
        interrupt: () => adapter.interrupt(this.session(live)),
        now: this.now,
        onError: (e) => this.onError(e, `inbox ${agent.id}`),
        ...(this.opts.inboxHistory !== undefined ? { history: this.opts.inboxHistory } : {}),
      }),
      questions: new Set(),
      paused: false,
      idle: false,
      capStop: undefined,
      terminal: undefined,
    };
    this.live.set(agent.id, live);
    this.caps.track(agent.id, caps);
    const gate = createPermissionGate({
      agentId: agent.id,
      policy: req.permissionPolicy ?? DEFAULT_PERMISSION_POLICY,
      workspace: req.workspace ?? req.cwd,
      cwd: req.cwd,
      caps: this.caps,
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
      this.record({ type: 'agent.failed', agentId: agent.id, error: message, reason: 'runtime' });
      this.end(live, 'agent.failed');
      return { ok: false, reason: message };
    }
    live.handle = handle;
    // The row's session ref and `agent.spawned` in one transaction (one write rule).
    try {
      live.agent = this.opts.log.runCommand((ctx) =>
        recordSpawned(ctx, live.agent, handle.sessionRef, this.now()),
      ).value;
    } catch (error) {
      this.onError(error, `record agent.spawned ${agent.id}`);
    }
    for (const event of live.early.splice(0)) this.route(event);
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
  send(agentId: Id, text: string, opts: { sender: Actor; interrupt?: boolean }): InboxMessage {
    const live = this.must(agentId);
    const messageId = `m-${randomUUID()}`;
    this.record({
      type: 'message.sent',
      messageId,
      agentId,
      sender: opts.sender,
      text,
      interrupt: opts.interrupt ?? false,
    });
    return live.inbox.enqueue(text, { ...opts, id: messageId });
  }

  async answer(questionId: Id, answer: string, by: Actor): Promise<void> {
    const agentId = this.byQuestion.get(questionId);
    if (!agentId) throw new Error(`no open question ${questionId}`);
    const live = this.must(agentId);
    // The adapter first: a question it no longer knows (re-asked after a resume) must not leave
    // an answer in the log that the agent never saw.
    await live.adapter.answer(questionId, answer);
    live.questions.delete(questionId);
    this.byQuestion.delete(questionId);
    this.command((ctx) => answerQuestion(ctx, questionId, answer, by, this.now()));
  }

  async pause(agentId: Id, by: Actor): Promise<void> {
    const live = this.must(agentId);
    if (live.paused) return;
    this.record({ type: 'control.pause', target: { kind: 'agent', id: agentId }, by });
    live.paused = true;
    live.inbox.paused();
    await live.adapter.pause(this.session(live));
  }

  async resumeAgent(agentId: Id, by: Actor): Promise<void> {
    const live = this.must(agentId);
    if (!live.paused) return;
    this.record({ type: 'control.resume', target: { kind: 'agent', id: agentId }, by });
    live.paused = false;
    await live.adapter.resume(this.session(live));
    live.inbox.resumed(live.idle);
  }

  async interrupt(agentId: Id): Promise<void> {
    const live = this.must(agentId);
    await live.adapter.interrupt(this.session(live));
  }

  async stop(agentId: Id, by: Actor): Promise<void> {
    const live = this.live.get(agentId);
    if (!live || !live.handle) return;
    this.record({ type: 'control.stop', target: { kind: 'agent', id: agentId }, by });
    await live.adapter.stop(live.handle.sessionId);
  }

  /**
   * Graceful shutdown (P1-14, P1-15; SPEC decision 8): every live agent is marked
   * `agent.interrupted` — its session ref is already on the row — and its process is stopped.
   * The adapter's own `agent.stopped` is dropped: the log says "interrupted", so the next start
   * knows to resume it rather than treat it as a user stop.
   */
  async shutdown(reason = 'server shutdown'): Promise<Id[]> {
    const interrupted: Id[] = [];
    for (const live of [...this.live.values()]) {
      if (live.terminal) continue;
      const pending = live.inbox.pending().map((m) => m.id);
      this.record({ type: 'agent.interrupted', agentId: live.agent.id, reason, pending });
      this.end(live, 'agent.interrupted');
      interrupted.push(live.agent.id);
      if (live.handle) {
        try {
          await live.adapter.stop(live.handle.sessionId);
        } catch (error) {
          this.onError(error, `shutdown stop ${live.agent.id}`);
        }
      }
    }
    return interrupted;
  }

  /**
   * Startup recovery (P1-14). Agents whose last state is live died with the previous server
   * (nothing can re-attach to a live process): they are marked `agent.interrupted` first. Every
   * interrupted agent whose runtime can resume is reopened from its session ref; messages sent
   * and answers given after the interruption are delivered as its first messages. The rest
   * stay `interrupted` for the panel's resume action.
   */
  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { resumed: [], needAttention: [] };
    const records = this.opts.statuses.all();
    for (const record of records) {
      if (LIVE_STATES.has(record.state)) {
        this.record({
          type: 'agent.interrupted',
          agentId: record.agentId,
          reason: 'server restarted',
        });
      }
    }
    for (const record of this.opts.statuses.all()) {
      if (record.state !== 'interrupted') continue;
      const agent = this.opts.log.tables.agents.get(record.agentId);
      const meta = (agent?.meta ?? {}) as {
        cwd?: string;
        prompt?: string;
        workspace?: string;
        permissionPolicy?: PermissionPolicy;
        bare?: boolean;
      };
      const adapter = agent ? this.adapters.get(agent.runtime) : undefined;
      if (!agent || !adapter?.resumeSession || !agent.sessionRef || !meta.cwd) {
        report.needAttention.push(record.agentId);
        continue;
      }
      const pending = this.pendingFor(agent.id);
      const result = await this.resume(agent, {
        cwd: meta.cwd,
        prompt: meta.prompt ?? '',
        ...(meta.workspace ? { workspace: meta.workspace } : {}),
        ...(meta.permissionPolicy ? { permissionPolicy: meta.permissionPolicy } : {}),
        ...(meta.bare ? { bare: true } : {}),
      });
      if (!result.ok) {
        this.onError(new Error(result.reason), `recover ${agent.id}`);
        report.needAttention.push(agent.id);
        continue;
      }
      report.resumed.push(agent.id);
      for (const first of pending) {
        this.must(agent.id).inbox.enqueue(first.text, { sender: first.sender, interrupt: false });
      }
    }
    return report;
  }

  /**
   * What the agent never got (P1-22 is the input): messages still queued when it was interrupted
   * — the exact ids a clean shutdown wrote into `agent.interrupted.pending`, or, after a crash
   * of the server, every message sent after the agent's last turn end — and answers to its
   * questions given after the interruption. In log order; redelivery logs nothing new.
   */
  private pendingFor(agentId: Id): { text: string; sender: Actor }[] {
    const all = this.opts.log.eventsSince(0, Number.MAX_SAFE_INTEGER);
    let interruptedAt = 0;
    let lastTurnEnd = 0;
    let known: Set<Id> | undefined;
    for (const e of all) {
      const ev = e.event;
      if (!('agentId' in ev) || ev.agentId !== agentId) continue;
      if (ev.type === 'agent.interrupted') {
        interruptedAt = e.seq;
        known = ev.pending ? new Set(ev.pending) : undefined;
      } else if (ev.type === 'agent.idle' || ev.type === 'agent.spawned') {
        lastTurnEnd = e.seq;
      }
    }
    const questions = new Set(
      this.opts.log.tables.questions
        .all()
        .filter((q) => q.originAgentId === agentId)
        .map((q) => q.id),
    );
    const out: { text: string; sender: Actor }[] = [];
    for (const e of all) {
      const ev = e.event;
      if (ev.type === 'message.sent' && ev.agentId === agentId) {
        const undelivered = known
          ? known.has(ev.messageId)
          : e.seq > lastTurnEnd && e.seq < interruptedAt;
        if (undelivered || e.seq > interruptedAt) out.push({ text: ev.text, sender: ev.sender });
      } else if (
        ev.type === 'question.answered' &&
        questions.has(ev.questionId) &&
        e.seq > interruptedAt
      ) {
        const q = this.opts.log.tables.questions.get(ev.questionId);
        out.push({
          text: `Answer to your earlier question "${q?.context.text ?? ev.questionId}": ${ev.answer}`,
          sender: ev.answeredBy,
        });
      }
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
    const event = redactEvent(raw);
    if (event.type === 'agent.output') {
      this.opts.transcripts.append(event.agentId, event.kind, event.text);
      this.opts.statuses.touch(event.agentId);
      if (!live.paused) live.idle = false;
      return;
    }
    if (TERMINAL.has(event.type)) {
      this.terminal(live, event as Extract<AgentEvent, { type: Terminal }>);
      return;
    }
    if (event.type === 'agent.needs_input') {
      // The question row and the event in one transaction: the server owns questions (§5.3).
      this.command((ctx) => {
        ctx.emit(event);
        openQuestion(ctx, {
          id: event.questionId,
          kind: event.kind,
          originAgentId: event.agentId,
          context: event.question,
          now: this.now(),
        });
      });
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
    this.record(event);
    this.caps.onEvent(event);
    this.end(live, event.type);
  }

  private failForCap(live: Live): void {
    if (live.terminal) return;
    this.record({
      type: 'agent.failed',
      agentId: live.agent.id,
      error: live.capStop ?? 'cap',
      reason: 'cap',
    });
    this.end(live, 'agent.failed');
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
    if (!live || live.terminal || !live.handle) return;
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
