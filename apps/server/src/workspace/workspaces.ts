import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CommandResult, Id, Project, Task } from '@galactic/protocol';
import { z } from 'zod';
import { expandHome } from '../config/config.js';
import type { Tables } from '../db/tables.js';
import { DomainError, must } from '../domain/errors.js';
import type { ProjectChanges } from '../domain/projects.js';
import type { TaskChanges } from '../domain/tasks.js';
import { gitRunner, splitZ, type Git } from './git.js';

/**
 * Workspaces and worktrees (P2-05; SPEC §3.5, decisions 8, 14, 24). A project's workspace is an
 * existing folder the user pointed at or a new `<projectsRoot>/<slug>`; a git workspace gives each
 * Steward its own worktree and branch, `mergeTask` brings the branch back into the base branch.
 *
 * - **New or empty folders** get `git init` and an empty root commit, so worktrees can branch.
 * - **An existing folder that is not a repository is left alone** unless the caller passes
 *   `initGit` (the user said so): the server does not turn someone's folder into a repository on
 *   its own. Without it the project is *serialised*: no worktrees, Stewards one at a time in the
 *   workspace (`stewardsSerialised`). `initGit` on such a folder commits a snapshot of it.
 * - **Worktrees live in `<workspace>/.galactic/worktrees/<task-id>`**, on branch
 *   `galactic/<task-id>-<slug>` from the project's base branch (the branch checked out when the
 *   workspace was prepared). `.galactic/` is excluded through the repository's `info/exclude`,
 *   never through the user's `.gitignore`.
 * - **Merges happen in the workspace's own checkout**, which must be on the base branch with no
 *   tracked changes; a conflict is aborted and reported, never left half-merged.
 *
 * Git runs through `git.ts` (argument arrays, hooks off, small environment). All git work on one
 * repository is serialised in-process, so two merges or a merge and a `worktree add` never race.
 */

export const GALACTIC_DIR = '.galactic';
export const WORKTREES_DIR = join(GALACTIC_DIR, 'worktrees');
export const BRANCH_PREFIX = 'galactic/';

/** What `prepare` found, kept in `Project.meta.workspace`. */
export const WorkspaceMeta = z.object({
  /** A git repository with a commit to branch from. */
  git: z.boolean(),
  /** Where `.git` lives when the workspace is a sub-folder of a repository. */
  repoRoot: z.string().optional(),
  /** The branch Steward branches start from and merge back into. */
  baseBranch: z.string().optional(),
  /** No worktrees: Stewards run one at a time in the workspace. */
  serialStewards: z.boolean(),
  /** Why the workspace is serialised. */
  reason: z.string().optional(),
  /** The server ran `git init` (or made the first commit) here. */
  initialised: z.boolean().optional(),
});
export type WorkspaceMeta = z.infer<typeof WorkspaceMeta>;

export interface WorkspaceInfo extends WorkspaceMeta {
  /** Absolute, symlinks resolved. */
  path: string;
  /** The folder did not exist and was created. */
  created: boolean;
}

export interface PrepareInput {
  /** The project's name; the folder is `<projectsRoot>/<slug>` when no path is given. */
  name: string;
  /** An existing folder (absolute or `~/…`), or one to create. */
  path?: string;
  /** The user agreed to turn an existing non-git folder into a repository (snapshot commit). */
  initGit?: boolean;
}

export interface WorktreeInfo {
  /** The Steward's working directory (the worktree, or its sub-folder matching the workspace). */
  path: string;
  /** The worktree's root. */
  root: string;
  branch: string;
  baseBranch: string;
}

export interface MergeConflict {
  taskId: Id;
  projectId: Id;
  /** The Steward's branch. */
  sourceBranch: string;
  /** The project's base branch. */
  targetBranch: string;
  /** Paths (relative to the repository root) git could not merge. */
  files: string[];
  workspace: string;
  worktreePath: string;
  /**
   * SPEC decision 30: the base branch's side of the conflict (its commits since the task branched,
   * touching the conflicting files) holds commits that did not come from the project's own task
   * branches — the user's or anyone else's. Then the user decides; otherwise the Waykeeper sends
   * the task's Steward back to merge the base branch and resolve.
   */
  external: boolean;
  /** Those commits, newest first (at most `EXTERNAL_COMMITS_SHOWN`). */
  externalCommits: ExternalCommit[];
  /** How many there are in all (the list may be cut). */
  externalCount: number;
}

