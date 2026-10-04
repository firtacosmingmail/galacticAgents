import { afterEach, describe, expect, it } from 'vitest';
import {
  EventEnvelope,
  type Agent,
  type AgentState,
  type Body,
  type Event,
  type Project,
  type Task,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { applyEvent, emptyWorld, type WorldState } from '../../state/reduce.js';
import { taskAsteroids } from '../belt/belt-model.js';
import { colonyList } from '../colonies/colony-model.js';
import { bodyLabel } from '../labels/label-model.js';
import type { Vec3Tuple } from '../orbit.js';
import { QUALITY_TIERS } from '../quality.js';
import { PRESENCE, SatelliteDirector, SURFACE, type AnchorLookup } from './director.js';
import { TIMING } from './machine.js';
import { publishSatellites } from './registry.js';
import { SCENE_SATELLITES, satelliteList } from './satellite-model.js';

/**
 * P4-04 end to end without WebGL: the client reducer folds the server's real event shapes for a
 * move (a standalone task joins a project) and a promotion (a moon project moves to a planet),
 * the scene's list (`SCENE_SATELLITES`) turns the world into satellites, and the director flies,
 * lands and drops them against anchors drawn from the same world (an asteroid is drawn only while
 * it hosts its task, decision 63).
 */

const T0 = '2026-10-04T10:00:00.000Z';
const kepler: Body = { id: 'b-kepler', kind: 'planet', name: 'Kepler', meta: { orbit: 4 } };
const luna: Body = { id: 'b-luna', kind: 'moon', name: 'Luna', parentId: 'b-kepler' };
const jupiter: Body = { id: 'b-jupiter', kind: 'planet', name: 'Jupiter', meta: { orbit: 5 } };
const asteroid: Body = { id: 'b-ast-7', kind: 'asteroid', name: 'Ast-7', meta: { number: 7 } };

/** Where each body is drawn; an asteroid only while `taskAsteroids` draws it. */
const PLACES: Record<string, { at: Vec3Tuple; radius: number }> = {
  'b-kepler': { at: [40, 0, 0], radius: 2 },
  'b-luna': { at: [46, 0, 0], radius: 0.5 },
  'b-jupiter': { at: [0, 0, -90], radius: 5 },
  'b-ast-7': { at: [-60, 0, 10], radius: 0.3 },
};
function anchorsOf(world: WorldState): AnchorLookup {
  const asteroids = new Set(taskAsteroids(world.bodies).map((a) => a.bodyId));
  return (bodyId, out) => {
    const body = world.bodies[bodyId];
    const place = PLACES[bodyId];
    if (!body || !place) return undefined;
    if (body.kind === 'asteroid' && !asteroids.has(bodyId)) return undefined;
    [out[0], out[1], out[2]] = place.at;
    return place.radius;
  };
}

const dist = (p: Vec3Tuple, q: Vec3Tuple) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

let seq = 0;
/** Folds events through the client reducer, each parsed as the wire's envelope. */
function fold(world: WorldState, ...events: Event[]): WorldState {
  return events.reduce(
    (w, event) => applyEvent(w, EventEnvelope.parse({ seq: ++seq, at: T0, event })),
    world,
  );
}

const agent = (over: Partial<Agent> & Pick<Agent, 'id' | 'role' | 'bodyId'>): Agent => ({
  ...fx.agent,
  taskId: undefined,
  projectId: undefined,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
const setStatus = (w: WorldState, agentId: string, state: AgentState): WorldState => ({
  ...w,
  statuses: { ...w.statuses, [agentId]: { ...fx.status, agentId, state } },
});

const project: Project = { ...fx.project, id: 'p-auth', bodyId: 'b-kepler', createdAt: T0 };
const standalone: Task = {
  ...fx.asteroidTask,
  id: 't-flaky',
  bodyId: 'b-ast-7',
  blockedBy: [],
  state: 'in_progress',
};
const waykeeper = agent({ id: 'a-wk', role: 'waykeeper', bodyId: 'b-kepler', projectId: 'p-auth' });
const steward = agent({ id: 'a-st', role: 'steward', bodyId: 'b-ast-7', taskId: 't-flaky' });

/** Kepler hosts "auth" with its Waykeeper; asteroid 7 hosts a standalone task with its Steward. */
function start(): WorldState {
  seq = 0;
  let w = fold(
    emptyWorld(),
    ...[kepler, luna, jupiter, asteroid].map((body): Event => ({ type: 'body.created', body })),
    { type: 'project.created', project },
    { type: 'body.assigned', bodyId: 'b-kepler', host: { kind: 'project', id: 'p-auth' } },
    { type: 'task.created', task: standalone },
    { type: 'body.assigned', bodyId: 'b-ast-7', host: { kind: 'task', id: 't-flaky' } },
    { type: 'agent.created', agent: waykeeper },
    { type: 'agent.created', agent: steward },
  );
  w = setStatus(w, 'a-wk', 'working');
  return setStatus(w, 'a-st', 'working');
}

/** The server's `moveTask` (a standalone task joins a project), in its order. */
const joinProject: Event[] = [
  { type: 'task.updated', taskId: 't-flaky', changes: { projectId: 'p-auth', bodyId: 'b-kepler' } },
  {
    type: 'body.moved',
    host: { kind: 'task', id: 't-flaky' },
    fromBodyId: 'b-ast-7',
    toBodyId: 'b-kepler',
    intoProjectId: 'p-auth',
  },
  { type: 'agent.updated', agentId: 'a-st', changes: { bodyId: 'b-kepler' } },
];

const director = (reducedMotion = false) =>
  new SatelliteDirector({ satellites: QUALITY_TIERS.high.satellites, reducedMotion });

function frameOf(d: SatelliteDirector, agentId: string) {
  const f = d.frames.find((x) => x.agentId === agentId);
  if (!f) throw new Error(`no frame for ${agentId}`);
  return f;
}

afterEach(() => publishSatellites(new Map()));

describe('a task joins a project (P4-04 acceptance)', () => {
  it('its satellite flies from the asteroid to the project planet, within a second of the event', () => {
    let w = start();
    const d = director();
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 0);
    d.update(5, anchorsOf(w));
    const before = [...frameOf(d, 'a-st').position] as Vec3Tuple;
    expect(dist(before, PLACES['b-ast-7']!.at)).toBeLessThan(1.5);

    // The move: the asteroid loses its host and is no longer drawn (it folds into the belt).
    w = fold(w, ...joinProject);
    expect(anchorsOf(w)('b-ast-7', [0, 0, 0])).toBeUndefined();
    expect(satelliteList(w, SCENE_SATELLITES).find((s) => s.agentId === 'a-st')?.bodyId).toBe(
      'b-kepler',
    );
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 5);
    expect(d.actor('a-st')?.mode).toBe('flying'); // at the event, not at the next drawn frame

    // The first frame after: still at the asteroid (the flight starts where it was drawn) …
    d.update(5.05, anchorsOf(w));
    const f = frameOf(d, 'a-st');
    expect(f.mode).toBe('flying');
    expect(f.visible).toBe(true);
    expect(dist(f.position, before)).toBeLessThan(0.5);
    // … well on its way within a second, and on the planet's orbit after the flight.
    d.update(5.9, anchorsOf(w));
    expect(dist(f.position, before)).toBeGreaterThan(1);
    d.update(5 + TIMING.flight + 0.01, anchorsOf(w));
    expect(f.mode).toBe('transporting'); // arrived: back to its activity (P4-03)
    const r = dist(f.position, PLACES['b-kepler']!.at) / PLACES['b-kepler']!.radius;
    expect(r).toBeGreaterThan(1.7);
    expect(r).toBeLessThan(4);

    // The asteroid keeps no label (decision 63) and nothing is colonised.
    expect(w.bodies['b-ast-7']?.movedTo?.bodyId).toBe('b-kepler');
    expect(bodyLabel(w, 'b-ast-7')).toBeUndefined();
    expect(colonyList(w)).toEqual([]);
  });

  it('a flight whose first frame comes after the old body vanished starts from its ghost', () => {
    let w = start();
    const d = director();
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 0);
    d.update(1, anchorsOf(w));
    const ghost = [...frameOf(d, 'a-st').position] as Vec3Tuple;
    // A frame where the destination is not drawn yet either (nothing to place against).
    w = fold(w, ...joinProject);
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 1);
    d.update(1.02, () => undefined);
    expect(frameOf(d, 'a-st').visible).toBe(false);
    // The planet is drawn again: the flight starts from where the satellite was last seen.
    d.update(1.04, anchorsOf(w));
    const f = frameOf(d, 'a-st');
    expect(f.mode).toBe('flying');
    expect(dist(f.position, ghost)).toBeLessThan(0.5);
    expect(dist(f.position, PLACES['b-kepler']!.at)).toBeGreaterThan(50);
  });

  it('under reduced motion the move is instant', () => {
    let w = start();
    const d = director(true);
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 0);
    d.update(1, anchorsOf(w));
    w = fold(w, ...joinProject);
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 1);
    expect(d.actor('a-st')?.mode).toBe('transporting'); // arrived already
    d.update(1, anchorsOf(w));
    const f = frameOf(d, 'a-st');
    expect(dist(f.position, PLACES['b-kepler']!.at)).toBeLessThan(10);
  });
});

