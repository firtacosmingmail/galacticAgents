import { randomUUID } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import {
  REPLAY_SKIPPED_EVENT_TYPES,
  type Event,
  type EventEnvelope,
  type EventType,
  type HistoryEventsParams,
  type HistoryEventsResponse,
  type Id,
} from '@galactic/protocol';

/**
 * The timeline scrubber's read (P4-07; TECHNOLOGY §6.3 "Timeline replay"): the events of the log
 * that touch one project, oldest first, paged forward by `seq`.
 *
 * **Which events.** What belongs to the project is decided from the tables as they are when a read
 * starts (its first page; later pages pass the `membership` token back and reuse those members, so
 * the pages of one read agree): the
 * project and its sub-projects (by `parentProjectId`, transitively), their tasks, every agent
 * working on one of them, the questions those agents asked, and the Waykeeper's plan cards
 * (`meta.plan.projectId`). Bodies are those the project, its tasks or its agents live on, plus every
 * body the log ever assigned to or moved one of them from or to (a task's asteroid before it joined
 * the project, a promotion's old body), found by `type` (indexed) — moves and assignments are rare.
 * An event is returned when it is about one of those (see `touches`), unless its type changes
 * nothing the scene draws (`REPLAY_SKIPPED_EVENT_TYPES`: chat, panel actions, notifications).
 * Known limit: membership comes from the current tables, so work that has *left* the project (a
 * task moved to another project, an agent handed elsewhere) is not a member and its past here is
 * missing from the replay.
 *
 * **Why no snapshot.** The client folds the returned events from the log's start with its ordinary
 * reducer (`applyEvent`), so the server never folds a world at `from`. A project's own events are a
 * small slice of the log (its rows' lifecycle plus its agents' `agent.*` events — tool calls are
 * the bulk, about one per tool use), so shipping all of them is cheaper and simpler than a second
 * fold on the server, and keeps one implementation of the fold (the client's, which the
 * conformance test holds to the server's tables).
 *
 * **Cost.** Each page reads a window of at most `SCAN_WINDOW` rows by rowid (`id > after`), never
 * a sort and never more than the window, and parses only rows whose type is not skipped; the
 * window's end (or the row where the page filled up) is the next `after`. Reading a whole project
 * walks the log once. No index serves "any of a dozen payload fields is one of these ids", and the
 * walk is bounded per request, so none is added (measured in `docs/tasks/notes/P4-07-scrubber.md`).
 *
 * Redaction parity: rows are returned as the log holds them, which is what the stream sends
 * (`EventLog.eventsSince`): secrets were redacted before the events were written.
 */
export const SCAN_WINDOW = 20_000;

/**
 * How many read sequences keep their members, and for how long: a replay reads its pages back to
 * back, so a few minutes and a handful of concurrent reads are plenty.
 */
const MEMBERSHIP_SLOTS = 32;
const MEMBERSHIP_TTL_MS = 10 * 60_000;

interface Members {
  projects: Set<Id>;
  tasks: Set<Id>;
  agents: Set<Id>;
  questions: Set<Id>;
  proposals: Set<Id>;
  bodies: Set<Id>;
  /** The deliverables of those projects and tasks (P9-01), removed ones included. */
  deliverables: Set<Id>;
}

export class HistoryEvents {
  private readonly stmts = new Map<string, Statement>();
  /** Members by token (insertion order = age), so a read's later pages filter as its first did. */
  private readonly memberships = new Map<string, { projectId: Id; members: Members; at: number }>();

  constructor(
    private readonly db: Database,
    private readonly window = SCAN_WINDOW,
  ) {}

  private stmt(sql: string): Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Whether the project exists (the route answers 404 otherwise). */
  has(projectId: Id): boolean {
    return this.stmt('SELECT 1 FROM projects WHERE id = ?').get(projectId) !== undefined;
  }

