import { describe, expect, it } from 'vitest';
import type { Agent, AgentState, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld, type WorldState } from '../../state/reduce.js';
import {
  hasLanded,
  isLive,
  isSuperseded,
  isWorkOver,
  LANDED_PER_BODY,
  SCENE_SATELLITES,
  sameSatellites,
  satelliteList,
  showsSatellite,
  workBody,
} from './satellite-model.js';

const waykeeper: Agent = {
  ...fx.agent,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  supervisorId: fx.harmonizer.id,
  projectId: fx.project.id,
  bodyId: fx.project.bodyId,
};
const { taskId: _t, ...noTask } = waykeeper;
const steward: Agent = { ...fx.agent, id: 'a-steward-1', taskId: fx.task.id, bodyId: 'b-luna' };
const asteroidSteward: Agent = {
  ...fx.agent,
  id: 'a-steward-2',
  taskId: fx.asteroidTask.id,
  bodyId: fx.asteroidTask.bodyId,
};

const status = (agentId: string, state: AgentState = 'working'): StatusRecord => ({
  ...fx.status,
  agentId,
  state,
});

function world(states: Record<string, AgentState | undefined>): WorldState {
  const w = emptyWorld();
  w.agents = {
    [fx.harmonizer.id]: fx.harmonizer,
    [noTask.id]: noTask as Agent,
    [steward.id]: steward,
    [asteroidSteward.id]: asteroidSteward,
  };
  w.projects = { [fx.project.id]: fx.project };
  w.tasks = { [fx.task.id]: fx.task, [fx.asteroidTask.id]: fx.asteroidTask };
  for (const [id, state] of Object.entries(states)) if (state) w.statuses[id] = status(id, state);
  return w;
}

const allWorking = {
  [fx.harmonizer.id]: 'working',
  'a-waykeeper-1': 'working',
  'a-steward-1': 'working',
  'a-steward-2': 'idle',
} as const;

