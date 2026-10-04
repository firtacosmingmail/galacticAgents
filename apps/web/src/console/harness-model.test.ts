import { describe, expect, it } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld, type WorldState } from '../state/reduce.js';
import {
  EXIT_CRITERIA,
  STATE_BUTTONS,
  harnessRows,
  moveTargets,
  settleLatency,
  workActions,
} from './harness-model.js';

function world(): WorldState {
  const w = emptyWorld();
  w.bodies = { 'b-luna': fx.moon, 'b-ast-1': fx.asteroid };
  w.projects = {
    [fx.project.id]: fx.project,
    'p-h': { ...fx.project, id: 'p-h', name: 'Harness project 1', meta: { harness: true } },
    'p-done': { ...fx.project, id: 'p-done', name: 'Done', state: 'completed' },
  };
  w.tasks = { [fx.task.id]: fx.task, [fx.asteroidTask.id]: fx.asteroidTask };
  w.agents = {
    [fx.agent.id]: fx.agent,
    [fx.harmonizer.id]: fx.harmonizer,
    'a-fake': {
      ...fx.agent,
      id: 'a-fake',
      taskId: 't-2',
      bodyId: 'b-ast-1',
      meta: { harness: true },
      createdAt: '2026-09-30T11:00:00.000Z',
    },
    'a-wk': {
      ...fx.agent,
      id: 'a-wk',
      role: 'waykeeper',
      taskId: undefined,
      projectId: 'p-1',
    } as never,
  };
  w.statuses = {
    [fx.agent.id]: { ...fx.status, agentId: fx.agent.id, state: 'working' },
    'a-fake': { ...fx.status, agentId: 'a-fake', state: 'idle', currentActivity: 'Grep: TODO' },
  };
  return w;
}

describe('the scene harness tab model (P4-06)', () => {
  it('lists Waykeepers and Stewards (live first, fake first), named by their work', () => {
    const rows = harnessRows(world());
    expect(rows.map((r) => r.agent.id)).toEqual(['a-fake', fx.agent.id, 'a-wk']);
    expect(rows[0]).toMatchObject({
      fake: true,
      state: 'idle',
      activity: 'Grep: TODO',
      label: `Steward · ${fx.asteroidTask.description}`,
    });
    expect(rows[2]!.label).toBe(`Waykeeper · ${fx.project.name}`);
    expect(rows[2]!.state).toBeUndefined();
  });

  it('offers move for a standalone task, complete for any open task, close for a project', () => {
    const w = world();
    expect(workActions(w, w.agents['a-fake']!)).toEqual({ completeTask: 't-2', moveTask: 't-2' });
    expect(workActions(w, w.agents[fx.agent.id]!)).toEqual({ completeTask: 't-1' });
    expect(workActions(w, w.agents['a-wk']!)).toEqual({ closeProject: 'p-1' });
    w.tasks['t-1'] = { ...fx.task, state: 'completed' };
    expect(workActions(w, w.agents[fx.agent.id]!)).toEqual({});
    // Open projects only, the harness's first.
    expect(moveTargets(w).map((p) => p.id)).toEqual(['p-h', 'p-1']);
  });

  it('times a state switch from the click to the status on the page', () => {
    const started = { agentId: 'a-fake', state: 'paused' as const, startedAt: 1_000 };
    const w = world();
    expect(settleLatency(started, w.statuses, 1_200)).toBe(started);
    w.statuses['a-fake'] = { ...w.statuses['a-fake']!, state: 'paused' };
    const settled = settleLatency(started, w.statuses, 1_234.4)!;
    expect(settled.ms).toBe(234);
    // Settled once: later statuses do not move it.
    expect(settleLatency(settled, w.statuses, 5_000)).toBe(settled);
    expect(settleLatency(undefined, w.statuses, 0)).toBeUndefined();
  });

  it('covers the three exit criteria and every live state', () => {
    expect(EXIT_CRITERIA.map((c) => c.id)).toEqual(['state', 'move', 'glance']);
    expect(STATE_BUTTONS.map((b) => b.state)).toEqual(
      expect.arrayContaining(['working', 'waiting_for_input', 'idle', 'paused', 'stalled']),
    );
  });
});
