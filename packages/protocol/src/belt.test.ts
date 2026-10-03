import { describe, expect, it } from 'vitest';
import { asteroidSpec, BELT_ORBIT, BELT_SEED, drawBeltOrbit, mulberry32 } from './belt.js';

describe('belt generator (shared by the server catalogue and the web belt)', () => {
  it('produces the same asteroids as the server did before the move (P2-02 values)', () => {
    // Captured from apps/server/src/domain/catalogue.ts before P3-03 moved the generator here.
    expect([1, 2, 7, 42, 1000].map(asteroidSpec)).toEqual([
      {
        id: 'b-asteroid-1',
        name: '(1) Tioi',
        meta: {
          number: 1,
          seed: 3235535255,
          orbit: { radius: 2.918, phase: 5.801, inclination: 0.105 },
        },
      },
      {
        id: 'b-asteroid-2',
        name: '(2) Zezi',
        meta: {
          number: 2,
          seed: 1652806468,
          orbit: { radius: 2.615, phase: 1.253, inclination: -0.128 },
        },
      },
      {
        id: 'b-asteroid-7',
        name: '(7) Thifus',
        meta: {
          number: 7,
          seed: 225014769,
          orbit: { radius: 2.365, phase: 1.252, inclination: 0.141 },
        },
      },
      {
        id: 'b-asteroid-42',
        name: '(42) Pagaefae',
        meta: {
          number: 42,
          seed: 2884949804,
          orbit: { radius: 2.744, phase: 2.848, inclination: -0.131 },
        },
      },
      {
        id: 'b-asteroid-1000',
        name: '(1000) Miosiozae',
        meta: {
          number: 1000,
          seed: 1449032526,
          orbit: { radius: 2.903, phase: 0.334, inclination: 0.102 },
        },
      },
    ]);
  });

  it('keeps the seed and the orbit ranges', () => {
    expect(BELT_SEED).toBe(0x5eed2026);
    expect(BELT_ORBIT.innerAu + BELT_ORBIT.widthAu).toBeCloseTo(BELT_ORBIT.outerAu, 12);
    const rand = mulberry32(BELT_SEED);
    for (let i = 0; i < 2000; i++) {
      const o = drawBeltOrbit(rand);
      expect(o.radius).toBeGreaterThanOrEqual(BELT_ORBIT.innerAu);
      expect(o.radius).toBeLessThan(BELT_ORBIT.outerAu);
      expect(o.phase).toBeGreaterThanOrEqual(0);
      expect(o.phase).toBeLessThan(2 * Math.PI);
      expect(Math.abs(o.inclination)).toBeLessThanOrEqual(BELT_ORBIT.maxInclination);
    }
  });

  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