describe('satelliteList', () => {
  it('one satellite per live Waykeeper and Steward, in agent-id order, on its work body', () => {
    const list = satelliteList(world(allWorking));
    expect(list.map((s) => [s.agentId, s.role, s.bodyId, s.state])).toEqual([
      ['a-steward-1', 'steward', 'b-luna', 'working'],
      ['a-steward-2', 'steward', 'b-ast-1', 'idle'],
      ['a-waykeeper-1', 'waykeeper', 'b-luna', 'working'],
    ]);
    expect(list[0]).toMatchObject({
      activity: fx.status.currentActivity,
      supervisorId: 'a-waykeeper-1',
      archetype: 'transporting', // P4-03: "Editing src/session.ts" is an edit
      landed: false,
    });
  });

  it('P4-03 hook: a working Steward gets the archetype of its activity; others none', () => {
    const w = world(allWorking);
    const at = (activity: string) => {
      w.statuses['a-steward-1'] = { ...status('a-steward-1'), currentActivity: activity };
      w.statuses['a-waykeeper-1'] = { ...status('a-waykeeper-1'), currentActivity: activity };
      const list = satelliteList(w);
      return [list[0]?.archetype, list[2]?.archetype];
    };
    expect(at('Read: src/a.ts')).toEqual(['gathering', undefined]);
    expect(at('Bash: pnpm test')).toEqual(['building', undefined]);
    expect(at('Bash: git commit -m x')).toEqual(['transporting', undefined]);
    expect(at('TodoWrite')).toEqual([undefined, undefined]);
    // The idle Steward of the asteroid has none, whatever it last did.
    expect(satelliteList(w)[1]?.archetype).toBeUndefined();
  });

  it('leaves the Harmonizer out until P4-02 asks for its HQ station on Earth', () => {
    expect(satelliteList(world(allWorking)).some((s) => s.role === 'harmonizer')).toBe(false);
    const withHq = satelliteList(world(allWorking), { harmonizer: true });
    expect(withHq.find((s) => s.role === 'harmonizer')?.bodyId).toBe('b-earth');
  });

  it('agents without a status record (never started) have no satellite', () => {
    const list = satelliteList(world({ 'a-steward-1': 'working' }));
    expect(list.map((s) => s.agentId)).toEqual(['a-steward-1']);
  });

  it('ended agents lose their satellite; every live state keeps it', () => {
    for (const state of ['finished', 'failed', 'stopped', 'interrupted'] as const) {
      const list = satelliteList(world({ ...allWorking, 'a-steward-1': state }));
      expect(list.map((s) => s.agentId)).not.toContain('a-steward-1');
    }
    for (const state of [
      'starting',
      'working',
      'waiting_for_input',
      'idle',
      'stalled',
      'paused',
    ] as const) {
      const list = satelliteList(world({ ...allWorking, 'a-steward-1': state }));
      expect(list.map((s) => s.agentId)).toContain('a-steward-1');
    }
  });

  it('moved work follows its body: a task that joined a project, a project moved to a moon', () => {
    const w = world(allWorking);
    // The asteroid task joined the project (P2-12): the server points the task (and its agent)
    // at the project's body.
    w.tasks = { ...w.tasks, [fx.asteroidTask.id]: { ...fx.asteroidTask, bodyId: 'b-luna' } };
    expect(satelliteList(w).find((s) => s.agentId === 'a-steward-2')?.bodyId).toBe('b-luna');
    // The project moved (promotion): the Waykeeper follows the project's body.
    w.projects = { [fx.project.id]: { ...fx.project, bodyId: 'b-kepler' } };
    expect(satelliteList(w).find((s) => s.agentId === 'a-waykeeper-1')?.bodyId).toBe('b-kepler');
  });

  it('falls back to the agent body while the work row is missing', () => {
    const w = world(allWorking);
    w.tasks = {};
    w.projects = {};
    expect(workBody(w, 'a-steward-2')).toBe('b-ast-1');
    expect(workBody(w, 'a-waykeeper-1')).toBe('b-luna');
    expect(workBody(w, 'nobody')).toBeUndefined();
  });

  it('isLive reads the status record', () => {
    const w = world({ 'a-steward-1': 'paused', 'a-steward-2': 'failed' });
    expect(isLive(w, 'a-steward-1')).toBe(true);
    expect(isLive(w, 'a-steward-2')).toBe(false);
    expect(isLive(w, 'a-waykeeper-1')).toBe(false);
  });
});

