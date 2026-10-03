import { describe, expect, it } from 'vitest';
import type { Agent, AgentState, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld, type WorldState } from '../../state/reduce.js';
import {
  hasLanded,
  isLive,
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
      archetype: undefined,
      landed: false,
    });
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
