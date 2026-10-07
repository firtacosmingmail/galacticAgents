// @vitest-environment node
//
// P9-01 — replay vs snapshot for deliverables (TECHNOLOGY §9.1): every `deliverable.*` and `run.*`
// event driven through the real commands — detected, declared and hand-added rows, edits, a
// removal and a restore, an open, runs with ports and ends — and the moves of decision 124: a
// standalone task joining a project, a standalone task promoted to a moon project (`moveTask`) and
// a project task promoted by its Waykeeper (`transferTask`). The world fold must equal the
// server's snapshot after every commit.
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, EventEnvelope, Snapshot } from '@galactic/protocol';
import {
  FakeAdapter,
  PromotionFlow,
  carriedOut,
  composeRuntime,
  openDatabase,
  type ComposedRuntime,
} from '@galactic/server';
import { applyEvent, applySnapshot, type WorldState } from './reduce.js';

const USER: Actor = { type: 'user' };
const SYSTEM: Actor = { type: 'system' };
const LOCAL = { origin: 'local' as const };

function tickingClock(): () => string {
  let t = Date.parse('2026-10-07T09:00:00.000Z');
  return () => new Date((t += 1000)).toISOString();
}

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

function tables(w: WorldState) {
  const { seq: _seq, statuses: _statuses, ...rest } = w;
  return rest;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('replay vs snapshot conformance: deliverables (P9-01)', () => {
  it('folding the recorded log gives the server snapshot, deliverables included, at every commit', async () => {
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter({ speed: 5 })],
      log: { now: tickingClock() },
      flushMs: 10,
      caps: { maxConcurrentAgents: 8 },
    });
    lives.push(composed);
    const { log, commands } = composed;
    const start: Snapshot = { ...log.snapshot(), statuses: [] };
    const recorded: EventEnvelope[] = [];
    const checkpoints: Snapshot[] = [];
    log.subscribe((env) => {
      recorded.push(env);
      if (log.currentSeq() === env.seq) checkpoints.push({ ...log.snapshot(), statuses: [] });
    });

    const project = (
      await commands.createProject({ name: 'App', workspace: '/w/app', bodyId: 'b-mars' })
    ).value;
    const harmonizer = (
      await commands.spawnAgent({ role: 'harmonizer', runtime: 'fake', cwd: '/w/hq', prompt: 'x' })
    ).value;
    const waykeeper = (
      await commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        supervisorId: harmonizer.id,
        prompt: 'scenario:long',
      })
    ).value;
    const steward: Actor = { type: 'agent', id: 'a-steward-x' };

    // --- the project's own: its folder and a detected script, a command added by hand
    await commands.addDeliverable(
      {
        projectId: project.id,
        kind: 'folder',
        title: 'Project folder',
        source: 'detected',
        detectedKey: 'folder',
        location: { storage: 'in_place', path: '/w/app' },
      },
      SYSTEM,
    );
    const dev = (
      await commands.addDeliverable(
        {
          projectId: project.id,
          kind: 'command',
          title: 'dev',
          source: 'detected',
          detectedKey: 'package.json#dev',
          command: { line: 'pnpm run dev', cwd: '/w/app', detectedFrom: 'package.json' },
          meta: { important: 0 },
        },
        SYSTEM,
      )
    ).value;
    const site = (
      await commands.addDeliverable(
        {
          projectId: project.id,
          kind: 'url',
          title: 'Staging',
          source: 'user',
          url: 'https://staging.example.com',
        },
        USER,
        LOCAL,
      )
    ).value;
    await commands.updateDeliverable(
      site.id,
      { title: 'Staging site', description: 'the preview deploy' },
      USER,
      { ...LOCAL, expectedVersion: 1 },
    );
    await commands.updateDeliverable(site.id, { description: null }, USER, LOCAL);

    // --- runs: one stopped, one exited, one left live
    const r1 = (
      await commands.recordRunStarted(
        { deliverableId: dev.id, line: 'pnpm run dev', cwd: '/w/app' },
        USER,
      )
    ).value;
    await commands.recordRunPorts(r1.id, [5173]);
    await commands.recordRunEnded(r1.id, { outcome: 'stopped', by: USER });
    const r2 = (
      await commands.recordRunStarted(
        { deliverableId: dev.id, line: 'pnpm run dev -- --port 4000', cwd: '/w/app' },
        USER,
      )
    ).value;
    await commands.recordRunEnded(r2.id, { outcome: 'exited', exitCode: 1 });
    const r3 = (
      await commands.recordRunStarted(
        { deliverableId: dev.id, line: 'pnpm run dev', cwd: '/w/app' },
        USER,
      )
    ).value;
    await commands.recordRunPorts(r3.id, [5173, 24678]);

    // --- a task's: a Steward's screenshot, re-pointed, opened, removed by the Waykeeper, restored
    const login = (await commands.createTask({ description: 'Login page', projectId: project.id }))
      .value;
    const shot = (
      await commands.addDeliverable(
        {
          taskId: login.id,
          kind: 'image',
          title: 'Login screen',
          source: 'agent',
          location: { storage: 'worktree', path: '/w/app/.galactic/worktrees/l/login.png' },
          meta: { size: 1200 },
        },
        steward,
      )
    ).value;
    await commands.updateDeliverable(
      shot.id,
      {
        location: {
          storage: 'copy',
          path: '/w/app/deliverables/login-page/login.png',
          originalPath: '/w/app/.galactic/worktrees/l/login.png',
        },
        meta: { copy: { bytes: 1200 } },
      },
      SYSTEM,
    );
    await commands.recordDeliverableOpened(shot.id, 'open', USER);
    await commands.removeDeliverable(shot.id, { type: 'agent', id: waykeeper.id }, 'duplicate');
    await commands.restoreDeliverable(shot.id, USER, LOCAL);

    // --- decision 124: a standalone task joins the project, its deliverables with it
    const chore = (
      await commands.createTask({ description: 'Rotate logs', meta: { workspace: '/w/s' } })
    ).value;
    const choreLog = (
      await commands.addDeliverable(
        {
          taskId: chore.id,
          kind: 'file',
          title: 'Rotation log',
          source: 'user',
          location: { storage: 'in_place', path: '/w/s/rotate.log' },
        },
        USER,
        LOCAL,
      )
    ).value;
    await commands.removeDeliverable(choreLog.id, USER, undefined, LOCAL);
    await commands.moveTask(chore.id, project.id, USER);
    expect(log.tables.deliverables.get(choreLog.id)?.projectId).toBe(project.id);

    // --- promotions (P2-12): a standalone task grows into a moon project (`moveTask`), a project
    // task is promoted by its Waykeeper to a sub-project moon (`transferTask`)
    const flow = new PromotionFlow({
      log,
      commands,
      liveAgents: () => composed.runtime.liveAgents(),
      startWaykeeper: async ({ projectId, supervisorId, runtime }) => ({
        agentId: (
          await commands.spawnAgent({
            role: 'waykeeper',
            runtime,
            projectId,
            supervisorId,
            prompt: 'scenario:long',
          })
        ).value.id,
      }),
    }).start();
    const grown = (
      await commands.createTask({ description: 'Grow the importer', meta: { workspace: '/w/imp' } })
    ).value;
    const notes = (
      await commands.addDeliverable(
        {
          taskId: grown.id,
          kind: 'file',
          title: 'Design notes',
          source: 'agent',
          location: { storage: 'in_place', path: '/w/imp/NOTES.md' },
        },
        steward,
      )
    ).value;
    const card = (
      await commands.createProposal({
        requestText: 'promote the importer',
        kind: 'moon',
        proposedBody: { kind: 'moon', name: 'Importer', bodyId: 'b-io', parentId: 'b-jupiter' },
        workspace: '/w/imp',
        rationale: 'it grew',
        meta: {
          request: {
            type: 'promotion',
            name: 'Importer',
            target: { kind: 'task', id: grown.id },
            fromBodyId: grown.bodyId,
          },
        },
      })
    ).value;
    await flow.idle();
    await commands.decideProposal(card.id, { decision: 'approve' }, USER);
    await until(() => carriedOut(log.tables.proposals.get(card.id)) !== undefined);
    await flow.idle();
    const importer = log.tables.projects.all().find((p) => p.meta?.['proposalId'] === card.id)!;
    expect(carriedOut(log.tables.proposals.get(card.id))).toMatchObject({ ok: true });
    expect(log.tables.deliverables.get(notes.id)?.projectId).toBe(importer.id);

    const api = (
      await commands.createTask({ description: 'The public API', projectId: project.id })
    ).value;
    const spec = (
      await commands.addDeliverable(
        {
          taskId: api.id,
          kind: 'file',
          title: 'OpenAPI spec',
          source: 'agent',
          location: { storage: 'in_place', path: '/w/app/openapi.yaml' },
        },
        steward,
      )
    ).value;
    const wkCard = (
      await commands.createProposal({
        requestText: 'Promote the API to a sub-project',
        kind: 'moon',
        proposedBody: { kind: 'moon', name: 'API', bodyId: 'b-phobos', parentId: 'b-mars' },
        workspace: '/w/app',
        rationale: 'it grew',
        meta: {
          promotion: { taskId: api.id, fromProjectId: project.id, requestedBy: waykeeper.id },
        },
      })
    ).value;
    await flow.idle();
    await commands.decideProposal(wkCard.id, { decision: 'approve' }, USER);
    await until(() => carriedOut(log.tables.proposals.get(wkCard.id)) !== undefined);
    await flow.idle();
    flow.stop();
    const apiProject = log.tables.projects.all().find((p) => p.meta?.['proposalId'] === wkCard.id)!;
    expect(carriedOut(log.tables.proposals.get(wkCard.id))).toMatchObject({ ok: true });
    expect(apiProject.parentProjectId).toBe(project.id);
    expect(log.tables.tasks.get(api.id)?.projectId).toBe(apiProject.id);
    expect(log.tables.deliverables.get(spec.id)).toMatchObject({
      projectId: apiProject.id,
      taskId: api.id,
    });

    // Every deliverable and run event was really logged.
    const types = new Set(recorded.map((e) => e.event.type));
    for (const t of [
      'deliverable.added',
      'deliverable.updated',
      'deliverable.removed',
      'deliverable.restored',
      'deliverable.opened',
      'run.started',
      'run.ports',
      'run.ended',
    ] as const) {
      expect(types, t).toContain(t);
    }

    // Replay: from the starting snapshot, fold the log; at each checkpoint compare.
    let world = applySnapshot(start);
    let next = 0;
    for (const checkpoint of checkpoints) {
      while (next < recorded.length && recorded[next]!.seq <= checkpoint.seq) {
        world = applyEvent(world, recorded[next++]!);
      }
      expect(world.seq).toBe(checkpoint.seq);
      expect(tables(world), `at seq ${checkpoint.seq}`).toEqual(tables(applySnapshot(checkpoint)));
    }
    expect(tables(world)).toEqual(tables(applySnapshot({ ...log.snapshot(), statuses: [] })));
    expect(Object.keys(world.deliverables)).toHaveLength(7);
    expect(world.deliverables[dev.id]?.lastRun).toMatchObject({
      runId: r3.id,
      state: 'running',
      ports: [5173, 24678],
    });
  });
});
