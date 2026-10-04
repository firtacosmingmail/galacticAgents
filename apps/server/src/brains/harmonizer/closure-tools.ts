import type { ControlAction, ControlTarget, Id, Project, Question } from '@galactic/protocol';
import { closureRequestOf } from '../../domain/closure.js';
import { DomainError, must } from '../../domain/errors.js';
import { COMMAND_SOURCE } from '../../domain/questions.js';
import { isLive } from '../common-tools.js';
import type { BrainStartContext, BrainTool, BrainToolContext } from '../definition.js';
import { asInput, oneOf, S, str } from './input.js';

/**
 * The Harmonizer's closure and finished-work tools (P2-13; SPEC §2.7, decisions 4, 11, 11b):
 *
 *   - `ask_closure`: the closure relay — "Anything else on <project>?" to the user, linked to the
 *     project's closure request so closing withdraws it;
 *   - `close_project`: carries out the user's decision to close (`control.close`: the Waykeeper
 *     and Stewards are stopped, `completed`, the retention clock starts);
 *   - `finished_work`: archive now, pin, unpin or reopen a project or task (the panel's actions,
 *     conversationally);
 *   - `ask_confirmation`: asks the user to confirm one of those actions, or a stop or cancel of
 *     work for `control_work` (P5-07, decision 83; `control-tools.ts`).
 *
 * The user's word is checked in code, never left to the prompt (decision 11): `close_project`
 * and `finished_work` act only on a question the user answered with that choice — the project's
 * "Anything else?" question answered "Close …", or an `ask_confirmation` question this Harmonizer
 * asked about exactly that action and target, answered with its first option (or yes). The
 * panel's own controls are the user's directly and need none of this. The tools record the
 * Harmonizer as `by`.
 */

const FINISHED = new Set(['completed', 'archived', 'failed', 'moved']);
const ACTIONS = ['archive', 'pin', 'unpin', 'reopen'] as const;

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
        closureRequest: {
          ...(request ?? { by: ctx.brainId, summary: summary ?? '' }),
          questionId: value.id,
        },
      },
    });
    return { questionId: value.id, projectId };
  },
};

/** The work controls that need the user's confirmation in conversation (decision 83). */
export const CONFIRMED_CONTROLS = ['stop', 'cancel'] as const;

export type Confirmable = 'close' | (typeof ACTIONS)[number] | (typeof CONFIRMED_CONTROLS)[number];

/** What the target is called on a confirmation question. */
export function labelOf(ctx: BrainToolContext, kind: 'project' | 'task', id: Id): string {
  if (kind === 'project') return must(ctx.queries.project(id), 'project', id).name;
  const task = must(ctx.queries.task(id), 'task', id);
  const line = task.description.split('\n')[0]!.trim();
  return `task "${line.length > 50 ? `${line.slice(0, 49)}…` : line}" (${id})`;
}

/** The choice a confirmation question offers first: what the user agrees to. */
function choiceOf(action: Confirmable, label: string): string {
  switch (action) {
    case 'close':
      return `Close ${label}`;
    case 'archive':
      return `Archive ${label} now`;
    case 'pin':
      return `Pin ${label} (never archived)`;
    case 'unpin':
      return `Unpin ${label}`;
    case 'reopen':
      return `Reopen ${label}`;
    case 'stop':
      return `Stop ${label} (its agents stop)`;
    case 'cancel':
      return `Cancel ${label} (it fails, its agents stop)`;
  }
}

const YES = /^\s*(yes|y|ok|okay|confirm(ed)?|do it)\b/i;

/** Whether the user answered `q` with `choice` (or a plain yes). */
function userChose(q: Question | undefined, choice: string, yes = true): boolean {
  if (q?.status !== 'answered' || q.answeredBy?.type !== 'user') return false;
  const answer = (q.answer ?? '').trim();
  return answer.toLowerCase() === choice.toLowerCase() || (yes && YES.test(answer));
}

/**
 * Refuses unless the user agreed (decision 11): `questionId` is a question this Harmonizer asked
 * with `ask_confirmation` for exactly this action and target, answered by the user with its
 * first option or yes. For a close, the project's "Anything else?" question answered "Close …"
 * counts too.
 */
