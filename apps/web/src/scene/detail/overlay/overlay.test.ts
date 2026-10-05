import { describe, expect, it } from 'vitest';
import { Group, Mesh, Plane, Vector3 } from 'three';
import type { Agent, Body, Project, StatusRecord, Task, WorkState } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld, type WorldState } from '../../../state/reduce.js';
import { resolveDetailBody, type DetailBody } from '../detail-body.js';
import { DETAIL_PARTS, partsFor } from '../parts.js';
import type { PickSphere } from '../../picking/pick.js';
import {
  assignSlots,
  cutAway,
  descent,
  markerBrightness,
  markerLook,
  MAX_MARKERS,
  MAX_STAND_INS,
  moonLinks,
  overlayCapacity,
  standInCut,
  orbitPoint,
  ORBIT_RINGS,
  ORBIT_SLOTS,
  OVERLAY_PART,
  overlayFooting,
  overlayMarkers,
  parentPlanetOf,
  projectTasksOn,
  selectedTaskOf,
  spinAngle,
  surfacePoint,
  surfaceSlot,
  SURFACE_LAT_MAX,
  SURFACE_SLOTS,
  taskHoverText,
  taskInfoDetail,
  taskSelection,
} from './overlay-model.js';
import { taskMarkerHit, taskMarkerUnder, type TaskMarkerFrame } from './task-registry.js';
import { ProjectOverlay } from './ProjectOverlay.js';

/*
 * P6-04, the project overlay as data: which tasks, where (deterministic slots that survive new
 * tasks and sessions), how they look, what a click selects, the moons' roles, the cutaway rule,
 * and picking a marker (never through a body).
 */

const bodies: Record<string, Body> = {
  'b-earth': { id: 'b-earth', kind: 'planet', name: 'Earth', meta: { orbit: 3, reserved: true } },
  'b-mars': {
    id: 'b-mars',
    kind: 'planet',
    name: 'Mars',
    meta: { orbit: 4 },
    host: { kind: 'project', id: 'p-mars' },
  },
  'b-jupiter': {
    id: 'b-jupiter',
    kind: 'planet',
    name: 'Jupiter',
    meta: { orbit: 5 },
    host: { kind: 'project', id: 'p-jup' },
  },
  'b-io': { id: 'b-io', kind: 'moon', parentId: 'b-jupiter', name: 'Io', meta: { orbit: 1 } },
  'b-europa': {
    id: 'b-europa',
    kind: 'moon',
    parentId: 'b-jupiter',
    name: 'Europa',
    meta: { orbit: 2 },
    host: { kind: 'project', id: 'p-eur' },
  },
  'b-ganymede': {
    id: 'b-ganymede',
    kind: 'moon',
    parentId: 'b-jupiter',
    name: 'Ganymede',
    meta: { orbit: 3 },
    host: { kind: 'project', id: 'p-gan' },
  },
  'b-ast-7': {
    id: 'b-ast-7',
    kind: 'asteroid',
    name: '7 Iris',
    host: { kind: 'task', id: 't-ast' },
    meta: { number: 7 },
  },
};

const project = (id: string, bodyId: string, parentProjectId?: string): Project => ({
  ...fx.project,
  id,
  name: id,
  bodyId,
  ...(parentProjectId ? { parentProjectId } : {}),
});

const at = (n: number) =>
  `2026-10-0${1 + Math.floor(n / 50)}T10:${String(n % 50).padStart(2, '0')}:00.000Z`;

const task = (id: string, bodyId: string, n: number, state: WorkState = 'in_progress'): Task => ({
  ...fx.task,
  id,
  projectId: `p-${bodyId}`,
  bodyId,
  description: `Task ${id}`,
  state,
  createdAt: at(n),
});

const steward = (id: string, taskId: string, n: number): Agent => ({
  ...fx.agent,
  id,
  taskId,
  createdAt: at(n),
});

const status = (agentId: string, state: StatusRecord['state'] = 'working'): StatusRecord => ({
  ...fx.status,
  agentId,
  state,
});

