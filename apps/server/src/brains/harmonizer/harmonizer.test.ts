import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Proposal } from '@galactic/protocol';
import { EARTH_ID } from '../../domain/catalogue.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { waykeeperDefinition } from '../waykeeper/index.js';
import {
  findRelated,
  harmonizerBrain,
  harmonizerRuntime,
  hintKind,
  SCRATCH_DIR,
  startHarmonizer,
  type HarmonizerDeps,
} from './index.js';

/**
 * The Harmonizer brain (P2-08) through the scripted fake-LLM harness (P2-07): the scripts stand
 * in for the model's choices; every tool handler, the runner, the gate and `DomainCommands` run
 * for real. Acceptance: a status question produces no proposal; a new project produces one; an
 * asteroid Steward's question is held (and answered) by the Harmonizer; permission questions
 * never reach it.
 */

const USER = { type: 'user' } as const;
const lives: { h: BrainHarness; root: string }[] = [];
afterEach(async () => {
  for (const { h, root } of lives.splice(0)) {
    await h.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

function setup(deps: Partial<HarmonizerDeps> = {}) {
  const h = brainHarness();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-hq-')));
  lives.push({ h, root });
  const waykeepers: Id[] = [];
  const definition = harmonizerBrain({
    projectsRoot: root,
    startWaykeeper: async ({ projectId, supervisorId }) => {
      // The real Waykeeper brain (P2-10), as `index.ts` wires it.
      const wk = await h.startBrain(waykeeperDefinition(), {
        runtime: 'fake',
        projectId,
        supervisorId,
      });
      waykeepers.push(wk.agentId);
      return { agentId: wk.agentId };
    },
    ...deps,
  });
  return { h, root, definition, waykeepers };
}

const proposals = (h: BrainHarness): Proposal[] => h.log.tables.proposals.all();
const heldByYou = /asked (\S+) \(held by you\)/;

describe('Harmonizer brain (P2-08)', () => {
  it('answers a status question without any proposal (decision 3)', async () => {
    const { h, definition } = setup();
    await h.commands.createProject({ name: 'CSV tools', workspace: '/w/csv' });
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s.once('status', async (t) => {
          const report = await t.call<{ projects: { name: string }[] }>('report_status');
          expect(report.projects.map((p) => p.name)).toEqual(['CSV tools']);
          t.say('One project, CSV tools, nothing running.');
        }),
    });

    hq.tell('What is the status of everything?');
    await h.done();

    hq.assertCalls(['report_status']);
    expect(proposals(h)).toEqual([]);
    expect(h.log.tables.agents.all().map((a) => a.role)).toEqual(['harmonizer']);
  });

  it('turns a new-project request into exactly one proposal and spawns nothing', async () => {
    const { h, root, definition } = setup();
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s.once('CSV to Parquet', async (t) => {
          const related = await t.call<unknown[]>('find_related_work', { request: t.prompt });
          expect(related).toEqual([]);
          const size = await t.call<{ proposedBody: { bodyId: Id }; workspace: string }>(
            'size_request',
            { request: 'a CLI that converts CSV to Parquet', kind: 'planet', name: 'Parquet CLI' },
          );
          await t.call('propose', {
            type: 'new_project',
            requestText: 'Start a new project: build a CLI that converts CSV to Parquet',
            name: 'Parquet CLI',
            kind: 'planet',
            rationale: 'a new application',
            bodyId: size.proposedBody.bodyId,
          });
          // propose ended the turn: a second card in the same turn is refused.
          const again = await t.try('propose', {
            type: 'new_project',
            requestText: 'again',
            name: 'Again',
            kind: 'moon',
            rationale: 'no',
          });
          expect(again).toMatchObject({ ok: false, error: 'turn_ended' });
        }),
    });

    hq.tell('Start a new project: build a CLI that converts CSV to Parquet');
    await h.done();

    const all = proposals(h);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      state: 'pending',
      kind: 'planet',
      proposedBody: { kind: 'planet', name: 'Parquet CLI', bodyId: 'b-mars' },
      workspace: join(root, 'parquet-cli'),
      meta: { request: { type: 'new_project', name: 'Parquet CLI' } },
    });
    expect(hq.calls('propose')[0]).toMatchObject({ ok: true, turnEnded: true });
    expect(h.log.tables.projects.all()).toEqual([]);
    expect(h.log.tables.agents.all().map((a) => a.role)).toEqual(['harmonizer']);
  });

  it('carries out an approved project card: create_project, then its Waykeeper', async () => {
    const { h, definition, waykeepers } = setup();
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('build a parser', async (t) => {
            const { proposalId } = await t.call<{ proposalId: Id }>('propose', {
              type: 'new_project',
              requestText: 'build a parser',
              name: 'Parser',
              kind: 'moon',
              rationale: 'a small tool',
            });
            // Nothing is created before the user approves (decision 3).
            void proposalId;
          })
          .once(/proposal (\S+) was approved/, async (t) => {
            const proposalId = /proposal (\S+) was approved/.exec(t.prompt)![1]!;
            const project = await t.call<{ projectId: Id }>('create_project', { proposalId });
            const twice = await t.try('create_project', { proposalId });
            expect(twice).toMatchObject({ ok: false, error: 'conflict' });
            await t.call('spawn_waykeeper', { projectId: project.projectId });
            const second = await t.try('spawn_waykeeper', { projectId: project.projectId });
            expect(second).toMatchObject({ ok: false, error: 'conflict' });
          }),
    });

    hq.tell('build a parser');
    await h.settle();
    const [proposal] = proposals(h);
    // Approval is the user's: before it, the tools refuse.
    const early = await hq.runner.definition.tools
      .find((x) => x.name === 'create_project')!
      .handler(
        { proposalId: proposal!.id },
        {
          brainId: hq.agentId,
          role: 'harmonizer',
          actor: { type: 'agent', id: hq.agentId },
          commands: h.commands,
          queries: h.queries,
          send: () => {
            throw new Error('not used here');
          },
        },
      )
      .catch((e: { code: string }) => e.code);
    expect(early).toBe('invalid_transition');

    await h.commands.decideProposal(proposal!.id, { decision: 'approve' }, USER);
    await h.done();

    const [project] = h.log.tables.projects.all();
    expect(project).toMatchObject({ name: 'Parser', meta: { proposalId: proposal!.id } });
    expect(h.log.tables.bodies.get(project!.bodyId)?.kind).toBe('moon');
    expect(waykeepers).toHaveLength(1);
    expect(h.log.tables.agents.get(waykeepers[0]!)).toMatchObject({
      role: 'waykeeper',
      projectId: project!.id,
      supervisorId: hq.agentId,
    });
  });

  it('holds and answers an asteroid Steward’s clarification, then closes the task', async () => {
    const { h, root, definition } = setup({ stewardPrompt: () => 'scenario:asks' });
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('rename the logs', (t) =>
            t.call('propose', {
              type: 'standalone_task',
              requestText: 'rename the log files',
              name: 'Rename logs',
              rationale: 'a one-off script',
            }),
          )
          .once(/proposal (\S+) was approved/, async (t) => {
            const proposalId = /proposal (\S+) was approved/.exec(t.prompt)![1]!;
            const task = await t.call<{ taskId: Id }>('create_task', { proposalId });
            await t.call('spawn_steward', { taskId: task.taskId });
          })
          .once(heldByYou, async (t) => {
            const questionId = heldByYou.exec(t.prompt)![1]!;
            await t.call('answer_question', { questionId, answer: 'ISO 8601' });
          })
          .once(/finished/, async (t) => {
            const taskId = h.log.tables.tasks.all()[0]!.id;
            await t.call('close_task', { taskId });
          }),
    });

    hq.tell('please rename the logs');
    await h.settle();
    const [proposal] = proposals(h);
    expect(proposal).toMatchObject({
      kind: 'asteroid',
      workspace: join(root, SCRATCH_DIR, 'rename-logs'),
    });
    await h.commands.decideProposal(proposal!.id, { decision: 'approve' }, USER);
    await h.until(() => h.log.tables.tasks.all()[0]?.state === 'completed', {
      what: 'the asteroid task to be closed',
    });
    await h.done();

    const steward = h.log.tables.agents.all().find((a) => a.role === 'steward')!;
    expect(steward).toMatchObject({
      supervisorId: hq.agentId,
      meta: { cwd: join(root, SCRATCH_DIR, 'rename-logs') },
    });
    const [question] = h.log.tables.questions.all();
    expect(question).toMatchObject({
      kind: 'clarification',
      originAgentId: steward.id,
      status: 'answered',
      answer: 'ISO 8601',
      answeredBy: { type: 'agent', id: hq.agentId },
    });
    hq.assertCalls(['propose', 'create_task', 'spawn_steward', 'answer_question', 'close_task']);
  });

  it('runs an asteroid Steward only in the workspace approved on its card (decision 34)', async () => {
    const elsewhere = join(tmpdir(), 'galactic-not-approved');
    const made: string[] = [];
    const { h, root, definition } = setup({
      stewardPrompt: () => 'scenario:happy',
      ensureDir: (p) => made.push(p),
    });
    const { value: card } = await h.commands.createProposal({
      requestText: 'rename the logs',
      kind: 'asteroid',
      proposedBody: { kind: 'asteroid', name: 'Rename logs' },
      workspace: join(root, 'approved'),
      rationale: 'small',
      meta: {
        request: { type: 'standalone_task', name: 'Rename logs', description: 'rename the logs' },
      },
    });
    await h.commands.decideProposal(card.id, { decision: 'approve' }, USER);
    // A task that never had a card has no approved workspace.
    const { value: bare } = await h.commands.createTask({ description: 'no card' });
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('go', async (t) => {
            const task = await t.call<{ taskId: Id }>('create_task', { proposalId: card.id });
            const moved = await t.try('spawn_steward', {
              taskId: task.taskId,
              workspace: elsewhere,
            });
            expect(moved).toMatchObject({ ok: false, error: 'invalid' });
            expect(await t.try('spawn_steward', { taskId: bare.id })).toMatchObject({
              ok: false,
              error: 'invalid',
            });
            const out = await t.call<{ workspace: string }>('spawn_steward', {
              taskId: task.taskId,
            });
            expect(out.workspace).toBe(join(root, 'approved'));
          })
          .on(/finished/, () => {}),
    });
    hq.tell('go');
    await h.done();
    expect(made).toEqual([join(root, 'approved')]);
    expect(h.log.tables.agents.all().filter((a) => a.role === 'steward')).toHaveLength(1);
  });

  it('never sees a permission question, and refuses to answer one', async () => {
    const { h, root, definition } = setup({ stewardPrompt: () => 'scenario:permission' });
    const seen: { permissionId?: Id } = {};
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('clean the build', async (t) => {
            // An approved card the user created out of band stands in for the proposal flow.
            const pid = h.log.tables.proposals.all()[0]!.id;
            const task = await t.call<{ taskId: Id }>('create_task', { proposalId: pid });
            await t.call('spawn_steward', { taskId: task.taskId });
          })
          .once('answer it for me', async (t) => {
            const refused = await t.try('answer_question', {
              questionId: seen.permissionId,
              answer: 'allow',
            });
            expect(refused).toMatchObject({ ok: false, error: 'invalid' });
          })
          .once(/finished/, () => {}),
    });
    const { value: card } = await h.commands.createProposal({
      requestText: 'clean the build',
      kind: 'asteroid',
      proposedBody: { kind: 'asteroid', name: 'Clean build' },
      workspace: join(root, 'build'),
      rationale: 'small',
      meta: {
        request: { type: 'standalone_task', name: 'Clean build', description: 'clean the build' },
      },
    });
    await h.commands.decideProposal(card.id, { decision: 'approve' }, USER);

    hq.tell('clean the build');
    await h.until(() => h.log.tables.questions.all().length > 0, { what: 'the permission card' });
    await h.settle();
    const [question] = h.log.tables.questions.all();
    const permissionId = (seen.permissionId = question!.id);
    expect(question).toMatchObject({ kind: 'permission', holder: { type: 'user' } });

    hq.tell('answer it for me');
    await hq.waitForTurns(3);
    await h.commands.answerQuestion({ questionId: permissionId, answer: 'allow', by: USER });
    await h.done();

    // No mailbox line was ever about it (the seed may show the Steward waiting: status is
    // observable, decision 7 is about who decides).
    const lines = hq.runner.turns.flatMap((t) => t.items);
    expect(lines.filter((i) => JSON.stringify(i.event).includes(permissionId))).toEqual([]);
    expect(hq.runner.turns.map((t) => t.kind)).toEqual(['first', 'mailbox', 'mailbox', 'mailbox']);
    expect(h.log.tables.questions.get(permissionId)).toMatchObject({
      status: 'answered',
      answeredBy: USER,
    });
  });

  it('adds work that belongs to an existing project there, on the project’s body', async () => {
    const { h, definition } = setup();
    const { value: project } = await h.commands.createProject({
      name: 'CSV exporter',
      workspace: '/w/csv',
    });
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('pagination', async (t) => {
            const related = await t.call<{ kind: string; id: Id }[]>('find_related_work', {
              request: 'add pagination to the CSV exporter',
            });
            expect(related[0]).toMatchObject({ kind: 'project', id: project.id });
            await t.call('propose', {
              type: 'project_task',
              requestText: 'add pagination to the CSV exporter',
              name: 'Pagination',
              projectId: project.id,
              rationale: 'belongs to CSV exporter',
            });
          })
          .once(/was approved/, async (t) => {
            const proposalId = /proposal (\S+) was approved/.exec(t.prompt)![1]!;
            const task = await t.call<{ taskId: Id }>('create_task', { proposalId });
            // A project task's Steward is its Waykeeper's to spawn; its closing too.
            expect(await t.try('spawn_steward', { taskId: task.taskId })).toMatchObject({
              ok: false,
              error: 'invalid',
            });
            expect(await t.try('close_task', { taskId: task.taskId })).toMatchObject({
              ok: false,
              error: 'invalid',
            });
          }),
    });

    hq.tell('add pagination to the CSV exporter');
    await h.settle();
    const [proposal] = proposals(h);
    expect(proposal).toMatchObject({
      proposedBody: { bodyId: project.bodyId },
      workspace: '/w/csv',
    });
    await h.commands.decideProposal(proposal!.id, { decision: 'approve' }, USER);
    await h.done();
    const [task] = h.queries.projectTasks(project.id);
    expect(task).toMatchObject({
      description: 'add pagination to the CSV exporter',
      bodyId: project.bodyId,
    });
  });

  it('proposes a promotion without moving anything', async () => {
    const { h, definition } = setup();
    const { value: task } = await h.commands.createTask({ description: 'a growing script' });
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s.once('grown', (t) =>
          t.call('propose_promotion', { taskId: task.id, toKind: 'moon', rationale: 'it grew' }),
        ),
    });
    hq.tell('the script has grown');
    await h.done();
    const [proposal] = proposals(h);
    expect(proposal).toMatchObject({
      kind: 'moon',
      state: 'pending',
      meta: {
        request: {
          type: 'promotion',
          target: { kind: 'task', id: task.id },
          fromBodyId: task.bodyId,
        },
      },
    });
    expect(h.log.tables.tasks.get(task.id)?.bodyId).toBe(task.bodyId);
  });
});

