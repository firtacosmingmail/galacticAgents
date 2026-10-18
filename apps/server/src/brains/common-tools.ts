import {
  ENDED_STATES,
  QUESTION_SET_LIMITS,
  type Actor,
  type Agent,
  type Id,
  type Question,
  type SetQuestionInput,
  type StatusRecord,
} from '@galactic/protocol';
import { DomainError } from '../domain/errors.js';
import type { BrainQueries, BrainTool, BrainToolContext } from './definition.js';

/**
 * Tools every supervising brain has (P2-10; TECHNOLOGY §5.1): the Harmonizer and the Waykeepers
 * both control, observe and answer for the agents below them. Written against the generic
 * `BrainToolContext` only — the actor is always the calling brain, the reach is always "agents
 * below me in the hierarchy" (`supervisorId` chain), and a refusal is a thrown `DomainError`, which
 * the runner hands back to the model as `{ error: <code>, message }`.
 *
 *   stop_agent, pause_agent, resume_agent   {agentId}            an agent below the caller
 *   get_agent_status                         {agentId}            the caller or an agent below it
 *   list_supervised_agents                   {}                   the caller's direct reports
 *   answer_question                          {questionId, answer, version?}
 *                                            a clarification the caller holds (decision 12; the
 *                                            answer is logged with `answeredBy` = the caller);
 *                                            permission questions are refused (decision 7)
 *   report_status                            {text}               a line to the caller's supervisor
 *                                            (the Harmonizer, having none, tells the user in its
 *                                            reply)
 *   ask_questions                            {title, questions[]} 2–10 related clarifications as one
 *                                            set (P8-19, decision 141); held like one question of
 *                                            the caller's; ends the turn
 *   answer_question_set                      {setId, answers[]}   the rows of a set the caller holds
 *                                            that it can answer; the rest it holds go one level up
 *                                            in the same transaction
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const AGENT_ID = { agentId: { type: 'string', description: 'The agent id (a-…).' } };

function str(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new DomainError('invalid', `${key} must be a non-empty string`);
  }
  return v;
}

function optNumber(input: unknown, key: string): number | undefined {
  const v = (input as Record<string, unknown> | null)?.[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new DomainError('invalid', `${key} must be an integer`);
  }
  return v;
}

/** Whether `agentId` sits below `brainId` in the hierarchy (its supervisor chain reaches it). */
export function isBelow(queries: BrainQueries, brainId: Id, agentId: Id): boolean {
  const seen = new Set<Id>();
  let current = queries.agent(agentId);
  while (current?.supervisorId && !seen.has(current.id)) {
    if (current.supervisorId === brainId) return true;
    seen.add(current.id);
    current = queries.agent(current.supervisorId);
  }
  return false;
}

/** The agent, when it is below the calling brain; otherwise a refusal. */
export function agentBelow(ctx: BrainToolContext, agentId: Id): Agent {
  const agent = ctx.queries.agent(agentId);
  if (!agent) throw new DomainError('not_found', `no agent ${agentId}`);
  if (agentId === ctx.brainId) {
    throw new DomainError('invalid', 'you cannot do this to yourself');
  }
  if (!isBelow(ctx.queries, ctx.brainId, agentId)) {
    throw new DomainError('invalid', `agent ${agentId} is not one of the agents you supervise`);
  }
  return agent;
}

/** Whether a status record shows a running agent (not finished, failed, stopped or interrupted). */
export const isLive = (status: StatusRecord | undefined): boolean =>
  status !== undefined && !ENDED_STATES.has(status.state);

/** What the model reads about one agent. */
export function describeAgent(ctx: BrainToolContext, agent: Agent) {
  const status = ctx.queries.status(agent.id);
  const task = agent.taskId ? ctx.queries.task(agent.taskId) : undefined;
  return {
    agentId: agent.id,
    role: agent.role,
    ...(agent.supervisorId ? { supervisorId: agent.supervisorId } : {}),
    ...(agent.projectId ? { projectId: agent.projectId } : {}),
    ...(agent.taskId ? { taskId: agent.taskId } : {}),
    ...(task ? { task: { description: task.description, state: task.state } } : {}),
    state: status?.state ?? 'unknown',
    ...(status?.currentActivity ? { activity: status.currentActivity } : {}),
    ...(status?.pendingQuestionId ? { waitingOn: status.pendingQuestionId } : {}),
    ...(status?.progress ? { progress: status.progress } : {}),
    ...(status ? { lastEventAt: status.lastEventAt, caps: status.caps } : {}),
  };
}

const control = (
  name: 'stop_agent' | 'pause_agent' | 'resume_agent',
  verb: string,
  run: (ctx: BrainToolContext, agentId: Id) => Promise<unknown>,
): BrainTool => ({
  name,
  description: `${verb} an agent you supervise (directly or through a Waykeeper below you).`,
  inputSchema: obj(AGENT_ID, ['agentId']),
  handler: async (input, ctx) => {
    const agent = agentBelow(ctx, str(input, 'agentId'));
    await run(ctx, agent.id);
    return describeAgent(ctx, ctx.queries.agent(agent.id) ?? agent);
  },
});