function world(extra: Partial<WorldState> = {}): WorldState {
  return {
    ...emptyWorld(),
    bodies,
    projects: {
      'p-mars': project('p-mars', 'b-mars'),
      'p-jup': project('p-jup', 'b-jupiter'),
      'p-eur': project('p-eur', 'b-europa', 'p-jup'),
      'p-gan': project('p-gan', 'b-ganymede'),
    },
    ...extra,
  };
}

const detail = (id: string): DetailBody => resolveDetailBody(bodies, id, 'fake')!;

describe("the 'project-overlay' part", () => {
  it('is registered once, for planets and moons; not for a task asteroid', () => {
    const entries = DETAIL_PARTS.filter((p) => p.id === OVERLAY_PART);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.Component).toBe(ProjectOverlay);
    for (const id of ['b-mars', 'b-jupiter', 'b-europa']) {
      expect(partsFor(detail(id)).map((p) => p.id)).toContain(OVERLAY_PART);
    }
    expect(partsFor(detail('b-ast-7')).map((p) => p.id)).not.toContain(OVERLAY_PART);
  });

  it('a rocky planet and a moon put tasks on the surface; a giant in orbit', () => {
    expect(overlayFooting(detail('b-mars'))).toBe('surface');
    expect(overlayFooting(detail('b-europa'))).toBe('surface');
    expect(overlayFooting(detail('b-jupiter'))).toBe('orbit');
  });
});

describe('which tasks', () => {
  it('the body’s project tasks, oldest first, without archived, moved or standalone work', () => {
    const tasks: Record<string, Task> = {
      b: task('b', 'b-mars', 2),
      a: task('a', 'b-mars', 1),
      gone: task('gone', 'b-mars', 3, 'archived'),
      moved: task('moved', 'b-mars', 4, 'moved'),
      done: task('done', 'b-mars', 5, 'completed'),
      elsewhere: task('elsewhere', 'b-jupiter', 0),
      alone: { ...task('alone', 'b-mars', 0), projectId: undefined } as unknown as Task,
    };
    delete (tasks['alone'] as Partial<Task>).projectId;
    expect(projectTasksOn({ tasks }, 'b-mars').map((t) => t.id)).toEqual(['a', 'b', 'done']);
  });

  it('beyond the cap, open work wins and the newest completed tasks are left out', () => {
    const tasks: Record<string, Task> = {};
    for (let i = 0; i < 6; i++) tasks[`c${i}`] = task(`c${i}`, 'b-mars', i, 'completed');
    for (let i = 0; i < 3; i++) tasks[`o${i}`] = task(`o${i}`, 'b-mars', 10 + i);
    const kept = projectTasksOn({ tasks }, 'b-mars', 5).map((t) => t.id);
    expect(kept).toEqual(['c0', 'c1', 'o0', 'o1', 'o2']);
    expect(MAX_MARKERS.mobile).toBeLessThan(MAX_MARKERS.high);
    expect(MAX_MARKERS.high).toBeLessThanOrEqual(SURFACE_SLOTS);
  });
});

