import { z } from 'zod';
import { isHarnessMeta, TaskPriority } from '@galactic/protocol';
import type { ControlAction, ControlTarget, Id, Meta } from '@galactic/protocol';
import { DomainError, must } from '../../domain/errors.js';
import type { BrainTool, BrainToolContext } from '../definition.js';
import { checkUserAgreed, CONFIRMED_CONTROLS, labelOf } from './closure-tools.js';
import { S } from './input.js';

/**
 * `control_work` (P5-07; SPEC decision 83, §4.3): the Harmonizer carries out the panel's work
 * controls on a task or project the user names in conversation, through the same `control`
 * command as `POST /api/control`:
 *
 *   - pause, resume and edit (a task's description or priority, a project's name) run at once;
 *   - stop and cancel run only on an `ask_confirmation` question this Harmonizer asked for exactly
 *     that action and target, answered by the user with its first choice (decision 42's check,
 *     `checkUserAgreed`), and each such answer unlocks one call: it is consumed — recorded on the
 *     target's `meta.usedConfirmations` — once the control went through;
 *   - the trust level and permission table stay the user's (decision 49): an edit naming them is
 *     refused, and so is any other field the panel could not edit;
 *   - scene-harness rows (decision 79) are refused: the harness drives its own stand-ins.
 *
 * The control is logged with the Harmonizer as `by` and with the turn's origin (P2-21), and the
 * affected supervisors are woken by the same `concernedSupervisors` rule as for a panel action.
 */

export const CONTROL_WORK_ACTIONS = ['pause', 'resume', 'stop', 'cancel', 'edit'] as const;

/** The edit fields a policy write would go through: never the Harmonizer's (decision 49). */
const TRUST_FIELDS = new Set([
  'permissionPolicy',
  'policy',
  'trust',
  'trustLevel',
  'preset',
  'autoApproveRemote',
]);

const ControlWorkInput = z
  .object({
    target: z.object({ kind: z.enum(['task', 'project']), id: z.string().trim().min(1) }).strict(),
    action: z.enum(CONTROL_WORK_ACTIONS),
    changes: z.record(z.string(), z.unknown()).optional(),
    questionId: z.string().trim().min(1).optional(),
  })
  .strict();

/** What an edit may change, per kind: the panel's edit form minus the trust level. */
const TaskEdit = z
  .object({ description: z.string().trim().min(1).optional(), priority: TaskPriority.optional() })
  .strict();
const ProjectEdit = z.object({ name: z.string().trim().min(1).optional() }).strict();

/** The `meta` key holding the confirmations a stop or cancel already used. */
export const USED_CONFIRMATIONS = 'usedConfirmations';