export function checkUserAgreed(
  ctx: BrainToolContext,
  action: Confirmable,
  kind: 'project' | 'task',
  id: Id,
  questionId: Id | undefined,
): void {
  const label = labelOf(ctx, kind, id);
  const choice = choiceOf(action, label);
  if (action === 'close' && kind === 'project') {
    const closure = closureRequestOf(ctx.queries.project(id)!)?.questionId;
    const q = closure ? ctx.queries.question(closure) : undefined;
    if (q && userChose(q, choice, false)) return;
    if (q && /^\s*close\b/i.test(q.answer ?? '') && userChose(q, q.answer ?? '', false)) return;
  }
  const q = questionId ? ctx.queries.question(questionId) : undefined;
  if (
    q &&
    q.originAgentId === ctx.brainId &&
    q.context.options?.[0] === choice &&
    userChose(q, choice)
  ) {
    return;
  }
  throw new DomainError(
    'invalid',
    `only the user decides to ${action} ${label} (decision 11): ask_confirmation first, then ` +
      `call this again with its questionId once the user answered "${choice}"` +
      (questionId ? ` (question ${questionId} is not such an answer)` : ''),
  );
}

export const askConfirmationTool: BrainTool = {
  name: 'ask_confirmation',
  description:
    'Asks the user to confirm closing a project, a finished-work action (archive, pin, unpin, ' +
    'reopen) or stopping or cancelling work (stop, cancel) they asked for in conversation. Ends ' +
    'your turn; once the user answers with the first choice, call close_project / finished_work ' +
    '/ control_work with this questionId.',
  inputSchema: S.obj(
    {
      kind: { type: 'string', enum: ['project', 'task'] },
      id: S.str('The project or task.'),
      action: { type: 'string', enum: ['close', ...ACTIONS, ...CONFIRMED_CONTROLS] },
    },
    ['kind', 'id', 'action'],
  ),
  endsTurn: true,
  async handler(raw, ctx) {
    const input = asInput(raw);
    const kind = oneOf(input, 'kind', ['project', 'task'] as const);
    const id = str(input, 'id');
    const action = oneOf(input, 'action', ['close', ...ACTIONS, ...CONFIRMED_CONTROLS] as const);
    if (action === 'close' && kind !== 'project') {
      throw new DomainError('invalid', 'only a project is closed; a task is closed by close_task');
    }
    const choice = choiceOf(action, labelOf(ctx, kind, id));
    const { value } = await ctx.commands.openQuestion({
      kind: 'clarification',
      originAgentId: ctx.brainId,
      context: { text: `${choice}?`, options: [choice, 'No'] },
    });
    return { questionId: value.id, asked: `${choice}?` };
  },
};

export const closeProjectTool: BrainTool = {
  name: 'close_project',
  description:
    "Closes a project on the user's decision only (decision 11): its Waykeeper and Stewards are " +
    'stopped, transcripts kept, the project is completed and its body is kept for the retention ' +
    'period. Allowed once the user answered the "Anything else?" question with "Close …", or an ' +
    'ask_confirmation question (pass its questionId). Refused while a sub-project moon is active.',
  inputSchema: S.obj(
    {
      projectId: S.str('The project the user closes.'),
      questionId: S.str(
        'The ask_confirmation question the user answered (not needed after "Anything else?").',
      ),
    },
    ['projectId'],
  ),
  async handler(raw, ctx) {
    const input = asInput(raw);
    const projectId = str(input, 'projectId');
    must(ctx.queries.project(projectId), 'project', projectId);
    checkUserAgreed(ctx, 'close', 'project', projectId, str(input, 'questionId', true));
    await ctx.commands.control({ kind: 'project', id: projectId }, { action: 'close' }, ctx.actor);
    return { projectId, state: ctx.queries.project(projectId)?.state };
  },
};