describe('deterministic slots', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `t-${i}-${(i * 7919).toString(36)}`);

  it('the same tasks get the same slots in every session, all distinct', () => {
    const a = assignSlots(ids, SURFACE_SLOTS);
    const b = assignSlots([...ids], SURFACE_SLOTS);
    expect([...a]).toEqual([...b]);
    expect(new Set(a.values()).size).toBe(ids.length);
    for (const slot of a.values()) expect(slot).toBeLessThan(SURFACE_SLOTS);
  });

  it('a new task never moves an older one; a removed newer task frees only its own slot', () => {
    const before = assignSlots(ids.slice(0, 10), SURFACE_SLOTS);
    const after = assignSlots(ids, SURFACE_SLOTS);
    for (const id of ids.slice(0, 10)) expect(after.get(id)).toBe(before.get(id));
  });

  it('collisions probe to the next free slot; past the slots no slot is given', () => {
    const slots = assignSlots(['x', 'x2', 'x3'], 2);
    expect(slots.size).toBe(2);
    expect(new Set(slots.values())).toEqual(new Set([0, 1]));
  });

  it('surface slots are unit directions within the latitude band, spread round the body', () => {
    let east = 0;
    for (let i = 0; i < SURFACE_SLOTS; i++) {
      const d = surfaceSlot(i);
      expect(Math.hypot(...d)).toBeCloseTo(1, 9);
      expect(Math.abs(Math.asin(d[1]))).toBeLessThanOrEqual(SURFACE_LAT_MAX + 1e-9);
      if (d[0] > 0) east++;
    }
    expect(east).toBeGreaterThan(SURFACE_SLOTS / 3);
    expect(east).toBeLessThan((2 * SURFACE_SLOTS) / 3);
  });

  it('a surface point rides the body’s tilt and spin exactly as the per-kind components nest them', () => {
    const tilt = 0.44;
    const spin = 1.7;
    const tiltGroup = new Group();
    tiltGroup.rotation.set(0, 0, tilt);
    const spinning = new Mesh();
    spinning.rotation.y = spin;
    tiltGroup.add(spinning);
    tiltGroup.updateMatrixWorld(true);
    for (const i of [0, 7, 31]) {
      const dir = surfaceSlot(i);
      const expected = spinning.localToWorld(new Vector3(...dir).multiplyScalar(3));
      const got = surfacePoint(dir, tilt, spin, 3);
      expect(got[0]).toBeCloseTo(expected.x, 9);
      expect(got[1]).toBeCloseTo(expected.y, 9);
      expect(got[2]).toBeCloseTo(expected.z, 9);
    }
    expect(spinAngle(12, true)).toBe(0);
    expect(spinAngle(10, false)).toBeGreaterThan(0);
  });

  it('orbit slots: three rings under the satellites’ shells, distinct places, moving only with time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < ORBIT_SLOTS; i++) {
      const p = orbitPoint(i, 0, 0, 2);
      const r = Math.hypot(...p) / 2;
      expect(ORBIT_RINGS.some((ring) => Math.abs(ring.radius - r) < 1e-9)).toBe(true);
      expect(r).toBeLessThan(1.8); // the satellites' innermost shell (`BASE_SHELL`)
      seen.add(p.map((x) => x.toFixed(4)).join(','));
    }
    expect(seen.size).toBe(ORBIT_SLOTS);
    expect(orbitPoint(3, 0.2, 0, 1)).toEqual(orbitPoint(3, 0.2, 0, 1));
    expect(orbitPoint(3, 0.2, 5, 1)).not.toEqual(orbitPoint(3, 0.2, 0, 1));
  });
});

describe('looks', () => {
  it('blocked on the user is amber, larger and blinks; closed work small and dim', () => {
    const blocked = markerLook('blocked_on_user');
    const working = markerLook('in_progress');
    const done = markerLook('completed');
    expect(blocked.pulse).toBe('blink');
    expect(blocked.scale).toBeGreaterThan(working.scale);
    expect(blocked.color[0]).toBeGreaterThan(blocked.color[2]); // amber
    expect(done.scale).toBeLessThan(working.scale);
    expect(done.level).toBeLessThan(working.level);
    // Built once per state: read for every marker every frame without allocating.
    expect(markerLook('in_progress')).toBe(working);
  });

  it('under reduced motion nothing pulses: the still level at any time', () => {
    const look = markerLook('blocked_on_user');
    const a = markerBrightness(look, 0.1, true, 't-1');
    const b = markerBrightness(look, 0.9, true, 't-1');
    expect(a).toBe(b);
    expect(a).toBe(look.still);
    expect(markerBrightness(look, 0, false, 't-1')).not.toBe(
      markerBrightness(look, 0.8, false, 't-1'),
    );
  });

  it('the hover and info texts name the task and its state', () => {
    const t = task('t', 'b-mars', 1, 'blocked_on_user');
    expect(taskHoverText(t)).toBe('Task t · blocked on you');
    expect(taskHoverText({ ...t, description: 'x'.repeat(80) }).length).toBeLessThan(70);
    expect(taskInfoDetail(t)).toContain('no Steward yet');
  });

  it('the stand-ins descend with the cross-fade, eased and clamped', () => {
    expect(descent(0)).toBe(0);
    expect(descent(1)).toBe(1);
    expect(descent(2)).toBe(1);
    expect(descent(0.5)).toBeCloseTo(0.5, 9);
  });
});

