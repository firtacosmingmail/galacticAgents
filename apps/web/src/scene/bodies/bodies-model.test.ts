import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Body } from '@galactic/protocol';
import { allAnchors, getAnchor, SUN_ANCHOR_ID } from '../anchors.js';
import {
  auToScene,
  FAKE_SPACING,
  PLANET_AU,
  TRUE_SIZE_EXAGGERATION,
  useSceneScale,
  type ScaleMode,
} from '../scale.js';
import { STAR_SHELL } from '../starfield.js';
import { DEFAULT_LOOK, DEFAULT_MOON_LOOK, MOON_LOOKS, PLANET_LOOKS } from './appearance.js';
import { attachAnchor } from '../anchor-binding.js';
import {
  anchorSpecs,
  angleBetween,
  buildRenderList,
  castsShadow,
  circlePoints,
  FAR_SIDE_ANGLE,
  FAR_SIDE_MARGIN,
  orbitAngle,
  safePhase,
  type PlanetItem,
} from './layout.js';
import {
  motionEnabled,
  prefersReducedMotion,
  REDUCED_MOTION_QUERY,
  sceneFrameloop,
} from '../motion.js';
import { orbitPoint } from '../orbit.js';
import { paintRings, paintSurface } from './surface.js';
import type { Object3D } from 'three';

/** The seeded catalogue, read from the migration itself so the test follows it. */
function seededCatalogue(): Body[] {
  const sql = readFileSync(
    resolve(import.meta.dirname, '../../../../server/src/db/migrations/0005_body_catalogue.sql'),
    'utf8',
  );
  const row =
    /\('(b-[a-z]+)', '(star|planet|moon)', (NULL|'b-[a-z]+'), '([A-Za-z]+)', '(\{[^']*\})'\)/g;
  const bodies: Body[] = [];
  for (const m of sql.matchAll(row)) {
    const [, id, kind, parent, name, meta] = m;
    bodies.push({
      id: id!,
      kind: kind as Body['kind'],
      ...(parent !== 'NULL' ? { parentId: parent!.slice(1, -1) } : {}),
      name: name!,
      meta: JSON.parse(meta!) as Record<string, unknown>,
    });
  }
  return bodies;
}

const CATALOGUE = seededCatalogue();
const MODES: ScaleMode[] = ['fake', 'true'];

function systemExtent(p: PlanetItem): { inner: number; outer: number } {
  const reach = Math.max(p.outerRadius, ...p.moons.map((m) => m.distance + m.radius));
  return { inner: p.distance - reach, outer: p.distance + reach };
}

describe('the seeded catalogue (sanity)', () => {
  it('has the Sun, 8 planets and 22 moons', () => {
    expect(CATALOGUE.filter((b) => b.kind === 'star').map((b) => b.id)).toEqual(['b-sun']);
    expect(CATALOGUE.filter((b) => b.kind === 'planet')).toHaveLength(8);
    expect(CATALOGUE.filter((b) => b.kind === 'moon')).toHaveLength(22);
  });
});

