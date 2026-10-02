import {
  proposalPlan,
  type Actor,
  type Agent,
  type Id,
  type PlanTaskInput,
  type Project,
  type ProposedBody,
  type Question,
  type Task,
  type TaskPriority,
} from '@galactic/protocol';
import { DomainError } from '../../domain/errors.js';
import {
  stewardsSerialised,
  workspaceMeta,
  type MergeConflict,
} from '../../workspace/workspaces.js';
import { isLive } from '../common-tools.js';
import type { BrainTool, BrainToolContext } from '../definition.js';
import {
  EXTERNAL_CONFLICT_OPTIONS,
  externalConflictText,
  sendBackPrompt,
  stewardPrompt,
} from './prompt.js';

/**
 * The Waykeeper's own tools (P2-10; TECHNOLOGY §5.1). Every handler works on the calling brain's
 * project (`ctx.projectId`) and refuses anything outside it with a `DomainError`, which the model
 * reads as `{ error, message }`. The shared supervision tools live in `../common-tools.ts`.
 */

const SYSTEM: Actor = { type: 'system' };
const PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent'];
/** Task states with nothing left to do on the task. */
const TASK_DONE = new Set(['completed', 'archived', 'moved']);
/** Times merge_task sends a Steward back for the same task before the user is asked. */
export const MAX_SEND_BACKS = 2;
/** Steward states in which a merge must wait: it is still working on the branch. */
const BUSY = new Set(['starting', 'working', 'waiting_for_input', 'stalled', 'paused']);

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

type Input = Record<string, unknown>;
const asInput = (input: unknown): Input =>
  input && typeof input === 'object' ? (input as Input) : {};

function str(input: Input, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new DomainError('invalid', `${key} must be a non-empty string`);
  }
  return v;
}
function optStr(input: Input, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new DomainError('invalid', `${key} must be a string`);
  return v;
}
function optPriority(input: Input): TaskPriority | undefined {
  const v = input['priority'];
  if (v === undefined || v === null) return undefined;
  if (!PRIORITIES.includes(v as TaskPriority)) {
    throw new DomainError('invalid', `priority must be one of ${PRIORITIES.join(', ')}`);
  }
  return v as TaskPriority;
}

/** The brain's project; a Waykeeper always has one. */
export function projectOf(ctx: BrainToolContext): Project {
  if (!ctx.projectId) throw new DomainError('invalid', 'you do not run a project');
  const project = ctx.queries.project(ctx.projectId);
  if (!project) throw new DomainError('not_found', `no project ${ctx.projectId}`);
  return project;
}

/** A task of the brain's project. */
export function taskOf(ctx: BrainToolContext, taskId: Id): Task {
  const project = projectOf(ctx);
  const task = ctx.queries.task(taskId);
  if (!task) throw new DomainError('not_found', `no task ${taskId}`);
  if (task.projectId !== project.id) {
    throw new DomainError('invalid', `task ${taskId} is not a task of your project ${project.id}`);
  }
  return task;
}