export const stopAgentTool = control('stop_agent', 'Stops', (ctx, id) =>
  ctx.commands.stopAgent(id, ctx.actor),
);
export const pauseAgentTool = control('pause_agent', 'Pauses', (ctx, id) =>
  ctx.commands.pauseAgent(id, ctx.actor),
);
export const resumeAgentTool = control('resume_agent', 'Resumes', (ctx, id) =>
  ctx.commands.resumeAgent(id, ctx.actor),
);

export const getAgentStatusTool: BrainTool = {
  name: 'get_agent_status',
  description:
    'Reads the status record of yourself or of an agent below you: state, current activity, the ' +
    'question it waits on, progress and caps. Reading never interrupts the agent.',
  inputSchema: obj(AGENT_ID, ['agentId']),
  handler: (input, ctx) => {
    const agentId = str(input, 'agentId');
    const agent = agentId === ctx.brainId ? ctx.queries.agent(agentId) : agentBelow(ctx, agentId);
    if (!agent) throw new DomainError('not_found', `no agent ${agentId}`);
    return Promise.resolve(describeAgent(ctx, agent));
  },
};

export const listSupervisedAgentsTool: BrainTool = {
  name: 'list_supervised_agents',
  description: 'Lists the agents that report to you directly, with their status.',
  inputSchema: obj({}),
  handler: (_input, ctx) =>
    Promise.resolve(
      ctx.queries.supervisedAgents(ctx.brainId).map(({ agent }) => describeAgent(ctx, agent)),
    ),
};

export const answerQuestionTool: BrainTool = {
  name: 'answer_question',
  description:
    'Answers a clarification question you hold, when the approved plan or the project context ' +
    'already contains the answer (decision 12). The answer is logged as yours and the user sees ' +
    'it. Never for permission questions: those belong to the policy or the user. Pass the version ' +
    'you saw; if someone answered first you are told who.',
  inputSchema: obj(
    {
      questionId: { type: 'string' },
      answer: { type: 'string' },
      version: { type: 'integer', description: 'The question version you saw.' },
    },
    ['questionId', 'answer'],
  ),
  handler: async (input, ctx) => {
    const questionId = str(input, 'questionId');
    const answer = str(input, 'answer');
    const version = optNumber(input, 'version');
    const question = ctx.queries.question(questionId);
    if (!question) throw new DomainError('not_found', `no question ${questionId}`);
    refuseSetRow(question);
    if (question.kind === 'permission') {
      throw new DomainError(
        'invalid',
        `${questionId} is a permission question: only the project's policy or the user answers it (decision 7)`,
      );
    }
    const holdsIt = question.holder.type === 'agent' && question.holder.id === ctx.brainId;
    if (question.status === 'open' && !holdsIt) {
      const holder =
        question.holder.type === 'agent' ? `agent ${question.holder.id}` : question.holder.type;
      throw new DomainError('conflict', `${questionId} is held by ${holder}, not by you`);
    }
    // Answered or withdrawn already: the command says by whom ("already answered by …").
    const { value } = await ctx.commands.answerQuestion({
      questionId,
      answer,
      by: ctx.actor,
      ...(version !== undefined ? { version } : {}),
    });
    return { questionId, status: value.status, answeredBy: value.answeredBy };
  },
};

/**
 * A row of a question set is never answered or escalated alone (P8-19): the brain answers the set
 * with `answer_question_set`, which also passes up what it does not answer.
 */
export function refuseSetRow(question: Pick<Question, 'id' | 'context'>): void {
  const set = question.context.set;
  if (!set) return;
  throw new DomainError(
    'invalid',
    `${question.id} is part of set ${set.id}: answer it with answer_question_set (the rows you ` +
      'do not answer pass up on their own)',
  );
}

const MAX_QUESTIONS = QUESTION_SET_LIMITS.maxQuestions;

function setQuestions(input: unknown): SetQuestionInput[] {
  const raw = (input as Record<string, unknown> | null)?.['questions'];
  if (!Array.isArray(raw)) throw new DomainError('invalid', 'questions must be a list');
  return raw.map((q: unknown, i) => {
    const item = (q ?? {}) as Record<string, unknown>;
    const text = item['text'];
    if (typeof text !== 'string' || text.trim() === '') {
      throw new DomainError('invalid', `question ${i + 1} needs a text`);
    }
    const options = item['options'];
    if (
      options !== undefined &&
      (!Array.isArray(options) || options.some((o) => typeof o !== 'string'))
    ) {
      throw new DomainError('invalid', `question ${i + 1}: options must be strings`);
    }
    return {
      text,
      ...(Array.isArray(options) && options.length > 0 ? { options: options as string[] } : {}),
      ...(item['multiSelect'] === true ? { multiSelect: true } : {}),
    };
  });
}