describe('scale', () => {
  it('auToScene is strictly increasing in both modes, past Neptune too', () => {
    for (const mode of MODES) {
      let prev = -Infinity;
      for (let au = 0; au <= 60; au += 0.05) {
        const d = auToScene(au, mode);
        expect(d).toBeGreaterThan(prev);
        prev = d;
      }
      expect(auToScene(-1, mode)).toBe(auToScene(0, mode));
    }
  });

  it('the fake spacing table hits each planet exactly and is strictly increasing', () => {
    PLANET_AU.forEach((au, i) =>
      expect(auToScene(au, 'fake')).toBeCloseTo(FAKE_SPACING[i + 1]![1]),
    );
    for (let i = 1; i < FAKE_SPACING.length; i++) {
      expect(FAKE_SPACING[i]![0]).toBeGreaterThan(FAKE_SPACING[i - 1]![0]);
      expect(FAKE_SPACING[i]![1]).toBeGreaterThan(FAKE_SPACING[i - 1]![1]);
    }
  });

  it('the belt (2.2–3.3 AU) lies between Mars and Jupiter, clear of their moons, in both modes', () => {
    for (const mode of MODES) {
      const list = buildRenderList(CATALOGUE, mode);
      const mars = list.find((p) => p.name === 'Mars')!;
      const jupiter = list.find((p) => p.name === 'Jupiter')!;
      const beltInner = auToScene(2.2, mode);
      const beltOuter = auToScene(3.3, mode);
      expect(mars.distance).toBeLessThan(beltInner);
      expect(beltOuter).toBeLessThan(jupiter.distance);
      expect(systemExtent(mars).outer).toBeLessThan(beltInner);
      expect(systemExtent(jupiter).inner).toBeGreaterThan(beltOuter);
    }
  });

  it('no planet system reaches a neighbour’s or the Sun, and everything stays inside the sky', () => {
    for (const mode of MODES) {
      const list = buildRenderList(CATALOGUE, mode);
      expect(systemExtent(list[0]!).inner).toBeGreaterThan(6); // SUN_RADIUS
      for (let i = 1; i < list.length; i++) {
        expect(systemExtent(list[i]!).inner).toBeGreaterThan(systemExtent(list[i - 1]!).outer);
      }
      expect(systemExtent(list[list.length - 1]!).outer).toBeLessThan(STAR_SHELL.inner);
    }
  });

  it('true scale keeps the real proportions of distances and sizes', () => {
    const list = buildRenderList(CATALOGUE, 'true');
    const earth = list.find((p) => p.name === 'Earth')!;
    const neptune = list.find((p) => p.name === 'Neptune')!;
    const jupiter = list.find((p) => p.name === 'Jupiter')!;
    expect(neptune.distance / earth.distance).toBeCloseTo(30.07, 1);
    expect(jupiter.radius / earth.radius).toBeCloseTo(69911 / 6371, 3);
    expect(TRUE_SIZE_EXAGGERATION).toBeGreaterThan(50);
  });

  it('the scale store toggles between the two modes', () => {
    expect(useSceneScale.getState().mode).toBe('fake');
    useSceneScale.getState().setMode('true');
    expect(useSceneScale.getState().mode).toBe('true');
    useSceneScale.getState().setMode('fake');
    expect(useSceneScale.getState().mode).toBe('fake');
  });
});

describe('appearance', () => {
  it('covers every seeded planet and moon', () => {
    for (const b of CATALOGUE) {
      if (b.kind === 'planet') expect(PLANET_LOOKS[b.name], b.name).toBeDefined();
      if (b.kind === 'moon') expect(MOON_LOOKS[b.name], b.name).toBeDefined();
    }
  });

  it('gives Saturn and Uranus rings, and only them; tilts are real', () => {
    const ringed = Object.entries(PLANET_LOOKS)
      .filter(([, l]) => l.rings)
      .map(([n]) => n);
    expect(ringed.sort()).toEqual(['Saturn', 'Uranus']);
    expect(PLANET_LOOKS['Uranus']!.tiltDeg).toBeGreaterThan(90);
    expect(PLANET_LOOKS['Earth']!.tiltDeg).toBeCloseTo(23.44);
  });

  it('every moon has a real distance outside its planet', () => {
    for (const b of CATALOGUE.filter((x) => x.kind === 'moon')) {
      const parent = CATALOGUE.find((p) => p.id === b.parentId)!;
      expect(MOON_LOOKS[b.name]!.distanceKm!).toBeGreaterThan(PLANET_LOOKS[parent.name]!.radiusKm);
    }
  });

  it('paints surfaces and rings deterministically, opaque, and different per body', () => {
    const mars = paintSurface(PLANET_LOOKS['Mars']!, 32, 16);
    expect(mars).toHaveLength(32 * 16 * 4);
    expect(paintSurface(PLANET_LOOKS['Mars']!, 32, 16)).toEqual(mars);
    expect(paintSurface(PLANET_LOOKS['Neptune']!, 32, 16)).not.toEqual(mars);
    for (let i = 3; i < mars.length; i += 4) expect(mars[i]).toBe(255);
    for (const look of [...Object.values(PLANET_LOOKS), ...Object.values(MOON_LOOKS)]) {
      expect(paintSurface(look, 16, 8).every((v) => Number.isFinite(v))).toBe(true);
    }
    const rings = paintRings(PLANET_LOOKS['Saturn']!.rings!, 64);
    expect(rings).toHaveLength(64 * 4);
    expect(rings[3]).toBeLessThan(64); // faded inner edge
    expect(Math.max(...rings.filter((_, i) => i % 4 === 3))).toBeGreaterThan(128);
  });
});

