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
  handle: SpawnHandle;
  inbox: AgentInbox;
  /** Question ids currently open for this agent (adapter-assigned). */
  questions: Set<Id>;
  paused: boolean;
  idle: boolean;
  ended: boolean;
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
    let handle: SpawnHandle;
    try {
      handle = await open({
        agentId: agent.id,
        role: agent.role,
        cwd: req.cwd,
        prompt: req.prompt,
        permissionPolicy: req.permissionPolicy ?? DEFAULT_PERMISSION_POLICY,
        caps,
        ...(req.tools ? { tools: req.tools } : {}),
        ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
        ...(req.bare ? { bare: true } : {}),
      });
    } catch (error) {
      const message = (error as Error).message;
      this.record({ type: 'agent.failed', agentId: agent.id, error: message, reason: 'runtime' });
      return { ok: false, reason: message };
    }
    if (handle.sessionRef && handle.sessionRef !== agent.sessionRef) {
      agent = this.opts.log.runCommand(({ tables }) =>
        tables.agents.upsert({ ...agent, sessionRef: handle.sessionRef!, updatedAt: this.now() }),
      ).value;
    }
    const live: Live = {
      agent,
      adapter,
      handle,
      inbox: new AgentInbox(agent.id, {
        deliver: (m) => adapter.send(handle.sessionId, m.text),
        interrupt: () => adapter.interrupt(handle.sessionId),
        now: this.now,
        onError: (e) => this.onError(e, `inbox ${agent.id}`),
      }),
      questions: new Set(),
      paused: false,
      idle: false,
      ended: false,
    };
    this.live.set(agent.id, live);
    this.caps.track(agent.id, caps);
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
    return { ok: true, agent };
  }

  /** Queues a message; delivered when the agent is idle, or now with `interrupt`. */
  send(agentId: Id, text: string, opts: { sender: Actor; interrupt?: boolean }): InboxMessage {
    return this.must(agentId).inbox.enqueue(text, opts);
  }

  async answer(questionId: Id, answer: string, by: Actor): Promise<void> {
    const agentId = this.byQuestion.get(questionId);
    if (!agentId) throw new Error(`no open question ${questionId}`);
    const live = this.must(agentId);
    live.questions.delete(questionId);
    this.byQuestion.delete(questionId);
    this.record({ type: 'question.answered', questionId, answer, answeredBy: by, version: 0 });
    await live.adapter.answer(questionId, answer);
  }

  async pause(agentId: Id, by: Actor): Promise<void> {
    const live = this.must(agentId);
    if (live.paused) return;
    this.record({ type: 'control.pause', target: { kind: 'agent', id: agentId }, by });
    live.paused = true;
    live.inbox.paused();
    await live.adapter.pause(live.handle.sessionId);
  }

  async resumeAgent(agentId: Id, by: Actor): Promise<void> {
    const live = this.must(agentId);
    if (!live.paused) return;
    this.record({ type: 'control.resume', target: { kind: 'agent', id: agentId }, by });
    live.paused = false;
    await live.adapter.resume(live.handle.sessionId);
    live.inbox.resumed(live.idle);
  }

  async interrupt(agentId: Id): Promise<void> {
    const live = this.must(agentId);
    await live.adapter.interrupt(live.handle.sessionId);
  }

  async stop(agentId: Id, by: Actor): Promise<void> {
    const live = this.live.get(agentId);
    if (!live || live.ended) return;
    this.record({ type: 'control.stop', target: { kind: 'agent', id: agentId }, by });
    await live.adapter.stop(live.handle.sessionId);
  }

  /** Stops every live agent (graceful) and closes the adapters. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(this.liveAgents().map((a) => this.stop(a.id, SYSTEM)));
    await Promise.all([...this.adapters.values()].map((a) => a.dispose()));
    await Promise.all(this.pumps);
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
      for await (const event of adapter.events) this.route(event);
    } catch (error) {
      this.onError(error, `events of ${adapter.runtime}`);
    }
  }

  private route(event: AgentEvent): void {
    const live = this.live.get(event.agentId);
    if (event.type === 'agent.output') {
      this.opts.transcripts.append(event.agentId, event.kind, event.text);
      this.opts.statuses.touch(event.agentId);
      if (live && !live.paused) live.idle = false;
      return;
    }
    // Caps first: a tool-call over the limit stops the agent before its event is even logged.
    this.caps.onEvent(event);
    this.record(event);
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
        live.ended = true;
        live.inbox.ended();
        for (const q of live.questions) this.byQuestion.delete(q);
        live.questions.clear();
        this.caps.release(event.agentId);
        return;
      default:
        return;
    }
  }

  /** Called by the caps enforcer: stop the agent, then report the cap. */
  async onCapHit(agentId: Id, reason: string): Promise<void> {
    const live = this.live.get(agentId);
    if (!live || live.ended) return;
    live.ended = true;
    live.inbox.ended();
    this.record({ type: 'control.stop', target: { kind: 'agent', id: agentId }, by: SYSTEM });
    try {
      await live.adapter.stop(live.handle.sessionId);
    } catch (error) {
      this.onError(error, `cap stop ${agentId}`);
    }
    this.record({ type: 'agent.failed', agentId, error: reason, reason: 'cap' });
  }
}