  read(query: HistoryEventsParams): HistoryEventsResponse {
    const { projectId, limit } = query;
    const after = query.after ?? 0;
    const from = query.from ? Date.parse(query.from) : undefined;
    const to = query.to ? Date.parse(query.to) : undefined;
    return this.db.transaction(() => {
      const { token: membership, members } = this.membersFor(projectId, query.membership);
      const end = after + this.window;
      const rows = this.stmt(
        'SELECT id, at, type, payload FROM events WHERE id > ? AND id <= ? ORDER BY id LIMIT ?',
      ).all(after, end, this.window) as { id: number; at: string; type: string; payload: string }[];
      const events: EventEnvelope[] = [];
      let filled: number | undefined;
      for (const row of rows) {
        if (REPLAY_SKIPPED_EVENT_TYPES.has(row.type as EventType)) continue;
        const time = Date.parse(row.at);
        if (from !== undefined && time < from) continue;
        if (to !== undefined && time > to) continue;
        const event = JSON.parse(row.payload) as Event;
        if (!touches(event, members)) continue;
        events.push({ seq: row.id, at: row.at, event });
        if (events.length >= limit) {
          filled = row.id;
          break;
        }
      }
      const last = (
        this.stmt('SELECT COALESCE(MAX(id), 0) AS seq FROM events').get() as { seq: number }
      ).seq;
      // A full page stops at its last event; otherwise the whole window was read.
      const seq = filled ?? Math.max(after, Math.min(end, last));
      return { projectId, events, seq, hasMore: seq < last, membership };
    })();
  }

  /**
   * The members a read sequence filters by: those its first page computed (by `token`), else
   * computed now under a new token. Bounded: the oldest token goes past `MEMBERSHIP_SLOTS`, and a
   * token older than `MEMBERSHIP_TTL_MS` is not reused.
   */
  private membersFor(
    projectId: Id,
    token: string | undefined,
  ): { token: string; members: Members } {
    const now = Date.now();
    for (const [key, entry] of this.memberships) {
      if (now - entry.at > MEMBERSHIP_TTL_MS) this.memberships.delete(key);
    }
    const known = token ? this.memberships.get(token) : undefined;
    if (token && known && known.projectId === projectId) return { token, members: known.members };
    const fresh = { token: randomUUID(), members: this.members(projectId) };
    this.memberships.set(fresh.token, { projectId, members: fresh.members, at: now });
    while (this.memberships.size > MEMBERSHIP_SLOTS) {
      this.memberships.delete(this.memberships.keys().next().value!);
    }
    return fresh;
  }

  /** The ids that belong to the project now (see the class comment). */
  private members(projectId: Id): Members {
    const projects = new Set<Id>([projectId]);
    const children = this.stmt(
      'SELECT id, parent_project_id AS parent FROM projects WHERE parent_project_id IS NOT NULL',
    ).all() as { id: Id; parent: Id }[];
    for (let grew = true; grew;) {
      grew = false;
      for (const c of children) {
        if (projects.has(c.parent) && !projects.has(c.id)) {
          projects.add(c.id);
          grew = true;
        }
      }
    }
    const bodies = new Set<Id>();
    const projectRows = this.stmt('SELECT id, body_id AS bodyId FROM projects').all() as {
      id: Id;
      bodyId: Id;
    }[];
    for (const p of projectRows) if (projects.has(p.id)) bodies.add(p.bodyId);
    const tasks = new Set<Id>();
    const taskRows = this.stmt(
      'SELECT id, project_id AS projectId, body_id AS bodyId FROM tasks WHERE project_id IS NOT NULL',
    ).all() as { id: Id; projectId: Id; bodyId: Id }[];
    for (const t of taskRows) {
      if (!projects.has(t.projectId)) continue;
      tasks.add(t.id);
      bodies.add(t.bodyId);
    }
    const agents = new Set<Id>();
    const agentRows = this.stmt(
      `SELECT id, project_id AS projectId, task_id AS taskId, body_id AS bodyId FROM agents
        WHERE project_id IS NOT NULL OR task_id IS NOT NULL`,
    ).all() as { id: Id; projectId: Id | null; taskId: Id | null; bodyId: Id }[];
    for (const a of agentRows) {
      if ((a.projectId && projects.has(a.projectId)) || (a.taskId && tasks.has(a.taskId))) {
        agents.add(a.id);
        bodies.add(a.bodyId);
      }
    }
    const questions = new Set<Id>();
    const questionRows = this.stmt(
      'SELECT id, origin_agent_id AS agentId FROM questions',
    ).all() as { id: Id; agentId: Id }[];
    for (const q of questionRows) if (agents.has(q.agentId)) questions.add(q.id);
    const proposals = new Set<Id>();
    const planRows = this.stmt(
      `SELECT id, json_extract(meta, '$.plan.projectId') AS projectId FROM proposals
        WHERE json_extract(meta, '$.plan.projectId') IS NOT NULL`,
    ).all() as { id: Id; projectId: Id }[];
    for (const p of planRows) if (projects.has(p.projectId)) proposals.add(p.id);
    // Every body the log put this work on or moved it from (indexed by `type`).
    const hosts = new Set<Id>([...projects, ...tasks]);
    const placements = this.stmt(
      `SELECT payload FROM events WHERE type IN ('body.assigned', 'body.moved') ORDER BY id`,
    ).all() as { payload: string }[];
    for (const { payload } of placements) {
      const e = JSON.parse(payload) as Extract<Event, { type: 'body.assigned' | 'body.moved' }>;
      const ours = hosts.has(e.host.id) || (e.type === 'body.moved' && hosts.has(e.intoProjectId!));
      if (!ours) continue;
      if (e.type === 'body.assigned') bodies.add(e.bodyId);
      else bodies.add(e.fromBodyId).add(e.toBodyId);
    }
    const deliverables = new Set<Id>();
    const deliverableRows = this.stmt(
      'SELECT id, project_id AS projectId, task_id AS taskId FROM deliverables',
    ).all() as { id: Id; projectId: Id | null; taskId: Id | null }[];
    for (const d of deliverableRows) {
      if ((d.projectId && projects.has(d.projectId)) || (d.taskId && tasks.has(d.taskId))) {
        deliverables.add(d.id);
      }
    }
    return { projects, tasks, agents, questions, proposals, bodies, deliverables };
  }
}