describe('selection', () => {
  it('a task selects its Steward — the newest live one, else the newest — or nothing yet', () => {
    const w = world({
      tasks: { t: task('t', 'b-mars', 1) },
      agents: { s1: steward('s1', 't', 1), s2: steward('s2', 't', 2) },
      statuses: { s1: status('s1'), s2: status('s2', 'failed') },
    });
    expect(taskSelection(w, 't')).toEqual({ kind: 'steward', id: 's1' });
    expect(taskSelection({ ...w, statuses: {} }, 't')).toEqual({ kind: 'steward', id: 's2' });
    expect(taskSelection({ ...w, agents: {} }, 't')).toBeUndefined();
  });

  it('the panel’s selection of a Steward highlights its task; others highlight nothing', () => {
    const agents = { s1: steward('s1', 't', 1) };
    expect(selectedTaskOf({ agents }, { kind: 'steward', id: 's1' })).toBe('t');
    expect(selectedTaskOf({ agents }, { kind: 'harmonizer' })).toBeUndefined();
    expect(selectedTaskOf({ agents }, { kind: 'waykeeper', id: 's1' })).toBeUndefined();
  });
});

describe('moons', () => {
  it('a sub-project moon is part of the planet’s project; an independent one its own', () => {
    const w = world();
    expect(moonLinks(w, ['b-io', 'b-europa', 'b-ganymede'])).toEqual([
      { moonId: 'b-europa', role: 'sub-project' },
      { moonId: 'b-ganymede', role: 'independent' },
    ]);
    expect(parentPlanetOf(w, 'b-europa')).toBe('b-jupiter');
    expect(parentPlanetOf(w, 'b-ganymede')).toBeUndefined();
    expect(parentPlanetOf(w, 'b-io')).toBeUndefined();
  });

  it('a planet’s view also places its sub-project moons’ tasks, on their surface, slots per body', () => {
    const w = world({
      tasks: {
        j1: task('j1', 'b-jupiter', 1),
        e1: task('e1', 'b-europa', 2),
        g1: task('g1', 'b-ganymede', 3),
      },
    });
    const markers = overlayMarkers(w, detail('b-jupiter'), 48, ['b-europa']);
    expect(markers.map((m) => [m.taskId, m.bodyId, m.footing])).toEqual([
      ['j1', 'b-jupiter', 'orbit'],
      ['e1', 'b-europa', 'surface'],
    ]);
    // The moon's own view: its tasks on its surface.
    expect(overlayMarkers(w, detail('b-europa'), 48).map((m) => m.taskId)).toEqual(['e1']);
  });
});

describe('instance capacity', () => {
  it('fits every marker: mobile tier, three sub-project moons with 17 tasks each', () => {
    const tasks: Record<string, Task> = {};
    let n = 0;
    for (let i = 0; i < 30; i++) tasks[`m${i}`] = task(`m${i}`, 'b-mars', n++);
    for (const moon of ['b-m1', 'b-m2', 'b-m3'])
      for (let i = 0; i < 17; i++) tasks[`${moon}-${i}`] = task(`${moon}-${i}`, moon, n++);
    const max = MAX_MARKERS.mobile;
    const markers = overlayMarkers(world({ tasks }), detail('b-mars'), max, [
      'b-m1',
      'b-m2',
      'b-m3',
    ]);
    const onMars = markers.filter((m) => m.bodyId === 'b-mars').length;
    const onMoons = markers.length - onMars;
    expect(onMars).toBe(max);
    expect(onMoons).toBe(51); // more than the old fixed `max × 2` (48)
    const standIns = MAX_STAND_INS.mobile;
    const c = overlayCapacity(markers, 'b-mars', standIns);
    expect(c.pins).toBeGreaterThanOrEqual(onMars);
    expect(c.moonPins).toBeGreaterThanOrEqual(onMoons);
    expect(c.glow).toBeGreaterThanOrEqual(onMoons + standIns);
    expect(c.cutGlow).toBeGreaterThanOrEqual(onMars + standIns);
    // Rounded up in steps: one task more or less keeps the same meshes.
    expect(overlayCapacity(markers.slice(1), 'b-mars', standIns)).toEqual(c);
  });

  it('a giant’s buoys and its moons’ pins have their own lists', () => {
    const c = overlayCapacity(
      [
        { bodyId: 'b-jupiter', footing: 'orbit' },
        { bodyId: 'b-europa', footing: 'surface' },
      ],
      'b-jupiter',
      4,
    );
    expect(c).toEqual({ pins: 8, moonPins: 8, buoys: 8, glow: 8, cutGlow: 8 });
  });
});

