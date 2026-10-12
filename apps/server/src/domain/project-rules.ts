import { randomUUID } from 'node:crypto';
import type {
  Actor,
  Id,
  PermissionRule,
  Project,
  RequestOrigin,
  WorkState,
} from '@galactic/protocol';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import type { RuleDraft } from './permission-rules.js';

/**
 * A project's "Allow similar" rules as rows (P9-17, SPEC decision 138): kept on the project's row
 * (`Project.permissionRules`), changed only here, each change with its event in the caller's
 * transaction (`permission.rule_added` / `permission.rule_removed`), folded alike by the web
 * client (`applyEvent`). A rule is not an edit of the project: `updatedAt` stays.
 */

const SYSTEM: Actor = { type: 'system' };

/**
 * The project states that end its rules ("until the project closes", decision 138): closed and
 * archived. A cancel ends them too (`cascade.ts`), but not a project that turned `failed` because
 * its Waykeeper failed: the user did not close it, and its Stewards may still ask.
 */
export const RULES_END_IN: ReadonlySet<WorkState> = new Set(['completed', 'archived']);

/**
 * Throws when `project` takes no rule or `draft` may not be stored: a project that ended, a rule
 * for a push. Checked before an "Allow similar" answer (review S6) and again when storing.
 */
export function checkRuleAllowed(project: Project, draft: RuleDraft): void {
  if (RULES_END_IN.has(project.state)) {
    throw new DomainError(
      'invalid',
      `project ${project.id} is ${project.state}: it takes no rules`,
    );
  }
  if (draft.categories.includes('push')) {
    throw new DomainError('invalid', 'a push always asks (decision 49): no rule allows it');
  }
}

/** Stores a rule the server drafted (`similarOptions`) for `projectId`; returns it. */
export function addPermissionRule(
  ctx: CommandContext,
  projectId: Id,
  draft: RuleDraft,
  made: { by: Actor; origin: RequestOrigin; questionId?: Id },
): PermissionRule {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  checkRuleAllowed(project, draft);
  const rule: PermissionRule = {
    id: `r-${randomUUID()}`,
    projectId,
    scope: draft.scope,
    tool: draft.tool,
    match: draft.match,
    categories: draft.categories,
    ...(draft.unclassified ? { unclassified: true } : {}),
    label: draft.label,
    createdBy: made.by,
    createdAt: ctx.now,
    origin: made.origin,
    ...(made.questionId ? { questionId: made.questionId } : {}),
  };
  ctx.tables.projects.upsert({
    ...project,
    permissionRules: [...(project.permissionRules ?? []), rule],
  });
  ctx.emit({ type: 'permission.rule_added', rule });
  return rule;
}

/** Removes one rule; `not_found` when the project has no such rule. */
export function removePermissionRule(
  ctx: CommandContext,
  projectId: Id,
  ruleId: Id,
  by: Actor,
  reason: string,
): PermissionRule {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  const rule = project.permissionRules?.find((r) => r.id === ruleId);
  if (!rule) throw new DomainError('not_found', `project ${projectId} has no rule ${ruleId}`);
  const rest = project.permissionRules!.filter((r) => r.id !== ruleId);
  const { permissionRules: _old, ...row } = project;
  ctx.tables.projects.upsert(rest.length > 0 ? { ...row, permissionRules: rest } : row);
  ctx.emit({ type: 'permission.rule_removed', projectId, ruleId, by, reason });
  return rule;
}

/** Removes every rule of a project that ended (`RULES_END_IN`), as the system. */
export function endProjectRules(
  ctx: CommandContext,
  projectId: Id,
  to: 'completed' | 'archived' | 'cancelled',
): void {
  const rules = ctx.tables.projects.get(projectId)?.permissionRules ?? [];
  const why =
    to === 'completed'
      ? 'the project was closed'
      : to === 'cancelled'
        ? 'the project was cancelled'
        : 'the project was archived';
  for (const r of rules) removePermissionRule(ctx, projectId, r.id, SYSTEM, why);
}
