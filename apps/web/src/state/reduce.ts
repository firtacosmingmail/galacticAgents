import type {
  Agent,
  Body,
  EventEnvelope,
  Id,
  Project,
  Proposal,
  Question,
  Snapshot,
  StatusRecord,
  Task,
} from '@galactic/protocol';
import { summarize, type SystemSummary } from '@galactic/protocol';

/** Everything the page knows, derived from the stream only (TECHNOLOGY §6.3). */
export interface WorldState {
  seq: number;
  bodies: Record<Id, Body>;
  projects: Record<Id, Project>;
  tasks: Record<Id, Task>;
  agents: Record<Id, Agent>;
  questions: Record<Id, Question>;
  proposals: Record<Id, Proposal>;
  statuses: Record<Id, StatusRecord>;
}

export const emptyWorld = (): WorldState => ({
  seq: 0,
  bodies: {},
  projects: {},
  tasks: {},
  agents: {},
  questions: {},
  proposals: {},
  statuses: {},
});

const byId = <T extends { id: Id }>(items: T[]): Record<Id, T> =>
  Object.fromEntries(items.map((i) => [i.id, i]));

export function applySnapshot(snapshot: Snapshot): WorldState {
  return {
    seq: snapshot.seq,
    bodies: byId(snapshot.bodies),
    projects: byId(snapshot.projects),
    tasks: byId(snapshot.tasks),
    agents: byId(snapshot.agents),
    questions: byId(snapshot.questions),
    proposals: byId(snapshot.proposals),
    statuses: Object.fromEntries(snapshot.statuses.map((s) => [s.agentId, s])),
  };
}

