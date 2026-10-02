import type { ControlAction, ControlTarget, Project } from '@galactic/protocol';
import { closureRequestOf } from '../../domain/closure.js';
import { DomainError, must } from '../../domain/errors.js';
import type { BrainTool } from '../definition.js';
import { asInput, oneOf, S, str } from './input.js';

/**
 * The Harmonizer's closure and finished-work tools (P2-13; SPEC §2.7, decisions 4, 11, 11b):
 *
 *   - `ask_closure`: the closure relay — "Anything else on <project>?" to the user, linked to the
 *     project's closure request so closing withdraws it;
 *   - `close_project`: carries out the user's decision to close (`control.close`: the Waykeeper
 *     and Stewards are stopped, `completed`, the retention clock starts);
 *   - `finished_work`: archive now, pin, unpin or reopen a project or task (the panel's actions,
 *     conversationally).
 *
 * The tools record the Harmonizer as `by`; the prompt holds it to acting on the user's word.
 */

const FINISHED = new Set(['completed', 'archived', 'failed', 'moved']);

export const askClosureTool: BrainTool = {
  name: 'ask_closure',
  description:
    'Relays a Waykeeper\'s closure request to the user: asks "Anything else on <project>?" with ' +
    'the summary, linked to the project so closing it answers the question. Ends your turn; ' +
    'the answer arrives later (then close_project, or handle the new request).',
  inputSchema: S.obj(
    {
      projectId: S.str('The project whose Waykeeper asked for closure.'),
      summary: S.str('What was delivered, in a sentence or two (default: the Waykeeper’s).'),
    },
    ['projectId'],
  ),
  endsTurn: true,
  async handler(raw, ctx) {
    const input = asInput(raw);
    const projectId = str(input, 'projectId');
    const project = must(ctx.queries.project(projectId), 'project', projectId);
    if (FINISHED.has(project.state)) {
      throw new DomainError('invalid_transition', `project ${projectId} is ${project.state}`);
    }
    const request = closureRequestOf(project);
    const open = request?.questionId ? ctx.queries.question(request.questionId) : undefined;
    if (open?.status === 'open') {
      return { questionId: open.id, note: 'the user was already asked; waiting for the answer' };
    }
    const summary = str(input, 'summary', true) ?? request?.summary;
    const { value } = await ctx.commands.openQuestion({
      kind: 'clarification',
      originAgentId: ctx.brainId,
      context: {
        text: `Anything else on ${project.name}?${summary ? ` ${summary}` : ''}`,
        options: [`Close ${project.name}`, 'Something else: …'],
      },
    });
    await ctx.commands.updateProject(projectId, {
      meta: {
        ...project.meta,
        closureRequest: { ...(request ?? { by: ctx.brainId, summary: summary ?? '' }), questionId: value.id },
      },
    });
    return { questionId: value.id, projectId };
  },
};

export const closeProjectTool: BrainTool = {
  name: 'close_project',
  description:
    "Closes a project on the user's decision only (decision 11): its Waykeeper and Stewards are " +
    'stopped, transcripts kept, the project is completed and its body is kept for the retention ' +
    'period. Refused while a sub-project moon is active.',
  inputSchema: S.obj({ projectId: S.str('The project the user closes.') }, ['projectId']),
  async handler(raw, ctx) {
    const projectId = str(asInput(raw), 'projectId');
    must(ctx.queries.project(projectId), 'project', projectId);
    await ctx.commands.control({ kind: 'project', id: projectId }, { action: 'close' }, ctx.actor);
    return { projectId, state: ctx.queries.project(projectId)?.state };
  },
};

const ACTIONS = ['archive', 'pin', 'unpin', 'reopen'] as const;

export const finishedWorkTool: BrainTool = {
  name: 'finished_work',
  description:
    'On the user\'s request, for a project or a task: "archive" now (frees its body), "pin" ' +
    '(never archived by the retention timer), "unpin" (a full retention period starts again) or ' +
    '"reopen" finished work (its old body if free, else a new one; spawn_waykeeper afterwards ' +
    'for a project).',
  inputSchema: S.obj(
    {
      kind: { type: 'string', enum: ['project', 'task'] },
      id: S.str('The project or task.'),
      action: { type: 'string', enum: [...ACTIONS] },
    },
    ['kind', 'id', 'action'],
  ),
  async handler(raw, ctx) {
    const input = asInput(raw);
    const kind = oneOf(input, 'kind', ['project', 'task'] as const);
    const id = str(input, 'id');
    const action = oneOf(input, 'action', ACTIONS);
    if (kind === 'project') must(ctx.queries.project(id), 'project', id);
    else must(ctx.queries.task(id), 'task', id);
    const target: ControlTarget = { kind, id };
    const control: ControlAction =
      action === 'pin' || action === 'unpin'
        ? { action: 'pin', pinned: action === 'pin' }
        : { action };
    await ctx.commands.control(target, control, ctx.actor);
    const row: Pick<Project, 'state' | 'bodyId' | 'pinned'> | undefined =
      kind === 'project' ? ctx.queries.project(id) : ctx.queries.task(id);
    return {
      kind,
      id,
      state: row?.state,
      bodyId: row?.bodyId,
      ...(row?.pinned !== undefined ? { pinned: row.pinned } : {}),
    };
  },
};

export const CLOSURE_TOOLS: readonly BrainTool[] = [askClosureTool, closeProjectTool, finishedWorkTool];