describe('world → render list', () => {
  it('draws every seeded planet in orbit order with its moons, reserved bodies included', () => {
    const list = buildRenderList(CATALOGUE, 'fake');
    expect(list.map((p) => p.name)).toEqual([
      'Mercury',
      'Venus',
      'Earth',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
    ]);
    const earth = list[2]!;
    expect(earth.reserved).toBe(true);
    expect(earth.moons.map((m) => [m.bodyId, m.reserved])).toEqual([['b-moon', true]]);
    expect(list.find((p) => p.name === 'Saturn')!.moons.map((m) => m.name)).toEqual([
      'Mimas',
      'Enceladus',
      'Tethys',
      'Dione',
      'Rhea',
      'Titan',
      'Iapetus',
    ]);
    const moons = list.flatMap((p) => p.moons);
    expect(moons).toHaveLength(22);
    expect(list.every((p) => p.known) && moons.every((m) => m.known)).toBe(true);
    // Distances grow outward; moons orbit outside their planet (and its rings).
    for (let i = 1; i < list.length; i++)
      expect(list[i]!.distance).toBeGreaterThan(list[i - 1]!.distance);
    for (const p of list) {
      let prev = p.outerRadius;
      for (const m of p.moons) {
        expect(m.distance).toBeGreaterThan(prev);
        prev = m.distance;
      }
    }
  });

  it('accepts the store’s record form and ignores the Sun and asteroids', () => {
    const record = Object.fromEntries(
      [
        ...CATALOGUE,
        { id: 'a-1', kind: 'asteroid', name: 'A-1', meta: { orbit: { radius: 2.5 } } } as Body,
      ].map((b) => [b.id, b]),
    );
    const list = buildRenderList(record, 'fake');
    expect(list).toHaveLength(8);
    expect(list.some((p) => p.bodyId === 'b-sun' || p.bodyId === 'a-1')).toBe(false);
  });

  it('gives unknown bodies the default look, and places orbit-less planets past the last', () => {
    const bodies: Body[] = [
      ...CATALOGUE,
      { id: 'b-vulcan', kind: 'planet', name: 'Vulcan' },
      { id: 'b-x', kind: 'moon', parentId: 'b-vulcan', name: 'X', meta: { orbit: 1 } },
      { id: 'b-orphan', kind: 'moon', parentId: 'b-nowhere', name: 'Orphan' },
    ];
    const list = buildRenderList(bodies, 'fake');
    const vulcan = list[list.length - 1]!;
    expect(vulcan.bodyId).toBe('b-vulcan');
    expect(vulcan.orbit).toBe(9);
    expect(vulcan.known).toBe(false);
    expect(vulcan.look.style).toBe(DEFAULT_LOOK.style);
    expect(vulcan.radius).toBe(DEFAULT_LOOK.radius);
    expect(vulcan.distance).toBeGreaterThan(list[list.length - 2]!.distance);
    expect(vulcan.moons.map((m) => [m.bodyId, m.known, m.radius])).toEqual([
      ['b-x', false, DEFAULT_MOON_LOOK.radius],
    ]);
    expect(list.flatMap((p) => p.moons).some((m) => m.bodyId === 'b-orphan')).toBe(false);
  });

  it('two planets claiming the same orbit do not overlap', () => {
    const bodies: Body[] = [
      { id: 'b-a', kind: 'planet', name: 'Mars', meta: { orbit: 4 } },
      { id: 'b-b', kind: 'planet', name: 'Other', meta: { orbit: 4 } },
    ];
    const [a, b] = buildRenderList(bodies, 'fake');
    expect(a!.orbit).toBe(4);
    expect(b!.orbit).toBe(5);
  });

  it('an empty world draws nothing', () => {
    expect(buildRenderList({}, 'fake')).toEqual([]);
  });
});