describe('the list rule (showsSatellite)', () => {
  const completed = (w: WorldState): WorldState => {
    w.tasks = { ...w.tasks, [fx.task.id]: { ...fx.task, state: 'completed' } };
    return w;
  };

  it('defaults to live agents only: failed and landed agents are dropped (P4-01)', () => {
    const w = completed(world({ 'a-steward-1': 'finished', 'a-steward-2': 'failed' }));
    expect(hasLanded(w, 'a-steward-1')).toBe(true);
    expect(showsSatellite(w, 'a-steward-1')).toBe(false);
    expect(showsSatellite(w, 'a-steward-2')).toBe(false);
    expect(satelliteList(w)).toEqual([]);
  });

  it('keepFailed (P4-02) keeps a failed agent, still not landed', () => {
    const w = world({ 'a-steward-2': 'failed', 'a-steward-1': 'stopped' });
    const list = satelliteList(w, { keepFailed: true });
    expect(list.map((s) => [s.agentId, s.state, s.landed])).toEqual([
      ['a-steward-2', 'failed', false],
    ]);
  });

  it('keepFailed: a failed agent goes once a newer agent of its role is given its work', () => {
    const w = world({ 'a-steward-1': 'failed' });
    expect(showsSatellite(w, 'a-steward-1', { keepFailed: true })).toBe(true);
    // The Waykeeper respawns a Steward on the same task: the failed satellite gives way.
    const respawned: Agent = { ...steward, id: 'a-steward-9', createdAt: '2026-10-03T12:00:00Z' };
    w.agents[respawned.id] = respawned;
    w.statuses[respawned.id] = status(respawned.id, 'starting');
    expect(isSuperseded(w, 'a-steward-1')).toBe(true);
    expect(satelliteList(w, SCENE_SATELLITES).map((s) => s.agentId)).toEqual(['a-steward-9']);
    // The replacement finishes: the old failure does not come back (respawn → finish).
    w.statuses[respawned.id] = status(respawned.id, 'finished');
    expect(isSuperseded(w, 'a-steward-1')).toBe(true);
    expect(satelliteList(w, { keepFailed: true })).toEqual([]);
    // The replacement fails too: only the newest failure shows.
    w.statuses[respawned.id] = status(respawned.id, 'failed');
    expect(satelliteList(w, { keepFailed: true }).map((s) => s.agentId)).toEqual(['a-steward-9']);
    // An older Steward on the task supersedes nothing; the Harmonizer is never superseded.
    expect(isSuperseded(w, 'a-steward-9')).toBe(false);
    expect(isSuperseded(w, fx.harmonizer.id)).toBe(false);
    // Another task's Steward does not count.
    const w2 = world({ 'a-steward-1': 'failed', 'a-steward-2': 'working' });
    expect(isSuperseded(w2, 'a-steward-1')).toBe(false);
  });

  it('keepFailed: a failed agent goes when its work is over (closed, cancelled, moved)', () => {
    const shown = (w: WorldState, id: string) => showsSatellite(w, id, { keepFailed: true });
    // A failed Steward's own task is `failed` (derived): the satellite stays.
    const w = world({ 'a-steward-1': 'failed', 'a-waykeeper-1': 'failed' });
    w.tasks[fx.task.id] = { ...fx.task, state: 'failed' };
    expect(isWorkOver(w, 'a-steward-1')).toBe(false);
    expect(shown(w, 'a-steward-1')).toBe(true);
    expect(shown(w, 'a-waykeeper-1')).toBe(true);
    // The task is closed, archived or moved away: gone.
    for (const state of ['completed', 'archived', 'moved'] as const) {
      w.tasks[fx.task.id] = { ...fx.task, state };
      expect(shown(w, 'a-steward-1')).toBe(false);
    }
    // The project is cancelled (its tasks and itself `failed`): its Steward and Waykeeper go.
    w.tasks[fx.task.id] = { ...fx.task, state: 'failed' };
    w.projects[fx.project.id] = { ...fx.project, state: 'failed' };
    expect(shown(w, 'a-steward-1')).toBe(false);
    expect(shown(w, 'a-waykeeper-1')).toBe(false);
    // The project is closed (completed) or archived: same.
    for (const state of ['completed', 'archived'] as const) {
      w.projects[fx.project.id] = { ...fx.project, state };
      expect(shown(w, 'a-steward-1')).toBe(false);
      expect(shown(w, 'a-waykeeper-1')).toBe(false);
    }
    // A cancelled standalone task: its Steward was stopped, not failed — no satellite either.
    const w3 = world({ 'a-steward-2': 'stopped' });
    w3.tasks[fx.asteroidTask.id] = { ...fx.asteroidTask, state: 'failed' };
    expect(satelliteList(w3, SCENE_SATELLITES).some((s) => s.agentId === 'a-steward-2')).toBe(
      false,
    );
  });

  it('the scene keeps failed agents and draws the HQ station on Earth (SCENE_SATELLITES)', () => {
    expect(SCENE_SATELLITES).toMatchObject({ keepFailed: true, harmonizer: true });
    const w = world({ ...allWorking, 'a-steward-1': 'failed' });
    const list = satelliteList(w, SCENE_SATELLITES);
    expect(list.find((s) => s.agentId === 'a-steward-1')?.state).toBe('failed');
    const hq = list.filter((s) => s.role === 'harmonizer');
    expect(hq).toHaveLength(1);
    expect(hq[0]).toMatchObject({ agentId: fx.harmonizer.id, bodyId: 'b-earth', state: 'working' });
    // The HQ follows its status record: idle, and gone without one.
    w.statuses[fx.harmonizer.id] = status(fx.harmonizer.id, 'idle');
    expect(satelliteList(w, SCENE_SATELLITES).find((s) => s.role === 'harmonizer')?.state).toBe(
      'idle',
    );
    delete w.statuses[fx.harmonizer.id];
    expect(satelliteList(w, SCENE_SATELLITES).some((s) => s.role === 'harmonizer')).toBe(false);
  });

  it('keepLanded (P4-04) keeps a finished Steward whose task completed, landed', () => {
    const w = completed(world({ 'a-steward-1': 'finished', 'a-steward-2': 'finished' }));
    // a-steward-2's task is not completed: dropped; a-steward-1 lands.
    const list = satelliteList(w, { keepLanded: true });
    expect(list.map((s) => [s.agentId, s.landed])).toEqual([['a-steward-1', true]]);
    // A live agent on a completed task is not landed; a finished one on an open task is not either.
    expect(hasLanded(completed(world({ 'a-steward-1': 'working' })), 'a-steward-1')).toBe(false);
    expect(hasLanded(world({ 'a-steward-1': 'finished' }), 'a-steward-1')).toBe(false);
    expect(hasLanded(w, 'a-waykeeper-1')).toBe(false);
  });
});