/** The task's Stewards, newest first. */
export function stewardsOf(ctx: BrainToolContext, taskId: Id): Agent[] {
  return ctx.queries
    .supervisedAgents(ctx.brainId)
    .map((s) => s.agent)
    .filter((a) => a.role === 'steward' && a.taskId === taskId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const liveStewards = (ctx: BrainToolContext, filter: (a: Agent) => boolean = () => true) =>
  ctx.queries
    .supervisedAgents(ctx.brainId)
    .filter(({ agent, status }) => agent.role === 'steward' && filter(agent) && isLive(status));

const runtimeOf = (ctx: BrainToolContext) =>
  ctx.queries.agent(ctx.brainId)?.runtime ?? 'claude-sdk';

const brief = (t: Task) => ({ taskId: t.id, description: t.description, state: t.state });

/** The project's plan cards, oldest first. */
const plansOf = (ctx: BrainToolContext, projectId: Id) =>
  ctx.queries.proposals().filter((p) => proposalPlan(p)?.projectId === projectId);

// -- plan_tasks ------------------------------------------------------------------------------------

export const planTasksTool: BrainTool = {
  name: 'plan_tasks',
  description:
    "Presents the project's task plan to the user as ONE card, approved or rejected as a whole " +
    '(SPEC §3.3). The tasks are created as proposed; on approval they become approved and you ' +
    'are told. One plan per project: later work is added with create_task. Ends your turn.',
  inputSchema: obj(
    {
      summary: { type: 'string', description: 'What the plan delivers, one or two lines.' },
      rationale: { type: 'string', description: 'Why this breakdown.' },
      tasks: {
        type: 'array',
        minItems: 1,
        items: obj(
          {
            description: { type: 'string' },
            priority: { enum: PRIORITIES },
            blockedBy: {
              type: 'array',
              items: { type: 'integer', minimum: 0 },
              description: 'Positions (0-based) of earlier tasks of this plan it must wait for.',
            },
          },
          ['description'],
        ),
      },
    },
    ['summary', 'tasks'],
  ),
  endsTurn: true,
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const project = projectOf(ctx);
    const tasks = input['tasks'];
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new DomainError('invalid', 'tasks must be a non-empty list');
    }
    const planned: PlanTaskInput[] = tasks.map((t, i) => {
      const task = asInput(t);
      const blockedBy = task['blockedBy'];
      if (blockedBy !== undefined && !Array.isArray(blockedBy)) {
        throw new DomainError('invalid', `tasks[${i}].blockedBy must be a list of positions`);
      }
      const priority = optPriority(task);
      return {
        description: str(task, 'description'),
        ...(priority ? { priority } : {}),
        ...(Array.isArray(blockedBy) && blockedBy.length > 0
          ? { blockedBy: blockedBy as number[] }
          : {}),
      };
    });
    const rationale = optStr(input, 'rationale');
    const { value } = await ctx.commands.proposePlan({
      projectId: project.id,
      waykeeperId: ctx.brainId,
      summary: str(input, 'summary'),
      ...(rationale ? { rationale } : {}),
      tasks: planned,
    });
    return {
      proposalId: value.proposal.id,
      state: value.proposal.state,
      tasks: value.tasks.map((t) => ({ ...brief(t), blockedBy: t.blockedBy })),
    };
  },
};

// -- create_task -----------------------------------------------------------------------------------

export const createTaskTool: BrainTool = {
  name: 'create_task',
  description:
    'Adds one task to your project after the plan was approved (work you discovered on the way). ' +
    'It is approved at once; spawn a Steward for it when it is ready.',
  inputSchema: obj(
    {
      description: { type: 'string' },
      priority: { enum: PRIORITIES },
      blockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids it waits for.',
      },
    },
    ['description'],
  ),
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const project = projectOf(ctx);
    const plans = plansOf(ctx, project.id);
    const waiting = plans.find((p) => ['pending', 'edited', 'parked'].includes(p.state));
    if (waiting) {
      throw new DomainError(
        'conflict',
        `your plan ${waiting.id} is waiting for the user; tasks are added after the decision`,
      );
    }
    if (!plans.some((p) => p.state === 'approved')) {
      throw new DomainError(
        'invalid_transition',
        'the project has no approved plan yet: present one with plan_tasks first',
      );
    }
    const blockedBy = input['blockedBy'];
    if (blockedBy !== undefined && !Array.isArray(blockedBy)) {
      throw new DomainError('invalid', 'blockedBy must be a list of task ids');
    }
    for (const id of (blockedBy ?? []) as Id[]) taskOf(ctx, id);
    const priority = optPriority(input);
    const { value } = await ctx.commands.createTask({
      description: str(input, 'description'),
      projectId: project.id,
      ...(priority ? { priority } : {}),
      ...(Array.isArray(blockedBy) && blockedBy.length > 0 ? { blockedBy: blockedBy as Id[] } : {}),
    });
    return { ...brief(value), blockedBy: value.blockedBy };
  },
};

// -- spawn_steward ---------------------------------------------------------------------------------

