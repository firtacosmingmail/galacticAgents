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
  type Body,
  type Event,
  type Id,
  type PermissionPolicy,
  type SpawnHandle,
  type ToolDefinition,
} from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import { AgentInbox, type InboxMessage } from './inbox.js';
import { CapsEnforcer, DEFAULT_CAPS } from './caps.js';
import { redactSecrets } from './redact.js';
import type { StatusStore } from './status-store.js';
import type { TranscriptPipeline } from './transcripts.js';

/**
 * The agent runtime: what ties an adapter's session to the rest of the server (P1-02, P1-05,
 * P1-07; TECHNOLOGY §3.4, §4, §6.2). For every agent it owns the inbox, the caps, the adapter
 * session, and the routing of the adapter's events:
 *
 *   agent.output  → transcript pipeline (redacted, batched) + status store `touch()`
 *   everything else → the event log (one write rule), whose subscribers include the status
 *                     store and, later, the brains' mailboxes
 *
 * `agent.spawned` is emitted here, not by adapters (they do not know bodies). Phase 2's
 * `spawnAgent` command will call `spawn()` after creating the rows; in Phase 1 `spawn()` also
 * creates the agent row (and a procedural asteroid when no body is given) so the ops console can
 * run standalone agents.
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
  now?: () => string;
  onError?: (error: unknown, context: string) => void;
}

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
  /** A terminal event (finished, failed, stopped) was routed. */
  ended: boolean;
  /** Which one; `agent.stopped` may be the tail of a cap stop, the other two are the agent's own verdict. */
  terminal: 'agent.finished' | 'agent.failed' | 'agent.stopped' | undefined;
}

const SYSTEM: Actor = { type: 'system' };

