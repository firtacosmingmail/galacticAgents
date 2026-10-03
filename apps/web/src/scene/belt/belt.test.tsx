// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { InstancedMesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import { asteroidSpec, BELT_ORBIT, QualityTier, type Body } from '@galactic/protocol';
import { allAnchors, getAnchor } from '../anchors.js';
import { QUALITY_TIERS } from '../quality.js';
import { auToScene, type ScaleMode } from '../scale.js';
import {
  asteroidOrbit,
  beltBounds,
  beltSpin,
  BELT_ANGULAR_SPEED,
  generateBelt,
  orbitPosition,
  pickData,
  rockPositions,
  ROCK_SIZE,
  ROCK_STRIDE,
  taskAsteroids,
} from './belt-model.js';
import { rockGeometry, writeBeltInstances } from './belt-mesh.js';
import { useBodyAnchor } from '../anchor-binding.js';

afterEach(cleanup);

const MODES: ScaleMode[] = ['fake', 'true'];

describe('background belt generation (P3-03)', () => {
  it('is deterministic: the same belt on every run', () => {
    const a = generateBelt(3000);
    const b = generateBelt(3000);
    expect(a.count).toBe(3000);
    expect(a.data).toEqual(b.data);
    expect(generateBelt(10, 1).data).not.toEqual(generateBelt(10, 2).data);
  });

  it('a lighter tier draws a prefix of the heavier belt (switching tiers never reshuffles)', () => {
    const big = generateBelt(QUALITY_TIERS.high.beltRocks);
    const small = generateBelt(QUALITY_TIERS.mobile.beltRocks);
    expect(small.data).toEqual(big.data.subarray(0, small.count * ROCK_STRIDE));
  });

  it('has a rock count per tier, thousands, lighter on mobile', () => {
    for (const tier of QualityTier.options) {
      const n = QUALITY_TIERS[tier].beltRocks;
      expect(generateBelt(n).count).toBe(n);
      expect(n).toBeGreaterThanOrEqual(1000);
    }
    const { high, balanced, mobile } = QUALITY_TIERS;
    expect(high.beltRocks).toBeGreaterThan(balanced.beltRocks);
    expect(balanced.beltRocks).toBeGreaterThan(mobile.beltRocks);
  });

  it('keeps every rock in the band and the size range', () => {
    const belt = generateBelt(QUALITY_TIERS.high.beltRocks);
    for (let i = 0; i < belt.count; i++) {
      const o = i * ROCK_STRIDE;
      expect(belt.data[o]).toBeGreaterThanOrEqual(BELT_ORBIT.innerAu - 1e-6);
      expect(belt.data[o]).toBeLessThanOrEqual(BELT_ORBIT.outerAu + 1e-6);
      expect(belt.data[o + 3]).toBeGreaterThanOrEqual(ROCK_SIZE.min - 1e-6);
      expect(belt.data[o + 3]).toBeLessThanOrEqual(ROCK_SIZE.max + 1e-6);
    }
  });

  it.each(MODES)('places every rock within auToScene(2.2..3.3 AU) in %s scale', (mode) => {
    const belt = generateBelt(QUALITY_TIERS.high.beltRocks);
    const positions = rockPositions(belt, mode);
    const { inner, outer } = beltBounds(mode);
    expect(inner).toBe(auToScene(2.2, mode));
    expect(outer).toBe(auToScene(3.3, mode));
    let maxHeight = 0;
    for (let i = 0; i < belt.count; i++) {
      const v = new Vector3().fromArray(positions, i * 3);
      expect(v.length()).toBeGreaterThanOrEqual(inner - 1e-3);
      expect(v.length()).toBeLessThanOrEqual(outer + 1e-3);
      maxHeight = Math.max(maxHeight, Math.abs(v.y));
    }
    // A flat-ish ring: the height stays within the largest inclination.
    expect(maxHeight).toBeLessThanOrEqual(outer * Math.sin(BELT_ORBIT.maxInclination) + 1e-3);
  });
});