export const spawnStewardTool: BrainTool = {
  name: 'spawn_steward',
  description:
    'Starts the Steward of an approved task: the server creates its git worktree and branch (or, ' +
    'in a workspace that is not a git repository, runs it in the workspace, one Steward at a ' +
    "time) and the Steward works under the project's permission policy, reporting to you.",
  inputSchema: obj(
    {
      taskId: { type: 'string' },
      instructions: {
        type: 'string',
        description: 'What the Steward must do and how it knows it is done.',
      },
    },
    ['taskId', 'instructions'],
  ),
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const task = taskOf(ctx, str(input, 'taskId'));
    const instructions = str(input, 'instructions');
    if (task.state === 'proposed') {
      throw new DomainError('invalid_transition', `task ${task.id} waits for the plan's approval`);
    }
    if (TASK_DONE.has(task.state)) {
      throw new DomainError('invalid_transition', `task ${task.id} is ${task.state}`);
    }
    const open = task.blockedBy.filter((id) => ctx.queries.task(id)?.state !== 'completed');
    if (open.length > 0) {
      throw new DomainError(
        'invalid_transition',
        `task ${task.id} waits for ${open.join(', ')} to be completed`,
      );
    }
    const running = liveStewards(ctx, (a) => a.taskId === task.id);
    if (running.length > 0) {
      throw new DomainError(
        'conflict',
        `task ${task.id} already has a running Steward (${running[0]!.agent.id})`,
      );
    }
    const where = await placeSteward(ctx, task);
    const project = projectOf(ctx);
    const { value } = await ctx.commands.spawnAgent({
      role: 'steward',
      runtime: runtimeOf(ctx),
      taskId: task.id,
      supervisorId: ctx.brainId,
      prompt: stewardPrompt(task, project, where, instructions),
    });
    return {
      stewardId: value.id,
      taskId: task.id,
      cwd: where.cwd,
      ...(where.branch ? { branch: where.branch } : {}),
      serialised: where.serialised,
    };
  },
};

/**
 * Where the task's Steward works (SPEC §3.5, decision 27): its worktree, created now, or the
 * workspace itself when the project has no worktrees — then only one Steward runs at a time. A
 * workspace that was never prepared is prepared first (it creates nothing the user did not agree
 * to: an existing non-git folder stays as it is and serialises the project).
 */
async function placeSteward(
  ctx: BrainToolContext,
  task: Task,
): Promise<{ cwd: string; branch?: string; serialised: boolean }> {
  let project = projectOf(ctx);
  if (ctx.workspaces && !workspaceMeta(project)) {
    await ctx.workspaces.prepareProject(project.id);
    project = projectOf(ctx);
  }
  if (stewardsSerialised(project)) {
    const busy = liveStewards(ctx, (a) => a.projectId === project.id);
    if (busy.length > 0) {
      throw new DomainError(
        'conflict',
        `the workspace of project ${project.id} has no worktrees, so its Stewards run one at a time; ` +
          `wait for ${busy.map((b) => b.agent.id).join(', ')}`,
      );
    }
    return { cwd: project.workspace, serialised: true };
  }
  if (!ctx.workspaces) {
    throw new DomainError('invalid', 'the server has no workspace service to create worktrees');
  }
  const worktree = await ctx.workspaces.createWorktree(task.id);
  return { cwd: worktree.path, branch: worktree.branch, serialised: false };
}

// -- merge_task ------------------------------------------------------------------------------------

interface MergeMeta {
  /** Times the Steward was sent back to resolve a conflict. */
  sentBack?: number;
  /** The open question about the conflict, if one was asked. */
  questionId?: Id;
}

const mergeMetaOf = (task: Task): MergeMeta =>
  ((task.meta?.['mergeConflict'] as MergeMeta | undefined) ?? {}) as MergeMeta;

async function saveMergeMeta(ctx: BrainToolContext, taskId: Id, meta: MergeMeta | null) {
  const task = ctx.queries.task(taskId)!;
  const { mergeConflict: _drop, ...rest } = task.meta ?? {};
  await ctx.commands.updateTask(taskId, {
    meta: meta ? { ...rest, mergeConflict: meta } : rest,
  });
}

