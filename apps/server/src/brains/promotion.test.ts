import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Proposal } from '@galactic/protocol';
import { carriedOut } from '../domain/promotion.js';
import { tickingClock } from '../test/world.js';
import { harmonizerBrain } from './harmonizer/index.js';
import { PromotionFlow, promotionActor } from './promotion.js';
import { brainHarness, type BrainHarness, type BrainScript } from './testing/index.js';
import { waykeeperDefinition } from './waykeeper/index.js';

/**
 * Promotion and moves (P2-12) through the brain harness: the Harmonizer and Waykeepers are
 * scripted, their tools, the runtime, the commands and the promotion flow run for real.
 * Acceptance: an asteroid task promoted to a moon while its Steward is mid-task; a task moved
 * into an existing project; the old body freed after the retention period.
 */

const USER = { type: 'user' } as const;
const DAY = 24 * 60 * 60 * 1000;
const lives: BrainHarness[] = [];
const flows: PromotionFlow[] = [];
afterEach(async () => {
  for (const f of flows.splice(0)) f.stop();
  for (const h of lives.splice(0)) await h.dispose().catch(() => {});
});

const carriedLine = /promotion (\S+) was carried out/;
/** Any other wake-up (a Steward paused by the card, resumed, finished) needs no action here. */
const rest = (s: BrainScript) =>
  s.on(
    () => true,
    () => {},
    'anything else',
  );

function setup() {
  const clock = tickingClock();
  // `long` takes about a second at speed 1: the Steward is still mid-task when the card comes.
  const h = brainHarness({ adapter: { speed: 1 }, compose: { log: { now: clock } } });
  lives.push(h);
  const waykeepers: Id[] = [];
  const startWaykeeper = async (input: {
    projectId: Id;
    supervisorId: Id;
    runtime: 'fake' | 'claude-sdk' | 'acp' | 'pty';
  }) => {
    const wk = await h.startBrain(waykeeperDefinition(), input);
    waykeepers.push(wk.agentId);
    return { agentId: wk.agentId };
  };
  const definition = harmonizerBrain({ projectsRoot: '/w', startWaykeeper });
  const flow = new PromotionFlow({
    log: h.log,
    commands: h.commands,
    liveAgents: () => h.runtime.liveAgents(),
    startWaykeeper,
    onError: (e, ctx) => h.errors.push(`${ctx}: ${(e as Error).message}`),
  }).start();
  flows.push(flow);
  const state = (agentId: Id) => h.statuses.get(agentId)?.state;
  const card = (): Proposal => h.log.tables.proposals.all()[0]!;
  const types = () => h.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
  return { h, clock, flow, definition, waykeepers, state, card, types };
}

