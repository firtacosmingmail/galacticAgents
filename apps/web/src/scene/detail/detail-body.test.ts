import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Body } from '@galactic/protocol';
import { buildRenderList, planetAnchor, moonAnchor } from '../bodies/layout.js';
import { eclipseReceivers, ringsId } from '../bodies/eclipse.js';
import { TASK_ASTEROID_RADIUS } from '../belt/belt-model.js';
import { generateStarField } from '../starfield.js';
import { BACKDROP_STAR_SHELL, BACKDROP_SUN_AT, backdropStars, backdropSun } from './backdrop.js';
import {
  BACKDROP_MARGIN,
  BACKDROP_MIN_RADII,
  backdropRadius,
  detailEclipseReceivers,
  planetReach,
  resolveDetailBody,
} from './detail-body.js';
import { focusDistance, framedRadius, MIN_FRAMED_RADIUS, type View } from '../camera/flight.js';
import { DETAIL_FRAME_RADII, EXIT_RADII, radiiFrom, settleDue, zoomStep } from './mode.js';
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
        const fr = framedRadius(b.radius);
        expect(r).toBeGreaterThanOrEqual(fr * BACKDROP_MIN_RADII);
        const reach =
          b.kind === 'moon'
            ? b.moon.distance + planetReach(b.parent)
            : b.kind === 'asteroid'
              ? b.radius
              : planetReach(b.planet);
        expect(r).toBeGreaterThanOrEqual((reach + EXIT_RADII * fr) * BACKDROP_MARGIN);
        // The view's bodies (seen from a camera at most EXIT_RADII off the centre) come before the
        // backdrop's Sun and stars.
        const camera = EXIT_RADII * fr;
        expect(reach + camera).toBeLessThan(r * BACKDROP_SUN_AT);
        expect(reach + camera).toBeLessThan(r * (BACKDROP_STAR_SHELL.inner - camera / r));
        expect(r * BACKDROP_STAR_SHELL.outer + camera).toBeLessThan(r);
      }
    }
  });
});

/** The seeded catalogue, read from the migration itself (as `bodies/bodies-model.test.ts`). */
function seededCatalogue(): Record<string, Body> {
  const sql = readFileSync(
    resolve(import.meta.dirname, '../../../../server/src/db/migrations/0005_body_catalogue.sql'),
    'utf8',
  );
  const row =
    /\('(b-[a-z]+)', '(star|planet|moon)', (NULL|'b-[a-z]+'), '([A-Za-z]+)', '(\{[^']*\})'\)/g;
  const out: Record<string, Body> = {};
  for (const m of sql.matchAll(row)) {
    const [, id, kind, parent, name, meta] = m;
    out[id!] = {
      id: id!,
      kind: kind as Body['kind'],
      ...(parent !== 'NULL' ? { parentId: parent!.slice(1, -1) } : {}),
      name: name!,
      meta: JSON.parse(meta!) as Record<string, unknown>,
    };
  }
  return out;
}