describe('orbit placement', () => {
  it('puts a body at its scaled radius, azimuth and elevation', () => {
    const [x, y, z] = orbitPosition({ radius: 2.5, phase: Math.PI / 2, inclination: 0 }, 'true');
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 9);
    // The planets' convention (scene/orbit.ts): π/2 is the far side, −z.
    expect(z).toBeCloseTo(-auToScene(2.5, 'true'), 9);
    const tilted = orbitPosition({ radius: 3, phase: 0, inclination: 0.1 }, 'fake');
    expect(new Vector3(...tilted).length()).toBeCloseTo(auToScene(3, 'fake'), 9);
    expect(tilted[1]).toBeGreaterThan(0);
  });
});

const asteroid = (n: number, extra: Partial<Body> = {}): Body => {
  const spec = asteroidSpec(n);
  return { id: spec.id, kind: 'asteroid', name: spec.name, meta: spec.meta, ...extra };
};

describe('world → task asteroids', () => {
  it('lists only the asteroids that host work, at their catalogue orbit, sorted by id', () => {
    const bodies: Record<string, Body> = {
      'b-earth': { id: 'b-earth', kind: 'planet', name: 'Earth', meta: { reserved: true } },
      'b-mars': { id: 'b-mars', kind: 'planet', name: 'Mars', host: { kind: 'project', id: 'p1' } },
      'b-asteroid-2': asteroid(2, { host: { kind: 'task', id: 't2' } }),
      'b-asteroid-1': asteroid(1, { host: { kind: 'task', id: 't1' } }),
      // freed: no host
      'b-asteroid-3': asteroid(3),
      // the work moved away: only a marker remains
      'b-asteroid-4': asteroid(4, {
        movedTo: {
          bodyId: 'b-mars',
          host: { kind: 'task', id: 't4' },
          at: '2026-10-03T10:00:00.000Z',
        },
      }),
    };
    const list = taskAsteroids(bodies);
    expect(list.map((a) => a.bodyId)).toEqual(['b-asteroid-1', 'b-asteroid-2']);
    expect(list[0]).toEqual({
      bodyId: 'b-asteroid-1',
      name: '(1) Tioi',
      hostId: 't1',
      orbit: asteroidSpec(1).meta.orbit,
      seed: asteroidSpec(1).meta.seed,
      number: 1, // its stable place in the camera's next / previous order
    });
    expect(taskAsteroids({})).toEqual([]);
    const bare: Body = {
      id: 'hand-made',
      kind: 'asteroid',
      name: 'Hand-made',
      host: { kind: 'task', id: 't9' },
    };
    expect(taskAsteroids({ bare })[0]).not.toHaveProperty('number');
  });

  it('task asteroids sit in the belt in both scales', () => {
    for (let n = 1; n <= 200; n++) {
      const [a] = taskAsteroids({ x: asteroid(n, { host: { kind: 'task', id: 't' } }) });
      for (const mode of MODES) {
        const d = new Vector3(...orbitPosition(a!.orbit, mode)).length();
        expect(d).toBeGreaterThanOrEqual(beltBounds(mode).inner - 1e-6);
        expect(d).toBeLessThanOrEqual(beltBounds(mode).outer + 1e-6);
      }
    }
  });

  it('places an asteroid without catalogue data deterministically, still in the belt', () => {
    const byNumber: Body = { id: 'x', kind: 'asteroid', name: 'x', meta: { number: 42 } };
    expect(asteroidOrbit(byNumber).orbit).toEqual(asteroidSpec(42).meta.orbit);
    const bare: Body = { id: 'hand-made', kind: 'asteroid', name: 'Hand-made' };
    const o = asteroidOrbit(bare);
    expect(asteroidOrbit(bare)).toEqual(o);
    expect(o.orbit.radius).toBeGreaterThanOrEqual(BELT_ORBIT.innerAu);
    expect(o.orbit.radius).toBeLessThanOrEqual(BELT_ORBIT.outerAu);
    const far: Body = {
      id: 'far',
      kind: 'asteroid',
      name: 'Far',
      meta: { orbit: { radius: 40, phase: 1, inclination: 0 } },
    };
    expect(asteroidOrbit(far).orbit.radius).toBe(BELT_ORBIT.outerAu);
  });

  it('carries a pick marker naming the body and its task', () => {
    const [a] = taskAsteroids({ x: asteroid(5, { host: { kind: 'task', id: 't5' } }) });
    expect(pickData(a!)).toEqual({ bodyId: 'b-asteroid-5', kind: 'asteroid', hostId: 't5' });
  });
});