describe('completion lands the satellite (P4-04 acceptance)', () => {
  /** The task joined Kepler and runs there; its Steward orbits Kepler. */
  function onProject(): WorldState {
    return fold(start(), ...joinProject);
  }

  it('closing the task stops its Steward: the satellite lands on the project body and stays', () => {
    let w = onProject();
    const d = director();
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 0);
    d.update(1, anchorsOf(w));
    // The Waykeeper closes the task (`control.close` stops the live Steward).
    w = fold(w, {
      type: 'task.state_changed',
      taskId: 't-flaky',
      from: 'in_progress',
      to: 'completed',
    });
    w = setStatus(w, 'a-st', 'stopped');
    const spec = satelliteList(w, SCENE_SATELLITES).find((s) => s.agentId === 'a-st');
    expect(spec).toMatchObject({ landed: true, state: 'finished', bodyId: 'b-kepler' });
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 2);
    d.update(2 + TIMING.landing / 2, anchorsOf(w));
    const f = frameOf(d, 'a-st');
    expect(f.mode).toBe('landing');
    expect(f.animated).toBe(true); // landings always animate
    const mid = dist(f.position, f.target) / f.bodyRadius;
    expect(mid).toBeGreaterThan(SURFACE + 0.05);
    d.update(2 + TIMING.landing + 0.01, anchorsOf(w));
    expect(f.mode).toBe('landed');
    expect(dist(f.position, f.target) / f.bodyRadius).toBeCloseTo(SURFACE, 6);
    expect(f.animated).toBe(false); // parked: no budget, no beam
    expect(f.beam).toBe(0);
    // A task completing on a project body does not colonise it: the project is still open.
    expect(colonyList(w)).toEqual([]);
    // Much later (the server dropped the ended record after a day), still landed.
    const { ['a-st']: _gone, ...statuses } = w.statuses;
    w = { ...w, statuses };
    expect(satelliteList(w, SCENE_SATELLITES).find((s) => s.agentId === 'a-st')?.landed).toBe(true);
    // Archived: the satellite goes (shrinks out).
    w = fold(w, {
      type: 'task.state_changed',
      taskId: 't-flaky',
      from: 'completed',
      to: 'archived',
    });
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 10);
    d.update(10 + PRESENCE + 0.01, anchorsOf(w));
    expect(d.frames.some((x) => x.agentId === 'a-st')).toBe(false);
  });

  it('a standalone task completed colonises its asteroid; archival frees it and clears the mark', () => {
    let w = start();
    w = fold(w, {
      type: 'task.state_changed',
      taskId: 't-flaky',
      from: 'in_progress',
      to: 'completed',
    });
    w = setStatus(w, 'a-st', 'finished');
    expect(colonyList(w).map((c) => [c.bodyId, c.host])).toEqual([['b-ast-7', 'task']]);
    expect(satelliteList(w, SCENE_SATELLITES).find((s) => s.agentId === 'a-st')).toMatchObject({
      landed: true,
      bodyId: 'b-ast-7',
    });
    w = fold(
      w,
      { type: 'task.state_changed', taskId: 't-flaky', from: 'completed', to: 'archived' },
      { type: 'body.freed', bodyId: 'b-ast-7' },
    );
    expect(colonyList(w)).toEqual([]);
    expect(satelliteList(w, SCENE_SATELLITES).some((s) => s.agentId === 'a-st')).toBe(false);
  });

  it('closing the project lands its Waykeeper and colonises the planet', () => {
    let w = onProject();
    w = fold(
      w,
      { type: 'task.state_changed', taskId: 't-flaky', from: 'in_progress', to: 'completed' },
      {
        type: 'project.state_changed',
        projectId: 'p-auth',
        from: 'awaiting_closure',
        to: 'completed',
      },
    );
    w = setStatus(setStatus(w, 'a-st', 'stopped'), 'a-wk', 'stopped');
    const list = satelliteList(w, SCENE_SATELLITES);
    expect(list.map((s) => [s.agentId, s.bodyId, s.landed])).toEqual([
      ['a-st', 'b-kepler', true],
      ['a-wk', 'b-kepler', true],
    ]);
    expect(colonyList(w).map((c) => [c.bodyId, c.host])).toEqual([['b-kepler', 'project']]);
    // The label keeps its completed state.
    expect(bodyLabel(w, 'b-kepler')?.state).toBe('completed');
  });
});

