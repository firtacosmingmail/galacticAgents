import type { Id } from '@galactic/protocol';

/**
 * The seam between declarations (P9-04, `service.ts`) and the project's `deliverables/` folder
 * (P9-06, `copies.ts`; TECHNOLOGY §9.4). An agent may declare a stray — a file or folder it made
 * in a temporary folder (decision 122, §9.2 "Strays") — and the stray must be copied into the
 * project's `deliverables/` folder at once, before the declaration is recorded: the temporary
 * folder is not the user's and may be emptied any time.
 *
 * `DeliverableService` calls `keep()` for an accepted stray and records the deliverable with the
 * copy's path (`storage: 'copy'`, `originalPath`). Without an implementation (`copies` not given
 * to the service) strays are refused with the reason, as P9-04's task says until P9-06 lands.
 *
 * P9-06 implements it: it makes the folder on first need (0700, a symlink or non-directory
 * refused), records it as `Project.meta.deliverablesFolder` (a standalone task's as
 * `Task.meta.deliverablesFolder`), adds the git exclude, checks the free space and copies
 * (`.partial`, then rename; links left out; ` (2)` on a taken name). Nothing is ever deleted
 * under the folder.
 */
export interface StrayCopyRequest {
  /** The stray's real path, as `checkPath` accepted it (`where: 'stray'`). */
  source: string;
  type: 'file' | 'folder';
  /** The deliverable's owner: a project task (both ids), a standalone task (`taskId` only), or a project. */
  projectId?: Id;
  taskId?: Id;
}

export interface KeptCopy {
  /** The copy's real path, inside the project's (or standalone task's) `deliverables/` folder. */
  path: string;
  /** Bytes copied (`meta.copy.bytes`). */
  bytes: number;
}

export interface DeliverableCopies {
  /**
   * Copies an accepted stray into the deliverables folder of its project or task. Throws a
   * `DomainError` with the reason when it is refused (not enough space: both sizes in the
   * message; the folder cannot be made); the declaration is then refused with that reason.
   */
  keep(request: StrayCopyRequest): Promise<KeptCopy>;
}