export const mergeTaskTool: BrainTool = {
  name: 'merge_task',
  description:
    "Merges a finished task's branch into the project's base branch (SPEC decision 30). On a " +
    "conflict with work this project merged itself, the task's Steward is sent back into its " +
    'worktree to merge the base branch and resolve; merge again once it reports. On a conflict ' +
    'with commits from outside the project, the user is asked. Call it before close_task.',
  inputSchema: obj(
    {
      taskId: { type: 'string' },
      commitPending: {
        type: 'boolean',
        description: "Commit the worktree's uncommitted changes before merging.",
      },
      note: {
        type: 'string',
        description: 'A line for the Steward, should it be sent back to resolve a conflict.',
      },
    },
    ['taskId'],
  ),
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const task = taskOf(ctx, str(input, 'taskId'));
    const project = projectOf(ctx);
    if (stewardsSerialised(project)) {
      return {
        merged: true,
        serialised: true,
        nothingToMerge: true,
        note: 'This workspace has no worktrees: the Steward worked in it directly.',
      };
    }
    if (!ctx.workspaces) {
      throw new DomainError('invalid', 'the server has no workspace service to merge with');
    }
    const busy = liveStewards(
      ctx,
      (a) => a.taskId === task.id && BUSY.has(ctx.queries.status(a.id)?.state ?? ''),
    );
    if (busy.length > 0) {
      throw new DomainError(
        'conflict',
        `the Steward of task ${task.id} (${busy[0]!.agent.id}) is still working; merge when it reports`,
      );
    }
    const result = await ctx.workspaces.mergeTask(task.id, {
      ...(input['commitPending'] === true ? { commitPending: true } : {}),
    });
    if (result.ok) {
      if (task.meta?.['mergeConflict']) await saveMergeMeta(ctx, task.id, null);
      return {
        merged: true,
        commit: result.commit,
        fastForward: result.fastForward,
        nothingToMerge: result.nothingToMerge,
        branchDeleted: result.branchDeleted,
        next: 'Close the task with close_task if its work is done.',
      };
    }
    if (result.reason !== 'conflict') {
      return {
        merged: false,
        reason: result.reason,
        message: result.message,
        ...(result.files ? { files: result.files } : {}),
      };
    }
    return onConflict(ctx, task, result.conflict, optStr(input, 'note'));
  },
};

async function onConflict(
  ctx: BrainToolContext,
  task: Task,
  conflict: MergeConflict,
  note: string | undefined,
) {
  const meta = mergeMetaOf(task);
  const facts = {
    merged: false,
    reason: 'conflict' as const,
    files: conflict.files,
    sourceBranch: conflict.sourceBranch,
    targetBranch: conflict.targetBranch,
    external: conflict.external,
  };
  if (!conflict.external && (meta.sentBack ?? 0) < MAX_SEND_BACKS) {
    const back = await sendBack(ctx, task, conflict, note);
    await saveMergeMeta(ctx, task.id, { ...meta, sentBack: (meta.sentBack ?? 0) + 1 });
    return {
      ...facts,
      action: 'steward_sent_back',
      ...back,
      next: 'Wait for the Steward to report, then call merge_task again.',
    };
  }
  // External commits (or a Steward that could not resolve it twice): the user decides.
  const open = meta.questionId ? ctx.queries.question(meta.questionId) : undefined;
  if (open?.status === 'open') {
    return { ...facts, action: 'asked_user', questionId: open.id, note: 'already asked' };
  }
  const text = conflict.external
    ? externalConflictText(conflict, task.description)
    : `Task ${task.id} ("${task.description}") still conflicts with ${conflict.targetBranch} in ` +
      `${conflict.files.join(', ')} after its Steward was sent back ${meta.sentBack} times. ` +
      `The work is kept in ${conflict.worktreePath} on ${conflict.sourceBranch}. How should it be resolved?`;
  const question = await askUser(ctx, text, EXTERNAL_CONFLICT_OPTIONS);
  await saveMergeMeta(ctx, task.id, { ...meta, questionId: question.id });
  return {
    ...facts,
    ...(conflict.external
      ? { externalCommits: conflict.externalCommits, externalCount: conflict.externalCount }
      : {}),
    action: 'asked_user',
    questionId: question.id,
    next: 'Wait for the answer; it arrives in a later turn.',
  };
}

/**
 * Sends the task's own Steward back into its kept worktree (decision 30): a live one gets the
 * instruction as a message, an ended one is spawned again on the same task, in the same worktree.
 */
async function sendBack(
  ctx: BrainToolContext,
  task: Task,
  conflict: MergeConflict,
  note: string | undefined,
): Promise<{ stewardId: Id; how: 'messaged' | 'respawned' }> {
  const text = sendBackPrompt(conflict, note);
  const live = stewardsOf(ctx, task.id).find((a) => isLive(ctx.queries.status(a.id)));
  if (live) {
    ctx.send(live.id, text);
    return { stewardId: live.id, how: 'messaged' };
  }
  const { value } = await ctx.commands.spawnAgent({
    role: 'steward',
    runtime: runtimeOf(ctx),
    taskId: task.id,
    supervisorId: ctx.brainId,
    prompt: text,
  });
  return { stewardId: value.id, how: 'respawned' };
}

