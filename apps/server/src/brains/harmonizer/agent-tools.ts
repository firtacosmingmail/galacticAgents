import type { Agent, Id, Question, StatusRecord } from '@galactic/protocol';
import { must } from '../../domain/errors.js';
import { commonTools } from '../common-tools.js';
import type { BrainQueries, BrainTool } from '../definition.js';
import { asInput, isLiving, S, str } from './input.js';

/**
 * The Harmonizer's own supervisor tools (P2-08). The tools both brains share — stop, pause and
 * resume an agent, its status, the supervised agents, answering a clarification — come from
 * `brains/common-tools.ts` (P2-10); only `report_status` differs: the Harmonizer has no
 * supervisor to report to, so its `report_status` reads the status of the system for the user.
 * Status is read, never requested from the agent (SPEC §2.5).
 */

/** One agent as a tool result shows it. */
export function agentLine(agent: Agent, status: StatusRecord | undefined) {
  return {
    id: agent.id,
    role: agent.role,
    ...(agent.taskId ? { taskId: agent.taskId } : {}),
    ...(agent.projectId ? { projectId: agent.projectId } : {}),
    bodyId: agent.bodyId,
    state: status?.state ?? 'unknown',
    ...(status?.currentActivity ? { activity: status.currentActivity } : {}),
    ...(status?.pendingQuestionId ? { waitingOn: status.pendingQuestionId } : {}),
    ...(status?.progress ? { progress: status.progress } : {}),
  };
}

function questionLine(q: Question) {
  return {
    id: q.id,
    kind: q.kind,
    from: q.originAgentId,
    holder: q.holder.type === 'agent' ? `agent ${q.holder.id}` : q.holder.type,
    text: q.context.text,
    ...(q.context.options ? { options: q.context.options } : {}),
    version: q.version,
  };
}

/** What `report_status` says about the whole system, a project, a task or an agent. */
export function statusReport(queries: BrainQueries, brainId: Id, input: Record<string, unknown>) {
  const projectId = str(input, 'projectId', true);
  const taskId = str(input, 'taskId', true);
  const agentId = str(input, 'agentId', true);
  const agentsOf = (pred: (a: Agent) => boolean) =>
    queries
      .agents()
      .filter(pred)
      .filter((a) => isLiving(queries, a.id) || queries.status(a.id)?.state === 'interrupted')
      .map((a) => agentLine(a, queries.status(a.id)));
  const taskLine = (t: { id: Id; description: string; state: string; priority: string }) => ({
    id: t.id,
    description: t.description,
    state: t.state,
    priority: t.priority,
  });
  if (agentId) {
    const agent = must(queries.agent(agentId), 'agent', agentId);
    return { agent: agentLine(agent, queries.status(agentId)) };
  }
  if (taskId) {
    const task = must(queries.task(taskId), 'task', taskId);
    return {
      task: { ...taskLine(task), bodyId: task.bodyId, projectId: task.projectId },
      agents: agentsOf((a) => a.taskId === taskId),
      openQuestions: queries
        .allOpenQuestions()
        .filter((q) => queries.agent(q.originAgentId)?.taskId === taskId)
        .map(questionLine),
    };
  }
  if (projectId) {
    const project = must(queries.project(projectId), 'project', projectId);
    const tasks = queries.projectTasks(projectId);
    const ids = new Set(tasks.map((t) => t.id));
    return {
      project: {
        id: project.id,
        name: project.name,
        state: project.state,
        bodyId: project.bodyId,
        workspace: project.workspace,
        ...(project.parentProjectId ? { parentProjectId: project.parentProjectId } : {}),
      },
      tasks: tasks.map(taskLine),
      agents: agentsOf((a) => a.projectId === projectId),
      openQuestions: queries
        .allOpenQuestions()
        .filter((q) => {
          const origin = queries.agent(q.originAgentId);
          return origin?.projectId === projectId || (origin?.taskId && ids.has(origin.taskId));
        })
        .map(questionLine),
    };
  }
  const open = queries.allOpenQuestions();
  return {
    projects: queries
      .projects()
      .filter((p) => p.state !== 'archived')
      .map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
        bodyId: p.bodyId,
        tasks: queries.projectTasks(p.id).length,
      })),
    standaloneTasks: queries
      .tasks()
      .filter((t) => !t.projectId && t.state !== 'archived')
      .map((t) => ({ ...taskLine(t), bodyId: t.bodyId })),
    agents: agentsOf((a) => a.id !== brainId),
    pendingProposals: queries
      .proposals()
      .filter((p) => p.state === 'pending' || p.state === 'edited' || p.state === 'parked')
      .map((p) => ({ id: p.id, kind: p.kind, name: p.proposedBody.name, state: p.state })),
    openQuestions: {
      total: open.length,
      heldByUser: open.filter((q) => q.holder.type === 'user').length,
      heldByYou: open
        .filter((q) => q.holder.type === 'agent' && q.holder.id === brainId)
        .map(questionLine),
    },
  };
}

export const reportStatus: BrainTool = {
  name: 'report_status',
  description:
    'Reads the status of the whole system, or of one project, task or agent (give at most one ' +
    'id), to answer a status question. Read-only.',
  inputSchema: S.obj({
    projectId: S.str('A project.'),
    taskId: S.str('A task.'),
    agentId: S.str('An agent.'),
  }),
  async handler(raw, ctx) {
    return statusReport(ctx.queries, ctx.brainId, asInput(raw));
  },
};

/** The shared supervisor tools, with the Harmonizer's own `report_status`. */
export const SUPERVISOR_TOOLS: BrainTool[] = [
  ...commonTools().filter((t) => t.name !== 'report_status'),
  reportStatus,
];