export class AgentRuntime {
  private readonly adapters = new Map<RuntimeName, AgentAdapter>();
  private readonly live = new Map<Id, Live>();
  private readonly byQuestion = new Map<Id, Id>();
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
    return [...this.live.values()].filter((l) => !l.ended).map((l) => l.agent);
  }

  inbox(agentId: Id): AgentInbox | undefined {
    return this.live.get(agentId)?.inbox;
  }

  /**
   * Creates the agent (row + `agent.spawned`) and starts its session. Refused, with the reason
   * in an `agent.failed(reason: cap)` event, when the concurrency cap is reached; refused with a
   * plain error when the runtime is unknown.
   */
  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    if (this.disposed) throw new Error('runtime disposed');
    const adapter = this.adapters.get(req.runtime);
    if (!adapter) return { ok: false, reason: `no adapter for runtime ${req.runtime}` };

    const agent = this.createAgent(req);
    const gate = this.caps.canSpawn();
    if (!gate.ok) {
      this.record({ type: 'agent.failed', agentId: agent.id, error: gate.reason, reason: 'cap' });
      return { ok: false, reason: gate.reason };
    }
    return this.start(agent, req, adapter, (opts) => adapter.spawn(opts));
  }

  /** Re-opens a saved session (P1-14): the agent row exists, the adapter resumes from its ref. */
  async resume(agent: Agent, req: Omit<SpawnRequest, 'role' | 'runtime'>): Promise<SpawnResult> {
    const adapter = this.adapters.get(agent.runtime);
    if (!adapter) return { ok: false, reason: `no adapter for runtime ${agent.runtime}` };
    if (!adapter.resumeSession || !agent.sessionRef) {
      return { ok: false, reason: `runtime ${agent.runtime} cannot resume sessions` };
    }
    const gate = this.caps.canSpawn();
    if (!gate.ok) {
      this.record({ type: 'agent.failed', agentId: agent.id, error: gate.reason, reason: 'cap' });
      return { ok: false, reason: gate.reason };
    }
    const ref = agent.sessionRef;
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
    open: (opts: Parameters<AgentAdapter['spawn']>[0]) => Promise<SpawnHandle>,
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
        deliver: (m) => adapter.send(this.session(live), m.text),
        interrupt: () => adapter.interrupt(this.session(live)),
        now: this.now,
        onError: (e) => this.onError(e, `inbox ${agent.id}`),
      }),
      questions: new Set(),
      paused: false,
      idle: false,
      ended: false,
      terminal: undefined,
    };
    this.live.set(agent.id, live);
    this.caps.track(agent.id, caps);
    let handle: SpawnHandle;
    try {
      handle = await open({
        agentId: agent.id,
        role: agent.role,
        cwd: req.cwd,
        workspace: req.workspace ?? req.cwd,
        prompt: req.prompt,
        permissionPolicy: req.permissionPolicy ?? DEFAULT_PERMISSION_POLICY,
        caps,
        ...(req.tools ? { tools: req.tools } : {}),
        ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
        ...(req.bare ? { bare: true } : {}),
      });
    } catch (error) {
      const message = (error as Error).message;
      this.live.delete(agent.id);
      this.caps.release(agent.id);
      this.record({ type: 'agent.failed', agentId: agent.id, error: message, reason: 'runtime' });
      return { ok: false, reason: message };
    }
    if (handle.sessionRef && handle.sessionRef !== agent.sessionRef) {
      agent = this.opts.log.runCommand(({ tables }) =>
        tables.agents.upsert({ ...agent, sessionRef: handle.sessionRef!, updatedAt: this.now() }),
      ).value;
      live.agent = agent;
    }
    live.handle = handle;
    this.record({
      type: 'agent.spawned',
      agentId: agent.id,
      role: agent.role,
      runtime: agent.runtime,
      bodyId: agent.bodyId,
      ...(handle.sessionRef ? { sessionRef: handle.sessionRef } : {}),
      ...(agent.supervisorId ? { supervisorId: agent.supervisorId } : {}),
      ...(agent.taskId ? { taskId: agent.taskId } : {}),
      ...(agent.projectId ? { projectId: agent.projectId } : {}),
    });
    for (const event of live.early.splice(0)) this.route(event);
    return { ok: true, agent };
  }

  private session(live: Live): string {
    if (!live.handle) throw new Error(`agent ${live.agent.id} has no session yet`);
    return live.handle.sessionId;
  }

  /** Queues a message; delivered when the agent is idle, or now with `interrupt`. */
  send(agentId: Id, text: string, opts: { sender: Actor; interrupt?: boolean }): InboxMessage {
    return this.must(agentId).inbox.enqueue(text, opts);
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
    this.record({ type: 'question.answered', questionId, answer, answeredBy: by, version: 0 });
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
    if (!live || live.ended || !live.handle) return;
    this.record({ type: 'control.stop', target: { kind: 'agent', id: agentId }, by });
    await live.adapter.stop(live.handle.sessionId);
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
    if (!live || live.ended) throw new Error(`agent ${agentId} is not running`);
    return live;
  }

  private createAgent(req: SpawnRequest): Agent {
    const now = this.now();
    const id = req.agentId ?? `a-${randomUUID()}`;
    return this.opts.log.runCommand(({ tables, emit }) => {
      let bodyId = req.bodyId;
      if (!bodyId) {
        // Phase 1 convenience: a standalone agent gets a procedural asteroid of its own.
        const body: Body = {
          id: `b-${randomUUID()}`,
          kind: 'asteroid',
          name: `Asteroid ${id.slice(2, 10)}`,
        };
        tables.bodies.insert(body);
        emit({ type: 'body.created', body });
        bodyId = body.id;
      }
      const agent: Agent = {
        id,
        role: req.role,
        runtime: req.runtime,
        bodyId,
        caps: this.caps.resolve(req.caps),
        createdAt: now,
        updatedAt: now,
        ...(req.supervisorId ? { supervisorId: req.supervisorId } : {}),
        ...(req.taskId ? { taskId: req.taskId } : {}),
        ...(req.projectId ? { projectId: req.projectId } : {}),
      };
      tables.agents.insert(agent);
      emit({ type: 'agent.created', agent });
      return agent;
    }).value;
  }

  /** Appends an event under the one write rule; the status store sees it as a log subscriber. */
  private record(event: Event): void {
    try {
      this.opts.log.runCommand(({ emit }) => emit(event));
    } catch (error) {
      this.onError(error, `record ${event.type}`);
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
    if (live && !live.handle) {
      live.early.push(raw);
      return;
    }
    const event = redactEvent(raw);
    if (event.type === 'agent.output') {
      this.opts.transcripts.append(event.agentId, event.kind, event.text);
      this.opts.statuses.touch(event.agentId);
      if (live && !live.paused) live.idle = false;
      return;
    }
    this.record(event);
    // Caps after the log so a tripping tool call precedes the stop it causes.
    this.caps.onEvent(event);
    if (!live) return;
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
      case 'agent.finished':
      case 'agent.failed':
      case 'agent.stopped':
        this.end(live, event.type);
        return;
      default:
        return;
    }
  }

  private end(live: Live, terminal: Live['terminal']): void {
    if (live.ended) return;
    live.ended = true;
    live.terminal = terminal;
    live.inbox.ended();
    for (const q of live.questions) this.byQuestion.delete(q);
    live.questions.clear();
    this.caps.release(live.agent.id);
    // The log and the status store keep the history; the runtime forgets the session.
    this.live.delete(live.agent.id);
  }

  /** Called by the caps enforcer: stop the agent, then report the cap. */
  async onCapHit(agentId: Id, reason: string): Promise<void> {
    const live = this.live.get(agentId);
    if (!live || live.ended || !live.handle) return;
    live.inbox.ended();
    this.record({ type: 'control.stop', target: { kind: 'agent', id: agentId }, by: SYSTEM });
    try {
      await live.adapter.stop(live.handle.sessionId);
    } catch (error) {
      this.onError(error, `cap stop ${agentId}`);
    }
    // A verdict that was already on the wire wins: the agent finished (or failed) on its own.
    if (live.terminal === 'agent.finished' || live.terminal === 'agent.failed') return;
    this.record({ type: 'agent.failed', agentId, error: reason, reason: 'cap' });
    this.end(live, 'agent.failed');
  }
}

/** Every string an agent event carries can hold a printed secret; redact them like output. */
export function redactEvent<T extends AgentEvent>(event: T): T {
  switch (event.type) {
    case 'agent.output':
      return { ...event, text: redactSecrets(event.text) };
    case 'agent.tool_call':
      return {
        ...event,
        ...(event.input !== undefined ? { input: redactValue(event.input) } : {}),
      };
    case 'agent.needs_input':
      return {
        ...event,
        question: {
          ...event.question,
          text: redactSecrets(event.question.text),
          ...(event.question.options
            ? { options: event.question.options.map((o) => redactSecrets(o)) }
            : {}),
          ...(event.question.toolCall
            ? {
                toolCall: {
                  ...event.question.toolCall,
                  ...(event.question.toolCall.input !== undefined
                    ? { input: redactValue(event.question.toolCall.input) }
                    : {}),
                },
              }
            : {}),
        },
      };
    case 'agent.progress':
      return { ...event, summary: redactSecrets(event.summary) };
    case 'agent.finished':
      return {
        ...event,
        ...(event.result !== undefined ? { result: redactSecrets(event.result) } : {}),
      };
    case 'agent.failed':
      return { ...event, error: redactSecrets(event.error) };
    default:
      return event;
  }
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)]));
  }
  return value;
}