/**
 * A clarification question for the user: opened by the brain (held by its supervisor at first,
 * as every question is) and escalated by the system straight up to the user, because decision 30
 * leaves this one to the user — no brain between may answer it.
 */
async function askUser(ctx: BrainToolContext, text: string, options: string[]): Promise<Question> {
  let question = (
    await ctx.commands.openQuestion({
      kind: 'clarification',
      originAgentId: ctx.brainId,
      context: { text, options },
    })
  ).value;
  for (let hops = 0; question.holder.type === 'agent' && hops < 8; hops++) {
    question = (await ctx.commands.escalateQuestion(question.id, SYSTEM)).value;
  }
  return question;
}

// -- close_task ------------------------------------------------------------------------------------

export const closeTaskTool: BrainTool = {
  name: 'close_task',
  description:
    'Closes a task whose work you judged done (SPEC §2.7): it becomes completed and its Steward ' +
    'is stopped. Merge it first; pass unmerged: true only to close it without merging (the ' +
    'branch and worktree are kept).',
  inputSchema: obj(
    {
      taskId: { type: 'string' },
      unmerged: { type: 'boolean', description: 'Close without merging its branch.' },
    },
    ['taskId'],
  ),
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const task = taskOf(ctx, str(input, 'taskId'));
    if (task.worktreePath && input['unmerged'] !== true) {
      throw new DomainError(
        'invalid',
        `task ${task.id} has an unmerged worktree: merge it with merge_task first (or pass unmerged: true)`,
      );
    }
    const live = liveStewards(ctx, (a) => a.taskId === task.id);
    const working = live.filter((s) => BUSY.has(s.status?.state ?? ''));
    if (working.length > 0) {
      throw new DomainError(
        'conflict',
        `the Steward of task ${task.id} (${working[0]!.agent.id}) is still working; stop it first or wait for its report`,
      );
    }
    const { value } = await ctx.commands.closeTask(task.id, ctx.actor);
    for (const { agent } of live) await ctx.commands.stopAgent(agent.id, ctx.actor);
    const open = ctx.queries.projectTasks(projectOf(ctx).id).filter((t) => !TASK_DONE.has(t.state));
    return {
      ...brief(value),
      openTasks: open.map(brief),
      ...(open.length === 0
        ? {
            allTasksClosed: true,
            next: 'Every task is closed: call request_project_closure when nothing is left to do.',
          }
        : {}),
    };
  },
};

// -- escalate --------------------------------------------------------------------------------------

export const escalateTool: BrainTool = {
  name: 'escalate',
  description:
    'Passes a clarification question you hold (questionId) up to the Harmonizer, or asks one of ' +
    'your own (text). Ends your turn; the answer arrives in a later turn.',
  inputSchema: obj({
    questionId: { type: 'string', description: 'A question you hold.' },
    text: { type: 'string', description: 'Your own question.' },
    options: { type: 'array', items: { type: 'string' } },
  }),
  endsTurn: true,
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const questionId = optStr(input, 'questionId');
    const text = optStr(input, 'text');
    if (!questionId === !text) {
      throw new DomainError('invalid', 'give either a questionId to escalate or a text to ask');
    }
    if (questionId) {
      const q = ctx.queries.question(questionId);
      if (q?.kind === 'permission') {
        throw new DomainError('invalid', `${questionId} is a permission question; it is not yours`);
      }
      const { value } = await ctx.commands.escalateQuestion(questionId, ctx.actor);
      return { questionId, holder: value.holder };
    }
    const options = input['options'];
    const { value } = await ctx.commands.openQuestion({
      kind: 'clarification',
      originAgentId: ctx.brainId,
      context: {
        text: text!,
        ...(Array.isArray(options) && options.length > 0 ? { options: options as string[] } : {}),
      },
    });
    return { questionId: value.id, holder: value.holder };
  },
};

// -- request_promotion -----------------------------------------------------------------------------

