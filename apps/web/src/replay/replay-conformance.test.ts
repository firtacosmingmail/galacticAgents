// @vitest-environment node
//
// P4-07 — the timeline scrubber's replay vs the server's tables. The route
// (`GET /api/history/events`, here its `HistoryEvents` read) returns one project's events; the
// replay folds them from a free solar system with the page's reducer. At every commit of a real
// run, the replayed world must hold exactly the server's rows for that project's entities (and
// nothing of the other projects); at the end the replayed agent states are the status store's.
// Scrubbing to before / after a move and a completion changes the body assignment and the landing.
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, Body, EventEnvelope, Id, Snapshot } from '@galactic/protocol';
import {
  FakeAdapter,
  HistoryEvents,
  composeRuntime,
  openDatabase,
  seedDemoProject,
  type ComposedRuntime,
} from '@galactic/server';
import { applySnapshot, type WorldState } from '../state/reduce.js';
import { SCENE_SATELLITES, satelliteList } from '../scene/satellites/satellite-model.js';
import { createReplayTimeline, replayBase } from './replay-model.js';

const USER: Actor = { type: 'user' };

function tickingClock(): () => string {
  let t = Date.parse('2026-10-04T09:00:00.000Z');
  return () => new Date((t += 1000)).toISOString();
}

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Members {
  projects: Set<Id>;
  tasks: Set<Id>;
  agents: Set<Id>;
  questions: Set<Id>;
}

/** The project's entities by the final tables (as the route decides them). */
function membersOf(world: WorldState, projectId: Id): Members {
  const projects = new Set([projectId]);
  for (const p of Object.values(world.projects))
    if (p.parentProjectId === projectId) projects.add(p.id);
  const tasks = new Set(
    Object.values(world.tasks)
      .filter((t) => t.projectId && projects.has(t.projectId))
      .map((t) => t.id),
  );
  const agents = new Set(
    Object.values(world.agents)
      .filter(
        (a) => (a.projectId && projects.has(a.projectId)) || (a.taskId && tasks.has(a.taskId)),
      )
      .map((a) => a.id),
  );
  const questions = new Set(
    Object.values(world.questions)
      .filter((q) => agents.has(q.originAgentId))
      .map((q) => q.id),
  );
  return { projects, tasks, agents, questions };
}

const pick = <T>(map: Record<Id, T>, ids: Set<Id>) =>
  Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)));

/** A body as the replay should show it: the server's row when it concerns the project, else free. */
function expectedBody(body: Body, m: Members): Body {
  const ours = (id: Id) => m.projects.has(id) || m.tasks.has(id);
  const { host, movedTo, ...free } = body;
  return {
    ...free,
    ...(host && ours(host.id) ? { host } : {}),
    ...(movedTo && ours(movedTo.host.id) ? { movedTo } : {}),
  };
}

function compare(replayed: WorldState, server: WorldState, m: Members, at: string) {
  expect(replayed.projects, at).toEqual(pick(server.projects, m.projects));
  expect(pick(replayed.tasks, m.tasks), at).toEqual(pick(server.tasks, m.tasks));
  expect(pick(replayed.agents, m.agents), at).toEqual(pick(server.agents, m.agents));
  expect(pick(replayed.questions, m.questions), at).toEqual(pick(server.questions, m.questions));
  // Nothing of the other projects' work is in the replay.
  for (const id of Object.keys(replayed.tasks)) expect(m.tasks.has(id), at).toBe(true);
  for (const id of Object.keys(replayed.agents)) expect(m.agents.has(id), at).toBe(true);
  for (const [id, body] of Object.entries(server.bodies)) {
    const want = expectedBody(body, m);
    if (want.host || want.movedTo) expect(replayed.bodies[id], `${at} ${id}`).toEqual(want);
    else if (replayed.bodies[id]) expect(replayed.bodies[id], `${at} ${id}`).toEqual(want);
  }
}