export interface ExternalCommit {
  /** Abbreviated id. */
  id: string;
  subject: string;
  author?: string;
}

/** How many external commits a conflict lists. */
export const EXTERNAL_COMMITS_SHOWN = 20;

/** What a successful merge recorded in `Task.meta.merge`. */
export interface MergeRecord {
  branch: string;
  /** The base branch's commit after the merge. */
  commit: string;
  /** The base branch's commit before it: `before..commit` is what the task brought in. */
  before?: string;
  fastForward: boolean;
  branchDeleted: boolean;
}

export type MergeResult =
  | {
      ok: true;
      taskId: Id;
      branch: string;
      baseBranch: string;
      /** The base branch's commit after the merge. */
      commit: string;
      /** The base branch's commit before the merge. */
      before: string;
      fastForward: boolean;
      /** The branch had nothing the base branch lacked. */
      nothingToMerge: boolean;
      /** Whether `git branch -d` removed the branch. */
      branchDeleted: boolean;
    }
  | { ok: false; reason: 'conflict'; conflict: MergeConflict }
  | {
      ok: false;
      reason: 'worktree_dirty' | 'workspace_dirty' | 'not_on_base_branch' | 'failed';
      message: string;
      files?: string[];
    };

/** What the service needs from the command surface: the two updates it records through. */
export interface WorkspaceCommands {
  updateProject(projectId: Id, changes: ProjectChanges): Promise<CommandResult<Project>>;
  updateTask(taskId: Id, changes: TaskChanges): Promise<CommandResult<Task>>;
}

export interface WorkspacesOptions {
  projectsRoot: string;
  /** The server's data dir: never a workspace, nor inside or around one. */
  dataDir: string;
  /** Default `os.homedir()`. */
  home?: string;
  git?: Git;
  /** Author of the server's own commits when the repository has no `user.email` configured. */
  identity?: { name: string; email: string };
  commands?: WorkspaceCommands;
  tables?: Tables;
}

export const DEFAULT_IDENTITY = { name: 'GalacticAgents', email: 'galactic@localhost' };

/** Lower-case words joined by `-`, at most `max` characters; `fallback` when nothing is left. */
export function slugify(text: string, max = 40, fallback = 'project'): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** The branch a task's Steward works on. */
export function branchName(task: Pick<Task, 'id' | 'description'>): string {
  return `${BRANCH_PREFIX}${task.id}-${slugify(task.description, 40, 'task')}`;
}

/** What `prepare` recorded on the project, if it ran. */
export function workspaceMeta(project: Project): WorkspaceMeta | undefined {
  const parsed = WorkspaceMeta.safeParse(project.meta?.['workspace']);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether the project's Stewards must run one at a time in the workspace (SPEC §3.5: the non-git
 * fallback). A project whose workspace was never prepared counts as serialised: parallel Stewards
 * need worktrees, and worktrees need a prepared git workspace. P2-11/P2-17 enforce it.
 */
