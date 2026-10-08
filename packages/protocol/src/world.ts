import type { AgentSpend } from './budget.js';
import { foldSpend } from './budget.js';
import type { Deliverable, RunSummary } from './deliverables.js';
import type { Agent, Body, Project, Proposal, Question, StatusRecord, Task } from './domain.js';
import { foldProposalMeta, type ProposalMetaChanges } from './domain.js';
import { applyChanges, type EventEnvelope } from './events.js';
import type { Id } from './primitives.js';
import { summarize, type SystemSummary } from './summary.js';
import type { Snapshot } from './ws.js';

/**
 * The world fold (moved here from the web client's `state/reduce.ts` with P8-03): one pure
 * function from the event log to the domain rows, shared by the web client (which folds the
 * stream) and the server (which rebuilds its tables from an imported log, `db/map-import.ts`).
 * The web client's conformance test (`apps/web/src/state/conformance.test.ts`) checks that folding
 * a recorded log equals the server's snapshot after every commit — so the server's rebuild path
 * is covered by the same test.
 */

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
  /** Every agent's reported cost (P8-01): the snapshot's, folded on with `foldSpend`. */
  spend: Record<Id, AgentSpend>;
  /**
   * Every deliverable (P9-01), removed ones included, each with its newest run folded from
   * `run.*` (`lastRun`). The snapshot's `deliverables` (absent from older servers: none).
   */
  deliverables: Record<Id, Deliverable>;
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
  spend: {},
  deliverables: {},
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
    spend: Object.fromEntries((snapshot.spend ?? []).map((s) => [s.agentId, s])),
    deliverables: byId(snapshot.deliverables ?? []),
  };
}

/** The agent's spend after `envelope` (P8-01), the same fold as the server's `agent_spend`. */
function spendAfter(state: WorldState, envelope: EventEnvelope, agentId: Id): WorldState {
  // A world built before P8-01 (a test fixture, a replay base) may have no spend yet.
  const spend = state.spend ?? {};
  const next = foldSpend(spend[agentId], envelope);
  return next ? { ...state, spend: { ...spend, [agentId]: next } } : state;
}

/**
 * A proposal decision (P2-09): its field changes, and its `meta` folded by the protocol's
 * `foldProposalMeta` exactly as the server folds it (`parked` set or dropped, `initGit`, `trust`).
 */
function decide(
  map: Record<Id, Proposal>,
  id: Id,
  changes: { [K in keyof Proposal]?: Proposal[K] | undefined },
  metaChanges: ProposalMetaChanges,
): Record<Id, Proposal> {
  const current = map[id];
  if (!current) return map;
  const meta = foldProposalMeta(current.meta, metaChanges);
  return { ...map, [id]: applyChanges(current, { ...changes, meta: meta ?? null }) };
}

/**
 * Applies `changes` to a known item with the server's patch rule (`applyChanges`, P2-20): an
 * `undefined` value means "unchanged", an explicit `null` (a clearable field of `project.updated`
 * or `task.updated`) means "cleared".
 */
function patch<T extends object>(
  map: Record<Id, T>,
  id: Id,
  changes: { [K in keyof T]?: T[K] | null | undefined },
): Record<Id, T> {
  const current = map[id];
  if (!current) return map;
  return { ...map, [id]: applyChanges(current, changes) };
}

/**
 * Folds one event into the world. Pure: returns a new state, never mutates. The server's domain
 * commands emit events that fully describe their mutations and stamp rows with the event's `at`
 * (P2-01), so folding them here builds exactly the server's tables — `conformance.test.ts`
 * replays a recorded log and checks it against the server's snapshot at every commit.
 */
