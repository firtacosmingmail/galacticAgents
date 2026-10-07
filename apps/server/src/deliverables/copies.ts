import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type {
  Actor,
  Deliverable,
  DeliverableEdit,
  DeliverableLocation,
  DeliverablesUsageResponse,
  DomainCommands,
  Id,
  Project,
  Task,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { DomainError, must } from '../domain/errors.js';
import { gitRunner, splitZ, type Git } from '../workspace/git.js';
import { canonical, slugify, workspaceMeta } from '../workspace/workspaces.js';
import {
  DELIVERABLES_DIR,
  FALLBACK_DELIVERABLES_DIR,
  FOLDER_META_KEY,
  recordedFolder,
  standaloneWorkspace,
} from './folder.js';
import { checkPath, deliverableRoots } from './paths.js';
import { checkFreeSpace, DEFAULT_RESERVE_BYTES, TREE_MAX_ENTRIES, treeSize } from './space.js';

/**
 * The project's `deliverables/` folder, the copies into it and the merge hook (P9-06; TECHNOLOGY
 * §9.4, SPEC decisions 122, 123, 132).
 *
 * - **Where.** `<workspace>/deliverables/` — `galactic-deliverables/` when the repository tracks a
 *   `deliverables/` folder of its own — with one subfolder per task (`<task-slug>`, plus
 *   `-<first 6 of the task id>` when another task has that name). Always the project's main
 *   folder, never a worktree. A standalone task in a related project's folder uses that project's
 *   folder; a scratch task its own workspace's `deliverables/` (decision 34). Made on first need,
 *   mode 0700, never through a symlink, and recorded on the project (or the scratch task) as
 *   `meta.deliverablesFolder` before the deliverable that needed it, so a rename never moves it.
 * - **Out of git, locally.** `/<path>/deliverables/` appended to the repository's
 *   `<git common dir>/info/exclude` — never `.gitignore`, never a tracked file, never a commit —
 *   so the workspace stays clean for the next merge. A folder that is not a repository just gets
 *   the folder.
 * - **Copies.** `fs.cp` into a unique `.partial` name inside the destination folder, then renamed
 *   (a file is linked into place, so an existing name is never replaced); symlinks and anything
 *   but files and folders left out, never followed; modes kept minus group/other write and
 *   set-uid/set-gid/sticky; a name already taken gets ` (2)`, ` (3)` …; no size limit but the
 *   free-space guard (`checkFreeSpace`: the backups' reserve stays free). A failure removes the
 *   partial copy, never anything else.
 * - **The merge hook** (`beforeWorktreeRemoved`, called by `Workspaces` inside the repository's
 *   lock before `git worktree remove`): a task's deliverables in the worktree are re-pointed into
 *   the project's folder when the merge carried them, else copied into the task's subfolder, else
 *   marked missing (the supervisor is told). It never throws.
 * - **Never deleted.** Nothing here (or anywhere in the server) deletes a file or folder under a
 *   deliverables folder; the only removal is of the copy's own `.partial` name, after a failure.
 */

const SYSTEM: Actor = { type: 'system' };

/** What a deliverable is copied for: a project (its own) or a task. */
export interface CopyTarget {
  projectId?: Id | undefined;
  taskId?: Id | undefined;
}

/** Where a target's copies go. */
export interface FolderPlace {
  /** The deliverables folder (absolute, canonical); it may not exist yet. */
  folder: string;
  /** Where this target's copies land: the folder, or the task's subfolder in it. */
  dir: string;
  /** The workspace the folder is in (its parent). */
  workspace: string;
  /** Who records the folder: the project, or a scratch task. */
  owner: { kind: 'project'; id: Id } | { kind: 'task'; id: Id };
  /** The folder was already recorded. */
  recorded: boolean;
}

/** A finished copy: the location a deliverable records (`storage: 'copy'`). */
export interface CopyResult {
  location: DeliverableLocation;
  /** Bytes of the regular files copied. */
  bytes: number;
  /** The deliverables folder it went into. */
  folder: string;
}

/**
 * The copy API for the declarations (P9-04) and the user's additions from outside the project
 * (decision 121): `copyIn` copies a checked path (a stray in a temporary folder, the user's file)
 * into the target's place and returns the location to record. Refusals are `DomainError`s whose
 * message is meant for the agent's tool result or the panel as is (`not enough space: needs …`).
 */
export interface DeliverableCopier {
  copyIn(source: string, target: CopyTarget): Promise<CopyResult>;
}

/** What the hook needs from the command surface. */
export type CopiesCommands = Pick<
  DomainCommands,
  'updateProject' | 'updateTask' | 'updateDeliverable'
>;

export interface DeliverableCopiesOptions {
  tables: Tables;
  commands: CopiesCommands;
  /** The server's data folder (refused as a root, `paths.ts`). */
  dataDir: string;
  /** Default `os.homedir()`. */
  home?: string;
  git?: Git;
  /** The free space kept after a copy: the backups' reserve (`backups.reserveMiB`, 1 GiB). */
  reserveBytes?: number | (() => number | undefined);
  /** Free bytes on a folder's file system; default `diskFree` (`statfs`). */
  freeBytes?: (dir: string) => number;
  /** Entries a copied folder may hold (`treeSize`'s cap). */
  maxEntries?: number;
  /** Tells an agent (the task's supervisor) what could not be kept; must not throw. */
  notify?: (agentId: Id, text: string) => void;
  now?: () => string;
  onError?: (error: unknown, context: string) => void;
}

/** A free name in `dir` for `name`: itself, else `name (2)`, `name (3)` … before the extension. */
export async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext && ext !== name ? ext : ''}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Mode bits a copy keeps: no group/other write, no set-uid, set-gid or sticky bit. */
export function copiedMode(mode: number, directory: boolean): number {
  const kept = mode & 0o755;
  return directory ? kept | 0o700 : kept | 0o400;
}