/** Whether an event is about the project's members (an exhaustive switch over the event types). */
export function touches(event: Event, m: Members): boolean {
  const hosts = (id: Id) => m.projects.has(id) || m.tasks.has(id);
  switch (event.type) {
    case 'project.created':
      return m.projects.has(event.project.id);
    case 'project.updated':
    case 'project.state_changed':
      return m.projects.has(event.projectId);
    case 'task.created':
      return m.tasks.has(event.task.id);
    case 'task.updated':
    case 'task.state_changed':
      return m.tasks.has(event.taskId);
    case 'body.created':
      return m.bodies.has(event.body.id);
    case 'body.assigned':
      return hosts(event.host.id);
    case 'body.moved':
      return hosts(event.host.id) || (!!event.intoProjectId && m.projects.has(event.intoProjectId));
    case 'body.freed':
    case 'body.retired':
      return m.bodies.has(event.bodyId);
    case 'agent.created':
      return m.agents.has(event.agent.id);
    case 'question.opened':
      return m.questions.has(event.question.id) || m.agents.has(event.question.originAgentId);
    case 'question.escalated':
    case 'question.answered':
    case 'question.cancelled':
    case 'question.reassigned':
      return m.questions.has(event.questionId);
    case 'proposal.created':
      return m.proposals.has(event.proposal.id);
    case 'proposal.approved':
    case 'proposal.edited':
    case 'proposal.rejected':
    case 'proposal.parked':
    case 'proposal.unparked':
    case 'promotion.carried_out':
      return m.proposals.has(event.proposalId);
    case 'agent.updated':
    case 'agent.spawned':
    case 'agent.output':
    case 'agent.tool_call':
    case 'agent.needs_input':
    case 'agent.progress':
    case 'agent.idle':
    case 'agent.stalled':
    case 'agent.paused':
    case 'agent.resumed':
    case 'agent.finished':
    case 'agent.failed':
    case 'agent.stopped':
    case 'agent.interrupted':
    case 'recovery.needs_attention':
    case 'agent.processes_stopped':
    case 'message.sent':
    case 'message.delivered':
    case 'permission.decided':
      return m.agents.has(event.agentId);
    case 'permission.rule_added':
      return m.projects.has(event.rule.projectId);
    case 'permission.rule_removed':
      return m.projects.has(event.projectId);
    case 'control.stop':
    case 'control.cancel':
    case 'control.pause':
    case 'control.resume':
    case 'control.edit':
    case 'control.close':
    case 'control.archive':
    case 'control.pin':
    case 'control.reopen':
      return false; // skipped anyway: their effects arrive as domain events
    case 'budget.set':
    case 'budget.warning':
    case 'budget.exceeded':
    case 'budget.spawn_refused':
      return event.target.kind === 'project'
        ? m.projects.has(event.target.id)
        : m.tasks.has(event.target.id);
    case 'deliverable.added':
      return m.deliverables.has(event.deliverable.id);
    case 'deliverable.updated':
    case 'deliverable.removed':
    case 'deliverable.restored':
    case 'deliverable.opened':
    case 'run.ports':
    case 'run.ended':
      return m.deliverables.has(event.deliverableId);
    case 'run.started':
      return m.deliverables.has(event.run.deliverableId);
  }
}
