import { isAbsolute, resolve } from 'node:path';
import {
  DEFAULT_DECLARATION_LIMITS,
  DeliverableKind,
  PATH_KINDS,
  isActiveDeliverable,
  isDeliverableUrl,
  type Actor,
  type Agent,
  type DeclarationLimits,
  type Deliverable,
  type DeliverableCommand,
  type DeliverableLocation,
  type DomainCommands,
  type Id,
  type Project,
  type Task,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { DomainError } from '../domain/errors.js';
import { containsSecret, redactSecrets } from '../runtime/redact.js';
export { TOOL_RUNTIMES, stewardDeclares } from '../runtime/tool-runtimes.js';
import type { DeliverableCopies } from './copy-interface.js';
import { IMAGE_TYPES, extensionOf, isAppName } from './facts.js';
import {
  checkPath,
  deliverableRoots,
  nodePathFs,
  type DeliverableRoots,
  type PathAccepted,
  type PathFs,
  type StrayRule,
} from './paths.js';

/**
 * Agents' declarations (P9-04; SPEC decision 120; TECHNOLOGY §9.3). `DeliverableService.declare`
 * is the one way an agent adds a deliverable: the Steward's `declare_deliverable` tool (on the
 * runtimes that serve the server's tools), the Waykeeper's and the Harmonizer's
 * (`brains/deliverable-tools.ts`), and a supervisor declaring what a Steward on another runtime
 * listed in its "Done:" report. In order:
 *
 *   1. the target — a Steward its own task; a Waykeeper its project or one of its tasks; the
 *      Harmonizer standalone tasks (the domain commands check it again, the second line);
 *   2. the text — the title and description within the limits, redacted like any agent text;
 *   3. the limits of decision 120, read from the settings at every call (`limits()`): active
 *      agent-declared rows per task and per project, declarations per agent per sliding hour;
 *   4. the target's shape — a path kind's path through `checkPath` with the agents' rules
 *      (secret names, hard links, strays), a command's line and folder, an http(s) address;
 *   5. a stray copied into the deliverables folder (`copies`, P9-06), else refused;
 *   6. `addDeliverable` (source `agent`, the agent as `by`).
 *
 * The same thing declared twice for the same target (same kind and path, line or address) is not
 * a second row: the existing one is returned (`existing: true`), and it costs no declaration.
 */

/** Whose deliverable it is: a task (a project task or a standalone one) or a project. */
export interface DeclareTarget {
  taskId?: Id;
  projectId?: Id;
}

export interface DeclareInput {
  kind: string;
  title: string;
  /** A path kind's path; a command's folder (default: the agent's working folder). */
  path?: string;
  /** A command's line. */
  command?: string;
  /** A url's address. */
  url?: string;
  description?: string;
}

export interface DeclareOptions {
  /** Resolves a relative path (the Steward's worktree); default the target's folder. */
  cwd?: string;
  /**
   * The command surface to write through (a brain passes its own, so its writes do not wake it);
   * default the service's.
   */
  commands?: DomainCommands;
}

export interface Declared {
  deliverable: Deliverable;
  /** The same thing was already declared for this target: nothing new was added. */
  existing?: true;
}

export interface DeliverableServiceOptions {
  commands: DomainCommands;
  tables: Pick<Tables, 'agents' | 'projects' | 'tasks' | 'deliverables'>;
  /** The server's data folder: refused as a deliverable whatever the roots say. */
  dataDir: string;
  /** Default `os.homedir()`. */
  home?: string;
  /** The declaration limits now (the `deliverables.declarations` setting); default decision 120's. */
  limits?: () => DeclarationLimits;
  /** P9-06's copies: without them, a stray is refused. */
  copies?: DeliverableCopies;
  fs?: PathFs;
  /** The temporary folders strays may come from (tests); default `os.tmpdir()` and `/private/tmp`. */
  tmpDirs?: string[];
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
/** A command line an agent may declare: one line, this long at most. */
export const COMMAND_LINE_MAX = 2000;
/** An address an agent may declare. */
export const URL_MAX = 2048;

export class DeliverableService {
  private readonly fs: PathFs;
  /** Each agent's declarations in the last hour (ms), in memory like `tell_steward`'s window. */
  private readonly window = new Map<Id, number[]>();

  constructor(private readonly opts: DeliverableServiceOptions) {
    this.fs = opts.fs ?? nodePathFs;
  }

  limits(): DeclarationLimits {
    return this.opts.limits?.() ?? DEFAULT_DECLARATION_LIMITS;
  }

  /** Declares a deliverable for `target` as the agent `agentId` (see the class comment). */
  async declare(
    agentId: Id,
    target: DeclareTarget,
    input: DeclareInput,
    opts: DeclareOptions = {},
  ): Promise<Declared> {
    const agent = this.agent(agentId);
    const owner = this.reach(agent, target, 'declare');
    const kind = parseKind(input.kind);
    const limits = this.limits();
    const title = agentText(input.title, 'title', limits.titleChars);
    if (!title) throw new DomainError('invalid', 'a deliverable needs a title');
    const description =
      input.description === undefined || input.description.trim() === ''
        ? undefined
        : agentText(input.description, 'description', limits.descriptionChars);

    const shape = await this.shape(agent, owner, kind, input, opts);
    const same = this.sameAs(owner, kind, shape);
    if (same) return { deliverable: same, existing: true };
    this.checkCounts(owner, limits);
    this.checkRate(agent.id, limits);

    let location = shape.location;
    let meta = shape.meta;
    if (shape.stray) {
      if (!this.opts.copies) {
        throw new DomainError(
          'invalid',
          `${input.path} is in a temporary folder, and copying it into the project's ` +
            'deliverables folder is not available on this server yet: save it inside your working folder and declare it there',
        );
      }
      const kept = await this.opts.copies.keep({
        source: shape.stray.path,
        type: shape.stray.type,
        ...(owner.projectId ? { projectId: owner.projectId } : {}),
        ...(owner.taskId ? { taskId: owner.taskId } : {}),
      });
      location = { storage: 'copy', path: kept.path, originalPath: shape.stray.path };
      meta = { ...meta, copy: { bytes: kept.bytes } };
    }
    const commands = opts.commands ?? this.opts.commands;
    const { value } = await commands.addDeliverable(
      {
        ...(owner.projectId ? { projectId: owner.projectId } : {}),
        ...(owner.taskId ? { taskId: owner.taskId } : {}),
        kind,
        title,
        ...(description ? { description } : {}),
        source: 'agent',
        ...(location ? { location } : {}),
        ...(shape.command ? { command: shape.command } : {}),
        ...(shape.url ? { url: shape.url } : {}),
        ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
      },
      { type: 'agent', id: agent.id },
    );
    this.noteDeclaration(agent.id);
    return { deliverable: value };
  }

  /**
   * Removes an agent-declared deliverable (`remove_deliverable`): the agent must reach its work;
   * the domain refuses a user's or a detected row. Never deletes a file (decision 122).
   */
  async remove(
    agentId: Id,
    deliverableId: Id,
    reason: string,
    opts: Pick<DeclareOptions, 'commands'> = {},
  ): Promise<Deliverable> {
    const agent = this.agent(agentId);
    const row = this.opts.tables.deliverables.get(deliverableId);
    if (!row) throw new DomainError('not_found', `no deliverable ${deliverableId}`);
    this.reach(
      agent,
      {
        ...(row.taskId ? { taskId: row.taskId } : {}),
        ...(row.projectId && !row.taskId ? { projectId: row.projectId } : {}),
      },
      'remove',
    );
    const why = reason.trim();
    if (!why) throw new DomainError('invalid', 'say why the deliverable is removed (reason)');
    const commands = opts.commands ?? this.opts.commands;
    const { value } = await commands.removeDeliverable(
      deliverableId,
      { type: 'agent', id: agent.id },
      redactSecrets(why).slice(0, 500),
    );
    return value;
  }

  /**
   * The deliverables an agent may read: a Steward its own task's; a Waykeeper its project's (or
   * one task's); the Harmonizer standalone tasks' and, read-only, any project's.
   */
  list(agentId: Id, target: DeclareTarget = {}, includeRemoved = false): Deliverable[] {
    const agent = this.agent(agentId);
    let rows: Deliverable[];
    if (agent.role === 'steward') {
      if (!agent.taskId) return [];
      if (target.taskId && target.taskId !== agent.taskId) {
        throw new DomainError('invalid', `a Steward lists its own task's deliverables only`);
      }
      rows = this.opts.tables.deliverables.of({ taskId: agent.taskId });
    } else if (agent.role === 'waykeeper') {
      const projectId = agent.projectId;
      if (!projectId) return [];
      if (target.projectId && target.projectId !== projectId) {
        throw new DomainError(
          'invalid',
          `project ${target.projectId} is not yours: a Waykeeper lists its own project's deliverables`,
        );
      }
      if (target.taskId) {
        const task = this.task(target.taskId);
        if (task.projectId !== projectId) {
          throw new DomainError('invalid', `task ${task.id} is not a task of your project`);
        }
        rows = this.opts.tables.deliverables.of({ taskId: task.id });
      } else {
        rows = this.opts.tables.deliverables.of({ projectId });
      }
    } else if (target.taskId) {
      rows = this.opts.tables.deliverables.of({ taskId: this.task(target.taskId).id });
    } else if (target.projectId) {
      this.project(target.projectId);
      rows = this.opts.tables.deliverables.of({ projectId: target.projectId });
    } else {
      // The Harmonizer: every standalone task's.
      rows = this.opts.tables.tasks
        .all()
        .filter((t) => t.projectId === undefined)
        .flatMap((t) => this.opts.tables.deliverables.of({ taskId: t.id }));
    }
    return includeRemoved ? rows : rows.filter(isActiveDeliverable);
  }

  // -- reach --------------------------------------------------------------------------------------

  private agent(agentId: Id): Agent {
    const agent = this.opts.tables.agents.get(agentId);
    if (!agent) throw new DomainError('not_found', `no agent ${agentId}`);
    return agent;
  }

  private task(taskId: Id): Task {
    const task = this.opts.tables.tasks.get(taskId);
    if (!task) throw new DomainError('not_found', `no task ${taskId}`);
    return task;
  }

  private project(projectId: Id): Project {
    const project = this.opts.tables.projects.get(projectId);
    if (!project) throw new DomainError('not_found', `no project ${projectId}`);
    return project;
  }

  /**
   * Whose deliverable this is, if the agent may write it (decision 120): a Steward its own task
   * (whatever target it named), a Waykeeper its project or a task of it, the Harmonizer a
   * standalone task. The domain's `checkAgentScope` is the second line.
   */
  private reach(
    agent: Agent,
    target: DeclareTarget,
    what: 'declare' | 'remove',
  ): { projectId?: Id; taskId?: Id; task?: Task; project?: Project } {
    if (agent.role === 'steward') {
      if (!agent.taskId) throw new DomainError('invalid', `Steward ${agent.id} has no task`);
      if (
        (target.taskId && target.taskId !== agent.taskId) ||
        (target.projectId && !target.taskId)
      ) {
        throw new DomainError(
          'invalid',
          `a Steward can ${what} the deliverables of its own task (${agent.taskId}) only`,
        );
      }
      const task = this.task(agent.taskId);
      const project = task.projectId ? this.project(task.projectId) : undefined;
      return {
        taskId: task.id,
        task,
        ...(project ? { projectId: project.id, project } : {}),
      };
    }
    if (agent.role === 'waykeeper') {
      const own = agent.projectId;
      if (!own) throw new DomainError('invalid', `Waykeeper ${agent.id} has no project`);
      if (target.taskId) {
        const task = this.task(target.taskId);
        if (task.projectId !== own) {
          throw new DomainError(
            'invalid',
            `task ${task.id} is not a task of your project (${own}): a Waykeeper can ${what} ` +
              "the deliverables of its own project's work only",
          );
        }
        return { taskId: task.id, task, projectId: own, project: this.project(own) };
      }
      if (target.projectId && target.projectId !== own) {
        throw new DomainError(
          'invalid',
          `project ${target.projectId} is not yours (${own}): a Waykeeper can ${what} the ` +
            "deliverables of its own project's work only",
        );
      }
      return { projectId: own, project: this.project(own) };
    }
    if (agent.role === 'harmonizer') {
      if (!target.taskId) {
        throw new DomainError(
          'invalid',
          `the Harmonizer can ${what} the deliverables of standalone tasks only: give a taskId`,
        );
      }
      const task = this.task(target.taskId);
      if (task.projectId !== undefined) {
        throw new DomainError(
          'invalid',
          `task ${task.id} belongs to project ${task.projectId}: its Waykeeper ${what}s its deliverables`,
        );
      }
      return { taskId: task.id, task };
    }
    throw new DomainError('invalid', `agent ${agent.id} cannot ${what} deliverables`);
  }

  // -- the target's shape -------------------------------------------------------------------------

  private async shape(
    agent: Agent,
    owner: { projectId?: Id; taskId?: Id; task?: Task; project?: Project },
    kind: DeliverableKind,
    input: DeclareInput,
    opts: DeclareOptions,
  ): Promise<{
    location?: DeliverableLocation;
    command?: DeliverableCommand;
    url?: string;
    meta?: Record<string, unknown>;
    stray?: PathAccepted;
  }> {
    const given = (name: 'path' | 'command' | 'url') =>
      typeof input[name] === 'string' && input[name].trim() !== '';
    if (PATH_KINDS.has(kind)) {
      if (!given('path')) throw new DomainError('invalid', `a ${kind} deliverable needs a path`);
      if (given('command') || given('url')) {
        throw new DomainError(
          'invalid',
          `a ${kind} deliverable has a path only (no command, no url)`,
        );
      }
      const checked = this.checkAgentPath(agent, owner, input.path!, opts);
      checkKindFits(kind, checked, input.path!);
      const meta =
        checked.type === 'file'
          ? { size: checked.stat.size, mtime: new Date(checked.stat.mtimeMs).toISOString() }
          : {};
      if (checked.where === 'stray') return { stray: checked, meta };
      return {
        location: {
          storage: checked.where === 'worktree' ? 'worktree' : 'in_place',
          path: checked.path,
        },
        meta,
      };
    }
    if (kind === 'command') {
      if (!given('command'))
        throw new DomainError('invalid', 'a command deliverable needs a command line');
      if (given('url')) throw new DomainError('invalid', 'a command deliverable has no url');
      const line = input.command!.trim();
      if (line.length > COMMAND_LINE_MAX) {
        throw new DomainError(
          'invalid',
          `a command line is at most ${COMMAND_LINE_MAX} characters`,
        );
      }
      if (/[\0\r\n]/.test(line)) {
        throw new DomainError(
          'invalid',
          'a command is one line (no newlines): put several steps in a script and declare that',
        );
      }
      if (containsSecret(line)) {
        throw new DomainError(
          'invalid',
          'the command line contains what looks like a secret: read it from the environment or a file the user keeps instead',
        );
      }
      const folder = given('path') ? input.path! : (opts.cwd ?? this.defaultFolder(owner));
      const checked = this.checkAgentPath(agent, owner, folder, opts, false);
      if (checked.type !== 'folder') {
        throw new DomainError('invalid', `${folder} is not a folder: a command runs in a folder`);
      }
      if (checked.where === 'stray') {
        throw new DomainError(
          'invalid',
          'a command runs in the project’s folder, not a temporary one',
        );
      }
      return { command: { line, cwd: checked.path } };
    }
    // url
    if (!given('url')) throw new DomainError('invalid', 'a url deliverable needs an address (url)');
    if (given('command') || given('path')) {
      throw new DomainError(
        'invalid',
        'a url deliverable has an address only (no path, no command)',
      );
    }
    const url = input.url!.trim();
    if (url.length > URL_MAX)
      throw new DomainError('invalid', `an address is at most ${URL_MAX} characters`);
    if (!isDeliverableUrl(url))
      throw new DomainError('invalid', 'an address is http or https only');
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      throw new DomainError('invalid', 'an address with a user name or password is refused');
    }
    if (containsSecret(url)) {
      throw new DomainError(
        'invalid',
        'the address contains what looks like a secret (a token): leave it out',
      );
    }
    return { url };
  }

  /** The folder a target's relative paths and default command run in. */
  private defaultFolder(owner: { task?: Task; project?: Project }): string {
    if (owner.task?.worktreePath) return owner.task.worktreePath;
    if (owner.project) return owner.project.workspace;
    const w = owner.task?.meta?.['workspace'];
    if (typeof w === 'string' && w !== '') return w;
    throw new DomainError('invalid', 'this task has no folder yet: nothing can be declared in it');
  }

  private roots(owner: { taskId?: Id; task?: Task; project?: Project }): DeliverableRoots {
    const places = {
      dataDir: this.opts.dataDir,
      ...(this.opts.home ? { home: this.opts.home } : {}),
    };
    if (owner.project) {
      const repoRoot = (owner.project.meta?.['workspace'] as { repoRoot?: unknown } | undefined)
        ?.repoRoot;
      const folder = owner.project.meta?.['deliverablesFolder'];
      return deliverableRoots(
        {
          workspace: owner.project.workspace,
          ...(typeof repoRoot === 'string' ? { repoRoot } : {}),
          ...(owner.taskId ? { taskId: owner.taskId } : {}),
          ...(typeof folder === 'string' ? { deliverablesFolder: folder } : {}),
        },
        places,
        this.fs,
      );
    }
    const workspace = owner.task?.meta?.['workspace'];
    if (typeof workspace !== 'string' || workspace === '') {
      throw new DomainError(
        'invalid',
        'this task has no folder yet: nothing can be declared in it',
      );
    }
    const folder = owner.task?.meta?.['deliverablesFolder'];
    return deliverableRoots(
      { workspace, ...(typeof folder === 'string' ? { deliverablesFolder: folder } : {}) },
      places,
      this.fs,
    );
  }

  private checkAgentPath(
    agent: Agent,
    owner: { taskId?: Id; task?: Task; project?: Project },
    path: string,
    opts: DeclareOptions,
    strays = true,
  ): PathAccepted {
    const roots = this.roots(owner);
    const cwd = opts.cwd ?? (isAbsolute(path) ? undefined : this.defaultFolder(owner));
    const stray: StrayRule = {
      firstSpawnAt: Date.parse(agent.createdAt),
      ...(this.opts.tmpDirs ? { tmpDirs: this.opts.tmpDirs } : {}),
    };
    const checked = checkPath(
      path,
      roots,
      { ...(cwd ? { cwd: resolve(cwd) } : {}), secretNames: true, ...(strays ? { stray } : {}) },
      this.fs,
    );
    if (!checked.ok) throw new DomainError('invalid', `${checked.reason} (${checked.code})`);
    return checked;
  }

  // -- limits -------------------------------------------------------------------------------------

  private sameAs(
    owner: { projectId?: Id; taskId?: Id },
    kind: DeliverableKind,
    shape: {
      location?: DeliverableLocation;
      command?: DeliverableCommand;
      url?: string;
      stray?: PathAccepted;
    },
  ): Deliverable | undefined {
    const rows = owner.taskId
      ? this.opts.tables.deliverables.of({ taskId: owner.taskId })
      : this.opts.tables.deliverables.of({ projectId: owner.projectId! }).filter((d) => !d.taskId);
    return rows.find(
      (d) =>
        isActiveDeliverable(d) &&
        d.source === 'agent' &&
        d.kind === kind &&
        ((shape.location && d.location?.path === shape.location.path) ||
          (shape.stray && d.location?.originalPath === shape.stray.path) ||
          (shape.command &&
            d.command?.line === shape.command.line &&
            d.command.cwd === shape.command.cwd) ||
          (shape.url !== undefined && d.url === shape.url)),
    );
  }

  private checkCounts(owner: { projectId?: Id; taskId?: Id }, limits: DeclarationLimits): void {
    const agentRows = (rows: Deliverable[]) =>
      rows.filter((d) => d.source === 'agent' && isActiveDeliverable(d)).length;
    if (owner.taskId) {
      const n = agentRows(this.opts.tables.deliverables.of({ taskId: owner.taskId }));
      if (n >= limits.perTask) {
        throw new DomainError(
          'conflict',
          `task ${owner.taskId} already has ${n} deliverables declared by agents (limit ` +
            `${limits.perTask}): declare only what the user will want to open, or remove one first`,
        );
      }
    }
    if (owner.projectId) {
      const n = agentRows(this.opts.tables.deliverables.of({ projectId: owner.projectId }));
      if (n >= limits.perProject) {
        throw new DomainError(
          'conflict',
          `project ${owner.projectId} already has ${n} deliverables declared by agents (limit ` +
            `${limits.perProject}): remove scratch ones before declaring more`,
        );
      }
    }
  }

  private recent(agentId: Id): number[] {
    const now = this.opts.now?.() ?? Date.now();
    const recent = (this.window.get(agentId) ?? []).filter((at) => at > now - HOUR_MS);
    this.window.set(agentId, recent);
    return recent;
  }

  private checkRate(agentId: Id, limits: DeclarationLimits): void {
    const recent = this.recent(agentId);
    if (recent.length >= limits.perAgentPerHour) {
      throw new DomainError(
        'conflict',
        `you declared ${recent.length} deliverables in the last hour (limit ` +
          `${limits.perAgentPerHour}): declare only what the user will want to open`,
      );
    }
  }

  private noteDeclaration(agentId: Id): void {
    this.recent(agentId).push(this.opts.now?.() ?? Date.now());
  }
}

function parseKind(kind: unknown): DeliverableKind {
  const parsed = DeliverableKind.safeParse(kind);
  if (!parsed.success) {
    throw new DomainError(
      'invalid',
      `kind must be one of ${DeliverableKind.options.join(', ')} (got ${JSON.stringify(kind)})`,
    );
  }
  return parsed.data;
}

/** An agent's title or description: within the limit, then redacted (TECHNOLOGY §8). */
function agentText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new DomainError('invalid', `${what} must be a string`);
  const text = value.trim();
  if (text.length > max) {
    throw new DomainError(
      'invalid',
      `a ${what} is at most ${max} characters (this one has ${text.length})`,
    );
  }
  return redactSecrets(text);
}

/** The path's type fits the kind: files for file and image (an image extension), folders for folder. */
function checkKindFits(kind: DeliverableKind, checked: PathAccepted, path: string): void {
  if (kind === 'file' && checked.type !== 'file') {
    throw new DomainError('invalid', `${path} is a folder: declare it as kind folder`);
  }
  if (kind === 'folder' && checked.type !== 'folder') {
    throw new DomainError('invalid', `${path} is a file: declare it as kind file`);
  }
  if (kind === 'image') {
    if (checked.type !== 'file')
      throw new DomainError('invalid', `${path} is a folder, not an image`);
    if (!IMAGE_TYPES[extensionOf(checked.path)]) {
      throw new DomainError(
        'invalid',
        `${path} is not an image the panel shows (${Object.keys(IMAGE_TYPES).join(', ')}): declare it as kind file`,
      );
    }
  }
  if (kind === 'app' && !isAppName(checked.path) && checked.type === 'folder') {
    throw new DomainError('invalid', `${path} is a folder, not an application bundle (.app)`);
  }
}
