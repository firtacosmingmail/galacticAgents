import { afterEach, describe, expect, it } from 'vitest';
import type { Body } from '@galactic/protocol';
import { beltBounds, orbitPosition, taskAsteroids } from '../belt/belt-model.js';
import { buildRenderList } from '../bodies/layout.js';
import { backdropRadius, planetReach, resolveDetailBody } from './detail-body.js';
import {
  clearDome,
  currentDome,
  drawnBehindBackdrop,
  orbitLineFactor,
  orbitOutsideDome,
  publishDome,
  shellOutsideDome,
  sphereOutsideDome,
  type Dome,
} from './dome.js';

const owner = {};
afterEach(() => clearDome(owner));

describe('the dome registry', () => {
  it('publishes and clears; a stale owner cannot clear a newer dome', () => {
    expect(currentDome()).toBeUndefined();
    const centre: [number, number, number] = [1, 2, 3];
    publishDome(owner, centre, 10);
    expect(currentDome()).toEqual({ centre: [1, 2, 3], radius: 10 });
    const other = {};
    clearDome(other);
    expect(currentDome()).toBeDefined();
    clearDome(owner);
    expect(currentDome()).toBeUndefined();
  });
});

describe('what a settled backdrop hides (P6-01 review, S2)', () => {
  const dome: Dome = { centre: [100, 0, 0], radius: 44 };

  it('a sphere only when wholly outside', () => {
    expect(sphereOutsideDome([130, 0, 0], 2, dome)).toBe(false); // inside
    expect(sphereOutsideDome([145, 0, 0], 2, dome)).toBe(false); // straddles the dome
    expect(sphereOutsideDome([147, 0, 0], 2, dome)).toBe(true);
  });

  it('an orbit line about the Sun only when it does not come within the dome', () => {
    expect(orbitOutsideDome(100, dome)).toBe(false); // through the centre
    expect(orbitOutsideDome(140, dome)).toBe(false);
    expect(orbitOutsideDome(50, dome)).toBe(true);
    expect(orbitOutsideDome(150, dome)).toBe(true);
    // Above the plane: the vertical offset counts.
    expect(orbitOutsideDome(100, { centre: [100, 50, 0], radius: 44 })).toBe(true);
  });

  it('a shell (the belt) only when the dome is in its hole or beyond it', () => {
    expect(shellOutsideDome(80, 120, dome)).toBe(false);
    expect(shellOutsideDome(150, 200, dome)).toBe(true);
    expect(shellOutsideDome(10, 50, dome)).toBe(true);
    expect(shellOutsideDome(10, 60, dome)).toBe(false);
  });

  it('nothing is hidden until settled, nor without a dome', () => {
    const always = () => true;
    expect(drawnBehindBackdrop(false, always, dome)).toBe(true);
    expect(drawnBehindBackdrop(true, always, undefined)).toBe(true);
    expect(drawnBehindBackdrop(true, always, dome)).toBe(false);
    expect(drawnBehindBackdrop(true, () => false, dome)).toBe(true);
  });

  it("an asteroid's view keeps the belt and a nearby task asteroid drawn, not a far one", () => {
    const at = (id: string, phase: number): Body => ({
      id,
      kind: 'asteroid',
      name: id,
      host: { kind: 'task', id: `t-${id}` },
      meta: { orbit: { radius: 2.7, phase, inclination: 0.02 } },
    });
    const bodies: Record<string, Body> = {
      'b-ast-a': at('b-ast-a', 1),
      'b-ast-near': at('b-ast-near', 1.002),
      'b-ast-far': at('b-ast-far', 1 + Math.PI),
    };
    for (const mode of ['fake', 'true'] as const) {
      const shown = resolveDetailBody(bodies, 'b-ast-a', mode)!;
      if (shown.kind !== 'asteroid') throw new Error('asteroid');
      const d: Dome = {
        centre: orbitPosition(shown.asteroid.orbit, mode),
        radius: backdropRadius(shown),
      };
      // The belt passes through the dome: never hidden.
      const belt = beltBounds(mode);
      expect(shellOutsideDome(belt.inner, belt.outer, d)).toBe(false);
      const where = Object.fromEntries(
        taskAsteroids(bodies).map((a) => [a.bodyId, orbitPosition(a.orbit, mode)]),
      );
      expect(sphereOutsideDome(where['b-ast-near']!, 2, d), mode).toBe(false);
      expect(sphereOutsideDome(where['b-ast-far']!, 2, d), mode).toBe(true);
    }
  });

  it("a moon's view keeps its planet drawn; a planet's view the planet's own system", () => {
    const bodies: Record<string, Body> = {
      'b-jupiter': { id: 'b-jupiter', kind: 'planet', name: 'Jupiter', meta: { orbit: 5 } },
      'b-io': { id: 'b-io', kind: 'moon', name: 'Io', parentId: 'b-jupiter', meta: { orbit: 1 } },
      'b-callisto': {
        id: 'b-callisto',
        kind: 'moon',
        name: 'Callisto',
        parentId: 'b-jupiter',
        meta: { orbit: 4 },
      },
    };
    for (const mode of ['fake', 'true'] as const) {
      const jupiter = buildRenderList(bodies, mode).find((p) => p.bodyId === 'b-jupiter')!;
      const io = jupiter.moons.find((m) => m.bodyId === 'b-io')!;
      // Io's dome, centred on Io (at its distance from Jupiter).
      const ioDome: Dome = {
        centre: [jupiter.distance + io.distance, 0, 0],
        radius: backdropRadius(resolveDetailBody(bodies, 'b-io', mode)!),
      };
      expect(sphereOutsideDome([jupiter.distance, 0, 0], planetReach(jupiter), ioDome)).toBe(false);
      expect(orbitOutsideDome(jupiter.distance, ioDome)).toBe(false);
    }
  });
});

describe("the detail body's own orbit line", () => {
  it('fades out with the cross-fade and back in; other lines keep full opacity', () => {
    expect(orbitLineFactor(true, 0)).toBe(1);
    expect(orbitLineFactor(true, 0.25)).toBeCloseTo(0.75);
    expect(orbitLineFactor(true, 1)).toBe(0);
    expect(orbitLineFactor(false, 1)).toBe(1);
  });
});
