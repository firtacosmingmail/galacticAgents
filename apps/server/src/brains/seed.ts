import {
  ENDED_STATES,
  proposalPlan,
  type AgentRole,
  type Id,
  type StatusRecord,
  type WorkState,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import type { BrainQueries } from './definition.js';
import { concernedSupervisors } from '../domain/cascade.js';
import type { WakeScope } from './wake.js';

/**
 * The database is the brain's memory (TECHNOLOGY §5.2): every turn is seeded from the tables and
 * the status store instead of relying on a growing transcript. Read-only; nothing here writes.
 */

export interface SeedSources {
  tables: Tables;
  status(agentId: Id): StatusRecord | undefined;
}

export function createBrainQueries({ tables, status }: SeedSources): BrainQueries {
  const queries: BrainQueries = {
    agent: (id) => tables.agents.get(id),
    status,
    supervisedAgents: (brainId) =>
      tables.agents
        .all()
        .filter((a) => a.supervisorId === brainId)
        .map((agent) => {
          const s = status(agent.id);
          return s ? { agent, status: s } : { agent };
        }),
    project: (id) => tables.projects.get(id),
    task: (id) => tables.tasks.get(id),
    projectTasks: (projectId) =>
      tables.tasks
        .all()
        .filter((t) => t.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    openQuestions: (brainId) =>
      tables.questions.all().filter((q) => {
        if (q.status !== 'open' || q.kind !== 'clarification') return false;
        if (q.holder.type === 'agent' && q.holder.id === brainId) return true;
        return tables.agents.get(q.originAgentId)?.supervisorId === brainId;
      }),
    agents: () => tables.agents.all(),
    projects: () => tables.projects.all(),
    tasks: () => tables.tasks.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    body: (id) => tables.bodies.get(id),
    proposal: (id) => tables.proposals.get(id),
    proposals: () => tables.proposals.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    question: (id) => tables.questions.get(id),
    allOpenQuestions: () => tables.questions.all().filter((q) => q.status === 'open'),
  };
  return queries;
}

/** Work that should have an agent running it (P8-01 review): not proposed, paused or finished. */
const ATTENDED_STATES = new Set<WorkState>([
  'approved',
  'in_progress',
  'blocked_on_user',
  'awaiting_closure',
]);

/** The brain's place in the hierarchy, as the wake rules ask about it. */
export function createWakeScope(
  tables: Tables,
  brain: { brainId: Id; role: AgentRole; projectId?: Id },
  opts: {
    isLive?: (agentId: Id) => boolean;
    /** Agents' status records: `unattended` asks whether a Waykeeper or Steward runs. */
    status?: (agentId: Id) => StatusRecord | undefined;
  } = {},
): WakeScope {
  const running = (id: Id) => {
    const s = opts.status?.(id);
    return s !== undefined && !ENDED_STATES.has(s.state);
  };
  const supervises = (id: Id | undefined) =>
    id !== undefined && tables.agents.get(id)?.supervisorId === brain.brainId;
  const supervised = () => tables.agents.all().filter((a) => a.supervisorId === brain.brainId);
  return {
    ...brain,
    supervises,
    below: (id) => {
      const seen = new Set<Id>();
      for (let at = id; at !== undefined && !seen.has(at);) {
        seen.add(at);
        const up: Id | undefined = tables.agents.get(at)?.supervisorId;
        if (up === brain.brainId) return true;
        at = up;
      }
      return false;
    },
    runsTask: (taskId) => {
      const task = tables.tasks.get(taskId);
      if (task && brain.projectId && task.projectId === brain.projectId) return true;
      return supervised().some((a) => a.taskId === taskId);
    },
    runsProject: (projectId) =>
      projectId === brain.projectId || supervised().some((a) => a.projectId === projectId),
    // The Harmonizer proposes (SPEC §3.3); a plan card belongs to its project's Waykeeper —
    // whichever agent runs the project now, so a replacement Waykeeper learns the decision (P2-10).
    // A Waykeeper's promotion request (`meta.promotion`) is its project's Waykeeper's too: only
    // that brain hears the decision (P2-12 does the move), never the Harmonizer as well.
    ownsProposal: (proposalId) => {
      const proposal = tables.proposals.get(proposalId);
      const plan = proposalPlan(proposal);
      if (plan) return brain.role === 'waykeeper' && plan.projectId === brain.projectId;
      const promotion = proposal?.meta?.['promotion'] as
        { fromProjectId?: unknown; requestedBy?: unknown } | undefined;
      if (promotion && typeof promotion.fromProjectId === 'string' && promotion.requestedBy) {
        return brain.role === 'waykeeper' && promotion.fromProjectId === brain.projectId;
      }
      return brain.role === 'harmonizer';
    },
    question: (id) => tables.questions.get(id),
    concerned: (event) =>
      concernedSupervisors(tables, event, opts.isLive ? { isLive: opts.isLive } : {}).includes(
        brain.brainId,
      ),
    ...(opts.status
      ? {
          unattended: (target) => {
            if (target.kind === 'project') {
              const project = tables.projects.get(target.id);
              if (!project || !ATTENDED_STATES.has(project.state)) return false;
              return !tables.agents
                .all()
                .some((a) => a.role === 'waykeeper' && a.projectId === target.id && running(a.id));
            }
            const task = tables.tasks.get(target.id);
            // A project's task is its Waykeeper's to staff; only an asteroid is the Harmonizer's.
            if (!task || task.projectId || !ATTENDED_STATES.has(task.state)) return false;
            return !tables.agents
              .all()
              .some((a) => a.role === 'steward' && a.taskId === target.id && running(a.id));
          },
        }
      : {}),
  };
}

/** The "current state" block of a turn prompt. */
export function renderSeed(queries: BrainQueries, brain: { brainId?: Id; projectId?: Id }): string {
  const lines: string[] = ['Current state (from the database):'];
  const agents = brain.brainId ? queries.supervisedAgents(brain.brainId) : [];
  lines.push(`Agents you supervise (${agents.length}):`);
  for (const { agent, status } of agents) {
    const where = agent.taskId
      ? ` · task ${agent.taskId}`
      : agent.projectId
        ? ` · project ${agent.projectId}`
        : '';
    const activity = status?.currentActivity ? ` · ${JSON.stringify(status.currentActivity)}` : '';
    const question = status?.pendingQuestionId ? ` · waiting on ${status.pendingQuestionId}` : '';
    lines.push(
      `- ${agent.id} ${agent.role}${where} · ${status?.state ?? 'unknown'}${activity}${question}`,
    );
  }
  if (brain.projectId) {
    const project = queries.project(brain.projectId);
    const tasks = queries.projectTasks(brain.projectId);
    lines.push(
      `Tasks of project ${brain.projectId}${project ? ` (${project.name}, ${project.state})` : ''} (${tasks.length}):`,
    );
    for (const t of tasks) {
      const blocked = t.blockedBy.length > 0 ? ` · blocked by ${t.blockedBy.join(', ')}` : '';
      lines.push(`- ${t.id} [${t.state}] ${t.priority} · ${t.description}${blocked}`);
    }
  }
  const questions = brain.brainId ? queries.openQuestions(brain.brainId) : [];
  lines.push(`Open questions you hold or your agents asked (${questions.length}):`);
  for (const q of questions) {
    const holder =
      q.holder.type === 'agent'
        ? q.holder.id === brain.brainId
          ? 'you'
          : `agent ${q.holder.id}`
        : q.holder.type;
    lines.push(
      `- ${q.id} from ${q.originAgentId}, held by ${holder} (version ${q.version}): ${JSON.stringify(q.context.text)}`,
    );
  }
  return lines.join('\n');
}