describe('instanced belt mesh (one draw call)', () => {
  it.each(MODES)('writes every rock into one InstancedMesh with a bounding sphere (%s)', (mode) => {
    const belt = generateBelt(QUALITY_TIERS.balanced.beltRocks);
    const geometry = rockGeometry(1);
    const mesh = new InstancedMesh(geometry, new MeshStandardMaterial(), belt.count);
    writeBeltInstances(mesh, belt, mode);
    // One object, one geometry, one material, no children: three issues one draw call for it.
    expect(mesh.count).toBe(belt.count);
    expect(Array.isArray(mesh.material)).toBe(false);
    expect(mesh.children).toHaveLength(0);
    expect(geometry.groups).toHaveLength(0);
    expect(mesh.instanceColor?.count).toBe(belt.count);
    // The bounding sphere covers the whole ring (frustum culling never drops a visible belt).
    const sphere = mesh.boundingSphere!;
    const outer = beltBounds(mode).outer;
    expect(sphere.center.length()).toBeLessThan(outer * 0.2);
    expect(sphere.radius).toBeGreaterThanOrEqual(outer * 0.95);
    const positions = rockPositions(belt, mode);
    for (let i = 0; i < belt.count; i += 97) {
      expect(sphere.containsPoint(new Vector3().fromArray(positions, i * 3))).toBe(true);
    }
  });

  it('builds a closed, deterministic rock', () => {
    const a = rockGeometry(7).getAttribute('position').array;
    const b = rockGeometry(7).getAttribute('position').array;
    expect(a).toEqual(b);
    expect(rockGeometry(8).getAttribute('position').array).not.toEqual(a);
  });
});

describe('belt spin', () => {
  it('turns by delta, not at all with reduced motion, capped after long gaps', () => {
    expect(beltSpin(0.016, false)).toBeCloseTo(0.016 * BELT_ANGULAR_SPEED, 12);
    expect(beltSpin(0.016, true)).toBe(0);
    expect(beltSpin(5, false)).toBeCloseTo(0.1 * BELT_ANGULAR_SPEED, 12);
    expect(beltSpin(0, false)).toBe(0);
  });
});

describe('anchor registration helper', () => {
  function Probe({ id, radius }: { id: string; radius: number }) {
    const ref = useRef<Object3D>(new Object3D());
    useBodyAnchor(ref, { bodyId: id, radius, kind: 'asteroid' });
    return null;
  }

  it('registers on mount, re-registers on change, unregisters on unmount', () => {
    const { rerender, unmount } = render(<Probe id="b-asteroid-9" radius={1.1} />);
    const anchor = getAnchor('b-asteroid-9');
    expect(anchor).toMatchObject({ bodyId: 'b-asteroid-9', radius: 1.1, kind: 'asteroid' });
    expect(anchor?.object).toBeInstanceOf(Object3D);
    rerender(<Probe id="b-asteroid-10" radius={1.1} />);
    expect(getAnchor('b-asteroid-9')).toBeUndefined();
    expect(getAnchor('b-asteroid-10')).toBeDefined();
    unmount();
    expect(getAnchor('b-asteroid-10')).toBeUndefined();
    expect(allAnchors()).toEqual([]);
  });
});