function usedConfirmations(meta: Meta | undefined): Id[] {
  const used = meta?.[USED_CONFIRMATIONS];
  return Array.isArray(used) ? used.filter((x): x is Id => typeof x === 'string') : [];
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** The edit's changes, checked like the panel's (the domain checks them once more). */
function editChanges(kind: 'task' | 'project', raw: Record<string, unknown> | undefined) {
  if (!raw || Object.keys(raw).length === 0) {
    throw new DomainError(
      'invalid',
      kind === 'task'
        ? 'an edit needs changes: a task’s description and/or priority'
        : 'an edit needs changes: a project’s name',
    );
  }
  const trust = Object.keys(raw).filter((k) => TRUST_FIELDS.has(k));
  if (trust.length > 0) {
    throw new DomainError(
      'invalid',
      `the trust level and permission table stay the user's (decision 49): ${trust.join(', ')} ` +
        "cannot be changed by you — tell the user to change it on the project's edit form",
    );
  }
  const parsed = (kind === 'task' ? TaskEdit : ProjectEdit).safeParse(raw);
  if (!parsed.success) {
    throw new DomainError(
      'invalid',
      `a ${kind}'s edit takes ${kind === 'task' ? 'description, priority' : 'name'} only: ` +
        issues(parsed.error),
    );
  }
  return Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
}

/** Refuses unless the target exists and is real work (not the scene harness's, decision 79). */
function workOf(ctx: BrainToolContext, target: ControlTarget) {
  const row =
    target.kind === 'project'
      ? must(ctx.queries.project(target.id), 'project', target.id)
      : must(ctx.queries.task(target.id), 'task', target.id);
  if (isHarnessMeta(row.meta)) {
    throw new DomainError(
      'invalid',
      `${target.kind} ${target.id} belongs to the scene harness (decision 79): only the ops ` +
        'console drives it',
    );
  }
  return row;
}

export const controlWorkTool: BrainTool = {
  name: 'control_work',
  description:
    "The panel's work controls on a task or project the user names in conversation (decision " +
    '83): "pause" (its agents pause), "resume", "edit" (changes: a task\'s description and/or ' +
    'priority; a project\'s name) run at once. "stop" (its agents stop, the work is paused) and ' +
    '"cancel" (the work fails, its agents stop) need the user\'s word: ask_confirmation with that ' +
    'action and target first, then call this with its questionId once the user answered its ' +
    'first choice; one answer allows one call. The trust level and permission table are never ' +
    'yours to change.',
  inputSchema: S.obj(
    {
      target: S.obj(
        {
          kind: S.enum(['task', 'project'], 'What the user named.'),
          id: S.str('The task or project id.'),
        },
        ['kind', 'id'],
      ),
      action: S.enum(CONTROL_WORK_ACTIONS, 'The control to carry out.'),
      changes: {
        type: 'object',
        description:
          'edit only: a task\'s {description?, priority?: "low"|"normal"|"high"|"urgent"}, or ' +
          "a project's {name}.",
      },
      questionId: S.str('stop / cancel only: the ask_confirmation question the user answered.'),
    },
    ['target', 'action'],
  ),
  async handler(raw, ctx) {
    const parsed = ControlWorkInput.safeParse(raw ?? {});
    if (!parsed.success) throw new DomainError('invalid', issues(parsed.error));
    const { target, action, changes, questionId } = parsed.data;
    if (changes !== undefined && action !== 'edit') {
      throw new DomainError('invalid', `changes go with "edit" only, not with "${action}"`);
    }
    const row = workOf(ctx, target);

    const confirmed = (CONFIRMED_CONTROLS as readonly string[]).includes(action);
    if (confirmed) {
      const confirm = action as (typeof CONFIRMED_CONTROLS)[number];
      if (questionId && usedConfirmations(row.meta).includes(questionId)) {
        throw new DomainError(
          'invalid',
          `the user's answer to ${questionId} was already used for a ${confirm}: ` +
            `ask_confirmation again to ${confirm} ${labelOf(ctx, target.kind, target.id)}`,
        );
      }
      checkUserAgreed(ctx, confirm, target.kind, target.id, questionId);
    }

    const control: ControlAction =
      action === 'edit' ? { action, changes: editChanges(target.kind, changes) } : { action };
    await ctx.commands.control(target, control, ctx.actor, { origin: ctx.origin });

    if (confirmed && questionId) {
      // Consumed once the control went through: the same answer never unlocks a second one.
      const fresh =
        target.kind === 'project' ? ctx.queries.project(target.id) : ctx.queries.task(target.id);
      const meta = {
        ...fresh?.meta,
        [USED_CONFIRMATIONS]: [...usedConfirmations(fresh?.meta), questionId],
      };
      if (target.kind === 'project') await ctx.commands.updateProject(target.id, { meta });
      else await ctx.commands.updateTask(target.id, { meta });
    }
    const after =
      target.kind === 'project' ? ctx.queries.project(target.id) : ctx.queries.task(target.id);
    return {
      kind: target.kind,
      id: target.id,
      action,
      state: after?.state,
      ...(action === 'edit' ? { changes: control.action === 'edit' ? control.changes : {} } : {}),
    };
  },
};

export const CONTROL_TOOLS: readonly BrainTool[] = [controlWorkTool];
