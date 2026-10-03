import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moonOrder, registerAnchor, type BodyAnchor } from '../anchors.js';
import {
  AnchorWorld,
  anchorPosition,
  bodyOrder,
  handledOnMount,
  OVERVIEW_PLANET_REACH,
  pendingRequest,
  systemExtent,
  useCameraStore,
} from './store.js';

/** Fake anchors: plain three objects (no renderer), registered like the bodies will. */
function fake(
  bodyId: string,
  kind: BodyAnchor['kind'],
  x: number,
  radius = 1,
  order?: number,
): BodyAnchor {
  const object = new Object3D();
  object.position.set(x, 0, 0);
  return { bodyId, kind, object, radius, ...(order !== undefined ? { order } : {}) };
}

const ANCHORS = [
  fake('b-rock-2', 'asteroid', 90, 0.1, 2),
  fake('b-earth', 'planet', 35, 1, 3),
  fake('b-moon', 'moon', 37, 0.3, moonOrder(3, 1)),
  fake('b-mars', 'planet', 50, 1, 4),
  fake('b-sun', 'star', 0, 6),
  fake('b-rock-1', 'asteroid', 80, 0.1, 1),
  fake('b-mercury', 'planet', 20, 1, 1),
];

let unregister: (() => void)[] = [];

beforeEach(() => {
  unregister = ANCHORS.map(registerAnchor);
  useCameraStore.setState({ focusedId: undefined, flying: false, request: undefined });
});
afterEach(() => unregister.forEach((u) => u()));

describe('body order', () => {
  it('goes Sun, planets outward, moons, asteroids outward', () => {
    expect(bodyOrder(ANCHORS).map((a) => a.bodyId)).toEqual([
      'b-sun',
      'b-mercury',
      'b-earth',
      'b-mars',
      'b-moon',
      'b-rock-1',
      'b-rock-2',
    ]);
  });

  it('is stable as bodies move: moons by planet then rank, never by distance from the Sun', () => {
    const planet = (id: string, orbit: number, x: number) => fake(id, 'planet', x, 1, orbit);
    const moon = (id: string, orbit: number, rank: number, x: number) =>
      fake(id, 'moon', x, 0.2, moonOrder(orbit, rank));
    const anchors = [
      planet('b-jupiter', 5, 90),
      planet('b-mars', 4, 43),
      moon('b-io', 5, 1, 95),
      moon('b-europa', 5, 2, 97),
      moon('b-phobos', 4, 1, 45),
      moon('b-deimos', 4, 2, 46),
      fake('b-hand-made', 'moon', 10, 0.2),
    ];
    const expected = [
      'b-mars',
      'b-jupiter',
      'b-phobos',
      'b-deimos',
      'b-io',
      'b-europa',
      'b-hand-made',
    ];
    expect(bodyOrder(anchors).map((a) => a.bodyId)).toEqual(expected);
    // The moons go round: Io swings nearer the Sun than Europa, Deimos nearer than Phobos.
    anchors[2]!.object.position.set(85, 0, 0);
    anchors[3]!.object.position.set(99, 0, 0);
    anchors[5]!.object.position.set(40, 0, 0);
    expect(bodyOrder(anchors).map((a) => a.bodyId)).toEqual(expected);
  });

  it('reads world positions (a moon inside its planet group)', () => {
    const planet = new Object3D();
    planet.position.set(40, 0, 0);
    const moon = new Object3D();
    moon.position.set(3, 1, 0);
    planet.add(moon);
    expect(anchorPosition({ bodyId: 'm', kind: 'moon', object: moon, radius: 1 })).toEqual([
      43, 1, 0,
    ]);
  });
});

describe('anchor world', () => {
  it('takes the Sun radius from the star and the extent from the farthest body', () => {
    const w = new AnchorWorld(() => ANCHORS);
    expect(w.sunRadius).toBe(6);
    expect(w.extent).toBeCloseTo(90.1);
    expect(w.body('b-mars')).toEqual({ position: [50, 0, 0], radius: 1 });
    expect(w.body('nope')).toBeUndefined();
  });

  it('falls back to the default Sun when none is registered', () => {
    const w = new AnchorWorld(() => []);
    expect(w.sunRadius).toBe(6);
    expect(w.extent).toBe(0);
  });

  it('keeps the extent until invalidated; reads a body live', () => {
    const list = [fake('b-sun', 'star', 0, 6), fake('b-mars', 'planet', 50, 1, 4)];
    let reads = 0;
    const w = new AnchorWorld(
      () => {
        reads++;
        return list;
      },
      (id) => list.find((a) => a.bodyId === id),
    );
    const first = w.extent;
    expect(w.sunRadius).toBe(6);
    expect(reads).toBe(1);
    list.push(fake('b-far', 'asteroid', 200, 1));
    expect(w.extent).toBe(first); // cached
    w.invalidate();
    expect(w.extent).toBeCloseTo(201);
    expect(reads).toBe(2);
    list[1]!.object.position.set(0, 0, 60);
    expect(w.body('b-mars')!.position).toEqual([0, 0, 60]);
  });
});

