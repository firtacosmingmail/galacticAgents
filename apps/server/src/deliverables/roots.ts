import { isAbsolute } from 'node:path';
import type { Id } from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { workspaceMeta } from '../workspace/workspaces.js';
import { recordedFolder } from './folder.js';
import {
  deliverableRoots,
  nodePathFs,
  type DeliverableRoots,
  type PathFs,
  type RefusedPlaces,
  type RootsInput,
} from './paths.js';

/**
 * Whose folders a deliverable may point into (TECHNOLOGY §9.2): the one computation of a
 * project's or a task's roots, shared by the declarations (`service.ts`), the copies and the
 * merge hook (`copies.ts`), the routes that serve, open and add by hand
 * (`http/deliverable-routes.ts`).
 *
 * - A project (or a project task): its workspace, the repository it is in
 *   (`Project.meta.workspace.repoRoot`), the task's own worktree root (`taskId`) and its recorded
 *   deliverables folder.
 * - A standalone task: its workspace (`standaloneWorkspace`) and its own recorded folder.
 */

/** What the roots are read from. */
export type RootsLookup = Pick<Tables, 'projects' | 'tasks' | 'agents'>;

/** A project, a project task (both ids, or the task alone) or a standalone task. */
export interface RootsTarget {
  projectId?: Id | undefined;
  taskId?: Id | undefined;
}

/**
 * The folder a standalone task works in (decision 34): `Task.meta.workspace` when recorded, else
 * the newest of its Stewards' `meta.workspace` (or `meta.cwd`), as the Harmonizer spawned it.
 * Absolute paths only.
 */
export function standaloneWorkspace(lookup: RootsLookup, taskId: Id): string | undefined {
  const task = lookup.tasks.get(taskId);
  const absolute = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' && isAbsolute(value) ? value : undefined;
  const own = absolute(task?.meta?.['workspace']);
  if (own) return own;
  const stewards = lookup.agents
    .all()
    .filter((a) => a.role === 'steward' && a.taskId === taskId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const agent of stewards) {
    const meta = (agent.meta ?? {}) as { workspace?: unknown; cwd?: unknown };
    const found = absolute(meta.workspace) ?? absolute(meta.cwd);
    if (found) return found;
  }
  return undefined;
}

/**
 * Where a project or task keeps the deliverables it may point at, before canonicalisation. A
 * task's project comes from the task itself when only `taskId` is given.
 */
export function rootsInputOf(lookup: RootsLookup, target: RootsTarget): RootsInput | undefined {
  const task = target.taskId ? lookup.tasks.get(target.taskId) : undefined;
  const projectId = target.projectId ?? task?.projectId;
  if (projectId) {
    const project = lookup.projects.get(projectId);
    if (!project) return undefined;
    const repoRoot = workspaceMeta(project)?.repoRoot;
    const folder = recordedFolder(project.meta);
    return {
      workspace: project.workspace,
      ...(repoRoot ? { repoRoot } : {}),
      ...(target.taskId ? { taskId: target.taskId } : {}),
      ...(folder ? { deliverablesFolder: folder } : {}),
    };
  }
  if (target.taskId) {
    const workspace = standaloneWorkspace(lookup, target.taskId);
    if (!workspace) return undefined;
    const folder = recordedFolder(task?.meta);
    return { workspace, ...(folder ? { deliverablesFolder: folder } : {}) };
  }
  return undefined;
}

/** The canonical roots a deliverable (or a new one for `target`) may point into. */
export function rootsOf(
  lookup: RootsLookup,
  target: RootsTarget,
  places: RefusedPlaces,
  fs: PathFs = nodePathFs,
): DeliverableRoots | undefined {
  const input = rootsInputOf(lookup, target);
  return input ? deliverableRoots(input, places, fs) : undefined;
}