describe('keepLanded in the scene (P4-04)', () => {
  const closed = (w: WorldState, state: 'completed' | 'archived' | 'approved' = 'completed') => {
    w.tasks = { ...w.tasks, [fx.task.id]: { ...fx.task, state } };
    return w;
  };
  const landedOf = (w: WorldState) =>
    satelliteList(w, SCENE_SATELLITES)
      .filter((s) => s.landed)
      .map((s) => [s.agentId, s.bodyId, s.state]);

  it('is on in the scene', () => {
    expect(SCENE_SATELLITES.keepLanded).toBe(true);
  });

  it('the Steward of a completed task lands, finished or stopped by the close, with the finished look', () => {
    for (const ended of ['finished', 'stopped', 'interrupted', 'failed'] as const) {
      const w = closed(world({ 'a-steward-1': ended }));
      expect(landedOf(w)).toEqual([['a-steward-1', 'b-luna', 'finished']]);
      const spec = satelliteList(w, SCENE_SATELLITES).find((s) => s.agentId === 'a-steward-1');
      expect(spec).toMatchObject({ activity: undefined, archetype: undefined });
    }
    // Still live (the close has not stopped it yet): it orbits, not landed.
    expect(landedOf(closed(world({ 'a-steward-1': 'idle' })))).toEqual([]);
  });

  it('archived or reopened work takes the landed satellite away', () => {
    expect(landedOf(closed(world({ 'a-steward-1': 'finished' }), 'archived'))).toEqual([]);
    expect(landedOf(closed(world({ 'a-steward-1': 'finished' }), 'approved'))).toEqual([]);
  });

  it('one landed satellite per task: the newest Steward', () => {
    const w = closed(world({ 'a-steward-1': 'failed' }));
    const retry: Agent = { ...steward, id: 'a-steward-9', createdAt: '2026-10-03T12:00:00Z' };
    w.agents[retry.id] = retry;
    w.statuses[retry.id] = status(retry.id, 'finished');
    expect(landedOf(w)).toEqual([['a-steward-9', 'b-luna', 'finished']]);
  });

  it('a newer Steward that never ran does not hide the older landed one', () => {
    const w = closed(world({ 'a-steward-1': 'finished' }));
    const { sessionRef: _s, ...unstarted } = steward;
    w.agents['a-steward-9'] = {
      ...(unstarted as Agent),
      id: 'a-steward-9',
      createdAt: '2026-10-03T12:00:00Z',
    };
    expect(isSuperseded(w, 'a-steward-1')).toBe(false);
    expect(landedOf(w)).toEqual([['a-steward-1', 'b-luna', 'finished']]);
    // Once it runs (a record), it is the newest: it lands instead (it is not live).
    w.statuses['a-steward-9'] = status('a-steward-9', 'stopped');
    expect(landedOf(w)).toEqual([['a-steward-9', 'b-luna', 'finished']]);
  });

  it(`300 landed agents: built in linear time, ${LANDED_PER_BODY} per body drawn, the newest`, () => {
    const w = world({});
    w.agents = {};
    // 300 completed tasks on the project's planet, each with one finished Steward.
    for (let i = 0; i < 300; i++) {
      const n = String(i).padStart(3, '0');
      const taskId = `t-${n}`;
      w.tasks[taskId] = { ...fx.task, id: taskId, state: 'completed' };
      w.agents[`a-st-${n}`] = {
        ...steward,
        id: `a-st-${n}`,
        taskId,
        createdAt: `2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
      };
      w.statuses[`a-st-${n}`] = status(`a-st-${n}`, 'finished');
    }
    // Count every read of an agent row: an O(agents) scan per agent would be ~90 000.
    let reads = 0;
    const agents = w.agents;
    w.agents = new Proxy(agents, {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const list = satelliteList(w, SCENE_SATELLITES);
    expect(reads).toBeLessThan(300 * 10);
    expect(list.filter((s) => s.landed)).toHaveLength(LANDED_PER_BODY);
    expect(list.map((s) => s.agentId)).toEqual([
      'a-st-294',
      'a-st-295',
      'a-st-296',
      'a-st-297',
      'a-st-298',
      'a-st-299',
    ]);
    // Per body: a Steward landed on the asteroid is drawn besides them.
    w.agents = agents;
    w.agents[asteroidSteward.id] = asteroidSteward;
    w.tasks[fx.asteroidTask.id] = { ...fx.asteroidTask, state: 'completed' };
    w.statuses[asteroidSteward.id] = status(asteroidSteward.id, 'finished');
    const byBody = satelliteList(w, SCENE_SATELLITES).map((s) => s.bodyId);
    expect(byBody.filter((b) => b === 'b-luna')).toHaveLength(LANDED_PER_BODY);
    expect(byBody.filter((b) => b === 'b-ast-1')).toHaveLength(1);
  });

  it('outlives the ended record (the server drops it after a day) if the agent ran', () => {
    const w = closed(world({}));
    expect(hasLanded(w, 'a-steward-1')).toBe(true); // `fx.agent` has a session
    expect(landedOf(w)).toEqual([['a-steward-1', 'b-luna', 'finished']]);
    // Created but never started: nothing to land.
    const { sessionRef: _s, ...neverRan } = steward;
    w.agents['a-steward-1'] = neverRan as Agent;
    expect(landedOf(w)).toEqual([]);
  });

  it('the Waykeeper of a completed project lands; a failed one of an open project keeps failing', () => {
    const w = world({ 'a-waykeeper-1': 'stopped' });
    expect(landedOf(w)).toEqual([]);
    w.projects[fx.project.id] = { ...fx.project, state: 'completed' };
    expect(landedOf(w)).toEqual([['a-waykeeper-1', 'b-luna', 'finished']]);
    w.projects[fx.project.id] = { ...fx.project, state: 'archived' };
    expect(landedOf(w)).toEqual([]);
    // The failed rules are unchanged (P4-02).
    const f = world({ 'a-waykeeper-1': 'failed', 'a-steward-1': 'failed' });
    const failed = satelliteList(f, SCENE_SATELLITES).filter((s) => s.state === 'failed');
    expect(failed.map((s) => [s.agentId, s.landed])).toEqual([
      ['a-steward-1', false],
      ['a-waykeeper-1', false],
    ]);
  });
});

describe('sameSatellites', () => {
  it('ignores status churn that changes nothing drawn, sees what does', () => {
    const a = satelliteList(world(allWorking));
    const w = world(allWorking);
    w.statuses['a-steward-1'] = { ...status('a-steward-1'), lastEventAt: '2026-10-03T00:00:00Z' };
    expect(sameSatellites(a, satelliteList(w))).toBe(true);
    w.statuses['a-steward-1'] = status('a-steward-1', 'paused');
    expect(sameSatellites(a, satelliteList(w))).toBe(false);
    expect(sameSatellites(a, a.slice(1))).toBe(false);
  });
});