describe('orbits and motion', () => {
  it('no planet starts behind the Sun (as seen from the default camera)', () => {
    for (const mode of MODES) {
      for (const p of buildRenderList(CATALOGUE, mode)) {
        expect(angleBetween(p.phase, FAR_SIDE_ANGLE)).toBeGreaterThanOrEqual(
          FAR_SIDE_MARGIN - 1e-9,
        );
        const [x, , z] = orbitPoint(p.distance, orbitAngle(p.phase, p.period, 0));
        // Not hidden by the Sun's disc: either in front of it, or off to the side by more than it.
        expect(z > 0 || Math.abs(x) > 6 + p.radius).toBe(true);
      }
    }
  });

  it('safePhase leaves free angles alone and pushes far-side ones out of the cone', () => {
    expect(safePhase(0)).toBeCloseTo(0);
    expect(safePhase(Math.PI)).toBeCloseTo(Math.PI);
    for (const a of [FAR_SIDE_ANGLE, FAR_SIDE_ANGLE + 0.1, FAR_SIDE_ANGLE - 0.1]) {
      expect(angleBetween(safePhase(a), FAR_SIDE_ANGLE)).toBeCloseTo(FAR_SIDE_MARGIN);
    }
  });

  it('orbits are slow and decorative: outer planets slower, a full turn per period', () => {
    const list = buildRenderList(CATALOGUE, 'fake');
    for (let i = 1; i < list.length; i++)
      expect(list[i]!.period).toBeGreaterThan(list[i - 1]!.period);
    expect(list[0]!.period).toBeGreaterThanOrEqual(60);
    const p = list[0]!;
    expect(orbitAngle(p.phase, p.period, p.period) - p.phase).toBeCloseTo(Math.PI * 2);
    const [x, , z] = orbitPoint(10, Math.PI / 2);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(-10); // the far side from a camera on +z
  });

  it('orbit lines are circles of the right radius', () => {
    const pts = circlePoints(5, 8);
    expect(pts).toHaveLength(24);
    for (let i = 0; i < 8; i++) {
      expect(Math.hypot(pts[i * 3]!, pts[i * 3 + 2]!)).toBeCloseTo(5);
      expect(pts[i * 3 + 1]).toBe(0);
    }
  });
});

describe('reduced motion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('without matchMedia (jsdom) there is no preference: motion on, loop continuous', () => {
    expect(prefersReducedMotion()).toBe(false);
    expect(sceneFrameloop({ motion: motionEnabled(false), fpsMeter: false })).toBe('always');
  });

  it('prefers-reduced-motion stops the motion and the loop goes back to on demand', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === REDUCED_MOTION_QUERY,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(prefersReducedMotion()).toBe(true);
    expect(motionEnabled(true)).toBe(false);
    expect(sceneFrameloop({ motion: false, fpsMeter: false })).toBe('demand');
    // The fps meter still needs a continuous loop to measure.
    expect(sceneFrameloop({ motion: false, fpsMeter: true })).toBe('always');
  });
});

