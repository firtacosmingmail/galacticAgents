import {
  isDemoProject,
  isHarnessMeta,
  isRetiredBody,
  type Actor,
  type DemoClearResponse,
  type Id,
} from '@galactic/protocol';
import type { Commands } from '../domain/commands.js';
import { retireFreeDemoBodies } from '../domain/demo.js';
import { DomainError } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import { FINISHED_WORK } from '../domain/states.js';

const USER: Actor = { type: 'user' };

/**
 * The ops console's "Clear demo projects" (P7-07, `POST /dev/demo/clear`): every seeded demo
 * project (`isDemoProject`) that is not archived yet has its tasks closed (when open) and
 * archived, then is closed — or, still `proposed`, cancelled — and archived; archiving retires its
 * demo planet (`body.retired`). Last, every free demo body left over from earlier archives is
 * retired too. Everything goes through `Commands`, as the panel's actions do; no row is deleted
 * (the log keeps the story).
 *
 * Never real work: a project that is not demo work is not looked at, harness rows (`meta.harness`)
 * are the harness's own Clear's, and a demo body still hosting a real project is left for that
 * project's archive. Best effort: a refused step (a demo project with a running agent) is listed
 * in `skipped` and the rest goes on.
 */
export async function clearDemoProjects(
  log: EventLog,
  commands: Pick<Commands, 'closeTask' | 'archiveTask' | 'closeProject' | 'archiveProject'>,
): Promise<DemoClearResponse> {
  const { tables } = log;
  const retiredIds = () =>
    new Set(
      tables.bodies
        .all()
        .filter(isRetiredBody)
        .map((b) => b.id),
    );
  const before = retiredIds();
  const skipped: { id: Id; reason: string }[] = [];
  /** One step; a refusal is reported and the rest goes on (clear is best effort). */
  const attempt = async (id: Id, step: () => Promise<unknown>): Promise<boolean> => {
    try {
      await step();
      return true;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      skipped.push({ id, reason: error.message });
      return false;
    }
  };

  // Sub-projects first: a parent is archived only once its children are finished.
  const demo = tables.projects
    .all()
    .filter((p) => isDemoProject(p) && p.state !== 'archived')
    .sort((a, b) => Number(Boolean(b.parentProjectId)) - Number(Boolean(a.parentProjectId)));
  const demoIds = new Set(demo.map((p) => p.id));

  const tasks: Id[] = [];
  for (const task of tables.tasks.all()) {
    if (!task.projectId || !demoIds.has(task.projectId)) continue;
    if (isHarnessMeta(task.meta) || task.state === 'archived') continue;
    const ok = await attempt(task.id, async () => {
      if (!FINISHED_WORK.has(task.state) && task.state !== 'proposed') {
        await commands.closeTask(task.id, USER);
      }
      await commands.archiveTask(task.id, USER);
    });
    if (ok) tasks.push(task.id);
  }

  const projects: Id[] = [];
  for (const { id } of demo) {
    const ok = await attempt(id, async () => {
      const state = tables.projects.get(id)!.state;
      if (!FINISHED_WORK.has(state) && state !== 'proposed') {
        await commands.closeProject(id, USER);
      }
      await commands.archiveProject(id, USER);
    });
    if (ok) projects.push(id);
  }

  // The archives above retired their planets; this takes the leftovers of earlier archives.
  const { value } = log.runCommand((ctx) => retireFreeDemoBodies(ctx));
  for (const body of value.busy) {
    const what = body.host ? `${body.host.kind} ${body.host.id}` : 'a "moved to …" marker';
    skipped.push({ id: body.id, reason: `${body.name} still holds ${what}` });
  }
  const retired = [...retiredIds()].filter((id) => !before.has(id));
  return { seq: log.currentSeq(), tasks, projects, retired, skipped };
}
