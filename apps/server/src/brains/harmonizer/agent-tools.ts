import type { Agent, Id, Question, StatusRecord } from '@galactic/protocol';
import { DomainError, must } from '../../domain/errors.js';
import type { BrainQueries, BrainTool, BrainToolContext } from '../definition.js';
import { asInput, int, isLiving, S, str } from './input.js';

/**
 * The supervisor tools both brains have (P2-08). P2-10 builds the shared module
 * `brains/common-tools.ts` with the same names in parallel; these are the Harmonizer's versions,
 * to be consolidated at merge (see `docs/tasks/notes/P2-08-harmonizer.md`). Status is read, never
 * requested from the agent (SPEC §2.5).
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

const agentControl = (
  name: 'stop_agent' | 'pause_agent' | 'resume_agent',
  verb: string,
  call: (ctx: BrainToolContext, agentId: Id) => Promise<unknown>,
): BrainTool => ({
  name,
  description: `${verb} an agent (a Waykeeper or a Steward) by id. Never yourself.`,
  inputSchema: S.obj(
    { agentId: S.str('The agent to act on.'), reason: S.str('Why, for the log and the user.') },
    ['agentId'],
  ),
  async handler(raw, ctx) {
    const input = asInput(raw);
    const agentId = str(input, 'agentId');
    must(ctx.queries.agent(agentId), 'agent', agentId);
    if (agentId === ctx.brainId) {
      throw new DomainError('invalid', `you cannot ${verb.toLowerCase()} yourself`);
    }
    await call(ctx, agentId);
    return agentLine(ctx.queries.agent(agentId)!, ctx.queries.status(agentId));
  },
});

export const stopAgent = agentControl('stop_agent', 'Stop', (ctx, id) =>
  ctx.commands.stopAgent(id, ctx.actor),
);
export const pauseAgent = agentControl('pause_agent', 'Pause', (ctx, id) =>
  ctx.commands.pauseAgent(id, ctx.actor),
);
export const resumeAgent = agentControl('resume_agent', 'Resume', (ctx, id) =>
  ctx.commands.resumeAgent(id, ctx.actor),
);

export const getAgentStatus: BrainTool = {
  name: 'get_agent_status',
  description:
    'Reads one agent’s status (state, activity, progress, the question it waits on) without ' +
    'interrupting it.',
  inputSchema: S.obj({ agentId: S.str('The agent.') }, ['agentId']),
  async handler(raw, ctx) {
    const agentId = str(asInput(raw), 'agentId');
    const agent = must(ctx.queries.agent(agentId), 'agent', agentId);
    const status = ctx.queries.status(agentId);
    const question = status?.pendingQuestionId
      ? ctx.queries.question(status.pendingQuestionId)
      : undefined;
    const task = agent.taskId ? ctx.queries.task(agent.taskId) : undefined;
    return {
      ...agentLine(agent, status),
      ...(agent.supervisorId ? { supervisorId: agent.supervisorId } : {}),
      ...(status ? { startedAt: status.startedAt, lastEventAt: status.lastEventAt } : {}),
      ...(status?.caps ? { caps: status.caps } : {}),
      ...(task ? { task: { id: task.id, description: task.description, state: task.state } } : {}),
      ...(question ? { question: questionLine(question) } : {}),
    };
  },
};

export const listSupervisedAgents: BrainTool = {
  name: 'list_supervised_agents',
  description:
    'Lists the agents you supervise directly (Waykeepers, asteroid Stewards) with their status.',
  inputSchema: S.obj({}),
  async handler(_raw, ctx) {
    return ctx.queries
      .supervisedAgents(ctx.brainId)
      .map(({ agent, status }) => agentLine(agent, status));
  },
};

export const answerQuestion: BrainTool = {
  name: 'answer_question',
  description:
    'Answers a clarification question you hold, when the context already contains the answer. ' +
    'Logged with you as the answerer and visible to the user. Permission questions are refused.',
  inputSchema: S.obj(
    {
      questionId: S.str('The question.'),
      answer: S.str('The answer.'),
      version: { type: 'integer', description: 'The version you saw (from the state block).' },
    },
    ['questionId', 'answer'],
  ),
  async handler(raw, ctx) {
    const input = asInput(raw);
    const questionId = str(input, 'questionId');
    const answer = str(input, 'answer');
    const version = int(input, 'version');
    const question = must(ctx.queries.question(questionId), 'question', questionId);
    if (question.kind === 'permission') {
      // Decision 7: the policy table or the user decides permissions, never an LLM.
      throw new DomainError(
        'invalid',
        'permission questions are decided by the project’s policy or the user, never by an agent',
      );
    }
    const { value } = await ctx.commands.answerQuestion({
      questionId,
      answer,
      by: ctx.actor,
      ...(version !== undefined ? { version } : {}),
    });
    return { questionId: value.id, status: value.status, answeredBy: 'you' };
  },
};

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

export const SUPERVISOR_TOOLS: BrainTool[] = [
  stopAgent,
  pauseAgent,
  resumeAgent,
  getAgentStatus,
  listSupervisedAgents,
  answerQuestion,
  reportStatus,
];
