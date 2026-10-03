import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAnchor, type BodyAnchor } from '../anchors.js';
import { anchorPosition, anchorWorld, bodyOrder, useCameraStore } from './store.js';

/** Fake anchors: plain three objects (no renderer), registered like the bodies will. */
function fake(bodyId: string, kind: BodyAnchor['kind'], x: number, radius = 1): BodyAnchor {
  const object = new Object3D();
  object.position.set(x, 0, 0);
  return { bodyId, kind, object, radius };
}

const ANCHORS = [
  fake('b-rock-2', 'asteroid', 90, 0.1),
  fake('b-earth', 'planet', 35),
  fake('b-moon', 'moon', 37, 0.3),
  fake('b-mars', 'planet', 50),
  fake('b-sun', 'star', 0, 6),
  fake('b-rock-1', 'asteroid', 80, 0.1),
  fake('b-mercury', 'planet', 20),
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
    const w = anchorWorld(ANCHORS);
    expect(w.sunRadius).toBe(6);
    expect(w.extent).toBeCloseTo(90.1);
    expect(w.body('b-mars')).toEqual({ position: [50, 0, 0], radius: 1 });
    expect(w.body('nope')).toBeUndefined();
  });

  it('falls back to the default Sun when none is registered', () => {
    const w = anchorWorld([]);
    expect(w.sunRadius).toBe(6);
    expect(w.extent).toBe(0);
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

  it('no bodies: next and previous do nothing', () => {
    unregister.forEach((u) => u());
    unregister = [];
    expect(useCameraStore.getState().next()).toBeUndefined();
    expect(useCameraStore.getState().request).toBeUndefined();
  });
});
