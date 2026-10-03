import { describe, expect, it } from 'vitest';
import type { Vec3Tuple } from '../orbit.js';
import {
  BASE_SHELL,
  blendOrbit,
  orbitAngle,
  orbitOffset,
  orbitSlots,
  satelliteOrbit,
  SHELL_STEP,
} from './orbits.js';

const stewards = (n: number, bodyId = 'b-mars') =>
  Array.from({ length: n }, (_, i) => ({
    agentId: `a-steward-${String(i).padStart(2, '0')}`,
    role: 'steward' as const,
    bodyId,
  }));

describe('orbit slots', () => {
  it('the Waykeeper takes slot 0, Stewards follow by id, per body', () => {
    const slots = orbitSlots([
      ...stewards(2),
      { agentId: 'a-zz-waykeeper', role: 'waykeeper', bodyId: 'b-mars' },
      { agentId: 'a-other', role: 'steward', bodyId: 'b-io' },
    ]);
    expect(slots.get('a-zz-waykeeper')).toBe(0);
    expect(slots.get('a-steward-00')).toBe(1);
    expect(slots.get('a-steward-01')).toBe(2);
    expect(slots.get('a-other')).toBe(0);
  });

  it('are sticky: holders keep their slot, arrivals take the lowest free one', () => {
    const first = orbitSlots([
      { agentId: 'a-w', role: 'waykeeper', bodyId: 'b-mars' },
      ...stewards(3),
    ]);
    const held = new Map(
      [...first].map(([agentId, slot]) => [agentId, { bodyId: 'b-mars', slot }] as const),
    );
    // Steward 01 ends, a new Steward (sorting first) arrives, the Waykeeper is replaced.
    const next = orbitSlots(
      [
        { agentId: 'a-new-waykeeper', role: 'waykeeper', bodyId: 'b-mars' },
        { agentId: 'a-aaa', role: 'steward', bodyId: 'b-mars' },
        { agentId: 'a-steward-00', role: 'steward', bodyId: 'b-mars' },
        { agentId: 'a-steward-02', role: 'steward', bodyId: 'b-mars' },
      ],
      held,
    );
    expect(next.get('a-steward-00')).toBe(first.get('a-steward-00'));
    expect(next.get('a-steward-02')).toBe(first.get('a-steward-02'));
    expect(next.get('a-new-waykeeper')).toBe(0); // slot 0 was free
    expect(next.get('a-aaa')).toBe(first.get('a-steward-01')); // the lowest free slot
  });

  it('a slot held on another body is not kept: a moved satellite arrives anew', () => {
    const next = orbitSlots(
      [
        { agentId: 'a-moved', role: 'steward', bodyId: 'b-io' },
        { agentId: 'a-io', role: 'steward', bodyId: 'b-io' },
      ],
      new Map([
        ['a-moved', { bodyId: 'b-mars', slot: 0 }],
        ['a-io', { bodyId: 'b-io', slot: 0 }],
      ]),
    );
    expect(next.get('a-io')).toBe(0);
    expect(next.get('a-moved')).toBe(1);
  });

  it('does not depend on the input order', () => {
    const list = stewards(6);
    const a = orbitSlots(list);
    const b = orbitSlots([...list].reverse());
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });
});

