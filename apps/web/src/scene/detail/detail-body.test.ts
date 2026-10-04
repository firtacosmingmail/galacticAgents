import { describe, expect, it } from 'vitest';
import type { Body } from '@galactic/protocol';
import { buildRenderList, planetAnchor, moonAnchor } from '../bodies/layout.js';
import { TASK_ASTEROID_RADIUS } from '../belt/belt-model.js';
import { generateStarField } from '../starfield.js';
import { BACKDROP_STAR_SHELL, BACKDROP_SUN_AT, backdropStars, backdropSun } from './backdrop.js';
import {
  BACKDROP_MARGIN,
  BACKDROP_MIN_RADII,
  backdropRadius,
  planetReach,
  resolveDetailBody,
} from './detail-body.js';
import { EXIT_RADII } from './mode.js';
import { partsFor, type DetailPart } from './parts.js';

const body = (b: Body): [string, Body] => [b.id, b];
const bodies: Record<string, Body> = Object.fromEntries([
  body({ id: 'b-sun', kind: 'star', name: 'Sun' }),
  body({ id: 'b-earth', kind: 'planet', name: 'Earth', meta: { orbit: 3 } }),
  body({ id: 'b-moon', kind: 'moon', name: 'Moon', parentId: 'b-earth', meta: { orbit: 1 } }),
  body({ id: 'b-jupiter', kind: 'planet', name: 'Jupiter', meta: { orbit: 5 } }),
  ...['Io', 'Europa', 'Ganymede', 'Callisto'].map((name, i) =>
    body({
      id: `b-${name.toLowerCase()}`,
      kind: 'moon',
      name,
      parentId: 'b-jupiter',
      meta: { orbit: i + 1 },
    }),
  ),
  body({ id: 'b-saturn', kind: 'planet', name: 'Saturn', meta: { orbit: 6 } }),
  body({
    id: 'b-ast-7',
    kind: 'asteroid',
    name: '7 Iris',
    host: { kind: 'task', id: 't-1' },
    meta: { number: 7 },
  }),
]);

describe('resolveDetailBody', () => {
  it('resolves each kind with the layout the system draws (same radius as the anchor)', () => {
    for (const mode of ['fake', 'true'] as const) {
      const list = buildRenderList(bodies, mode);
      const jupiter = resolveDetailBody(bodies, 'b-jupiter', mode)!;
      expect(jupiter.kind).toBe('giant');
      expect(jupiter.radius).toBe(planetAnchor(list.find((p) => p.bodyId === 'b-jupiter')!).radius);
      const saturn = resolveDetailBody(bodies, 'b-saturn', mode)!;
      expect(saturn.radius).toBeGreaterThan(
        list.find((p) => p.bodyId === 'b-saturn')!.radius, // the rings are in the anchor's radius
      );
      expect(resolveDetailBody(bodies, 'b-earth', mode)!.kind).toBe('rocky');
      const europa = resolveDetailBody(bodies, 'b-europa', mode)!;
      expect(europa.kind).toBe('moon');
      if (europa.kind !== 'moon') throw new Error('moon');
      expect(europa.parent.bodyId).toBe('b-jupiter');
      expect(europa.radius).toBe(moonAnchor(europa.moon).radius);
      const iris = resolveDetailBody(bodies, 'b-ast-7', mode)!;
      expect(iris).toMatchObject({ kind: 'asteroid', radius: TASK_ASTEROID_RADIUS });
    }
  });

  it('nothing for the Sun, an unknown body, or an asteroid that hosts nothing', () => {
    expect(resolveDetailBody(bodies, 'b-sun', 'fake')).toBeUndefined();
    expect(resolveDetailBody(bodies, 'b-nowhere', 'fake')).toBeUndefined();
    const free = { ...bodies, 'b-ast-7': { ...bodies['b-ast-7']!, host: undefined } };
    expect(resolveDetailBody(free, 'b-ast-7', 'fake')).toBeUndefined();
  });
});