/** Applies `copiedMode` to everything under `path` (an `lstat` walk; links are not there). */
async function sanitizeModes(path: string): Promise<void> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await chmod(path, copiedMode(st.mode, true));
    for (const name of await readdir(path)) await sanitizeModes(join(path, name));
  } else if (st.isFile()) {
    await chmod(path, copiedMode(st.mode, false));
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class DeliverableCopies implements DeliverableCopier {
  private readonly tables: Tables;
  private readonly commands: CopiesCommands;
  private readonly dataDir: string;
  private readonly home: string;
  private readonly git: Git;
  private readonly opts: DeliverableCopiesOptions;

  constructor(opts: DeliverableCopiesOptions) {
    this.opts = opts;
    this.tables = opts.tables;
    this.commands = opts.commands;
    this.dataDir = opts.dataDir;
    this.home = opts.home ?? homedir();
    this.git = opts.git ?? gitRunner();
  }

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  private reserve(): number {
    const r = this.opts.reserveBytes;
    return (typeof r === 'function' ? r() : r) ?? DEFAULT_RESERVE_BYTES;
  }

  // -- where -------------------------------------------------------------------------------------

  /**
   * Where a target's copies go, without making anything: the recorded folder, or the one that
   * would be made (git is asked whether `deliverables/` is tracked).
   */
  async placeOf(target: CopyTarget): Promise<FolderPlace> {
    const task = target.taskId
      ? must(this.tables.tasks.get(target.taskId), 'task', target.taskId)
      : undefined;
    const projectId = task ? task.projectId : target.projectId;
    if (projectId) {
      const project = must(this.tables.projects.get(projectId), 'project', projectId);
      return this.projectPlace(project, task);
    }
    if (!task) throw new DomainError('invalid', 'a copy belongs to a project or a task');
    const workspace = standaloneWorkspace(task);
    if (!workspace) {
      throw new DomainError('invalid', `standalone task ${task.id} has no workspace to copy into`);
    }
    const related = this.relatedProject(task, workspace);
    if (related) return this.projectPlace(related, task);
    const ws = canonical(workspace);
    const recorded = recordedFolder(task.meta);
    const folder = recorded ?? join(ws, await this.folderName(ws));
    return {
      folder,
      dir: folder,
      workspace: ws,
      owner: { kind: 'task', id: task.id },
      recorded: recorded !== undefined,
    };
  }

  /** The project whose folder a standalone task works in (decision 34), if any. */
  private relatedProject(task: Task, workspace: string): Project | undefined {
    const ws = canonical(workspace);
    const relatedId = task.meta?.['relatedProjectId'];
    const candidates = this.tables.projects
      .all()
      .filter((p) => p.state !== 'archived' && canonical(p.workspace) === ws);
    return candidates.find((p) => p.id === relatedId) ?? candidates[0];
  }

  private async projectPlace(project: Project, task: Task | undefined): Promise<FolderPlace> {
    const ws = canonical(project.workspace);
    const recorded = recordedFolder(project.meta);
    const folder = recorded ?? join(ws, await this.folderName(ws));
    const dir = task ? join(folder, await this.taskSubfolder(task, folder)) : folder;
    return {
      folder,
      dir,
      workspace: ws,
      owner: { kind: 'project', id: project.id },
      recorded: recorded !== undefined,
    };
  }

  /** `deliverables`, or `galactic-deliverables` when the repository tracks a `deliverables/`. */
  private async folderName(workspace: string): Promise<string> {
    const tracked = async (name: string) => {
      const out = await this.git(workspace, ['ls-files', '-z', '--', name], {
        allowFailure: true,
      });
      return out.code === 0 && splitZ(out.stdout).length > 0;
    };
    if (!(await this.isRepository(workspace))) return DELIVERABLES_DIR;
    if (!(await tracked(DELIVERABLES_DIR))) return DELIVERABLES_DIR;
    if (await tracked(FALLBACK_DELIVERABLES_DIR)) {
      throw new DomainError(
        'invalid',
        `the repository tracks both ${DELIVERABLES_DIR}/ and ${FALLBACK_DELIVERABLES_DIR}/: ` +
          'there is no folder to copy into that git does not own',
      );
    }
    return FALLBACK_DELIVERABLES_DIR;
  }

  private async isRepository(workspace: string): Promise<boolean> {
    const out = await this.git(workspace, ['rev-parse', '--is-inside-work-tree'], {
      allowFailure: true,
    });
    return out.code === 0 && out.stdout.trim() === 'true';
  }

  /**
   * The task's subfolder name: the one its copies already use, else `slugify(description, 40)`,
   * else that plus `-<first 6 of the task id>` when another task's copies (or anything not this
   * task's) already have that name.
   */
  private async taskSubfolder(task: Task, folder: string): Promise<string> {
    const copies = this.tables.deliverables
      .all()
      .filter((d) => d.location?.storage === 'copy' && isInside(d.location.path, folder));
    const nameOf = (d: Deliverable) => relative(folder, d.location!.path).split(sep)[0];
    const own = copies.find(
      (d) => d.taskId === task.id && nameOf(d) !== basename(d.location!.path),
    );
    if (own) return nameOf(own)!;
    const slug = slugify(task.description, 40, 'task');
    const candidates = [slug, `${slug}-${task.id.slice(0, 6)}`, `${slug}-${task.id}`];
    for (const name of candidates) {
      const others = copies.some((d) => d.taskId !== task.id && nameOf(d) === name);
      if (others) continue;
      if (await exists(join(folder, name))) continue;
      return name;
    }
    return candidates.at(-1)!;
  }

  // -- making it ---------------------------------------------------------------------------------

  /**
   * Makes (or re-checks) a target's folder and subfolder, keeps it out of git and records it.
   * Refused when the folder or the subfolder is a symlink or not a folder, or the workspace's
   * real path is not its parent.
   */
  async ensureFolder(target: CopyTarget): Promise<FolderPlace> {
    const place = await this.placeOf(target);
    await this.makeDir(place.folder, place.workspace);
    if (place.dir !== place.folder) await this.makeDir(place.dir, place.folder);
    await this.exclude(place.folder, place.workspace);
    if (!place.recorded) await this.record(place);
    return place;
  }

  private async makeDir(dir: string, parent: string): Promise<void> {
    if (canonical(dirname(dir)) !== canonical(parent)) {
      throw new DomainError('invalid', `${dir} is not inside ${parent} on disk`);
    }
    let st;
    try {
      st = await lstat(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (made) {
        if ((made as NodeJS.ErrnoException).code !== 'EEXIST') throw made;
      }
      st = await lstat(dir);
    }
    if (st.isSymbolicLink()) {
      throw new DomainError('invalid', `${dir} is a symlink: copies are not written through one`);
    }
    if (!st.isDirectory()) {
      throw new DomainError('invalid', `${dir} is not a folder: copies cannot go there`);
    }
  }

  /** `/<rel>/` in the repository's `info/exclude`, once (never `.gitignore`, never committed). */
  private async exclude(folder: string, workspace: string): Promise<void> {
    if (!(await this.isRepository(workspace))) return;
    const top = (await this.git(workspace, ['rev-parse', '--show-toplevel'])).stdout.trim();
    const common = (
      await this.git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).stdout.trim();
    const rel = relative(canonical(top), folder).split(sep).join('/');
    if (!rel || rel.startsWith('..')) return;
    const line = `/${rel}/`;
    const file = join(common, 'info', 'exclude');
    let current = '';
    try {
      current = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (current.split('\n').some((l) => l.trim() === line)) return;
    await mkdir(dirname(file), { recursive: true });
    const sepLine = current && !current.endsWith('\n') ? '\n' : '';
    await writeFile(
      file,
      `${current}${sepLine}# GalacticAgents: the project's deliverables, kept out of git on this Mac (P9-06)\n${line}\n`,
    );
  }

  private async record(place: FolderPlace): Promise<void> {
    if (place.owner.kind === 'project') {
      const fresh = must(this.tables.projects.get(place.owner.id), 'project', place.owner.id);
      if (recordedFolder(fresh.meta)) return;
      await this.commands.updateProject(place.owner.id, {
        meta: { ...fresh.meta, [FOLDER_META_KEY]: place.folder },
      });
    } else {
      const fresh = must(this.tables.tasks.get(place.owner.id), 'task', place.owner.id);
      if (recordedFolder(fresh.meta)) return;
      await this.commands.updateTask(place.owner.id, {
        meta: { ...fresh.meta, [FOLDER_META_KEY]: place.folder },
      });
    }
  }

  // -- copying -----------------------------------------------------------------------------------

  /**
   * Copies `source` (a checked real path: a stray, the user's file, a worktree's build output)
   * into the target's place and returns the location to record. A symlink is refused; so is a
   * copy that would leave less than the reserve free, or a folder of more than `maxEntries`.
   */
  async copyIn(source: string, target: CopyTarget): Promise<CopyResult> {
    const place = await this.ensureFolder(target);
    const copied = await this.copyInto(source, place.dir);
    return {
      location: { storage: 'copy', path: copied.path, originalPath: source },
      bytes: copied.bytes,
      folder: place.folder,
    };
  }

  /** The copy itself: `source` into the folder `dir`, under a free name. */
  async copyInto(source: string, dir: string): Promise<{ path: string; bytes: number }> {
    if (!isAbsolute(source)) throw new DomainError('invalid', `${source} is not absolute`);
    const st = await lstat(source).catch(() => undefined);
    if (!st) throw new DomainError('invalid', `${source} does not exist`);
    if (st.isSymbolicLink()) {
      throw new DomainError('invalid', `${source} is a symlink: copy the file it points to`);
    }
    if (!st.isFile() && !st.isDirectory()) {
      throw new DomainError('invalid', `${source} is neither a file nor a folder`);
    }
    if (isInside(dir, source)) {
      throw new DomainError('invalid', `${source} contains the folder it would be copied into`);
    }
    const max = this.opts.maxEntries ?? TREE_MAX_ENTRIES;
    const size = await treeSize(source, { maxEntries: max });
    if (!size.complete) {
      throw new DomainError('invalid', `too many files to copy: more than ${max} entries`);
    }
    const space = checkFreeSpace(size.bytes, dir, {
      reserveBytes: this.reserve(),
      ...(this.opts.freeBytes ? { freeBytes: this.opts.freeBytes } : {}),
    });
    if (!space.ok) throw new DomainError('invalid', space.message);

    const partial = join(dir, `.${basename(source)}.${randomBytes(4).toString('hex')}.partial`);
    try {
      await cp(source, partial, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        filter: async (src) => {
          // A worktree's `.git` (a link back into the repository) is never part of a copy.
          if (src !== source && basename(src) === '.git') return false;
          const s = await lstat(src);
          return s.isFile() || s.isDirectory();
        },
      });
      await sanitizeModes(partial);
      const path = await this.settle(partial, dir, basename(source), st.isDirectory());
      return { path: realpathSync.native(path), bytes: size.bytes };
    } catch (e) {
      // Only the copy's own partial name is ever removed (decision 122).
      await rm(partial, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  }

  /** Moves the partial copy to a free name without ever replacing what is there. */
  private async settle(
    partial: string,
    dir: string,
    name: string,
    directory: boolean,
  ): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const dst = join(dir, await freeName(dir, name));
      if (directory) {
        if (await exists(dst)) continue;
        await rename(partial, dst);
        return dst;
      }
      try {
        await link(partial, dst);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      await unlink(partial);
      return dst;
    }
    throw new Error(`no free name for ${name} in ${dir}`);
  }

  // -- the merge hook ----------------------------------------------------------------------------

  /**
   * Before a task's worktree goes (decision 123; `Workspaces.mergeTask` after a merge with
   * `mergedCommit`, `removeWorktree` without): each active deliverable of the task inside `root`
   * is re-pointed into the project's folder when the merged commit carries it unchanged, else
   * copied into the task's subfolder, else marked missing with the reason (the supervisor is
   * told). Commands declared there get their `cwd` re-pointed. Never throws.
   */
  async beforeWorktreeRemoved(
    taskId: Id,
    root: string,
    info: { mergedCommit?: string } = {},
  ): Promise<void> {
    try {
      await this.keepTaskDeliverables(taskId, root, info);
    } catch (e) {
      this.opts.onError?.(e, `deliverables of ${taskId} before its worktree was removed`);
    }
  }

  private async keepTaskDeliverables(
    taskId: Id,
    root: string,
    info: { mergedCommit?: string },
  ): Promise<void> {
    const task = this.tables.tasks.get(taskId);
    const project = task?.projectId ? this.tables.projects.get(task.projectId) : undefined;
    if (!task || !project) return;
    let realRoot: string;
    try {
      realRoot = realpathSync.native(root);
    } catch {
      return;
    }
    const meta = workspaceMeta(project);
    const repoRoot = canonical(meta?.repoRoot ?? project.workspace);
    const lost: string[] = [];
    for (const d of this.tables.deliverables.of({ taskId })) {
      if (d.removedAt !== undefined) continue;
      try {
        if (d.location && isInside(d.location.path, realRoot) && !d.location.missing) {
          const kept = await this.keepPath(d, d.location, task, project, realRoot, repoRoot, info);
          if (kept.lost) lost.push(kept.lost);
        } else if (d.command && isInside(d.command.cwd, realRoot)) {
          const cwd = join(repoRoot, relative(realRoot, d.command.cwd));
          const st = await lstat(cwd).catch(() => undefined);
          if (st?.isDirectory()) {
            await this.update(d, { command: { ...d.command, cwd: realpathSync.native(cwd) } });
          } else {
            lost.push(`"${d.title}" (a command in ${relative(realRoot, d.command.cwd) || '.'})`);
          }
        }
      } catch (e) {
        this.opts.onError?.(e, `deliverable ${d.id} before its worktree was removed`);
        const reason = `it was in the task's worktree and could not be kept: ${message(e)}`;
        if (d.location) {
          await this.update(d, {
            location: { ...d.location, missing: { reason, at: this.now() } },
          }).catch((err: unknown) => this.opts.onError?.(err, `deliverable ${d.id}`));
        }
        lost.push(`"${d.title}": ${message(e)}`);
      }
    }
    if (lost.length > 0) this.tell(task, lost);
  }

  private async keepPath(
    d: Deliverable,
    location: DeliverableLocation,
    task: Task,
    project: Project,
    root: string,
    repoRoot: string,
    info: { mergedCommit?: string },
  ): Promise<{ lost?: string }> {
    const rel = relative(root, location.path);
    if (await this.carried(rel, root, repoRoot, info.mergedCommit)) {
      const roots = deliverableRoots(
        {
          workspace: project.workspace,
          ...(workspaceMeta(project)?.repoRoot ? { repoRoot } : {}),
          ...(recordedFolder(project.meta)
            ? { deliverablesFolder: recordedFolder(project.meta)! }
            : {}),
        },
        { dataDir: this.dataDir, home: this.home },
      );
      const check = checkPath(join(repoRoot, rel), roots);
      if (check.ok) {
        await this.update(d, { location: { storage: 'in_place', path: check.path } });
        return {};
      }
    }
    try {
      const copy = await this.copyIn(location.path, { taskId: task.id });
      await this.update(d, {
        location: copy.location,
        meta: { copy: { bytes: copy.bytes } },
      });
      return {};
    } catch (e) {
      const reason = `it was in the task's worktree: ${message(e)}`;
      await this.update(d, { location: { ...location, missing: { reason, at: this.now() } } });
      return { lost: `"${d.title}" (${rel || '.'}): ${message(e)}` };
    }
  }

  /**
   * Whether the merge carried `rel` unchanged: the merged commit has it (a folder: something
   * under it) and the worktree has nothing uncommitted or ignored under it. The worktree's root
   * itself is the project's folder (re-pointed whatever is ignored in it).
   */
  private async carried(
    rel: string,
    root: string,
    repoRoot: string,
    commit: string | undefined,
  ): Promise<boolean> {
    if (!commit || !/^[0-9a-f]{7,64}$/.test(commit)) return false;
    if (rel === '') return true;
    const spec = rel.split(sep).join('/');
    const tree = await this.git(
      repoRoot,
      ['ls-tree', '-r', '--name-only', '-z', commit, '--', spec],
      {
        allowFailure: true,
      },
    );
    if (tree.code !== 0 || splitZ(tree.stdout).length === 0) return false;
    const status = await this.git(
      root,
      ['status', '--porcelain', '-z', '--ignored', '--untracked-files=all', '--', spec],
      { allowFailure: true },
    );
    return status.code === 0 && splitZ(status.stdout).length === 0;
  }

  private async update(d: Deliverable, edit: DeliverableEdit): Promise<void> {
    await this.commands.updateDeliverable(d.id, edit, SYSTEM);
  }

  /** The task's supervisor hears what could not be kept (decision 123). */
  private tell(task: Task, lost: string[]): void {
    const notify = this.opts.notify;
    if (!notify) return;
    const agentId = this.supervisorOf(task);
    if (!agentId) return;
    try {
      notify(
        agentId,
        `Task ${task.id}'s worktree was removed, and ${lost.length === 1 ? 'this deliverable' : 'these deliverables'} ` +
          `could not be kept (now shown as missing):\n${lost.map((l) => `- ${l}`).join('\n')}\n` +
          "Keep such files in the project's folder (committed) instead.",
      );
    } catch (e) {
      this.opts.onError?.(e, `telling the supervisor of ${task.id}`);
    }
  }

  private supervisorOf(task: Task): Id | undefined {
    const agents = this.tables.agents.all();
    const steward = agents.filter((a) => a.taskId === task.id && a.supervisorId).at(-1);
    if (steward?.supervisorId) return steward.supervisorId;
    if (task.projectId) {
      const waykeeper = agents
        .filter((a) => a.role === 'waykeeper' && a.projectId === task.projectId)
        .at(-1);
      if (waykeeper) return waykeeper.id;
    }
    return agents.filter((a) => a.role === 'harmonizer').at(-1)?.id;
  }

  // -- usage -------------------------------------------------------------------------------------

  /** Each recorded folder's size (`GET /api/deliverables/usage`, the settings page). */
  async usage(): Promise<DeliverablesUsageResponse> {
    const folders: DeliverablesUsageResponse['folders'] = [];
    const add = async (path: string, owner: { projectId?: Id; taskId?: Id }) => {
      const size = await treeSize(path).catch(() => undefined);
      folders.push({ ...owner, path, bytes: size?.bytes ?? 0 });
    };
    for (const p of this.tables.projects.all()) {
      const folder = recordedFolder(p.meta);
      if (folder) await add(folder, { projectId: p.id });
    }
    for (const t of this.tables.tasks.all()) {
      const folder = recordedFolder(t.meta);
      if (folder && !t.projectId) await add(folder, { taskId: t.id });
    }
    return { folders };
  }
}
