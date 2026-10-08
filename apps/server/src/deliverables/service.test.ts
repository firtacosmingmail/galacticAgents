import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DECLARATION_LIMITS,
  type Agent,
  type AgentRole,
  type DeclarationLimits,
  type Id,
  type Project,
  type Task,
} from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { worktreeRoot } from '../workspace/workspaces.js';
import type { CopyTarget, DeliverableCopier } from './copies.js';
import { DeliverableService, type DeclareInput, type DeclareTarget } from './service.js';

/**
 * P9-04 — `DeliverableService.declare` (decision 120, TECHNOLOGY §9.3): the target rules, the
 * path rules of §9.2 for agents (outside, secret names, hard links, strays), the limits read from
 * the settings at every call, and removal by a supervisor. Real folders, a real composed runtime
 * (the domain commands are the second line).
 */

const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 100 };

let tmp: string;
let composed: ComposedRuntime;
let service: DeliverableService;
let limits: DeclarationLimits;
let copied: { source: string; target: CopyTarget }[];

let project: Project;
let other: Project;
let task: Task;
let otherTask: Task;
let standalone: Task;
let worktree: string;
let steward: Agent;
let waykeeper: Agent;
let harmonizer: Agent;

function agent(role: AgentRole, extra: Partial<Agent> & { cwd?: string } = {}): Agent {
  const { cwd, ...rest } = extra;
  return composed.log.runCommand((ctx) =>
    createAgent(ctx, {
      role,
      runtime: 'fake',
      caps: CAPS,
      ...(rest.taskId ? { taskId: rest.taskId } : {}),
      ...(rest.projectId ? { projectId: rest.projectId } : {}),
      ...(cwd ? { meta: { cwd } } : {}),
    }),
  ).value;
}

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-declare-')));
  for (const d of ['home', 'data', 'projects', 'strays', 'outside']) mkdirSync(join(tmp, d));
  limits = { ...DEFAULT_DECLARATION_LIMITS };
  copied = [];
  composed = composeRuntime(openDatabase(':memory:'), {
    workspaces: {
      projectsRoot: join(tmp, 'projects'),
      dataDir: join(tmp, 'data'),
      home: join(tmp, 'home'),
    },
    deliverables: {
      limits: () => limits,
      tmpDirs: [join(tmp, 'strays')],
    },
  });
  service = composed.deliverables!;
  const { commands } = composed;
  const ws = join(tmp, 'projects', 'app');
  mkdirSync(ws);
  project = (await commands.createProject({ name: 'App', workspace: ws })).value;
  const otherWs = join(tmp, 'projects', 'other');
  mkdirSync(otherWs);
  other = (await commands.createProject({ name: 'Other', workspace: otherWs })).value;
  task = (await commands.createTask({ projectId: project.id, description: 'build it' })).value;
  otherTask = (await commands.createTask({ projectId: other.id, description: 'elsewhere' })).value;
  standalone = (await commands.createTask({ description: 'tidy notes' })).value;
  const scratch = join(tmp, 'projects', 'scratch', 'tidy');
  mkdirSync(scratch, { recursive: true });
  standalone = (await commands.updateTask(standalone.id, { meta: { workspace: scratch } })).value;
  worktree = worktreeRoot(ws, task.id);
  mkdirSync(worktree, { recursive: true });
  steward = agent('steward', { taskId: task.id, cwd: worktree });
  waykeeper = agent('waykeeper', { projectId: project.id });
  harmonizer = agent('harmonizer');
});