async function run() {
  const composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 5 })],
    log: { now: tickingClock() },
    flushMs: 10,
    caps: { maxConcurrentAgents: 8 },
  });
  lives.push(composed);
  const { log, commands, statuses } = composed;
  const start: Snapshot = { ...log.snapshot(), statuses: [] };
  const checkpoints: Snapshot[] = [];
  log.subscribe((env) => {
    if (log.currentSeq() === env.seq) checkpoints.push({ ...log.snapshot(), statuses: [] });
  });

  const alpha = (
    await commands.createProject({ name: 'Alpha', workspace: '/w/a', bodyId: 'b-mars' })
  ).value;
  const beta = (
    await commands.createProject({ name: 'Beta', workspace: '/w/b', bodyId: 'b-venus' })
  ).value;
  const sub = (
    await commands.createProject({
      name: 'Alpha writer',
      workspace: '/w/a/writer',
      bodyId: 'b-phobos',
      parentProjectId: alpha.id,
    })
  ).value;
  await commands.setProjectState(alpha.id, 'in_progress');
  const parse = (await commands.createTask({ description: 'Parse', projectId: alpha.id })).value;
  const write = (await commands.createTask({ description: 'Write', projectId: sub.id })).value;
  const other = (await commands.createTask({ description: 'Other', projectId: beta.id })).value;
  const loose = (await commands.createTask({ description: 'Loose end' })).value;

  const harmonizer = (
    await commands.spawnAgent({ role: 'harmonizer', runtime: 'fake', cwd: '/w/hq', prompt: 'x' })
  ).value;
  const waykeeper = (
    await commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      projectId: alpha.id,
      supervisorId: harmonizer.id,
      prompt: 'scenario:long',
    })
  ).value;
  const steward = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: parse.id,
      supervisorId: waykeeper.id,
      prompt: 'scenario:asks',
    })
  ).value;
  const looseSteward = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: loose.id,
      supervisorId: harmonizer.id,
      cwd: '/w/scratch',
      prompt: 'scenario:long',
    })
  ).value;
  const betaKeeper = (
    await commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      projectId: beta.id,
      supervisorId: harmonizer.id,
      prompt: 'scenario:long',
    })
  ).value;
  const otherSteward = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: other.id,
      supervisorId: betaKeeper.id,
      prompt: 'scenario:long',
    })
  ).value;
  await until(() => log.tables.questions.all().some((q) => q.originAgentId === steward.id));
  const asked = log.tables.questions.all().find((q) => q.originAgentId === steward.id)!;
  await commands.answerQuestion({ questionId: asked.id, answer: 'RFC 4180', by: USER, version: 0 });
  // The standalone task joins the project: its Steward flies, its asteroid shows "moved to …".
  await commands.moveTask(loose.id, alpha.id, USER);
  await until(() => statuses.get(steward.id)?.state === 'finished');
  await commands.closeTask(parse.id, { type: 'agent', id: waykeeper.id });
  // The asteroid's marker is freed early and another task takes the asteroid.
  await commands.freeBody(loose.bodyId);
  await commands.createTask({ description: 'Squatter', bodyId: loose.bodyId });
  await commands.closeTask(write.id, USER);
  for (const a of [looseSteward, otherSteward, betaKeeper, waykeeper])
    await commands.stopAgent(a.id, USER);
  await until(() =>
    [looseSteward, otherSteward, betaKeeper, waykeeper].every((a) =>
      ['stopped', 'finished'].includes(statuses.get(a.id)?.state ?? ''),
    ),
  );

  // The route's read, page by page.
  const reader = new HistoryEvents(log.db);
  const events: EventEnvelope[] = [];
  let after = 0;
  for (;;) {
    const page = reader.read({ projectId: alpha.id, after, limit: 25 });
    events.push(...page.events);
    after = page.seq;
    if (!page.hasMore) break;
  }
  const timeline = createReplayTimeline(replayBase(applySnapshot(start).bodies), events);
  return {
    composed,
    checkpoints,
    events,
    timeline,
    ids: { alpha, beta, parse, loose, steward, looseSteward, otherSteward },
  };
}