export const askQuestionsTool: BrainTool = {
  name: 'ask_questions',
  description:
    `Asks 2–${MAX_QUESTIONS} related clarification questions at once, as one set (e.g. the ` +
    'clarifications a plan needs): the user answers them one after the other on one card and you ' +
    'get every answer together. Each question may offer options (multiSelect: several may be ' +
    'chosen); the user can always write an answer instead or skip a question. For one question, ' +
    'use ask_user (Harmonizer) or escalate (Waykeeper). Ends your turn; the answers arrive later.',
  inputSchema: obj(
    {
      title: { type: 'string', description: 'What the set is about, in a few words (≤120).' },
      questions: {
        type: 'array',
        minItems: QUESTION_SET_LIMITS.minQuestions,
        maxItems: MAX_QUESTIONS,
        items: obj(
          {
            text: { type: 'string', description: 'The question, self-contained.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              maxItems: QUESTION_SET_LIMITS.maxOptions,
              description: 'Suggested answers.',
            },
            multiSelect: { type: 'boolean', description: 'Several options may be chosen.' },
          },
          ['text'],
        ),
      },
    },
    ['title', 'questions'],
  ),
  endsTurn: true,
  handler: async (input, ctx) => {
    const { value } = await ctx.commands.openQuestionSet({
      originAgentId: ctx.brainId,
      title: str(input, 'title'),
      questions: setQuestions(input),
    });
    return {
      setId: value[0]!.context.set!.id,
      questionIds: value.map((q) => q.id),
      holder: value[0]!.holder,
    };
  },
};

export const answerQuestionSetTool: BrainTool = {
  name: 'answer_question_set',
  description:
    'Answers the questions of a set you hold that the approved plan or the project context ' +
    'already settles (decision 12); every other question of the set you hold goes one level up ' +
    'in the same call (answers: [] passes them all up). Never reword, merge or drop a question, ' +
    'and never re-ask a set with ask_user or escalate: what you do not answer goes up as it was ' +
    'asked. Your answers are logged as yours; the asker learns who gave each one.',
  inputSchema: obj(
    {
      setId: { type: 'string', description: 'The set id (qs-…).' },
      answers: {
        type: 'array',
        items: obj({ questionId: { type: 'string' }, answer: { type: 'string' } }, [
          'questionId',
          'answer',
        ]),
      },
    },
    ['setId', 'answers'],
  ),
  handler: async (input, ctx) => {
    const setId = str(input, 'setId');
    const raw = (input as Record<string, unknown> | null)?.['answers'];
    if (!Array.isArray(raw)) throw new DomainError('invalid', 'answers must be a list');
    const answers = raw.map((a: unknown) => ({
      questionId: str(a, 'questionId'),
      answer: { choices: [], text: str(a, 'answer') },
    }));
    const listed = new Set(answers.map((a) => a.questionId));
    // The open rows it holds and does not answer: the command passes them one level up.
    const passing = ctx.queries
      .allOpenQuestions()
      .filter(
        (q) =>
          q.context.set?.id === setId &&
          q.holder.type === 'agent' &&
          q.holder.id === ctx.brainId &&
          !listed.has(q.id),
      )
      .map((q) => q.id);
    const { value } = await ctx.commands.answerQuestionSet({ setId, by: ctx.actor, answers });
    const after = new Map(value.map((q) => [q.id, q]));
    const passedUpTo: Actor | null =
      passing.length > 0 ? (after.get(passing[0]!)?.holder ?? null) : null;
    return {
      answered: answers
        .map((a) => a.questionId)
        .filter((id) => after.get(id)?.status === 'answered'),
      passedUpTo,
    };
  },
};

export const reportStatusTool: BrainTool = {
  name: 'report_status',
  description:
    'Sends a short status line to your supervisor (a Waykeeper reports to the Harmonizer). Use it ' +
    'for things your supervisor must know: a milestone, a blocker, a refused spawn.',
  inputSchema: obj({ text: { type: 'string' } }, ['text']),
  handler: (input, ctx) => {
    const text = str(input, 'text');
    const supervisorId = ctx.queries.agent(ctx.brainId)?.supervisorId;
    if (!supervisorId) {
      return Promise.resolve({
        to: 'user',
        note: 'You have no supervisor: tell the user in your reply.',
      });
    }
    try {
      const { messageId } = ctx.send(supervisorId, text);
      return Promise.resolve({ to: supervisorId, messageId });
    } catch (error) {
      throw new DomainError(
        'conflict',
        `your supervisor ${supervisorId} is not running: ${(error as Error).message}`,
      );
    }
  },
};

/** Every shared tool, in a stable order. */
export const COMMON_TOOLS: readonly BrainTool[] = [
  stopAgentTool,
  pauseAgentTool,
  resumeAgentTool,
  getAgentStatusTool,
  listSupervisedAgentsTool,
  answerQuestionTool,
  reportStatusTool,
  askQuestionsTool,
  answerQuestionSetTool,
];

export type CommonToolName = (typeof COMMON_TOOLS)[number]['name'];

/** The shared tools, all of them or the named ones (a brain that does without some). */
export function commonTools(only?: readonly string[]): BrainTool[] {
  return COMMON_TOOLS.filter((t) => !only || only.includes(t.name));
}
