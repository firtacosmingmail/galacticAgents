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

function patch<T>(map: Record<Id, T>, id: Id, changes: Partial<T>): Record<Id, T> {
  const current = map[id];
  return current ? { ...map, [id]: { ...current, ...changes } } : map;
}

function setStatus(
  state: WorldState,
  agentId: Id,
  at: string,
  changes: Partial<Omit<StatusRecord, 'agentId'>>,
): WorldState {
  const current = state.statuses[agentId];
  if (!current) return state; // Phase 1 pushes status records; until then only known ones update
  return {
    ...state,
    statuses: { ...state.statuses, [agentId]: { ...current, ...changes, lastEventAt: at } },
  };
}

/**
 * Folds one event into the world. Pure: returns a new state, never mutates.
 * Phase 0 covers the structural events; Phase 1–2 refine agent and question handling.
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

    case 'agent.spawned':
      return setStatus(next, event.agentId, at, { state: 'starting' });
    case 'agent.progress':
      return setStatus(next, event.agentId, at, {
        state: 'working',
        currentActivity: event.summary,
        ...(event.progress ? { progress: event.progress } : {}),
      });
    case 'agent.tool_call':
      return setStatus(next, event.agentId, at, {
        state: 'working',
        currentActivity: event.toolName,
      });
    case 'agent.needs_input':
      return setStatus(next, event.agentId, at, {
        state: 'waiting_for_input',
        pendingQuestionId: event.questionId,
      });
    case 'agent.idle':
      return setStatus(next, event.agentId, at, { state: 'idle' });
    case 'agent.stalled':
      return setStatus(next, event.agentId, at, { state: 'stalled' });
    case 'agent.paused':
      return setStatus(next, event.agentId, at, { state: 'paused' });
    case 'agent.resumed':
      return setStatus(next, event.agentId, at, { state: 'working' });
    case 'agent.finished':
      return setStatus(next, event.agentId, at, {
        state: 'finished',
        ...(event.cost ? { costSoFar: event.cost } : {}),
      });
    case 'agent.failed':
      return setStatus(next, event.agentId, at, { state: 'failed', currentActivity: event.error });
    case 'agent.stopped':
      return setStatus(next, event.agentId, at, { state: 'stopped' });
    case 'agent.output':
      return next; // transcript traffic never reaches this stream

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