describe('anchors', () => {
  const object = (name: string) => ({ name }) as unknown as Object3D;

  it('every drawn planet and moon has an anchor spec, with the same ids in both modes', () => {
    const fake = anchorSpecs(buildRenderList(CATALOGUE, 'fake'));
    const real = anchorSpecs(buildRenderList(CATALOGUE, 'true'));
    expect(fake).toHaveLength(30);
    expect(fake.map((a) => a.bodyId)).toEqual(real.map((a) => a.bodyId));
    expect(new Set(fake.map((a) => a.bodyId)).size).toBe(30);
    const saturn = fake.find((a) => a.bodyId === 'b-saturn')!;
    expect(saturn.kind).toBe('planet');
    expect(saturn.radius).toBeCloseTo(3.8 * 2.27); // framed with its rings
    expect(fake.find((a) => a.bodyId === 'b-titan')!.kind).toBe('moon');
    expect(real.find((a) => a.bodyId === 'b-saturn')!.radius).not.toBeCloseTo(saturn.radius);
  });

  it('attach registers, the cleanup unregisters, and a re-registration (scale change) keeps the id', () => {
    const mars = object('Mars');
    const detach = attachAnchor({ bodyId: 'b-mars', radius: 1.2, kind: 'planet' }, mars);
    expect(getAnchor('b-mars')).toMatchObject({ bodyId: 'b-mars', radius: 1.2, object: mars });
    // React runs the old cleanup, then the new effect, when the radius changes.
    detach();
    const detach2 = attachAnchor({ bodyId: 'b-mars', radius: 0.07, kind: 'planet' }, mars);
    expect(getAnchor('b-mars')?.radius).toBe(0.07);
    detach2();
    expect(getAnchor('b-mars')).toBeUndefined();
  });

  it('a stale cleanup does not remove a newer registration; no object, no anchor', () => {
    const stale = attachAnchor({ bodyId: 'b-io', radius: 0.4, kind: 'moon' }, object('a'));
    const fresh = attachAnchor({ bodyId: 'b-io', radius: 0.4, kind: 'moon' }, object('b'));
    stale();
    expect(getAnchor('b-io')).toBeDefined();
    fresh();
    const before = allAnchors().length;
    attachAnchor({ bodyId: 'b-none', radius: 1, kind: 'moon' }, null)();
    expect(allAnchors()).toHaveLength(before);
  });

  it('anchors carry a stable order: planets by orbit, moons by planet orbit then rank', () => {
    for (const mode of MODES) {
      const specs = anchorSpecs(buildRenderList(CATALOGUE, mode));
      const order = (id: string) => specs.find((a) => a.bodyId === id)!.order;
      expect(order('b-mercury')).toBe(1);
      expect(order('b-neptune')).toBe(8);
      expect(order('b-phobos')).toBeLessThan(order('b-deimos'));
      expect(order('b-deimos')).toBeLessThan(order('b-io'));
      expect(order('b-io')).toBeLessThan(order('b-europa'));
      expect(order('b-triton')).toBeLessThan(order('b-nereid'));
    }
  });

  it('the Sun registers under the catalogue id', () => {
    expect(SUN_ANCHOR_ID).toBe(CATALOGUE.find((b) => b.kind === 'star')!.id);
  });
});

describe('shadows', () => {
  it('planets cast; only the largest moons do (the small ones would be a few pixels)', () => {
    const list = buildRenderList(CATALOGUE, 'fake');
    const casters = list.flatMap((p) => p.moons.filter((m) => m.castShadow).map((m) => m.name));
    expect(casters.sort()).toEqual(
      ['Callisto', 'Europa', 'Ganymede', 'Io', 'Moon', 'Titan', 'Triton'].sort(),
    );
    expect(castsShadow(MOON_LOOKS['Phobos']!)).toBe(false);
    expect(castsShadow(DEFAULT_MOON_LOOK)).toBe(false);
  });
});
