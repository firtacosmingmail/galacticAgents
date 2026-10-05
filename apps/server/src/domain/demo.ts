import { randomUUID } from 'node:crypto';
import {
  DEMO_META_KEY,
  isDemoBody,
  isRetiredBody,
  type Body,
  type Id,
  type Project,
} from '@galactic/protocol';
import { retireBody } from './bodies.js';
import type { CommandContext } from './event-log.js';

/**
 * Demo work (P0-16 `/dev/seed`, P7-07). The ops console's "Seed demo project" makes a planet
 * outside the catalogue with a project on it, both flagged `meta.demo`; rows made before the flag
 * are recognised by `isDemoBody` / `isDemoProject` (`@galactic/protocol`). A demo planet is never
 * chosen or assigned for real work (`catalogue.ts`, `checkAssignable`) and is retired
 * (`body.retired`) once its project is archived (`archiveProject`).
 */

/** Creates "Demo planet n" with "Demo project n" on it — rows and events in one command. */
export function seedDemoProject(ctx: CommandContext): Project {
  const { tables, emit } = ctx;
  const n = tables.projects.all().length + 1;
  const meta = { [DEMO_META_KEY]: true };
  const body: Body = { id: `b-${randomUUID()}`, kind: 'planet', name: `Demo planet ${n}`, meta };
  const project: Project = {
    id: `p-${randomUUID()}`,
    name: `Demo project ${n}`,
    workspace: `/tmp/galactic-demo-${n}`,
    bodyId: body.id,
    state: 'in_progress',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    meta,
  };
  const host = { kind: 'project', id: project.id } as const;
  tables.bodies.insert({ ...body, host });
  tables.projects.insert(project);
  emit({ type: 'body.created', body });
  emit({ type: 'project.created', project });
  emit({ type: 'body.assigned', bodyId: body.id, host });
  return project;
}

/**
 * Retires every free demo body not yet retired (P7-07): the leftovers of demo projects archived
 * before demo bodies retired with them. A demo body still hosting work or showing a "moved to …"
 * marker is left alone and listed in `busy` (it retires when that work is archived).
 */
export function retireFreeDemoBodies(ctx: CommandContext): { retired: Id[]; busy: Body[] } {
  const retired: Id[] = [];
  const busy: Body[] = [];
  for (const body of ctx.tables.bodies.all()) {
    if (!isDemoBody(body) || isRetiredBody(body)) continue;
    if (body.host || body.movedTo) {
      busy.push(body);
      continue;
    }
    retireBody(ctx, body);
    retired.push(body.id);
  }
  return { retired, busy };
}