describe('an explicit enter stays in once the flight lands (P6-01 review, B1)', () => {
  const catalogue = {
    ...seededCatalogue(),
    'b-ast-7': bodies['b-ast-7']!,
  };
  const moons = Object.values(catalogue).filter((b) => b.kind === 'moon');
  const views: View[] = [
    { fovDeg: 45, aspect: 16 / 9 },
    { fovDeg: 45, aspect: 0.5 },
  ];

  it('reads the whole catalogue (22 moons), many under MIN_FRAMED_RADIUS in true scale', () => {
    expect(moons).toHaveLength(22);
    const tiny = moons.filter(
      (m) => resolveDetailBody(catalogue, m.id, 'true')!.radius < MIN_FRAMED_RADIUS,
    );
    expect(tiny.length).toBeGreaterThan(0);
  });

  it('every moon, planet and a task asteroid, in both scales: lands inside, settles, stays', () => {
    const ids = Object.values(catalogue)
      .filter((b) => b.kind !== 'star')
      .map((b) => b.id);
    for (const mode of ['true', 'fake'] as const) {
      for (const id of ids) {
        const b = resolveDetailBody(catalogue, id, mode);
        expect(b, `${id} ${mode}`).toBeDefined();
        const centre: [number, number, number] = [123, 4, -56];
        for (const view of views) {
          // The camera's detail flight (`focusDistance` with `radii`) lands here…
          const d = focusDistance(b!.radius, view, DETAIL_FRAME_RADII);
          const eye: [number, number, number] = [centre[0], centre[1], centre[2] + d];
          // …which the watcher (`radiiFrom`, DetailLayer) measures as DETAIL_FRAME_RADII.
          const distance = radiiFrom(eye, centre, b!.radius);
          expect(distance, `${id} ${mode}`).toBeCloseTo(DETAIL_FRAME_RADII);
          const mode_ = { kind: 'detail', bodyId: id } as const;
          const at = { mode: mode_, zoomArmed: true, focusedId: id, flying: false, distance };
          expect(zoomStep({ ...at, detailable: true }), `${id} ${mode}`).toBeUndefined();
          expect(settleDue({ mode: mode_, fade: undefined, covered: false }, 0, at)).toBe(true);
          // …and the camera, anywhere up to EXIT_RADII off, is well inside the backdrop.
          expect(EXIT_RADII * framedRadius(b!.radius)).toBeLessThan(backdropRadius(b!) / 2);
        }
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
    // Per frame into a scratch object: no allocation.
    const out = { position: [0, 0, 0] as [number, number, number], radius: 0 };
    expect(backdropSun([0, 0, 50], 100, 6, out)).toBe(out);
    expect(out.position[2]).toBeCloseTo(-70);
    expect(out.radius).toBeCloseTo(6 * (70 / 50));
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
    // The registered parts: P6-05's station on Earth only (earth-hq.test.ts covers it).
    expect(partsFor(earth).map((p) => p.id)).toContain('earth-hq');
    expect(partsFor(jupiter).map((p) => p.id)).not.toContain('earth-hq');
    // P6-03's cutaway too, for a body with layer data (cutaway.test.ts covers it).
    expect(partsFor(earth).map((p) => p.id)).toContain('cutaway');
    expect(partsFor(earth, [])).toEqual([]);
  });
});

describe("a planet's detail view: its moons cast no shadow on it (P6-07, SPEC 87)", () => {
  const catalogue = seededCatalogue();
  it('drops the moons as casters on the planet only; the planet still shades its moons and rings', () => {
    for (const planet of buildRenderList(catalogue, 'fake')) {
      const system = eclipseReceivers(planet);
      const detail = detailEclipseReceivers(planet);
      expect(detail.map((r) => r.id)).toEqual(system.map((r) => r.id));
      expect(detail.find((r) => r.id === planet.bodyId)!.casters).toEqual([]);
      for (const r of detail.filter((r) => r.id !== planet.bodyId))
        expect(r).toEqual(system.find((s) => s.id === r.id));
    }
    const earth = buildRenderList(catalogue, 'fake').find((p) => p.bodyId === 'b-earth')!;
    // The system view keeps the Moon's shadow on Earth…
    expect(
      eclipseReceivers(earth)
        .find((r) => r.id === 'b-earth')!
        .casters.map((c) => c.bodyId),
    ).toEqual(['b-moon']);
    // …and Earth's on the Moon stays in the detail view.
    expect(
      detailEclipseReceivers(earth)
        .find((r) => r.id === 'b-moon')!
        .casters.map((c) => c.bodyId),
    ).toContain('b-earth');
    const saturn = buildRenderList(catalogue, 'fake').find((p) => p.bodyId === 'b-saturn')!;
    expect(
      detailEclipseReceivers(saturn)
        .find((r) => r.id === ringsId('b-saturn'))!
        .casters.map((c) => c.bodyId),
    ).toContain('b-saturn');
  });
});