describe('the cutaway rule', () => {
  it('a robot on the removed wedge is out of sight; a drone in orbit never', () => {
    const planes = [new Plane(new Vector3(1, 0, 0), 0), new Plane(new Vector3(0, 0, 1), 0)];
    expect(standInCut('surface', planes, [-1, 0, -1])).toBe(true);
    expect(standInCut('surface', planes, [1, 0, -1])).toBe(false);
    expect(standInCut('orbit', planes, [-1, 0, -1])).toBe(false);
    expect(standInCut('surface', undefined, [-1, 0, -1])).toBe(false);
  });

  it('a point is cut only on the negative side of both planes; parked planes cut nothing', () => {
    const planes = [new Plane(new Vector3(1, 0, 0), 0), new Plane(new Vector3(0, 0, 1), 0)];
    expect(cutAway(planes, [-1, 0, -1])).toBe(true);
    expect(cutAway(planes, [1, 0, -1])).toBe(false);
    expect(cutAway(planes, [-1, 0, 1])).toBe(false);
    const parked = [new Plane(new Vector3(0, 1, 0), 1e9), new Plane(new Vector3(0, 1, 0), 1e9)];
    expect(cutAway(parked, [-1, 0, -1])).toBe(false);
    expect(cutAway(undefined, [-1, 0, -1])).toBe(false);
  });
});

describe('picking a marker', () => {
  const frame = (taskId: string, center: [number, number, number], over = {}): TaskMarkerFrame => ({
    taskId,
    bodyId: 'b-mars',
    visible: true,
    center,
    radius: 0.05,
    occluder: 1,
    ...over,
  });
  const ray = (x: number, y: number) => ({
    origin: [x, y, 10] as [number, number, number],
    direction: [0, 0, -1] as [number, number, number],
  });
  const mars: PickSphere[] = [{ bodyId: 'b-mars', center: [0, 0, 0], radius: 1 }];

  it('a pin on the near side is hit within its target; one on the far side never', () => {
    const near = frame('near', [0, 0, 1.05]);
    const far = frame('far', [0.3, 0, -1.05]);
    expect(taskMarkerUnder(ray(0, 0), 1000, mars, [near, far])?.taskId).toBe('near');
    expect(taskMarkerUnder(ray(0.3, 0), 1000, mars, [near, far])).toBeUndefined();
    // 9 px target at depth ~9 with 1000 px per unit: 0.08 units off still hits.
    expect(taskMarkerUnder(ray(0.07, 0), 1000, mars, [near])?.taskId).toBe('near');
    expect(taskMarkerUnder(ray(0.2, 0), 1000, mars, [near])).toBeUndefined();
  });

  it('its own body hides it at the surface radius (a ringed planet’s pick sphere would hide all)', () => {
    const ringed: PickSphere[] = [{ bodyId: 'b-mars', center: [0, 0, 0], radius: 2.3 }];
    const pin = frame('pin', [0, 0, 1.05]);
    expect(taskMarkerUnder(ray(0, 0), 1000, ringed, [pin])?.taskId).toBe('pin');
    // Another body in front hides it.
    const moon: PickSphere = { bodyId: 'b-phobos', center: [0, 0, 3], radius: 0.5 };
    expect(taskMarkerUnder(ray(0, 0), 1000, [...ringed, moon], [pin])).toBeUndefined();
  });

  it('of several, the nearest the pointer; hidden (cut, not grown in) markers are not targets', () => {
    const a = frame('a', [0, 0, 1.05]);
    const b = frame('b', [0.05, 0, 1.05]);
    const hit = taskMarkerHit(ray(0.04, 0), 1000, mars, [a, b]);
    expect(hit?.frame.taskId).toBe('b');
    expect(hit!.px).toBeLessThan(5);
    expect(taskMarkerUnder(ray(0.05, 0), 1000, mars, [a, { ...b, visible: false }])?.taskId).toBe(
      'a',
    );
  });
});