describe('timeline replay vs the server', () => {
  it("replays the project's rows at every commit, and nothing else", async () => {
    const { composed, checkpoints, events, timeline, ids } = await run();
    const final = applySnapshot({ ...composed.log.snapshot(), statuses: [] });
    const m = membersOf(final, ids.alpha.id);
    expect(m.tasks.has(ids.loose.id)).toBe(true);
    expect(m.agents.has(ids.otherSteward.id)).toBe(false);
    expect(checkpoints.length).toBeGreaterThan(20);
    for (const checkpoint of checkpoints) {
      const n = events.filter((e) => e.seq <= checkpoint.seq).length;
      compare(timeline.worldAt(n), applySnapshot(checkpoint), m, `at seq ${checkpoint.seq}`);
    }
    // At the end: the live world's rows for the project, and the status store's agent states.
    const end = timeline.worldAt(events.length);
    compare(end, final, m, 'at the end');
    for (const id of m.agents) {
      expect(end.statuses[id]?.state, id).toBe(composed.statuses.get(id)?.state);
    }
  });

  it('scrubbing before / after a move and a completion changes the assignment and the landing', async () => {
    const { events, timeline, ids } = await run();
    const asteroid = ids.loose.bodyId;
    const at = (e: EventEnvelope) => Date.parse(e.at);

    // The move: before it the task hosts its asteroid and its Steward orbits there; after it the
    // asteroid says "moved to Mars" and the satellite's body is Mars.
    const move = events.find((e) => e.event.type === 'body.moved')!;
    const before = timeline.worldAt(timeline.countAt(at(move) - 1));
    const after = timeline.worldAt(timeline.countAt(at(move)));
    expect(before.bodies[asteroid]?.host).toEqual({ kind: 'task', id: ids.loose.id });
    expect(before.bodies[asteroid]?.movedTo).toBeUndefined();
    expect(before.tasks[ids.loose.id]?.projectId).toBeUndefined();
    const orbit = (w: WorldState, agentId: Id) =>
      satelliteList(w, SCENE_SATELLITES).find((s) => s.agentId === agentId);
    expect(orbit(before, ids.looseSteward.id)?.bodyId).toBe(asteroid);
    expect(after.bodies[asteroid]?.host).toBeUndefined();
    expect(after.bodies[asteroid]?.movedTo).toMatchObject({ bodyId: 'b-mars' });
    expect(after.tasks[ids.loose.id]?.projectId).toBe(ids.alpha.id);
    expect(orbit(after, ids.looseSteward.id)?.bodyId).toBe('b-mars');

    // The Steward of "Parse" orbits Mars while it works, and waits (amber) on its question.
    const asked = events.find((e) => e.event.type === 'agent.needs_input')!;
    expect(orbit(timeline.worldAt(timeline.countAt(at(asked))), ids.steward.id)).toMatchObject({
      bodyId: 'b-mars',
      state: 'waiting_for_input',
      landed: false,
    });
    // The completion: before it the finished Steward has no satellite (as live: an ended agent
    // has none); once its task is completed it lands on Mars.
    const done = events.find(
      (e) =>
        e.event.type === 'task.state_changed' &&
        e.event.taskId === ids.parse.id &&
        e.event.to === 'completed',
    )!;
    const open = timeline.worldAt(timeline.countAt(at(done) - 1));
    const closed = timeline.worldAt(timeline.countAt(at(done)));
    expect(open.tasks[ids.parse.id]?.state).not.toBe('completed');
    expect(open.statuses[ids.steward.id]?.state).toBe('finished');
    expect(orbit(open, ids.steward.id)).toBeUndefined();
    expect(closed.tasks[ids.parse.id]?.state).toBe('completed');
    expect(orbit(closed, ids.steward.id)).toMatchObject({ landed: true, bodyId: 'b-mars' });

    // Scrubbing back again gives the same worlds (checkpoints, not a one-way fold).
    expect(timeline.worldAt(timeline.countAt(at(move) - 1))).toEqual(before);
    // Before anything: the free system, no satellites.
    const empty = timeline.worldAt(0);
    expect(Object.keys(empty.projects)).toHaveLength(0);
    expect(satelliteList(empty, SCENE_SATELLITES)).toHaveLength(0);
  });
});

describe('timeline replay of a demo project (P7-07)', () => {
  it('shows the demo planet while the project lived, and not after it retired', async () => {
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter({ speed: 1 })],
      log: { now: tickingClock() },
      flushMs: 10,
    });
    lives.push(composed);
    const { log, commands } = composed;
    const demo = log.runCommand((ctx) => seedDemoProject(ctx)).value;
    await commands.closeProject(demo.id, USER);
    await commands.archiveProject(demo.id, USER);

    // The live world no longer has the planet; the replay starts from it, as the page does.
    const live = applySnapshot({ ...log.snapshot(), statuses: [] });
    expect(live.bodies[demo.bodyId]).toBeUndefined();
    const page = new HistoryEvents(log.db).read({ projectId: demo.id, after: 0, limit: 100 });
    expect(page.events.map((e) => e.event.type)).toEqual([
      'body.created',
      'project.created',
      'body.assigned',
      'project.state_changed',
      'project.state_changed',
      'body.freed',
      'body.retired',
    ]);
    const timeline = createReplayTimeline(replayBase(live.bodies), page.events);
    const during = timeline.worldAt(3);
    expect(during.bodies[demo.bodyId]?.host).toEqual({ kind: 'project', id: demo.id });
    const end = timeline.worldAt(page.events.length);
    expect(end.bodies[demo.bodyId]).toBeUndefined();
    expect(end.projects[demo.id]?.state).toBe('archived');
  });
});