describe('promotion (P2-12)', () => {
  it('promotes an asteroid task to a moon while its Steward is mid-task; the asteroid is freed after retention', async () => {
    const { h, clock, flow, definition, waykeepers, state, card, types } = setup();
    // The new project's Waykeeper learns what it took over.
    h.script('waykeeper').once(carriedLine, (t) => t.say('I run the moved task now'));
    rest(h.script('waykeeper'));
    const task = (
      await h.commands.createTask({
        description: 'Grow the import script',
        meta: { workspace: '/w/scratch/import' },
      })
    ).value;
    const asteroid = task.bodyId;
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        rest(
          s
            .once('it has grown', (t) =>
              t.call('propose_promotion', {
                taskId: task.id,
                toKind: 'moon',
                name: 'Importer',
                rationale: 'the script became a tool',
              }),
            )
            .once(carriedLine, (t) => t.say('Importer now lives on its own moon')),
        ),
    });
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: hq.agentId,
        cwd: '/w/scratch/import',
        prompt: 'scenario:long',
      })
    ).value;
    await h.until(() => state(steward.id) === 'working', { what: 'the Steward to work' });

    // The card is made: the Steward is paused while the user decides (SPEC §3.4).
    hq.tell('the import script: it has grown');
    await h.until(() => h.log.tables.proposals.all().length === 1);
    await flow.idle();
    await h.until(() => state(steward.id) === 'paused', { what: 'the Steward to be paused' });
    expect(h.log.tables.tasks.get(task.id)?.projectId).toBeUndefined();

    // Approved: project, Waykeeper, move, hand-over, resume — then the owner is told.
    await h.commands.decideProposal(card().id, { decision: 'approve' }, USER);
    await h.until(() => carriedOut(card()) !== undefined, { what: 'the card to be carried out' });
    await flow.idle();
    const outcome = carriedOut(card())!;
    const project = h.log.tables.projects.all().find((p) => p.meta?.['proposalId'] === card().id)!;
    const moon = h.log.tables.bodies.get(project.bodyId)!;
    expect(moon.kind).toBe('moon');
    expect(project).toMatchObject({
      name: 'Importer',
      workspace: '/w/scratch/import',
      meta: { promotedFrom: { kind: 'task', taskId: task.id, bodyId: asteroid } },
    });
    expect(project.parentProjectId).toBeUndefined(); // the Harmonizer's moon: independent
    expect(waykeepers).toHaveLength(1);
    expect(h.log.tables.agents.get(waykeepers[0]!)).toMatchObject({
      role: 'waykeeper',
      projectId: project.id,
      supervisorId: hq.agentId,
      bodyId: moon.id,
    });
    expect(h.log.tables.tasks.get(task.id)).toMatchObject({
      projectId: project.id,
      bodyId: moon.id,
    });
    // The Steward flew to the moon and answers to the new Waykeeper (decision 32).
    expect(h.log.tables.agents.get(steward.id)).toMatchObject({
      projectId: project.id,
      supervisorId: waykeepers[0],
      bodyId: moon.id,
    });
    expect(outcome).toEqual({
      ok: true,
      target: { kind: 'task', id: task.id },
      fromBodyId: asteroid,
      toBodyId: moon.id,
      projectId: project.id,
      waykeeperId: waykeepers[0],
      stewardIds: [steward.id],
    });
    // The satellite flight and the old body's marker (decision 15).
    expect(types()).toContainEqual({
      type: 'body.moved',
      host: { kind: 'task', id: task.id },
      fromBodyId: asteroid,
      toBodyId: moon.id,
      intoProjectId: project.id,
    });
    expect(h.log.tables.bodies.get(asteroid)?.movedTo?.bodyId).toBe(moon.id);
    // Resumed by the card, the Steward finishes its work under its new supervisor.
    expect(
      types().filter(
        (e) => e.type === 'control.resume' && e.by.id === promotionActor(card().id).id,
      ),
    ).toHaveLength(1);
    await h.until(() => state(steward.id) === 'finished', {
      what: 'the Steward to finish',
      timeoutMs: 5000,
    });

    // Idempotent: carrying the card out again changes nothing.
    const seq = h.log.currentSeq();
    expect(await flow.carryOut(card().id)).toEqual(outcome);
    expect(h.log.currentSeq()).toBe(seq);

    // The asteroid keeps its marker for the retention period, then is freed.
    expect((await h.commands.sweepMarkers(7 * DAY)).value).toEqual([]);
    clock.advance(8 * DAY);
    const swept = (await h.commands.sweepMarkers(7 * DAY)).value;
    expect(swept.map((b) => b.id)).toEqual([asteroid]);
    expect(h.log.tables.bodies.get(asteroid)?.movedTo).toBeUndefined();

    await h.done({ timeoutMs: 5000 });
    expect(hq.prompts().join('\n')).toMatch(carriedLine);
  });

  it('moves a standalone task into an existing project: its Waykeeper takes the Steward over', async () => {
    const { h, flow, definition, waykeepers, state, card, types } = setup();
    const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const task = (
      await h.commands.createTask({ description: 'CSV quoting bug', meta: { workspace: '/w/csv' } })
    ).value;
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        rest(
          s
            .once('belongs to CSV', (t) =>
              t.call('propose_promotion', {
                taskId: task.id,
                toProjectId: project.id,
                rationale: 'it is CSV work',
              }),
            )
            .once(carriedLine, (t) => t.say('moved into CSV')),
        ),
    });
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      { script: (s) => rest(s.once(carriedLine, (t) => t.say('the task is mine now'))) },
    );
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: hq.agentId,
        cwd: '/w/csv',
        prompt: 'scenario:long',
      })
    ).value;
    await h.until(() => state(steward.id) === 'working');

    hq.tell('the quoting bug belongs to CSV');
    await h.until(() => h.log.tables.proposals.all().length === 1);
    await flow.idle();
    await h.until(() => state(steward.id) === 'paused');
    await h.commands.decideProposal(card().id, { decision: 'approve' }, USER);
    await h.until(() => carriedOut(card()) !== undefined);
    await flow.idle();

    expect(waykeepers).toEqual([]); // the project's running Waykeeper took it
    expect(h.log.tables.tasks.get(task.id)).toMatchObject({
      projectId: project.id,
      bodyId: project.bodyId,
    });
    expect(h.log.tables.agents.get(steward.id)).toMatchObject({
      projectId: project.id,
      supervisorId: wk.agentId,
      bodyId: project.bodyId,
    });
    expect(h.log.tables.bodies.get(task.bodyId)?.movedTo).toMatchObject({
      bodyId: project.bodyId,
      host: { kind: 'task', id: task.id },
    });
    expect(h.log.tables.projects.all()).toHaveLength(1);
    // Hand-over in the same commit as the move (decision 32 at every commit).
    const moved = h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .find((e) => e.event.type === 'body.moved')!;
    const handedOver = h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .find(
        (e) =>
          e.event.type === 'agent.updated' &&
          e.event.agentId === steward.id &&
          e.event.changes.supervisorId === wk.agentId,
      )!;
    expect(handedOver.seq).toBeGreaterThan(moved.seq);
    expect(handedOver.at).toBe(moved.at);
    expect(types().some((e) => e.type === 'promotion.carried_out')).toBe(true);
    await h.until(() => state(steward.id) === 'finished', { timeoutMs: 5000 });
    await h.done({ timeoutMs: 5000 });
    expect(wk.prompts().join('\n')).toMatch(carriedLine);
  });

  it("promotes a Waykeeper's task to a sub-project moon under that Waykeeper", async () => {
    const { h, flow, waykeepers, state, card } = setup();
    h.script({ role: 'waykeeper' }).on(
      () => true,
      () => {},
    );
    const project = (
      await h.commands.createProject({ name: 'App', workspace: '/w/app', bodyId: 'b-saturn' })
    ).value;
    const auth = (await h.commands.createTask({ projectId: project.id, description: 'auth' }))
      .value;
    const hq = await h.startHarmonizer();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          rest(
            s
              .once('auth is big', (t) =>
                t.call('request_promotion', { taskId: auth.id, to: 'moon', reason: 'it grew' }),
              )
              .once(carriedLine, (t) => t.say('auth is a sub-project now')),
          ),
      },
    );
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: auth.id,
        supervisorId: wk.agentId,
        prompt: 'scenario:long',
      })
    ).value;
    await h.until(() => state(steward.id) === 'working');
    wk.tell('auth is big');
    await h.until(() => h.log.tables.proposals.all().length === 1);
    await flow.idle();
    await h.until(() => state(steward.id) === 'paused');
    await h.commands.decideProposal(card().id, { decision: 'approve' }, USER);
    await h.until(() => carriedOut(card()) !== undefined);
    await flow.idle();

    const sub = h.log.tables.projects.all().find((p) => p.meta?.['proposalId'] === card().id)!;
    expect(sub).toMatchObject({
      parentProjectId: project.id,
      workspace: '/w/app',
      meta: { promotedFrom: { kind: 'task', taskId: auth.id, projectId: project.id } },
    });
    expect(h.log.tables.bodies.get(sub.bodyId)).toMatchObject({
      kind: 'moon',
      parentId: 'b-saturn',
    });
    // The sub-project's Waykeeper answers to the Waykeeper that asked (SPEC §3.2).
    expect(h.log.tables.agents.get(waykeepers[0]!)).toMatchObject({
      projectId: sub.id,
      supervisorId: wk.agentId,
    });
    expect(h.log.tables.tasks.get(auth.id)).toMatchObject({
      projectId: sub.id,
      bodyId: sub.bodyId,
    });
    expect(h.log.tables.agents.get(steward.id)).toMatchObject({
      projectId: sub.id,
      supervisorId: waykeepers[0],
      bodyId: sub.bodyId,
    });
    // The planet keeps hosting its project: no marker for a project task.
    expect(h.log.tables.bodies.get('b-saturn')).toMatchObject({
      host: { kind: 'project', id: project.id },
    });
    expect(h.log.tables.bodies.get('b-saturn')?.movedTo).toBeUndefined();
    await h.until(() => state(steward.id) === 'finished', { timeoutMs: 5000 });
    await h.done({ timeoutMs: 5000 });
    expect(hq.prompts().join('\n')).not.toMatch(carriedLine);
  });

  it('resumes the paused Steward where it is when the card is rejected', async () => {
    const { h, flow, definition, state, card } = setup();
    const task = (
      await h.commands.createTask({ description: 'x', meta: { workspace: '/w/scratch/x' } })
    ).value;
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        rest(
          s.once('grew', (t) =>
            t.call('propose_promotion', { taskId: task.id, toKind: 'planet', rationale: 'r' }),
          ),
        ),
    });
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: hq.agentId,
        cwd: '/w/scratch/x',
        prompt: 'scenario:long',
      })
    ).value;
    await h.until(() => state(steward.id) === 'working');
    hq.tell('it grew');
    await h.until(() => h.log.tables.proposals.all().length === 1);
    await flow.idle();
    await h.until(() => state(steward.id) === 'paused');
    await h.commands.decideProposal(card().id, { decision: 'reject', reason: 'no' }, USER);
    await flow.idle();
    await h.until(() => state(steward.id) === 'finished', { timeoutMs: 5000 });
    expect(h.log.tables.tasks.get(task.id)?.projectId).toBeUndefined();
    expect(h.log.tables.agents.get(steward.id)?.supervisorId).toBe(hq.agentId);
    expect(carriedOut(card())).toBeUndefined();
    await h.done({ timeoutMs: 5000 });
  });

  it('records a failure, resumes nothing it did not pause, and carries out a card left unrecorded after a restart', async () => {
    const { h, flow, card } = setup();
    const hq = await h.startHarmonizer();
    const archived = (await h.commands.createProject({ name: 'Old', workspace: '/w/old' })).value;
    await h.commands.closeProject(archived.id, USER);
    await h.commands.archiveProject(archived.id, USER);
    const task = (await h.commands.createTask({ description: 'x' })).value;
    const request = (toProjectId: Id) => ({
      requestText: 'move it',
      kind: 'planet' as const,
      proposedBody: { kind: 'planet' as const, name: 'Old' },
      workspace: '/w/old',
      rationale: 'r',
      meta: {
        request: {
          type: 'promotion',
          name: 'x',
          target: { kind: 'task', id: task.id },
          fromBodyId: task.bodyId,
          toProjectId,
        },
      },
    });
    const failing = (await h.commands.createProposal(request(archived.id))).value;
    await h.commands.decideProposal(failing.id, { decision: 'approve' }, USER);
    await h.until(() => carriedOut(card()) !== undefined);
    expect(carriedOut(card())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/archived/),
    });
    expect(h.log.tables.tasks.get(task.id)?.projectId).toBeUndefined();

    // A card approved while no flow listened (a crash between approval and the move).
    flow.stop();
    const live = (await h.commands.createProject({ name: 'Live', workspace: '/w/live' })).value;
    const pending = (await h.commands.createProposal(request(live.id))).value;
    await h.commands.decideProposal(pending.id, { decision: 'approve' }, USER);
    expect(carriedOut(h.log.tables.proposals.get(pending.id))).toBeUndefined();
    const next = new PromotionFlow({
      log: h.log,
      commands: h.commands,
      liveAgents: () => h.runtime.liveAgents(),
      startWaykeeper: async ({ projectId, supervisorId, runtime }) => ({
        agentId: (await h.startBrain(waykeeperDefinition(), { runtime, projectId, supervisorId }))
          .agentId,
      }),
    }).start();
    await h.until(() => carriedOut(h.log.tables.proposals.get(pending.id)) !== undefined);
    await next.idle();
    expect(carriedOut(h.log.tables.proposals.get(pending.id))).toMatchObject({
      ok: true,
      projectId: live.id,
    });
    expect(h.log.tables.tasks.get(task.id)?.projectId).toBe(live.id);
    // The project had no running Waykeeper: one was started under the Harmonizer.
    expect(
      h.log.tables.agents.all().find((a) => a.role === 'waykeeper' && a.projectId === live.id),
    ).toMatchObject({ supervisorId: hq.agentId });
    next.stop();
  });

  it('waits for a running Harmonizer instead of failing, then carries the card out (review)', async () => {
    const { h, flow, card, waykeepers } = setup();
    const task = (
      await h.commands.createTask({ description: 'grow', meta: { workspace: '/w/scratch/g' } })
    ).value;
    const { value: p } = await h.commands.createProposal(planetPromotion(task));
    await h.commands.decideProposal(p.id, { decision: 'approve' }, USER);
    await flow.idle();
    // No Harmonizer runs yet (the server starts it after the flow, or it is restarting).
    expect(carriedOut(card())).toBeUndefined();
    expect(flow.waitingCards()).toEqual([
      { proposalId: p.id, reason: expect.stringMatching(/no running Harmonizer/) },
    ]);
    // The approval took the body: the project holds it while the card waits.
    const project = h.log.tables.projects.all().find((x) => x.meta?.['proposalId'] === p.id)!;
    expect(h.log.tables.bodies.get(project.bodyId)!.host).toEqual({
      kind: 'project',
      id: project.id,
    });
    const hq = await h.startHarmonizer();
    await h.until(() => carriedOut(card()) !== undefined, { what: 'the card to be carried out' });
    await flow.idle();
    expect(carriedOut(card())).toMatchObject({ ok: true, projectId: project.id });
    expect(flow.waitingCards()).toEqual([]);
    expect(h.log.tables.tasks.get(task.id)?.projectId).toBe(project.id);
    expect(h.log.tables.agents.get(waykeepers[0]!)).toMatchObject({ supervisorId: hq.agentId });
  });

  it('adopts a Waykeeper someone else started meanwhile instead of failing (review)', async () => {
    const { h, card, flow: theirs } = setup();
    theirs.stop();
    const hq = await h.startHarmonizer();
    let started: Id | undefined;
    const flow = new PromotionFlow({
      log: h.log,
      commands: h.commands,
      liveAgents: () => h.runtime.liveAgents(),
      // The Harmonizer's own spawn_waykeeper won the race: this spawn is refused.
      startWaykeeper: async (input) => {
        started = (await h.startBrain(waykeeperDefinition(), input)).agentId;
        throw new Error(`project ${input.projectId} already has a running Waykeeper`);
      },
    }).start();
    flows.push(flow);
    const task = (
      await h.commands.createTask({ description: 'grow', meta: { workspace: '/w/scratch/g' } })
    ).value;
    // An earlier Steward of the task that ended: it is not "handed over and resumed".
    const old = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: hq.agentId,
        cwd: '/w/scratch/g',
        prompt: 'scenario:long',
      })
    ).value;
    await h.commands.stopAgent(old.id, USER);
    const { value: p } = await h.commands.createProposal(planetPromotion(task));
    await h.commands.decideProposal(p.id, { decision: 'approve' }, USER);
    await h.until(() => carriedOut(card()) !== undefined);
    await flow.idle();
    expect(carriedOut(card())).toMatchObject({ ok: true, waykeeperId: started });
    expect(carriedOut(card())).not.toHaveProperty('stewardIds');
  });

  it('a final failure frees the body of the empty project it made (review)', async () => {
    const { h, flow, card } = setup();
    await h.startHarmonizer();
    const task = (
      await h.commands.createTask({ description: 'grow', meta: { workspace: '/w/scratch/g' } })
    ).value;
    const { value: p } = await h.commands.createProposal(planetPromotion(task));
    // The task is finished before the user approves: nothing can move.
    await h.commands.closeTask(task.id, USER);
    await h.commands.decideProposal(p.id, { decision: 'approve' }, USER);
    await h.until(() => carriedOut(card()) !== undefined);
    await flow.idle();
    expect(carriedOut(card())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/completed/),
    });
    const project = h.log.tables.projects.all().find((x) => x.meta?.['proposalId'] === p.id)!;
    expect(project.state).toBe('failed');
    expect(h.log.tables.bodies.get(project.bodyId)!.host).toBeUndefined();
    expect(h.log.tables.agents.all().filter((a) => a.role === 'waykeeper')).toEqual([]);
  });

  it('pauses the Stewards of a card still waiting for the user again after a restart (review)', async () => {
    const { h, flow, card, state } = setup();
    const hq = await h.startHarmonizer();
    const task = (
      await h.commands.createTask({ description: 'grow', meta: { workspace: '/w/scratch/g' } })
    ).value;
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: hq.agentId,
        cwd: '/w/scratch/g',
        prompt: 'scenario:long',
      })
    ).value;
    await h.until(() => state(steward.id) === 'working');
    const { value: p } = await h.commands.createProposal(planetPromotion(task));
    await flow.idle();
    await h.until(() => state(steward.id) === 'paused');
    // A restart: the flow goes away, and the runtime's pause with it (the Steward runs again,
    // the log still says the card paused it).
    flow.stop();
    await h.runtime.resumeAgent(steward.id, { type: 'system' });
    h.log.runCommand((ctx) =>
      ctx.emit({
        type: 'control.pause',
        target: { kind: 'agent', id: steward.id },
        by: promotionActor(p.id),
      }),
    );
    await h.until(() => state(steward.id) === 'working');
    const next = new PromotionFlow({
      log: h.log,
      commands: h.commands,
      liveAgents: () => h.runtime.liveAgents(),
      startWaykeeper: async () => ({ agentId: 'unused' }),
    }).start();
    flows.push(next);
    await next.idle();
    await h.until(() => state(steward.id) === 'paused', { what: 'the Steward paused again' });
    expect(card().state).toBe('pending');
  });
});

function planetPromotion(task: { id: Id; bodyId: Id }) {
  return {
    requestText: 'promote',
    kind: 'planet' as const,
    proposedBody: { kind: 'planet' as const, name: 'G' },
    workspace: '/w/scratch/g',
    rationale: 'x',
    meta: {
      request: {
        type: 'promotion',
        name: 'G',
        target: { kind: 'task', id: task.id },
        fromBodyId: task.bodyId,
      },
    },
  };
}
