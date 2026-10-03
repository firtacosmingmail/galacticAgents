import { describe, expect, it } from 'vitest';
import { Group, Object3D, Vector3 } from 'three';
import { orbitPoint, placeOnOrbit } from './orbit.js';
import { orbitPosition } from './belt/belt-model.js';
import { auToScene } from './scale.js';

describe('one orbit convention (planets, moons, belt)', () => {
  it('angle 0 is +x, π/2 is −z: counter-clockwise seen from above', () => {
    const a = orbitPoint(10, 0);
    expect(a[0]).toBeCloseTo(10);
    expect(a[2]).toBeCloseTo(0);
    const b = orbitPoint(10, Math.PI / 2);
    expect(b[0]).toBeCloseTo(0);
    expect(b[2]).toBeCloseTo(-10);
  });

  it('inclination lifts the point and keeps its distance', () => {
    const [x, y, z] = orbitPoint(10, 1, 0.1);
    expect(Math.hypot(x, y, z)).toBeCloseTo(10);
    expect(y).toBeGreaterThan(0);
  });

  it('a positive rotation.y advances the angle (the belt spins the way the planets go)', () => {
    const group = new Group();
    const child = new Object3D();
    group.add(child);
    placeOnOrbit(child, 10, 0.3);
    group.rotation.y = 0.2;
    group.updateMatrixWorld(true);
    const world = child.getWorldPosition(new Vector3());
    const expected = orbitPoint(10, 0.5);
    expect(world.x).toBeCloseTo(expected[0]);
    expect(world.z).toBeCloseTo(expected[2]);
  });

  it('the belt and the planets agree on where an angle is', () => {
    const phase = 2.2;
    const belt = orbitPosition({ radius: 3, phase, inclination: 0 }, 'fake');
    const planet = orbitPoint(auToScene(3, 'fake'), phase);
    expect(belt[0]).toBeCloseTo(planet[0]);
    expect(belt[2]).toBeCloseTo(planet[2]);
  });

  it('placeOnOrbit writes into the object’s own position (no new vector)', () => {
    const o = new Object3D();
    const before = o.position;
    placeOnOrbit(o, 5, Math.PI);
    expect(o.position).toBe(before);
    expect(o.position.x).toBeCloseTo(-5);
    expect(o.position.z).toBeCloseTo(0);
  });
});