/** Applies `changes` to a known item; an `undefined` value means "unchanged", never "cleared". */
function patch<T extends object>(
  map: Record<Id, T>,
  id: Id,
  changes: { [K in keyof T]?: T[K] | undefined },
): Record<Id, T> {
  const current = map[id];
  if (!current) return map;
  const defined = Object.fromEntries(
    Object.entries(changes).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
  return { ...map, [id]: { ...current, ...defined } };
}

/**
 * Folds one event into the world. Pure: returns a new state, never mutates. The server's domain
 * commands emit events that fully describe their mutations and stamp rows with the event's `at`
 * (P2-01), so folding them here builds exactly the server's tables — `conformance.test.ts`
 * replays a recorded log and checks it against the server's snapshot at every commit.
 */
export function applyEvent(state: WorldState, { seq, at, event }: EventEnvelope): WorldState {
  const next = { ...state, seq };
  switch (event.type) {
    case 'project.created':
      return { ...next, projects: { ...next.projects, [event.project.id]: event.project } };
    case 'project.updated':
      return {
        ...next,
        projects: patch(next.projects, event.projectId, { ...event.changes, updatedAt: at }),
      };
    case 'project.state_changed':
      return {
        ...next,
        projects: patch(next.projects, event.projectId, { state: event.to, updatedAt: at }),
      };

    case 'task.created':
      return { ...next, tasks: { ...next.tasks, [event.task.id]: event.task } };
    case 'task.updated':
      return {
        ...next,
        tasks: patch(next.tasks, event.taskId, { ...event.changes, updatedAt: at }),
      };
    case 'task.state_changed':
      return {
        ...next,
        tasks: patch(next.tasks, event.taskId, { state: event.to, updatedAt: at }),
      };

    case 'body.created':
      return { ...next, bodies: { ...next.bodies, [event.body.id]: event.body } };
    case 'body.assigned':
      return { ...next, bodies: patch(next.bodies, event.bodyId, { host: event.host }) };
    case 'body.freed': {
      const body = next.bodies[event.bodyId];
      if (!body) return next;
      const { host: _host, ...freed } = body;
      return { ...next, bodies: { ...next.bodies, [event.bodyId]: freed } };
    }
    case 'body.moved': {
      let bodies = next.bodies;
      const from = bodies[event.fromBodyId];
      if (from) {
        const { host: _host, ...freed } = from;
        bodies = { ...bodies, [event.fromBodyId]: freed };
      }
      return { ...next, bodies: patch(bodies, event.toBodyId, { host: event.host }) };
    }

    case 'question.opened':
      return { ...next, questions: { ...next.questions, [event.question.id]: event.question } };
    case 'question.escalated':
    case 'question.reassigned':
      return {
        ...next,
        questions: patch(next.questions, event.questionId, {
          holder: event.to,
          version: event.version,
          updatedAt: at,
        }),
      };
    case 'question.cancelled':
      return {
        ...next,
        questions: patch(next.questions, event.questionId, {
          status: 'cancelled',
          version: event.version,
          updatedAt: at,
        }),
      };
    case 'question.answered':
      return {
        ...next,
        questions: patch(next.questions, event.questionId, {
          status: 'answered',
          answer: event.answer,
          answeredBy: event.answeredBy,
          version: event.version,
          updatedAt: at,
        }),
      };

    case 'proposal.created':
      return { ...next, proposals: { ...next.proposals, [event.proposal.id]: event.proposal } };
    case 'proposal.approved':
      return {
        ...next,
        proposals: patch(next.proposals, event.proposalId, { state: 'approved', updatedAt: at }),
      };
    case 'proposal.edited':
      return {
        ...next,
        proposals: patch(next.proposals, event.proposalId, {
          ...event.changes,
          state: 'edited',
          updatedAt: at,
        }),
      };
    case 'proposal.rejected':
      return {
        ...next,
        proposals: patch(next.proposals, event.proposalId, { state: 'rejected', updatedAt: at }),
      };
    case 'proposal.parked':
      return {
        ...next,
        proposals: patch(next.proposals, event.proposalId, { state: 'parked', updatedAt: at }),
      };

    // Status records are a server-owned projection (TECHNOLOGY §4, decision recorded with P0-18):
    // the client receives them in the snapshot and, from P1-05, as status messages, and never
    // folds `agent.*` events itself — two implementations of one projection would drift.
    case 'agent.created':
      // The row itself (P1-05 follow-up): a replaying client keeps `agents` in step with a snapshot.
      return { ...next, agents: { ...next.agents, [event.agent.id]: event.agent } };
    case 'agent.updated':
      return {
        ...next,
        agents: patch(next.agents, event.agentId, { ...event.changes, updatedAt: at }),
      };
    case 'agent.spawned':
      // The server stores a new session ref only (a resume under the same ref changes nothing).
      return event.sessionRef && next.agents[event.agentId]?.sessionRef !== event.sessionRef
        ? {
            ...next,
            agents: patch(next.agents, event.agentId, {
              sessionRef: event.sessionRef,
              updatedAt: at,
            }),
          }
        : next;
    case 'agent.progress':
    case 'agent.tool_call':
    case 'agent.needs_input':
    case 'agent.idle':
    case 'agent.stalled':
    case 'agent.paused':
    case 'agent.resumed':
    case 'agent.finished':
    case 'agent.failed':
    case 'agent.stopped':
    case 'agent.interrupted':
      return next;
    case 'agent.output':
      return next; // transcript traffic never reaches this stream
    case 'message.sent':
    case 'message.delivered':
      return next; // the inbox is runtime state; a chat view (Phase 2.5) will fold these

    case 'control.stop':
    case 'control.cancel':
    case 'control.pause':
    case 'control.resume':
    case 'control.edit':
    case 'control.close':
    case 'control.archive':
    case 'control.pin':
    case 'control.reopen':
      return next; // panel actions are recorded for supervisors; their effects arrive as domain events
  }
}

/**
 * The system summary counts (P2-15) of a folded world: the same pure function the server uses,
 * over the same rows, so the badge never disagrees with the server's view.
 */
export function summaryOf(world: WorldState): SystemSummary {
  return summarize({
    questions: Object.values(world.questions),
    tasks: Object.values(world.tasks),
    projects: Object.values(world.projects),
  });
}