describe('overview extent', () => {
  it('frames the planets’ orbits: a far moon (Nereid) does not widen it', () => {
    const neptune = fake('b-neptune', 'planet', 1052, 0.5, 8);
    const triton = fake('b-triton', 'moon', 1059, 0.03);
    const nereid = fake('b-nereid', 'moon', 1162, 0.01);
    const sun = fake('b-sun', 'star', 0, 6);
    const extent = systemExtent([sun, neptune, triton, nereid]);
    expect(extent).toBeCloseTo(1052 + 0.5 * OVERVIEW_PLANET_REACH);
    expect(extent).toBeLessThan(1162);
  });

  it('counts asteroids and the Sun by their own radius', () => {
    expect(systemExtent([fake('b-sun', 'star', 0, 6)])).toBe(6);
    expect(systemExtent([fake('a', 'asteroid', 60, 1.1), fake('p', 'planet', 40, 2)])).toBeCloseTo(
      61.1,
    );
    expect(systemExtent([])).toBe(0);
  });
});

describe('camera store', () => {
  it('flyTo a registered body sets the focus and a request; an unknown one does nothing', () => {
    expect(useCameraStore.getState().flyTo('b-mars')).toBe(true);
    const s = useCameraStore.getState();
    expect(s.focusedId).toBe('b-mars');
    expect(s.request).toMatchObject({ kind: 'focus', bodyId: 'b-mars' });
    expect(useCameraStore.getState().flyTo('b-pluto')).toBe(false);
    expect(useCameraStore.getState().focusedId).toBe('b-mars');
    expect(useCameraStore.getState().request).toBe(s.request);
  });

  it('every request has a new seq, so the same flight can be asked twice', () => {
    useCameraStore.getState().flyTo('b-mars');
    const first = useCameraStore.getState().request!.seq;
    useCameraStore.getState().flyTo('b-mars');
    expect(useCameraStore.getState().request!.seq).toBeGreaterThan(first);
  });

  it('back clears the focus and asks for the overview', () => {
    useCameraStore.getState().flyTo('b-mars');
    useCameraStore.getState().back();
    expect(useCameraStore.getState().focusedId).toBeUndefined();
    expect(useCameraStore.getState().request).toMatchObject({ kind: 'overview' });
  });

  it('next and previous walk the order and wrap around', () => {
    const { next, previous } = useCameraStore.getState();
    expect(next()).toBe('b-sun');
    expect(next()).toBe('b-mercury');
    expect(next()).toBe('b-earth');
    expect(previous()).toBe('b-mercury');
    expect(previous()).toBe('b-sun');
    expect(previous()).toBe('b-rock-2');
    expect(next()).toBe('b-sun');
    expect(useCameraStore.getState().focusedId).toBe('b-sun');
  });

  it('previous with nothing focused starts from the last body', () => {
    expect(useCameraStore.getState().previous()).toBe('b-rock-2');
  });

  it('the rig reports flights: started, arrived, interrupted or left', () => {
    const cam = useCameraStore.getState();
    cam.flyTo('b-earth');
    cam.flightStarted();
    expect(useCameraStore.getState().flying).toBe(true);
    cam.arrived();
    expect(useCameraStore.getState()).toMatchObject({ flying: false, focusedId: 'b-earth' });
    cam.flyTo('b-mars');
    cam.flightStarted();
    cam.released(); // the user grabbed the controls mid-flight
    expect(useCameraStore.getState()).toMatchObject({ flying: false, focusedId: undefined });
    cam.back();
    cam.flightStarted();
    cam.atOverview();
    expect(useCameraStore.getState()).toMatchObject({ flying: false, focusedId: undefined });
  });

  it('a released camera drops its request: nothing is left to replay', () => {
    const cam = useCameraStore.getState();
    cam.flyTo('b-earth');
    cam.flightStarted();
    cam.released();
    expect(useCameraStore.getState().request).toBeUndefined();
  });

  it('a remounted rig does not replay the last request', () => {
    const cam = useCameraStore.getState();
    // The first rig mounts (no request yet), then handles a flight to Mars and follows it.
    let handled = handledOnMount();
    expect(pendingRequest(useCameraStore.getState().request, handled)).toBeUndefined();
    cam.flyTo('b-mars');
    const req = pendingRequest(useCameraStore.getState().request, handled)!;
    expect(req).toMatchObject({ kind: 'focus', bodyId: 'b-mars' });
    handled = req.seq;
    cam.flightStarted();
    cam.arrived();
    expect(pendingRequest(useCameraStore.getState().request, handled)).toBeUndefined();
    // Even if a request survived (no release yet), a new rig counts it as handled.
    const remounted = handledOnMount();
    expect(pendingRequest(useCameraStore.getState().request, remounted)).toBeUndefined();
    // The first rig unmounts: the camera is released and the request dropped.
    cam.released();
    expect(useCameraStore.getState()).toMatchObject({ focusedId: undefined, request: undefined });
    expect(pendingRequest(useCameraStore.getState().request, handledOnMount())).toBeUndefined();
    // A request made after the mount is handled.
    cam.flyTo('b-earth');
    expect(pendingRequest(useCameraStore.getState().request, remounted)).toMatchObject({
      bodyId: 'b-earth',
    });
  });

  it('no bodies: next and previous do nothing', () => {
    unregister.forEach((u) => u());
    unregister = [];
    expect(useCameraStore.getState().next()).toBeUndefined();
    expect(useCameraStore.getState().request).toBeUndefined();
  });
});