afterEach(async () => {
  await composed.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

const file = (path: string, text = 'x\n') => {
  writeFileSync(path, text);
  return path;
};

async function refused(
  agentId: Id,
  target: DeclareTarget,
  input: DeclareInput,
): Promise<DomainError> {
  try {
    await service.declare(agentId, target, input, {});
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('not refused');
}

describe('DeliverableService.declare (P9-04)', () => {
  it('a Steward declares a file, an image, a folder, a command and an address of its task', async () => {
    file(join(worktree, 'report.md'), '# Report\n');
    file(join(worktree, 'shot.png'));
    mkdirSync(join(worktree, 'dist'));
    const cwd = { cwd: worktree };
    const report = await service.declare(
      steward.id,
      {},
      { kind: 'file', title: 'Report', path: 'report.md', description: 'What changed' },
      cwd,
    );
    expect(report.deliverable).toMatchObject({
      taskId: task.id,
      projectId: project.id,
      kind: 'file',
      title: 'Report',
      description: 'What changed',
      source: 'agent',
      addedBy: { type: 'agent', id: steward.id },
      location: { storage: 'worktree', path: join(worktree, 'report.md') },
      meta: { size: 9 },
    });
    const image = await service.declare(
      steward.id,
      {},
      { kind: 'image', title: 'Shot', path: join(worktree, 'shot.png') },
      cwd,
    );
    expect(image.deliverable.location?.path).toBe(join(worktree, 'shot.png'));
    const folder = await service.declare(
      steward.id,
      {},
      { kind: 'folder', title: 'Site', path: 'dist' },
      cwd,
    );
    expect(folder.deliverable.kind).toBe('folder');
    const dev = await service.declare(
      steward.id,
      {},
      { kind: 'command', title: 'Dev server', command: 'pnpm dev' },
      cwd,
    );
    expect(dev.deliverable.command).toEqual({ line: 'pnpm dev', cwd: worktree });
    const url = await service.declare(
      steward.id,
      {},
      { kind: 'url', title: 'Docs', url: 'https://example.com/docs' },
      cwd,
    );
    expect(url.deliverable.url).toBe('https://example.com/docs');
    expect(service.list(steward.id).map((d) => d.title)).toEqual([
      'Report',
      'Shot',
      'Site',
      'Dev server',
      'Docs',
    ]);
    // The same thing again is the same row, and costs no declaration.
    const again = await service.declare(
      steward.id,
      {},
      { kind: 'file', title: 'Report again', path: 'report.md' },
      cwd,
    );
    expect(again).toEqual({ deliverable: report.deliverable, existing: true });
    expect(composed.log.tables.deliverables.of({ taskId: task.id })).toHaveLength(5);
  });

  it('a Steward reaches its own task only, whatever target it names', async () => {
    file(join(worktree, 'a.txt'));
    expect(
      (
        await refused(
          steward.id,
          { taskId: otherTask.id },
          { kind: 'file', title: 'A', path: join(worktree, 'a.txt') },
        )
      ).message,
    ).toMatch(/its own task/);
    expect(
      (
        await refused(
          steward.id,
          { projectId: project.id },
          { kind: 'file', title: 'A', path: join(worktree, 'a.txt') },
        )
      ).message,
    ).toMatch(/its own task/);
  });

  it('refuses a path outside the project, a secret name, a hard link, a symlink out and a wrong kind', async () => {
    const outside = file(join(tmp, 'outside', 'notes.txt'));
    const cwd = { cwd: worktree };
    const reason = async (input: DeclareInput) =>
      (
        await service.declare(steward.id, {}, input, cwd).then(
          () => {
            throw new Error('not refused');
          },
          (e: DomainError) => e,
        )
      ).message;
    expect(await reason({ kind: 'file', title: 'Out', path: outside })).toMatch(
      /outside the project.*\(outside\)/,
    );
    expect(
      await reason({ kind: 'file', title: 'Up', path: '../../../../outside/notes.txt' }),
    ).toMatch(/outside/);
    file(join(worktree, '.env'), 'TOKEN=1\n');
    expect(await reason({ kind: 'file', title: 'Env', path: '.env' })).toMatch(/\(secret\)/);
    file(join(worktree, 'id_rsa'));
    expect(await reason({ kind: 'file', title: 'Key', path: 'id_rsa' })).toMatch(/\(secret\)/);
    linkSync(outside, join(worktree, 'linked.txt'));
    expect(await reason({ kind: 'file', title: 'Linked', path: 'linked.txt' })).toMatch(
      /\(hard_link\)/,
    );
    symlinkSync(outside, join(worktree, 'sym.txt'));
    expect(await reason({ kind: 'file', title: 'Sym', path: 'sym.txt' })).toMatch(/outside/);
    file(join(worktree, 'notes.txt'));
    expect(await reason({ kind: 'image', title: 'Not an image', path: 'notes.txt' })).toMatch(
      /not an image/,
    );
    expect(await reason({ kind: 'folder', title: 'Not a folder', path: 'notes.txt' })).toMatch(
      /is a file/,
    );
    expect(await reason({ kind: 'file', title: 'Missing', path: 'nope.txt' })).toMatch(
      /does not exist/,
    );
    expect(await reason({ kind: 'thing', title: 'X', path: 'notes.txt' })).toMatch(
      /kind must be one of/,
    );
    expect(await reason({ kind: 'url', title: 'X', url: 'file:///etc/passwd' })).toMatch(
      /http or https/,
    );
    expect(await reason({ kind: 'url', title: 'X', url: 'https://me:pw@example.com' })).toMatch(
      /user name or password/,
    );
    expect(
      await reason({
        kind: 'command',
        title: 'X',
        command: 'deploy --token ghp_' + 'a'.repeat(36),
      }),
    ).toMatch(/secret/);
    expect(await reason({ kind: 'command', title: 'X', command: 'a\nb' })).toMatch(/one line/);
    expect(
      await reason({ kind: 'command', title: 'X', command: 'ls', path: join(tmp, 'outside') }),
    ).toMatch(/outside/);
    expect(await reason({ kind: 'file', title: 'x'.repeat(121), path: 'notes.txt' })).toMatch(
      /at most 120/,
    );
    expect(composed.log.tables.deliverables.all()).toHaveLength(0);
  });

  it('redacts secrets in the title and the description', async () => {
    file(join(worktree, 'r.txt'));
    const { deliverable } = await service.declare(
      steward.id,
      {},
      {
        kind: 'file',
        title: 'Report',
        path: 'r.txt',
        description: 'uses password=hunter2hunter2',
      },
      { cwd: worktree },
    );
    expect(deliverable.description).not.toContain('hunter2');
  });

  it('a Waykeeper declares for its project and its tasks, never another project’s', async () => {
    file(join(tmp, 'projects', 'app', 'README.md'));
    const own = await service.declare(
      waykeeper.id,
      {},
      { kind: 'command', title: 'Dev', command: 'pnpm dev' },
    );
    expect(own.deliverable).toMatchObject({
      projectId: project.id,
      command: { cwd: project.workspace },
    });
    expect(own.deliverable.taskId).toBeUndefined();
    const readme = await service.declare(
      waykeeper.id,
      { taskId: task.id },
      { kind: 'file', title: 'Readme', path: join(project.workspace, 'README.md') },
    );
    expect(readme.deliverable).toMatchObject({
      taskId: task.id,
      location: { storage: 'in_place' },
    });
    expect(
      (
        await refused(
          waykeeper.id,
          { taskId: otherTask.id },
          { kind: 'url', title: 'X', url: 'https://x.dev' },
        )
      ).message,
    ).toMatch(/not a task of your project/);
    expect(
      (
        await refused(
          waykeeper.id,
          { projectId: other.id },
          { kind: 'url', title: 'X', url: 'https://x.dev' },
        )
      ).message,
    ).toMatch(/is not yours/);
    expect(() => service.list(waykeeper.id, { projectId: other.id })).toThrow(/not yours/);
  });

  it('the Harmonizer declares for standalone tasks only, and reads any project', async () => {
    const notes = file(join(standalone.meta!['workspace'] as string, 'notes.md'));
    const d = await service.declare(
      harmonizer.id,
      { taskId: standalone.id },
      { kind: 'file', title: 'Notes', path: notes },
    );
    expect(d.deliverable).toMatchObject({
      taskId: standalone.id,
      location: { storage: 'in_place' },
    });
    expect(d.deliverable.projectId).toBeUndefined();
    expect(
      (
        await refused(
          harmonizer.id,
          { taskId: task.id },
          { kind: 'url', title: 'X', url: 'https://x.dev' },
        )
      ).message,
    ).toMatch(/its Waykeeper declares/);
    expect(
      (
        await refused(
          harmonizer.id,
          { projectId: project.id },
          { kind: 'url', title: 'X', url: 'https://x.dev' },
        )
      ).message,
    ).toMatch(/standalone tasks only/);
    expect(service.list(harmonizer.id).map((r) => r.id)).toEqual([d.deliverable.id]);
    await service.declare(waykeeper.id, {}, { kind: 'url', title: 'Site', url: 'https://x.dev' });
    expect(service.list(harmonizer.id, { projectId: project.id }).map((r) => r.title)).toEqual([
      'Site',
    ]);
  });

  it('applies each configured limit, read at every call (a changed setting applies at once)', async () => {
    for (const n of [1, 2, 3]) file(join(worktree, `f${n}.txt`));
    const declare = (n: number) =>
      service.declare(
        steward.id,
        {},
        { kind: 'file', title: `F${n}`, path: `f${n}.txt` },
        { cwd: worktree },
      );
    limits = { ...limits, perTask: 1 };
    await declare(1);
    expect(((await declare(2).catch((e: Error) => e)) as Error).message).toMatch(
      /1 deliverables declared by agents \(limit 1\)/,
    );
    limits = { ...limits, perTask: 50, perProject: 1 };
    expect(((await declare(2).catch((e: Error) => e)) as Error).message).toMatch(
      /project .* \(limit 1\)/,
    );
    limits = { ...limits, perProject: 200, perAgentPerHour: 1 };
    expect(((await declare(2).catch((e: Error) => e)) as Error).message).toMatch(
      /in the last hour \(limit 1\)/,
    );
    limits = { ...limits, perAgentPerHour: 30 };
    await declare(2);
    limits = { ...limits, titleChars: 10 };
    const long = await service
      .declare(
        steward.id,
        {},
        { kind: 'file', title: 'A long title', path: 'f3.txt' },
        { cwd: worktree },
      )
      .catch((e: Error) => e);
    expect((long as Error).message).toMatch(/at most 10 characters/);
    limits = { ...limits, titleChars: 120, descriptionChars: 5 };
    const desc = await service
      .declare(
        steward.id,
        {},
        { kind: 'file', title: 'F3', path: 'f3.txt', description: 'too long' },
        { cwd: worktree },
      )
      .catch((e: Error) => e);
    expect((desc as Error).message).toMatch(/description is at most 5/);
  });

  it('a stray in a temporary folder is copied through DeliverableCopies, or refused without them', async () => {
    const stray = file(join(tmp, 'strays', 'chart.png'));
    const input = { kind: 'image', title: 'Chart', path: stray };
    // Without copies (a service composed with no workspaces) a stray is refused.
    const without = new DeliverableService({
      commands: composed.commands,
      tables: composed.log.tables,
      dataDir: join(tmp, 'data'),
      home: join(tmp, 'home'),
      tmpDirs: [join(tmp, 'strays')],
    });
    await expect(without.declare(steward.id, {}, input)).rejects.toThrow(
      /temporary folder.*not available/,
    );
    const copies: DeliverableCopier = {
      copyIn: async (source, target) => {
        copied.push({ source, target });
        const path = join(project.workspace, 'deliverables', 'chart.png');
        return {
          location: { storage: 'copy', path, originalPath: source },
          bytes: 2,
          folder: join(project.workspace, 'deliverables'),
          skipped: [],
        };
      },
    };
    const withCopies = new DeliverableService({
      commands: composed.commands,
      tables: composed.log.tables,
      dataDir: join(tmp, 'data'),
      home: join(tmp, 'home'),
      tmpDirs: [join(tmp, 'strays')],
      copies,
    });
    const { deliverable } = await withCopies.declare(steward.id, {}, input);
    expect(copied).toEqual([{ source: stray, target: { projectId: project.id, taskId: task.id } }]);
    expect(deliverable.location).toEqual({
      storage: 'copy',
      path: join(project.workspace, 'deliverables', 'chart.png'),
      originalPath: stray,
    });
    expect(deliverable.meta).toMatchObject({ copy: { bytes: 2 } });
    // Declared again: the same row, nothing copied twice.
    expect((await withCopies.declare(steward.id, {}, input)).existing).toBe(true);
    expect(copied).toHaveLength(1);
    // A stray the copy refuses (the disk) is refused with the copy's reason, nothing recorded.
    const full = new DeliverableService({
      commands: composed.commands,
      tables: composed.log.tables,
      dataDir: join(tmp, 'data'),
      tmpDirs: [join(tmp, 'strays')],
      copies: {
        copyIn: () =>
          Promise.reject(new DomainError('invalid', 'not enough space: needs 2 B, 1 B free')),
      },
    });
    const other = file(join(tmp, 'strays', 'other.png'));
    await expect(
      full.declare(steward.id, {}, { kind: 'image', title: 'O', path: other }),
    ).rejects.toThrow(/not enough space/);
    expect(composed.log.tables.deliverables.all()).toHaveLength(1);
  });

  it('the composed service copies a stray into <workspace>/deliverables/<task-slug>/ (P9-06)', async () => {
    const stray = file(join(tmp, 'strays', 'chart.png'), 'png bytes');
    const { deliverable } = await service.declare(
      steward.id,
      {},
      {
        kind: 'image',
        title: 'Chart',
        path: stray,
      },
    );
    const folder = join(project.workspace, 'deliverables');
    const copy = join(folder, 'build-it', 'chart.png');
    expect(deliverable.location).toEqual({ storage: 'copy', path: copy, originalPath: stray });
    expect(deliverable.meta).toMatchObject({ copy: { bytes: 9 } });
    expect(deliverable.source).toBe('agent');
    expect(readFileSync(copy, 'utf8')).toBe('png bytes');
    expect(composed.log.tables.projects.get(project.id)!.meta).toMatchObject({
      deliverablesFolder: folder,
    });
    // The Waykeeper's stray for its task (measured from the task's Steward) goes to the task's
    // subfolder; for the project itself there is no Steward to measure from: refused (S3).
    const plan = file(join(tmp, 'strays', 'plan.md'));
    const forTask = await service.declare(
      waykeeper.id,
      { taskId: task.id },
      { kind: 'file', title: 'Plan', path: plan },
    );
    expect(forTask.deliverable.location).toMatchObject({
      storage: 'copy',
      path: join(folder, 'build-it', 'plan.md'),
    });
    const top = await refused(
      waykeeper.id,
      { projectId: project.id },
      { kind: 'file', title: 'Plan', path: file(join(tmp, 'strays', 'top.md')) },
    );
    expect(top.message).toMatch(/only for a task with a Steward/);
    // The Harmonizer's stray for a scratch task (once a Steward works on it) goes to that task's
    // own folder.
    agent('steward', { taskId: standalone.id });
    const notes = file(join(tmp, 'strays', 'notes.txt'));
    const scratch = await service.declare(
      harmonizer.id,
      { taskId: standalone.id },
      { kind: 'file', title: 'Notes', path: notes },
    );
    const scratchFolder = join(tmp, 'projects', 'scratch', 'tidy', 'deliverables');
    expect(scratch.deliverable.location).toMatchObject({
      storage: 'copy',
      path: join(scratchFolder, 'notes.txt'),
    });
    expect(composed.log.tables.tasks.get(standalone.id)!.meta).toMatchObject({
      deliverablesFolder: scratchFolder,
    });
  });

  it('a supervisor removes an agent’s scratch with a reason, never the user’s row', async () => {
    file(join(worktree, 'debug.log'));
    const log = await service.declare(
      steward.id,
      {},
      { kind: 'file', title: 'Debug log', path: 'debug.log' },
      { cwd: worktree },
    );
    await expect(service.remove(waykeeper.id, log.deliverable.id, '  ')).rejects.toThrow(/say why/);
    const removed = await service.remove(waykeeper.id, log.deliverable.id, 'scratch log');
    expect(removed).toMatchObject({
      removedReason: 'scratch log',
      removedBy: { type: 'agent', id: waykeeper.id },
    });
    expect(service.list(steward.id)).toEqual([]);
    expect(service.list(steward.id, {}, true)).toHaveLength(1);
    const user = await composed.commands.addDeliverable(
      { taskId: task.id, kind: 'url', title: 'Mine', source: 'user', url: 'https://mine.dev' },
      { type: 'user' },
      { origin: 'local' },
    );
    await expect(service.remove(waykeeper.id, user.value.id, 'not needed')).rejects.toThrow(
      /added by the user/,
    );
    const otherWk = agent('waykeeper', { projectId: other.id });
    const mine = await service.declare(
      waykeeper.id,
      {},
      { kind: 'url', title: 'X', url: 'https://x.dev' },
    );
    await expect(service.remove(otherWk.id, mine.deliverable.id, 'no')).rejects.toThrow(
      /is not yours/,
    );
    // The files stay (decision 122).
    expect(realpathSync(join(worktree, 'debug.log'))).toBe(join(worktree, 'debug.log'));
  });
});