describe('a promotion flies the Waykeeper (P4-04)', () => {
  it('a moon project moved to a planet: its Waykeeper flies there; the moon shows "moved to"', () => {
    seq = 0;
    const moonProject: Project = { ...project, id: 'p-dark', bodyId: 'b-luna' };
    const wk = agent({ id: 'a-wk2', role: 'waykeeper', bodyId: 'b-luna', projectId: 'p-dark' });
    let w = fold(
      emptyWorld(),
      ...[kepler, luna, jupiter].map((body): Event => ({ type: 'body.created', body })),
      { type: 'project.created', project: moonProject },
      { type: 'body.assigned', bodyId: 'b-luna', host: { kind: 'project', id: 'p-dark' } },
      { type: 'agent.created', agent: wk },
    );
    w = setStatus(w, 'a-wk2', 'idle');
    const d = director();
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 0);
    d.update(1, anchorsOf(w));
    // The server's `moveProject` → `moveHost`, then the card's record.
    w = fold(
      w,
      {
        type: 'body.moved',
        host: { kind: 'project', id: 'p-dark' },
        fromBodyId: 'b-luna',
        toBodyId: 'b-jupiter',
      },
      { type: 'project.updated', projectId: 'p-dark', changes: { bodyId: 'b-jupiter' } },
      { type: 'agent.updated', agentId: 'a-wk2', changes: { bodyId: 'b-jupiter' } },
      {
        type: 'promotion.carried_out',
        proposalId: 'pr-1',
        outcome: {
          ok: true,
          target: { kind: 'project', id: 'p-dark' },
          fromBodyId: 'b-luna',
          toBodyId: 'b-jupiter',
        },
      },
    );
    d.setSpecs(satelliteList(w, SCENE_SATELLITES), 1);
    d.update(1.5, anchorsOf(w));
    const f = frameOf(d, 'a-wk2');
    expect(f.mode).toBe('flying');
    expect(f.bodyId).toBe('b-jupiter');
    d.update(1 + TIMING.flight + 0.01, anchorsOf(w));
    expect(f.mode).toBe('orbiting');
    expect(dist(f.position, PLACES['b-jupiter']!.at)).toBeLessThan(5 * 4);
    // The moon keeps its marker during retention; its label says where the work went.
    expect(bodyLabel(w, 'b-luna')).toMatchObject({
      kind: 'moved',
      movedTo: { bodyId: 'b-jupiter', name: 'Jupiter' },
    });
    // The retention sweep frees it: the marker and the label go.
    w = fold(w, { type: 'body.freed', bodyId: 'b-luna' });
    expect(bodyLabel(w, 'b-luna')).toBeUndefined();
  });
});