describe('satellite orbits', () => {
  it('are deterministic from the agent id and slot', () => {
    expect(satelliteOrbit('a-1', 'steward', 3)).toEqual(satelliteOrbit('a-1', 'steward', 3));
    expect(satelliteOrbit('a-1', 'steward', 3).phase).not.toBe(
      satelliteOrbit('a-2', 'steward', 3).phase,
    );
  });

  it('start outside the body and its rings, and Waykeepers turn slower than Stewards', () => {
    const w = satelliteOrbit('a-w', 'waykeeper', 0);
    const s = satelliteOrbit('a-s', 'steward', 0);
    expect(w.radius).toBe(BASE_SHELL);
    expect(BASE_SHELL).toBeGreaterThan(1.5);
    expect(w.speed).toBeLessThan(s.speed);
  });

  it('blend radius, inclination and node (the short way round), keeping the target phase', () => {
    const from = { radius: 2, inclination: 0.2, node: 6.2, phase: 1, speed: 1 };
    const to = { radius: 3, inclination: 0.6, node: 0.1, phase: 4, speed: 2 };
    const out = { ...from };
    expect(blendOrbit(from, to, 0, out)).toMatchObject({ radius: 2, inclination: 0.2, phase: 4 });
    const mid = blendOrbit(from, to, 0.5, out);
    expect(mid.radius).toBeCloseTo(2.5);
    expect(mid.inclination).toBeCloseTo(0.4);
    // 6.2 → 0.1 crosses 2π: halfway is near 2π, not near π.
    expect(Math.cos(mid.node)).toBeGreaterThan(0.99);
    const end = blendOrbit(from, to, 1, out);
    expect(Math.cos(end.node - to.node)).toBeCloseTo(1, 9);
    expect(end.speed).toBe(2);
  });

  it('place every point at the orbit radius from the centre', () => {
    const o = satelliteOrbit('a-r', 'steward', 5);
    const out: Vec3Tuple = [0, 0, 0];
    for (let t = 0; t < 30; t += 0.7) {
      const [x, y, z] = orbitOffset(o, orbitAngle(o, t), 3, out);
      expect(Math.hypot(x, y, z)).toBeCloseTo(3, 9);
    }
  });

  it('go counter-clockwise seen from +y (the scene convention) when not inclined', () => {
    const o = { ...satelliteOrbit('a-c', 'steward', 0), inclination: 0, node: 0 };
    const out: Vec3Tuple = [0, 0, 0];
    expect(orbitOffset(o, 0, 1, out).map((v) => +v.toFixed(6))).toEqual([1, 0, 0]);
    expect(orbitOffset(o, Math.PI / 2, 1, out).map((v) => +v.toFixed(6) || 0)).toEqual([0, 0, -1]);
  });

  it('keep the satellites of one crowded body apart at all times', () => {
    const list = [
      { agentId: 'a-waykeeper', role: 'waykeeper' as const, bodyId: 'b-mars' },
      ...stewards(12),
    ];
    const slots = orbitSlots(list);
    const orbits = list.map((s) => satelliteOrbit(s.agentId, s.role, slots.get(s.agentId) ?? 0));
    // No two share a radius: distinct shells, at least SHELL_STEP body radii apart.
    const radii = orbits.map((o) => o.radius).sort((a, b) => a - b);
    for (let i = 1; i < radii.length; i++)
      expect((radii[i] ?? 0) - (radii[i - 1] ?? 0)).toBeGreaterThanOrEqual(SHELL_STEP - 1e-9);
    // So their distance never drops below that gap (sizes are ≤ 0.16 body radii).
    const R = 2;
    const a: Vec3Tuple = [0, 0, 0];
    const b: Vec3Tuple = [0, 0, 0];
    let min = Infinity;
    for (let t = 0; t < 120; t += 0.5) {
      for (let i = 0; i < orbits.length; i++) {
        const oi = orbits[i];
        if (!oi) continue;
        orbitOffset(oi, orbitAngle(oi, t), oi.radius * R, a);
        for (let j = i + 1; j < orbits.length; j++) {
          const oj = orbits[j];
          if (!oj) continue;
          orbitOffset(oj, orbitAngle(oj, t), oj.radius * R, b);
          min = Math.min(min, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
        }
      }
    }
    expect(min).toBeGreaterThanOrEqual(SHELL_STEP * R - 1e-9);
    // And the orbit planes differ: inclinations and nodes are spread, not stacked.
    const planes = new Set(orbits.map((o) => `${o.inclination.toFixed(3)}:${o.node.toFixed(3)}`));
    expect(planes.size).toBe(orbits.length);
  });
});