export const requestPromotionTool: BrainTool = {
  name: 'request_promotion',
  description:
    'Asks the user to promote a task that turned out to be a project of its own to a moon (a ' +
    "sub-project of this planet's project) or a planet. Creates the request card; the user " +
    'decides, and the move itself happens on approval. Ends your turn.',
  inputSchema: obj(
    {
      taskId: { type: 'string' },
      to: { enum: ['moon', 'planet'] },
      reason: { type: 'string' },
    },
    ['taskId', 'to', 'reason'],
  ),
  endsTurn: true,
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const task = taskOf(ctx, str(input, 'taskId'));
    const project = projectOf(ctx);
    const to = input['to'] as 'moon' | 'planet';
    if (to !== 'moon' && to !== 'planet') throw new DomainError('invalid', 'to is moon or planet');
    const reason = str(input, 'reason');
    if (TASK_DONE.has(task.state) || task.state === 'proposed') {
      throw new DomainError('invalid_transition', `task ${task.id} is ${task.state}`);
    }
    const pending = ctx.queries
      .proposals()
      .find(
        (p) =>
          ['pending', 'edited', 'parked'].includes(p.state) &&
          (p.meta?.['promotion'] as { taskId?: Id } | undefined)?.taskId === task.id,
      );
    if (pending) {
      throw new DomainError('conflict', `promotion ${pending.id} of task ${task.id} is pending`);
    }
    const choice = await ctx.commands.chooseBody(
      to === 'moon' ? { kind: 'moon', parentProjectId: project.id } : { kind: 'planet' },
    );
    const proposedBody: ProposedBody = choice.ok
      ? {
          kind: to,
          bodyId: choice.body.id,
          name: choice.body.name,
          ...(choice.body.parentId ? { parentId: choice.body.parentId } : {}),
        }
      : { kind: to, name: `a free ${to}` };
    const { value } = await ctx.commands.createProposal({
      requestText: `Promote task ${task.id} ("${task.description}") of ${project.name} to a ${to}`,
      kind: to,
      proposedBody,
      workspace: project.workspace,
      rationale: reason,
      meta: {
        promotion: {
          taskId: task.id,
          fromProjectId: project.id,
          requestedBy: ctx.brainId,
          ...(choice.ok ? {} : { noFreeBody: choice.reason }),
        },
      },
    });
    return { proposalId: value.id, proposedBody: value.proposedBody };
  },
};

// -- request_project_closure -----------------------------------------------------------------------

export const requestProjectClosureTool: BrainTool = {
  name: 'request_project_closure',
  description:
    'Tells the Harmonizer that every task of the project is closed, with a summary of what was ' +
    "delivered; it asks the user whether anything else is needed. Closing is the user's " +
    'decision; stay available until then. Ends your turn.',
  inputSchema: obj({ summary: { type: 'string' } }, ['summary']),
  endsTurn: true,
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const summary = str(input, 'summary');
    const project = projectOf(ctx);
    const tasks = ctx.queries.projectTasks(project.id);
    const open = tasks.filter((t) => !TASK_DONE.has(t.state));
    if (tasks.every((t) => t.state !== 'completed') || open.length > 0) {
      throw new DomainError(
        'invalid_transition',
        open.length > 0
          ? `tasks still open: ${open.map((t) => `${t.id} [${t.state}]`).join(', ')}`
          : 'no task of the project was completed',
      );
    }
    const running = liveStewards(ctx);
    if (running.length > 0) {
      throw new DomainError(
        'conflict',
        `Stewards still running: ${running.map((r) => r.agent.id).join(', ')}`,
      );
    }
    const supervisorId = ctx.queries.agent(ctx.brainId)?.supervisorId;
    if (!supervisorId) throw new DomainError('invalid', 'you have no supervisor to ask');
    // The request is kept on the project, so it survives a restart and P2-13 can read it.
    await ctx.commands.updateProject(project.id, {
      meta: {
        ...project.meta,
        closureRequest: { by: ctx.brainId, summary, tasks: tasks.length },
      },
    });
    const text =
      `Project ${project.id} ("${project.name}") is done: every task is closed. ${summary}\n` +
      'Please ask the user whether anything else is needed, or whether to close the project.';
    let messageId: Id | undefined;
    try {
      messageId = ctx.send(supervisorId, text).messageId;
    } catch {
      // A supervisor that is not running learns it from the project's record on its next start.
    }
    return {
      projectId: project.id,
      requestedOf: supervisorId,
      ...(messageId
        ? { messageId }
        : { note: 'your supervisor is not running; the request is recorded' }),
    };
  },
};

export const WAYKEEPER_TOOLS: readonly BrainTool[] = [
  planTasksTool,
  createTaskTool,
  spawnStewardTool,
  mergeTaskTool,
  closeTaskTool,
  escalateTool,
  requestPromotionTool,
  requestProjectClosureTool,
];