describe('backdropRadius', () => {
  it('holds the camera and every body of the view, beyond the stars and the Sun inside it', () => {
    for (const mode of ['fake', 'true'] as const) {
      for (const id of [
        'b-earth',
        'b-moon',
        'b-jupiter',
        'b-io',
        'b-callisto',
        'b-saturn',
        'b-ast-7',
      ]) {
        const b = resolveDetailBody(bodies, id, mode)!;
        const r = backdropRadius(b);
        expect(r).toBeGreaterThanOrEqual(b.radius * BACKDROP_MIN_RADII);
        const reach =
          b.kind === 'moon'
            ? b.moon.distance + planetReach(b.parent)
            : b.kind === 'asteroid'
              ? b.radius
              : planetReach(b.planet);
        expect(r).toBeGreaterThanOrEqual((reach + EXIT_RADII * b.radius) * BACKDROP_MARGIN);
        // The view's bodies (seen from a camera at most EXIT_RADII off the centre) come before the
        // backdrop's Sun and stars.
        const camera = EXIT_RADII * b.radius;
        expect(reach + camera).toBeLessThan(r * BACKDROP_SUN_AT);
        expect(reach + camera).toBeLessThan(r * (BACKDROP_STAR_SHELL.inner - camera / r));
        expect(r * BACKDROP_STAR_SHELL.outer + camera).toBeLessThan(r);
      }
    }
  });
});

describe('backdrop stars and Sun', () => {
  it("are the sky's stars, same directions and colours, on a shell inside the backdrop", () => {
    const sky = generateStarField(500);
    const stars = backdropStars(500);
    expect(stars.colors).toEqual(sky.colors);
    for (let i = 0; i < 500; i++) {
      const [x, y, z] = [
        stars.positions[i * 3]!,
        stars.positions[i * 3 + 1]!,
        stars.positions[i * 3 + 2]!,
      ];
      const [sx, sy, sz] = [
        sky.positions[i * 3]!,
        sky.positions[i * 3 + 1]!,
        sky.positions[i * 3 + 2]!,
      ];
      const r = Math.hypot(x, y, z);
      expect(r).toBeGreaterThanOrEqual(BACKDROP_STAR_SHELL.inner - 1e-6);
      expect(r).toBeLessThanOrEqual(BACKDROP_STAR_SHELL.outer + 1e-6);
      const sr = Math.hypot(sx, sy, sz);
      expect((x * sx + y * sy + z * sz) / (r * sr)).toBeCloseTo(1, 6);
    }
  });

  it('puts the Sun in its real direction at the size it has from the body', () => {
    const sun = backdropSun([100, 0, 0], 200, 6)!;
    expect(sun.position).toEqual([-140, -0, -0]);
    // Angular radius from the body: 6 / 100 in the system, the same on the backdrop.
    expect(sun.radius / 140).toBeCloseTo(6 / 100);
    expect(backdropSun([0, 0, 0], 200, 6)).toBeUndefined();
  });
});

describe('parts (extension slots for P6-02…P6-05)', () => {
  it('mounts the parts of the body kind that accept the body', () => {
    const earth = resolveDetailBody(bodies, 'b-earth', 'fake')!;
    const jupiter = resolveDetailBody(bodies, 'b-jupiter', 'fake')!;
    const Nothing = () => null;
    const parts: DetailPart[] = [
      { id: 'overlay', kinds: ['rocky', 'giant', 'moon', 'asteroid'], Component: Nothing },
      { id: 'hq', kinds: ['rocky'], accepts: (b) => b.bodyId === 'b-earth', Component: Nothing },
      { id: 'cutaway', kinds: ['giant'], Component: Nothing },
    ];
    expect(partsFor(earth, parts).map((p) => p.id)).toEqual(['overlay', 'hq']);
    expect(partsFor(jupiter, parts).map((p) => p.id)).toEqual(['overlay', 'cutaway']);
    expect(partsFor(earth)).toEqual([]);
  });
});