describe('Harmonizer boot start (P2-08, decision 32)', () => {
  it('starts one Harmonizer on Earth, and none while one runs', async () => {
    const { h, root } = setup();
    const opts = { runtime: 'fake' as const, cwd: root, deps: { projectsRoot: root } };
    const first = await startHarmonizer(h.composed, opts);
    expect(first.status).toBe('started');
    expect(h.log.tables.agents.get(first.agentId)).toMatchObject({
      role: 'harmonizer',
      bodyId: EARTH_ID,
    });
    const second = await startHarmonizer(h.composed, opts);
    expect(second).toEqual({ status: 'running', agentId: first.agentId });
    expect(h.log.tables.agents.all()).toHaveLength(1);
    if (first.status === 'started') first.runner.dispose();
  });

  it('picks the boot runtime: fake in dev mode, claude-sdk otherwise, none when off', () => {
    expect(harmonizerRuntime(undefined, true)).toBe('fake');
    expect(harmonizerRuntime(undefined, false)).toBe('claude-sdk');
    expect(harmonizerRuntime('claude-sdk', true)).toBe('claude-sdk');
    expect(harmonizerRuntime('fake', false)).toBe('fake');
    expect(harmonizerRuntime('off', false)).toBeUndefined();
    expect(harmonizerRuntime('0', true)).toBeUndefined();
  });
});

describe('Harmonizer helpers', () => {
  it('finds related work by shared words, best first', () => {
    const now = new Date().toISOString();
    const base = { createdAt: now, updatedAt: now, bodyId: 'b' };
    const matches = findRelated('add pagination to the CSV exporter', {
      projects: [
        { ...base, id: 'p-1', name: 'CSV exporter', workspace: '/w/csv', state: 'in_progress' },
        { ...base, id: 'p-2', name: 'Old CSV', workspace: '/w/old', state: 'archived' },
      ],
      tasks: [
        {
          ...base,
          id: 't-1',
          description: 'pagination for lists',
          priority: 'normal',
          blockedBy: [],
          state: 'approved',
        },
      ],
    });
    expect(matches.map((m) => m.id)).toEqual(['p-1', 't-1']);
    expect(matches[0]).toMatchObject({ matched: ['csv', 'exporter'] });
  });

  it('hints a size without deciding it', () => {
    expect(hintKind('fix the flaky date test')).toBe('asteroid');
    expect(hintKind('build a new web application')).toBe('planet');
    expect(hintKind('a CSV to Parquet converter')).toBe('moon');
  });
});
