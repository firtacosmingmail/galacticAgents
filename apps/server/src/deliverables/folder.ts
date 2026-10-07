import { isAbsolute, join, resolve } from 'node:path';
import type { Id, Meta, Project, Task } from '@galactic/protocol';

/**
 * Where the project's `deliverables/` folder is (P9-06; TECHNOLOGY §9.4, SPEC decision 122) —
 * the pure part, shared by the copies (`copies.ts`) and the permission gate (the agent runtime):
 *
 * - a project's folder is `<workspace>/deliverables/`, or `<workspace>/galactic-deliverables/`
 *   when the repository already tracks something under `deliverables/`; once made it is recorded
 *   as `Project.meta.deliverablesFolder` (absolute, canonical), so a rename never moves it;
 * - a standalone task working in a related project's folder uses that project's folder (its own
 *   subfolder in it); a scratch task's is `<its workspace>/deliverables/`, recorded as
 *   `Task.meta.deliverablesFolder`.
 */

/** The folder's name. */
export const DELIVERABLES_DIR = 'deliverables';
/** Its name when the repository tracks a `deliverables/` folder of its own. */
export const FALLBACK_DELIVERABLES_DIR = 'galactic-deliverables';

/** The meta key both a project and a standalone task record their folder under. */
export const FOLDER_META_KEY = 'deliverablesFolder';

/** The recorded folder of a project or a standalone task (an absolute path), if one was made. */
export function recordedFolder(meta: Meta | undefined): string | undefined {
  const value = meta?.[FOLDER_META_KEY];
  return typeof value === 'string' && isAbsolute(value) ? value : undefined;
}

export interface FolderLookup {
  project(id: Id): Project | undefined;
  task(id: Id): Task | undefined;
  projects(): Project[];
}

/**
 * The folders an agent may not write into on its own (decision 22 via 122): the recorded
 * deliverables folder of its project (or its standalone task, or the project whose folder that
 * task works in), else `<workspace>/deliverables/` — the folder it would be. The permission gate
 * counts a write under any of them as outside the workspace.
 */
export function userFoldersOf(
  lookup: FolderLookup,
  agent: { projectId?: Id | undefined; taskId?: Id | undefined },
  workspace: string,
): string[] {
  const folders = new Set<string>();
  const project = agent.projectId ? lookup.project(agent.projectId) : undefined;
  if (project) {
    const recorded = recordedFolder(project.meta);
    if (recorded) folders.add(recorded);
  } else if (agent.taskId) {
    const task = lookup.task(agent.taskId);
    const recorded = task ? recordedFolder(task.meta) : undefined;
    if (recorded) folders.add(recorded);
    const here = resolve(workspace);
    for (const p of lookup.projects()) {
      const theirs = recordedFolder(p.meta);
      if (theirs && resolve(p.workspace) === here) folders.add(theirs);
    }
  }
  if (folders.size === 0) folders.add(join(workspace, DELIVERABLES_DIR));
  return [...folders];
}