export function stewardsSerialised(project: Project): boolean {
  return workspaceMeta(project)?.serialStewards ?? true;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolves symlinks of the longest existing prefix, so a not-yet-created path compares truly. */
function canonical(path: string): string {
  const abs = resolve(path);
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

export class Workspaces {
  readonly projectsRoot: string;
  private readonly dataDir: string;
  private readonly home: string;
  private readonly git: Git;
  private readonly identity: { name: string; email: string };
  private readonly commands: WorkspaceCommands | undefined;
  private readonly tables: Tables | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: WorkspacesOptions) {
    this.projectsRoot = canonical(expandHome(opts.projectsRoot));
    this.dataDir = canonical(opts.dataDir);
    this.home = canonical(opts.home ?? homedir());
    this.git = opts.git ?? gitRunner();
    this.identity = opts.identity ?? DEFAULT_IDENTITY;
    this.commands = opts.commands;
    this.tables = opts.tables;
  }

  // -- workspaces ------------------------------------------------------------------------------

  /** `<projectsRoot>/<slug>`, with `-2`, `-3`, … when that folder is already taken. */
  suggestPath(name: string): string {
    const slug = slugify(name);
    for (let n = 1; ; n++) {
      const candidate = join(this.projectsRoot, n === 1 ? slug : `${slug}-${n}`);
      if (!existsSync(candidate)) return candidate;
    }
  }

  /**
   * Refuses a workspace that would hand an agent the whole machine or the server's own state:
   * `/`, the home directory itself, the projects root itself, the data dir, anything inside it or
   * anything containing it. Returns the canonical absolute path.
   */
  checkPath(path: string): string {
    const expanded = expandHome(path.trim());
    if (!expanded) throw new DomainError('invalid', 'a project needs a workspace');
    if (!isAbsolute(expanded)) {
      throw new DomainError('invalid', `a workspace must be an absolute path: ${path}`);
    }
    const abs = canonical(expanded);
    if (abs === canonical('/')) throw new DomainError('invalid', 'the workspace cannot be /');
    if (abs === this.home) {
      throw new DomainError('invalid', 'the workspace cannot be the home directory itself');
    }
    if (abs === this.projectsRoot) {
      throw new DomainError('invalid', 'the workspace cannot be the projects root itself');
    }
    if (isInside(abs, this.dataDir) || isInside(this.dataDir, abs)) {
      throw new DomainError(
        'invalid',
        `the workspace cannot contain or be inside the server's data directory (${this.dataDir})`,
      );
    }
    return abs;
  }

  /** Validates or creates the workspace and gets git ready where it may. */
  async prepare(input: PrepareInput): Promise<WorkspaceInfo> {
    const path = this.checkPath(input.path ?? this.suggestPath(input.name));
    let created = false;
    if (existsSync(path)) {
      if (!statSync(path).isDirectory()) {
        throw new DomainError('invalid', `the workspace is not a folder: ${path}`);
      }
    } else {
      mkdirSync(path, { recursive: true });
      created = true;
    }
    const real = realpathSync(path);
    return this.serial(real, () => this.prepareGit(real, created, input.initGit === true));
  }

  private async prepareGit(
    path: string,
    created: boolean,
    initGit: boolean,
  ): Promise<WorkspaceInfo> {
    const empty = readdirSync(path).length === 0;
    const top = created
      ? undefined
      : await this.git(path, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    const serial = (reason: string): WorkspaceInfo => ({
      path,
      created,
      git: false,
      serialStewards: true,
      reason,
    });
    let initialised = false;
    let repoRoot: string;

    if (top && top.code === 0) {
      repoRoot = realpathSync(top.stdout.trim());
      const head = await this.git(path, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], {
        allowFailure: true,
      });
      if (head.code !== 0) {
        if (!initGit) return serial('the repository has no commit to branch from yet');
        await this.rootCommit(path);
        initialised = true;
      }
    } else {
      if (!created && !empty && !initGit) {
        return serial('the workspace is not a git repository');
      }
      await this.git(path, ['init', '-q']);
      repoRoot = path;
      if (!created && !empty) {
        await this.git(path, ['add', '-A']);
        await this.git(path, [
          ...(await this.identityArgs(path)),
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'GalacticAgents: initial snapshot of the workspace',
        ]);
      } else {
        await this.rootCommit(path);
      }
      initialised = true;
    }

    const branch = await this.currentBranch(path);
    await this.excludeGalactic(path);
    return {
      path,
      created,
      git: true,
      ...(repoRoot !== path ? { repoRoot } : {}),
      ...(branch ? { baseBranch: branch } : {}),
      serialStewards: !branch,
      ...(branch ? {} : { reason: 'the workspace has no branch checked out (detached HEAD)' }),
      ...(initialised ? { initialised } : {}),
    };
  }

  /** An empty first commit on the unborn branch, without touching the index or the files. */
  private async rootCommit(path: string): Promise<void> {
    const tree = (
      await this.git(path, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })
    ).stdout.trim();
    const commit = (
      await this.git(path, [
        ...(await this.identityArgs(path)),
        'commit-tree',
        tree,
        '-m',
        'GalacticAgents: initialise workspace',
      ])
    ).stdout.trim();
    const ref = (await this.git(path, ['symbolic-ref', 'HEAD'])).stdout.trim();
    await this.git(path, ['update-ref', ref, commit, '']);
  }

  /** The repository's own identity if it has one, else the server's (`-c user.*`). */
  private async identityArgs(cwd: string): Promise<string[]> {
    const email = await this.git(cwd, ['config', 'user.email'], { allowFailure: true });
    const name = await this.git(cwd, ['config', 'user.name'], { allowFailure: true });
    const args: string[] = [];
    if (email.code !== 0 || !email.stdout.trim())
      args.push('-c', `user.email=${this.identity.email}`);
    if (name.code !== 0 || !name.stdout.trim()) args.push('-c', `user.name=${this.identity.name}`);
    return args;
  }

  private async currentBranch(cwd: string): Promise<string | undefined> {
    const out = await this.git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], {
      allowFailure: true,
    });
    return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : undefined;
  }

  /** Adds `.galactic/` to the repository's `info/exclude` (shared by all its worktrees). */
  private async excludeGalactic(cwd: string): Promise<void> {
    const common = (
      await this.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).stdout.trim();
    const file = join(common, 'info', 'exclude');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const line = `/${GALACTIC_DIR}/`;
    if (current.split('\n').some((l) => l.trim() === line || l.trim() === `${GALACTIC_DIR}/`))
      return;
    mkdirSync(dirname(file), { recursive: true });
    const sepLine = current && !current.endsWith('\n') ? '\n' : '';
    writeFileSync(
      file,
      `${current}${sepLine}# GalacticAgents: Steward worktrees (P2-05)\n${GALACTIC_DIR}/\n`,
    );
  }

  /**
   * Prepares a project's workspace and records the result on it through the domain commands
   * (`project.updated`: canonical `workspace`, `repoPath`, `meta.workspace`).
   */
  async prepareProject(projectId: Id, opts: { initGit?: boolean } = {}): Promise<WorkspaceInfo> {
    const project = must(this.need('tables').projects.get(projectId), 'project', projectId);
    const info = await this.prepare({
      name: project.name,
      path: project.workspace,
      ...(opts.initGit ? { initGit: true } : {}),
    });
    const { path, created: _created, ...meta } = info;
    await this.need('commands').updateProject(projectId, {
      workspace: path,
      ...(info.git ? { repoPath: info.repoRoot ?? path } : {}),
      meta: { ...project.meta, workspace: meta },
    });
    return info;
  }

  // -- worktrees -------------------------------------------------------------------------------

  /**
   * Creates (or finds) the task's worktree on its branch and records `worktreePath`, `branch` and
   * `meta.worktree` on the task (`task.updated`). Refused for a serialised project and for a
   * standalone task (its Steward runs where the Harmonizer puts it, SPEC §3.5).
   */
  async createWorktree(taskId: Id): Promise<WorktreeInfo> {
    const { task, project, meta } = this.gitTask(taskId);
    const baseBranch = meta.baseBranch!;
    const repoRoot = meta.repoRoot ?? project.workspace;
    const root = worktreeRoot(project.workspace, task.id);
    const sub = relative(repoRoot, project.workspace);
    const path = sub ? join(root, sub) : root;
    const branch = task.branch ? checkBranch(task.branch) : branchName(task);

    await this.serial(repoRoot, async () => {
      await this.git(repoRoot, ['worktree', 'prune']);
      if (await this.isWorktree(repoRoot, root)) return;
      mkdirSync(dirname(root), { recursive: true });
      const exists = await this.git(
        repoRoot,
        ['rev-parse', '--verify', '-q', `refs/heads/${branch}`],
        {
          allowFailure: true,
        },
      );
      await this.git(
        repoRoot,
        exists.code === 0
          ? ['worktree', 'add', '-q', root, branch]
          : ['worktree', 'add', '-q', '-b', branch, root, baseBranch],
      );
    });

    const info = { path, root, branch, baseBranch };
    if (task.worktreePath !== path || task.branch !== branch || !this.worktreeMetaIs(task, info)) {
      await this.need('commands').updateTask(task.id, {
        worktreePath: path,
        branch,
        meta: { ...task.meta, worktree: { root, baseBranch } },
      });
    }
    return info;
  }

  private worktreeMetaIs(task: Task, info: WorktreeInfo): boolean {
    const w = task.meta?.['worktree'] as
      { root?: string; baseBranch?: string; removed?: boolean } | undefined;
    return w?.root === info.root && w.baseBranch === info.baseBranch && !w.removed;
  }

  private async isWorktree(repoRoot: string, root: string): Promise<boolean> {
    if (!existsSync(root)) return false;
    const list = await this.git(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
    const real = realpathSync(root);
    return splitZ(list.stdout).some(
      (line) => line.startsWith('worktree ') && canonical(line.slice('worktree '.length)) === real,
    );
  }

  /**
   * Merges the task's branch into the project's base branch in the workspace's checkout (fast
   * forward when possible), then removes the worktree and deletes the merged branch. A conflict is
   * aborted and returned as `MergeConflict` for the supervisor's clarification question (P2-10);
   * nothing is left half-merged. Uncommitted work in the worktree is refused unless
   * `commitPending` commits it first.
   */
  async mergeTask(taskId: Id, opts: { commitPending?: boolean } = {}): Promise<MergeResult> {
    const { task, project, meta } = this.gitTask(taskId);
    if (!task.branch || !task.worktreePath) {
      throw new DomainError('invalid', `task ${taskId} has no worktree to merge`);
    }
    const branch = checkBranch(task.branch);
    const baseBranch =
      (task.meta?.['worktree'] as { baseBranch?: string } | undefined)?.baseBranch ??
      meta.baseBranch!;
    const repoRoot = meta.repoRoot ?? project.workspace;
    // Never a stored path: task fields are writable through `updateTask` (wave-2 review).
    const root = worktreeRoot(project.workspace, task.id);
    const cwd = project.workspace;

    const result = await this.serial(repoRoot, async (): Promise<MergeResult> => {
      const live = existsSync(root) && (await this.isWorktree(repoRoot, root));
      if (live) {
        const pending = await this.changes(root, true);
        if (pending.length > 0) {
          if (!opts.commitPending) {
            return {
              ok: false,
              reason: 'worktree_dirty',
              message: `the worktree of task ${taskId} has uncommitted changes`,
              files: pending,
            };
          }
          await this.git(root, ['add', '-A']);
          await this.git(root, [
            ...(await this.identityArgs(root)),
            'commit',
            '-q',
            '-m',
            `${taskId}: uncommitted work at merge`,
          ]);
        }
      }

      const current = await this.currentBranch(cwd);
      if (current !== baseBranch) {
        return {
          ok: false,
          reason: 'not_on_base_branch',
          message: `the workspace has ${current ?? 'a detached HEAD'} checked out, not ${baseBranch}`,
        };
      }
      const dirty = await this.changes(cwd, false);
      if (dirty.length > 0) {
        return {
          ok: false,
          reason: 'workspace_dirty',
          message: `the workspace has uncommitted changes on ${baseBranch}`,
          files: dirty,
        };
      }

      const before = await this.rev(cwd, 'HEAD');
      const ahead = Number(
        (await this.git(cwd, ['rev-list', '--count', `HEAD..${branch}`])).stdout.trim(),
      );
      let fastForward = false;
      if (ahead > 0) {
        fastForward =
          (await this.git(cwd, ['merge-base', 'HEAD', branch])).stdout.trim() === before;
        const merge = await this.git(
          cwd,
          [
            ...(await this.identityArgs(cwd)),
            'merge',
            '--ff',
            '--no-edit',
            '-m',
            `Merge ${branch} (${taskId})`,
            branch,
          ],
          { allowFailure: true },
        );
        if (merge.code !== 0) {
          const files = splitZ(
            (
              await this.git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], {
                allowFailure: true,
              })
            ).stdout,
          );
          await this.git(cwd, ['merge', '--abort'], { allowFailure: true });
          if (files.length > 0) {
            const external = await this.externalCommits(cwd, project.id, branch, files);
            return {
              ok: false,
              reason: 'conflict',
              conflict: {
                taskId,
                projectId: project.id,
                sourceBranch: branch,
                targetBranch: baseBranch,
                files,
                workspace: project.workspace,
                worktreePath: task.worktreePath!,
                external: external.count > 0,
                externalCommits: external.commits,
                externalCount: external.count,
              },
            };
          }
          return { ok: false, reason: 'failed', message: (merge.stderr || merge.stdout).trim() };
        }
      }
      const commit = await this.rev(cwd, 'HEAD');
      if (live) await this.git(repoRoot, ['worktree', 'remove', '--force', root]);
      await this.git(repoRoot, ['worktree', 'prune']);
      const deleted = await this.git(repoRoot, ['branch', '-d', branch], { allowFailure: true });
      return {
        ok: true,
        taskId,
        branch,
        baseBranch,
        commit,
        before,
        fastForward,
        nothingToMerge: ahead === 0,
        branchDeleted: deleted.code === 0,
      };
    });

    if (result.ok) {
      // The folder is gone, so the task forgets it (an explicit null, P2-20): a reopened task
      // gets a fresh worktree, and a Steward is never sent into a removed one. The branch goes
      // too once it is deleted; `meta.merge` keeps the record of where the work happened.
      await this.need('commands').updateTask(taskId, {
        worktreePath: null,
        ...(result.branchDeleted ? { branch: null } : {}),
        meta: {
          ...task.meta,
          worktree: { root, baseBranch, removed: true },
          merge: {
            branch,
            commit: result.commit,
            before: result.before,
            fastForward: result.fastForward,
            branchDeleted: result.branchDeleted,
          } satisfies MergeRecord,
        },
      });
    }
    return result;
  }

  /**
   * Removes a task's worktree without merging (a cancelled or failed task). Uncommitted work is
   * refused unless `force`; the branch is kept (its commits may still be wanted) unless
   * `deleteBranch`, which force-deletes it.
   */
  async removeWorktree(
    taskId: Id,
    opts: { force?: boolean; deleteBranch?: boolean } = {},
  ): Promise<{ removed: boolean; files?: string[] }> {
    const { task, project, meta } = this.gitTask(taskId);
    const repoRoot = meta.repoRoot ?? project.workspace;
    const root = worktreeRoot(project.workspace, task.id);
    if (!task.worktreePath && !existsSync(root)) return { removed: false };
    const out = await this.serial(repoRoot, async () => {
      if (await this.isWorktree(repoRoot, root)) {
        const pending = await this.changes(root, true);
        if (pending.length > 0 && !opts.force) return { removed: false, files: pending };
        await this.git(repoRoot, ['worktree', 'remove', '--force', root]);
      }
      await this.git(repoRoot, ['worktree', 'prune']);
      if (opts.deleteBranch && task.branch) {
        await this.git(repoRoot, ['branch', '-D', checkBranch(task.branch)], {
          allowFailure: true,
        });
      }
      return { removed: true };
    });
    if (out.removed) {
      await this.need('commands').updateTask(taskId, {
        worktreePath: null,
        ...(opts.deleteBranch ? { branch: null } : {}),
        meta: {
          ...task.meta,
          worktree: {
            ...(task.meta?.['worktree'] as object | undefined),
            root,
            removed: true,
            ...(opts.deleteBranch ? { branchDeleted: true } : {}),
          },
        },
      });
    }
    return out;
  }

  // -- helpers ---------------------------------------------------------------------------------

  /**
   * The base branch's commits behind a conflict that the project did not merge itself (SPEC
   * decision 30). The base side is `merge-base..HEAD` limited to the conflicting files (merge
   * commits left out: their content is their parents'); a commit is the project's own when an
   * earlier merge of one of its tasks brought it in (`meta.merge.before..commit`). Run inside the
   * repository's lock, after the merge was aborted.
   */
  private async externalCommits(
    cwd: string,
    projectId: Id,
    branch: string,
    files: string[],
  ): Promise<{ count: number; commits: ExternalCommit[] }> {
    const base = (await this.git(cwd, ['merge-base', 'HEAD', branch])).stdout.trim();
    const list = async (args: string[]) =>
      (await this.git(cwd, ['rev-list', ...args], { allowFailure: true })).stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    let side = await list(['--full-history', '--no-merges', `${base}..HEAD`, '--', ...files]);
    if (side.length === 0) side = await list(['--no-merges', `${base}..HEAD`]);
    if (side.length === 0) return { count: 0, commits: [] };
    const own = new Set<string>();
    const tasks = this.need('tables')
      .tasks.all()
      .filter((t) => t.projectId === projectId);
    for (const t of tasks) {
      const merge = t.meta?.['merge'] as Partial<MergeRecord> | undefined;
      if (!merge?.commit || !merge.before) continue;
      if (!/^[0-9a-f]{7,64}$/.test(merge.commit) || !/^[0-9a-f]{7,64}$/.test(merge.before))
        continue;
      for (const c of await list([`${merge.before}..${merge.commit}`])) own.add(c);
    }
    const external = side.filter((c) => !own.has(c));
    if (external.length === 0) return { count: 0, commits: [] };
    const shown = external.slice(0, EXTERNAL_COMMITS_SHOWN);
    const out = await this.git(cwd, [
      'log',
      '--no-walk=unsorted',
      '--format=%h%x1f%an%x1f%s%x1e',
      ...shown,
    ]);
    const commits = out.stdout
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [id = '', author = '', subject = ''] = r.split('\x1f');
        return { id, subject, ...(author ? { author } : {}) };
      });
    return { count: external.length, commits };
  }

  /** Changed paths (`status --porcelain`), untracked included or not. */
  private async changes(cwd: string, untracked: boolean): Promise<string[]> {
    const out = await this.git(cwd, [
      'status',
      '--porcelain',
      '-z',
      `--untracked-files=${untracked ? 'all' : 'no'}`,
    ]);
    // Entries are "XY path"; a rename adds its source as the next NUL-separated field.
    const fields = splitZ(out.stdout);
    const files: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i]!;
      files.push(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C') i++;
    }
    return files;
  }

  private async rev(cwd: string, ref: string): Promise<string> {
    return (await this.git(cwd, ['rev-parse', ref])).stdout.trim();
  }

  private gitTask(taskId: Id): { task: Task; project: Project; meta: WorkspaceMeta } {
    const tables = this.need('tables');
    const task = must(tables.tasks.get(taskId), 'task', taskId);
    if (!task.projectId) {
      throw new DomainError('invalid', `task ${taskId} is standalone; it has no project workspace`);
    }
    const project = must(tables.projects.get(task.projectId), 'project', task.projectId);
    const meta = workspaceMeta(project);
    if (!meta) {
      throw new DomainError('invalid', `the workspace of project ${project.id} was not prepared`);
    }
    if (meta.serialStewards || !meta.git || !meta.baseBranch) {
      throw new DomainError(
        'conflict',
        `project ${project.id} has no worktrees (${meta.reason ?? 'not a git workspace'}); its Stewards run one at a time in the workspace`,
      );
    }
    return { task, project, meta };
  }

  private need<K extends 'tables' | 'commands'>(key: K): NonNullable<WorkspacesOptions[K]> {
    const value = key === 'tables' ? this.tables : this.commands;
    if (!value) throw new DomainError('invalid', `the workspace service has no ${key}`);
    return value as NonNullable<WorkspacesOptions[K]>;
  }

  /** Runs `fn` after every earlier job on the same key (one repository) has settled. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }
}

/** Where a task's worktree lives: derived, never read back from a stored field. */
export function worktreeRoot(workspace: string, taskId: Id): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) {
    throw new DomainError('invalid', `task id ${JSON.stringify(taskId)} cannot name a worktree`);
  }
  return join(workspace, WORKTREES_DIR, taskId);
}

/**
 * A stored branch name the server will pass to git: ours (`galactic/…`) and a valid ref name, so
 * a value written through `updateTask` can never be read by git as an option or another ref.
 */
export function checkBranch(branch: string): string {
  const ok =
    /^galactic\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.endsWith('.lock');
  if (!ok)
    throw new DomainError('invalid', `branch ${JSON.stringify(branch)} is not a galactic/ branch`);
  return branch;
}