export function applyEvent(state: WorldState, envelope: EventEnvelope): WorldState {
  const { seq, at, event } = envelope;
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
      const { host: _host, movedTo: _marker, ...freed } = body;
      return { ...next, bodies: { ...next.bodies, [event.bodyId]: freed } };
    }
    case 'body.retired': {
      // A retired demo body (P7-07) is gone from the world for good, as from the server's
      // snapshot (which leaves its tombstone row out).
      if (!next.bodies[event.bodyId]) return next;
      const { [event.bodyId]: _gone, ...bodies } = next.bodies;
      return { ...next, bodies };
    }
    case 'body.moved': {
      // The old body shows "moved to …" (P2-02, decision 15) until `body.freed`; a task that
      // joined a project lives on the project's body without hosting it (`intoProjectId`).
      let bodies = next.bodies;
      const from = bodies[event.fromBodyId];
      if (from) {
        const { host: _host, ...rest } = from;
        const movedTo = { bodyId: event.toBodyId, host: event.host, at };
        bodies = { ...bodies, [event.fromBodyId]: { ...rest, movedTo } };
      }
      if (event.intoProjectId) return { ...next, bodies };
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
    case 'question.cancelled': {
      // A dismissal (P9-14) says who and why on the row, as the server keeps it.
      const prior = next.questions[event.questionId]?.meta;
      return {
        ...next,
        questions: patch(next.questions, event.questionId, {
          status: 'cancelled',
          version: event.version,
          updatedAt: at,
          ...(event.by
            ? { meta: { ...prior, cancelledBy: event.by, cancelReason: event.reason } }
            : {}),
        }),
      };
    }
    case 'question.answered': {
      // The answer's idempotency key goes on the row as the server keeps it (P7-05).
      const prior = next.questions[event.questionId]?.meta;
      return {
        ...next,
        questions: patch(next.questions, event.questionId, {
          status: 'answered',
          answer: event.answer,
          answeredBy: event.answeredBy,
          version: event.version,
          updatedAt: at,
          ...(event.answerId ? { meta: { ...prior, answerId: event.answerId } } : {}),
        }),
      };
    }

    case 'proposal.created':
      return { ...next, proposals: { ...next.proposals, [event.proposal.id]: event.proposal } };
    case 'proposal.approved':
      return {
        ...next,
        proposals: decide(
          next.proposals,
          event.proposalId,
          { state: 'approved', updatedAt: at },
          { parked: null },
        ),
      };
    case 'proposal.edited': {
      const { initGit, trust, budgetUsd, ...changes } = event.changes;
      return {
        ...next,
        proposals: decide(
          next.proposals,
          event.proposalId,
          { ...changes, state: 'edited', updatedAt: at },
          {
            parked: null,
            ...(initGit !== undefined ? { initGit } : {}),
            ...(trust !== undefined ? { trust } : {}),
            ...(budgetUsd !== undefined ? { budgetUsd } : {}),
          },
        ),
      };
    }
    case 'proposal.rejected':
      return {
        ...next,
        proposals: decide(
          next.proposals,
          event.proposalId,
          { state: 'rejected', updatedAt: at },
          { parked: null },
        ),
      };
    case 'proposal.parked': {
      const { type: _type, proposalId, ...parked } = event;
      return {
        ...next,
        proposals: decide(
          next.proposals,
          proposalId,
          { state: 'parked', updatedAt: at },
          { parked },
        ),
      };
    }
    case 'proposal.unparked':
      return {
        ...next,
        proposals: decide(
          next.proposals,
          event.proposalId,
          { state: 'pending', proposedBody: event.proposedBody, updatedAt: at },
          { parked: null },
        ),
      };
    case 'promotion.carried_out': {
      // The card keeps how it was carried out (P2-12), as the server's row does.
      const card = next.proposals[event.proposalId];
      return card
        ? {
            ...next,
            proposals: patch(next.proposals, event.proposalId, {
              meta: { ...(card.meta ?? {}), carriedOut: event.outcome },
              updatedAt: at,
            }),
          }
        : next;
    }

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
    case 'agent.spawned': {
      // The spend's session meter (P8-01) follows the session, as on the server.
      const spent = spendAfter(next, envelope, event.agentId);
      // The server stores a new session ref only (a resume under the same ref changes nothing).
      return event.sessionRef && spent.agents[event.agentId]?.sessionRef !== event.sessionRef
        ? {
            ...spent,
            agents: patch(spent.agents, event.agentId, {
              sessionRef: event.sessionRef,
              updatedAt: at,
            }),
          }
        : spent;
    }
    case 'agent.idle':
    case 'agent.finished':
    case 'agent.failed':
      return spendAfter(next, envelope, event.agentId); // a cost report (P8-01)
    case 'agent.progress':
    case 'agent.tool_call':
    case 'agent.needs_input':
    case 'agent.stalled':
    case 'agent.paused':
    case 'agent.resumed':
    case 'agent.stopped':
    case 'agent.interrupted':
    case 'recovery.needs_attention': // a notification (P25-07), not world state
    case 'agent.processes_stopped': // OS processes are not world state (P4-14)
      return next;
    case 'agent.output':
      return next; // transcript traffic never reaches this stream
    case 'message.sent':
    case 'message.delivered':
      return next; // the inbox is runtime state; a chat view (Phase 2.5) will fold these
    case 'permission.decided':
      return next; // the policy answered without the user: no question row (P2-04)

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
    case 'budget.set': // the row's `budgetUsd` arrives as project.updated / task.updated
    case 'budget.warning': // notices (P8-01): the spend and the budget are already folded
    case 'budget.exceeded':
    case 'budget.spawn_refused':
      return next;

    // Deliverables (P9-01; TECHNOLOGY §9.1): the row's own changes stamp `updatedAt` and carry
    // the new `version`; `run.*` only fold `lastRun`, which changes neither.
    case 'deliverable.added': {
      const deliverables = next.deliverables ?? {};
      return {
        ...next,
        deliverables: { ...deliverables, [event.deliverable.id]: event.deliverable },
      };
    }
    case 'deliverable.updated':
      return {
        ...next,
        deliverables: patch(next.deliverables ?? {}, event.deliverableId, {
          ...event.changes,
          version: event.version,
          updatedAt: at,
        }),
      };
    case 'deliverable.removed':
      return {
        ...next,
        deliverables: patch(next.deliverables ?? {}, event.deliverableId, {
          removedAt: at,
          removedBy: event.by,
          removedReason: event.reason ?? null,
          version: event.version,
          updatedAt: at,
        }),
      };
    case 'deliverable.restored':
      return {
        ...next,
        deliverables: patch(next.deliverables ?? {}, event.deliverableId, {
          removedAt: null,
          removedBy: null,
          removedReason: null,
          version: event.version,
          updatedAt: at,
        }),
      };
    case 'deliverable.opened':
      return next; // the audit of decision 127: nothing in the row changes
    case 'run.started': {
      const { run } = event;
      const lastRun: RunSummary = {
        runId: run.id,
        state: run.state,
        startedAt: run.startedAt,
        ports: run.ports,
      };
      return {
        ...next,
        deliverables: patch(next.deliverables ?? {}, run.deliverableId, { lastRun }),
      };
    }
    case 'run.ports':
      return withLastRun(next, event.deliverableId, event.runId, (r) => ({
        ...r,
        ports: event.ports,
      }));
    case 'run.ended':
      return withLastRun(next, event.deliverableId, event.runId, (r) => ({
        ...r,
        state: 'ended',
        endedAt: at,
        outcome: event.outcome,
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.signal !== undefined ? { signal: event.signal } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      }));
  }
}

/**
 * Applies `change` to the deliverable's `lastRun` when it is the run `runId` (an event about an
 * older run — one that ended after a newer one started — leaves the summary alone).
 */
function withLastRun(
  state: WorldState,
  deliverableId: Id,
  runId: Id,
  change: (run: RunSummary) => RunSummary,
): WorldState {
  const deliverable = state.deliverables?.[deliverableId];
  if (deliverable?.lastRun?.runId !== runId) return state;
  return {
    ...state,
    deliverables: {
      ...state.deliverables,
      [deliverableId]: { ...deliverable, lastRun: change(deliverable.lastRun) },
    },
  };
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