export const finishedWorkTool: BrainTool = {
  name: 'finished_work',
  description:
    'On the user\'s request, for a project or a task: "archive" now (frees its body), "pin" ' +
    '(never archived by the retention timer), "unpin" (a full retention period starts again) or ' +
    '"reopen" finished work (its old body if free, else a new one; spawn_waykeeper afterwards ' +
    "for a project). Needs the user's confirmation: ask_confirmation first, then pass its " +
    'questionId.',
  inputSchema: S.obj(
    {
      kind: { type: 'string', enum: ['project', 'task'] },
      id: S.str('The project or task.'),
      action: { type: 'string', enum: [...ACTIONS] },
      questionId: S.str('The ask_confirmation question the user answered.'),
    },
    ['kind', 'id', 'action', 'questionId'],
  ),
  async handler(raw, ctx) {
    const input = asInput(raw);
    const kind = oneOf(input, 'kind', ['project', 'task'] as const);
    const id = str(input, 'id');
    const action = oneOf(input, 'action', ACTIONS);
    if (kind === 'project') must(ctx.queries.project(id), 'project', id);
    else must(ctx.queries.task(id), 'task', id);
    checkUserAgreed(ctx, action, kind, id, str(input, 'questionId', true));
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

export const CLOSURE_TOOLS: readonly BrainTool[] = [
  askClosureTool,
  askConfirmationTool,
  closeProjectTool,
  finishedWorkTool,
];

/**
 * The closure requests a starting or resumed Harmonizer must relay (P2-16; P2-13's deferred
 * case): every unfinished project whose Waykeeper recorded a closure request that no living
 * Harmonizer has asked the user about — no question yet (recorded while no Harmonizer ran), or
 * one that was cancelled. A question still open that an earlier, ended Harmonizer asked is
 * withdrawn, so this one asks again and hears the answer. One line per project for the first turn.
 */
export async function closureNotes(ctx: BrainStartContext): Promise<string[]> {
  const lines: string[] = [];
  for (const project of ctx.queries.projects()) {
    if (FINISHED.has(project.state)) continue;
    const request = closureRequestOf(project);
    if (!request) continue;
    const q = request.questionId ? ctx.queries.question(request.questionId) : undefined;
    if (q?.status === 'answered') continue;
    if (q?.status === 'open') {
      const mine = ctx.brainId !== undefined && q.originAgentId === ctx.brainId;
      if (mine || isLive(ctx.queries.status(q.originAgentId))) continue;
      try {
        await ctx.commands.withdrawQuestion(
          q.id,
          'the Harmonizer that asked it has ended; the new one asks again',
          { type: 'system' },
        );
      } catch {
        continue; // answered or withdrawn meanwhile
      }
    }
    lines.push(
      `the Waykeeper of project ${project.id} ("${project.name}") asked for closure and the ` +
        `user has not been asked yet${request.summary ? `: ${JSON.stringify(request.summary)}` : ''} ` +
        '— relay it with ask_closure.',
    );
  }
  return lines;
}

/**
 * The Harmonizer's other start notes (P2-16): questions an ended Harmonizer asked the user through
 * a tool (`ask_user`, `ask_confirmation`) and nobody answered. Their answer could never reach the
 * new Harmonizer (the answer wakes the asker, and `finished_work` accepts only a confirmation this
 * Harmonizer asked), so they are withdrawn — the "waiting for you" count comes back down — and the
 * new Harmonizer is told what was asked, to ask again if it still matters. Closure questions are
 * `closureNotes`' (run first).
 */
export async function strandedQuestionNotes(ctx: BrainStartContext): Promise<string[]> {
  const lines: string[] = [];
  for (const q of ctx.queries.allOpenQuestions()) {
    if (q.kind !== 'clarification' || q.meta?.['source'] !== COMMAND_SOURCE) continue;
    if (q.originAgentId === ctx.brainId) continue;
    if (ctx.queries.agent(q.originAgentId)?.role !== 'harmonizer') continue;
    if (isLive(ctx.queries.status(q.originAgentId))) continue;
    try {
      await ctx.commands.withdrawQuestion(
        q.id,
        'the Harmonizer that asked it has ended; the new one asks again if it still matters',
        { type: 'system' },
      );
    } catch {
      continue; // answered or withdrawn meanwhile
    }
    lines.push(
      `an earlier Harmonizer (${q.originAgentId}) had asked the user ${JSON.stringify(q.context.text)} ` +
        `(${q.id}) and ended before the answer; the question was withdrawn — ask again ` +
        '(ask_user, ask_confirmation) if it still matters.',
    );
  }
  return lines;
}

/** Every start note of the Harmonizer: unrelayed closure requests, then stranded questions. */
export async function harmonizerStartNotes(ctx: BrainStartContext): Promise<string[]> {
  const closure = await closureNotes(ctx);
  return [...closure, ...(await strandedQuestionNotes(ctx))];
}
