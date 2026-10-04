import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Plane,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Body } from '@galactic/protocol';
import { PLANET_LOOKS, MOON_LOOKS } from '../../bodies/appearance.js';
import { resolveDetailBody } from '../detail-body.js';
import { DETAIL_PARTS, partsFor } from '../parts.js';
import { acceptsCutaway, cutawayTarget, isCutMesh } from './target.js';
import { clipBody, parkPlanes, unclip, type ClippedMaterials } from './clipping.js';
import {
  CUTAWAY_BODIES,
  cutawayLayers,
  displayRadii,
  hasCutaway,
  INTERIORS,
  layersDescription,
  MIN_BAND,
} from './layers.js';
import {
  easeOpen,
  faceGeometry,
  inWedge,
  labelPoint,
  mixGate,
  OPEN_S,
  spreadVertically,
  stepOpen,
  WEDGE_ANGLE,
  wedgeAbout,
} from './wedge.js';

/** P6-03 without WebGL: the layer tables, the wedge's maths and the part's registration. */

const ROCKY = ['Mercury', 'Venus', 'Earth', 'Mars'];
const GIANTS = ['Jupiter', 'Saturn', 'Uranus', 'Neptune'];

describe('layer tables', () => {
  it('cover the rocky planets, the Moon and the four giants', () => {
    expect([...CUTAWAY_BODIES].sort()).toEqual([...ROCKY, ...GIANTS, 'Moon'].sort());
    for (const name of [...ROCKY, ...GIANTS]) expect(INTERIORS[name]!.kind).toBe('planet');
    expect(INTERIORS.Moon!.kind).toBe('moon');
  });

  it('every listed body is a catalogue body the appearance table knows', () => {
    for (const [name, interior] of Object.entries(INTERIORS)) {
      const table = interior.kind === 'planet' ? PLANET_LOOKS : MOON_LOOKS;
      expect(table[name], name).toBeDefined();
    }
  });

  it('radii fractions start at the surface, fall strictly inward, and the bands sum to the radius', () => {
    for (const [name, { layers }] of Object.entries(INTERIORS)) {
      expect(layers.length, name).toBeGreaterThanOrEqual(3);
      expect(layers[0]!.outer, name).toBe(1);
      let sum = 0;
      for (const [i, layer] of layers.entries()) {
        expect(layer.outer, `${name} ${layer.name}`).toBeGreaterThan(0);
        expect(layer.outer, `${name} ${layer.name}`).toBeLessThanOrEqual(1);
        const inner = layers[i + 1]?.outer ?? 0;
        expect(inner, `${name} ${layer.name}`).toBeLessThan(layer.outer);
        sum += layer.outer - inner;
      }
      expect(sum).toBeLessThanOrEqual(1 + 1e-9);
      expect(sum).toBeCloseTo(1);
    }
  });

  it('names are unique per body, colours are hex, notes are filled in', () => {
    for (const { layers } of Object.values(INTERIORS)) {
      expect(new Set(layers.map((l) => l.name)).size).toBe(layers.length);
      for (const l of layers) {
        expect(l.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(l.note.length).toBeGreaterThan(0);
      }
    }
  });

  it('rocky bodies are crust → mantle → core; giants have an envelope over a deeper layer and a core', () => {
    for (const name of [...ROCKY, 'Moon']) {
      const names = INTERIORS[name]!.layers.map((l) => l.name);
      expect(names.slice(0, 2)).toEqual(['Crust', 'Mantle']);
      expect(names.at(-1)).toMatch(/core/i);
    }
    expect(INTERIORS.Earth!.layers.map((l) => l.name)).toEqual([
      'Crust',
      'Mantle',
      'Outer core',
      'Inner core',
    ]);
    for (const name of ['Jupiter', 'Saturn'])
      expect(INTERIORS[name]!.layers.map((l) => l.name)).toEqual([
        'Molecular hydrogen',
        'Metallic hydrogen',
        'Core',
      ]);
    for (const name of ['Uranus', 'Neptune'])
      expect(INTERIORS[name]!.layers.map((l) => l.name)).toEqual([
        'Hydrogen–helium envelope',
        'Ice mantle',
        'Rocky core',
      ]);
  });

  it('look up by name and kind: a made-up moon called Mars or an unknown body has none', () => {
    expect(cutawayLayers({ kind: 'planet', name: 'Earth' })).toBe(INTERIORS.Earth!.layers);
    expect(hasCutaway({ kind: 'moon', name: 'Moon' })).toBe(true);
    expect(hasCutaway({ kind: 'moon', name: 'Mars' })).toBe(false);
    expect(hasCutaway({ kind: 'planet', name: 'Moon' })).toBe(false);
    expect(hasCutaway({ kind: 'moon', name: 'Io' })).toBe(false);
    expect(hasCutaway({ kind: 'star', name: 'Sun' })).toBe(false);
    expect(hasCutaway({ kind: 'asteroid', name: '7 Iris' })).toBe(false);
    expect(hasCutaway({ kind: 'planet', name: 'toString' })).toBe(false);
    expect(hasCutaway(undefined)).toBe(false);
  });

  it('drawn radii keep every band at least MIN_BAND thick and stay monotonic', () => {
    for (const { layers } of Object.values(INTERIORS)) {
      const drawn = displayRadii(layers);
      expect(drawn[0]).toBe(1);
      for (let i = 0; i < drawn.length; i++) {
        const inner = drawn[i + 1] ?? 0;
        expect(drawn[i]! - inner).toBeGreaterThanOrEqual(MIN_BAND - 1e-9);
        expect(drawn[i]!).toBeLessThanOrEqual(layers[i]!.outer);
      }
    }
    // Earth's crust (0.5 % of the radius) is drawn thicker; the cores are true to scale.
    const earth = displayRadii(INTERIORS.Earth!.layers);
    expect(earth[1]).toBeCloseTo(1 - MIN_BAND);
    expect(earth.slice(2)).toEqual([0.546, 0.192]);
  });

  it('the screen-reader description lists every layer from the surface inward', () => {
    expect(layersDescription('Earth', INTERIORS.Earth!.layers)).toBe(
      "Earth's layers, from the surface inward: crust (granite and basalt), mantle (hot silicate rock), " +
        'outer core (liquid iron and nickel), inner core (solid iron and nickel).',
    );
  });
});

describe('the wedge', () => {
  it('removes exactly the quarter facing the camera, through both poles', () => {
    const w = wedgeAbout(0, WEDGE_ANGLE); // camera on +x
    expect(inWedge(w, [1, 0, 0])).toBe(true);
    expect(inWedge(w, [0.5, 0.9, 0.1])).toBe(true);
    expect(inWedge(w, [0.5, -0.9, -0.1])).toBe(true);
    expect(inWedge(w, [-1, 0, 0])).toBe(false);
    expect(inWedge(w, [0, 0, 1])).toBe(false);
    expect(inWedge(w, [0.6, 0, 0.8])).toBe(false); // 53° off the camera: outside the ±45°
    expect(inWedge(w, [0.8, 0, 0.6])).toBe(true); // 37°
    const back = wedgeAbout(Math.PI, WEDGE_ANGLE);
    expect(inWedge(back, [-1, 0, 0])).toBe(true);
    expect(inWedge(back, [1, 0, 0])).toBe(false);
  });

  it('a closed wedge removes nothing', () => {
    const w = wedgeAbout(0.3, 0);
    for (const p of [
      [1, 0, 0],
      [Math.cos(0.3), 0, Math.sin(0.3)],
      [0, 1, 0],
    ] as const)
      expect(inWedge(w, p)).toBe(false);
  });

  it('opens and closes over OPEN_S, instantly with reduced motion', () => {
    expect(stepOpen(0, 1, OPEN_S / 2, false)).toBeCloseTo(0.5);
    expect(stepOpen(0.5, 1, OPEN_S, false)).toBe(1);
    expect(stepOpen(1, 0, OPEN_S / 4, false)).toBeCloseTo(0.75);
    expect(stepOpen(0.1, 0, 10, false)).toBe(0);
    expect(stepOpen(0, 1, 0, true)).toBe(1);
    expect(stepOpen(1, 0, 0, true)).toBe(0);
    expect(easeOpen(0)).toBe(0);
    expect(easeOpen(1)).toBe(1);
    expect(easeOpen(0.5)).toBeCloseTo(0.5);
  });

  it('shows only once the detail view has faded in', () => {
    expect(mixGate(0)).toBe(0);
    expect(mixGate(0.5)).toBe(0);
    expect(mixGate(1)).toBe(1);
    expect(mixGate(0.8)).toBeGreaterThan(0);
    expect(mixGate(0.8)).toBeLessThan(1);
  });

  it('faces: one half annulus per band, inside the unit radius, coloured per band', () => {
    const radii = [1, 0.5, 0.2];
    const colors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as const;
    const face = faceGeometry(radii, colors, 8);
    // Two triangles a step for the annuli, one for the central half disc.
    expect(face.positions.length / 3).toBe(8 * 6 * 2 + 8 * 3);
    expect(face.colors.length).toBe(face.positions.length);
    for (let i = 0; i < face.positions.length; i += 3) {
      const [x, y, z] = [face.positions[i]!, face.positions[i + 1]!, face.positions[i + 2]!];
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(1 + 1e-6);
      expect(x).toBeGreaterThanOrEqual(-1e-6); // the +x half
      expect(z).toBe(0);
    }
    expect([...face.colors.slice(0, 3)]).toEqual([1, 0, 0]);
    expect([...face.colors.slice(-3)]).toEqual([0, 0, 1]);
  });

  it('labels point at the middle of their band, on the face', () => {
    const p = labelPoint(1, 0.5, 0);
    expect(Math.hypot(...p)).toBeCloseTo(0.75);
    expect(p[2]).toBeCloseTo(0);
    expect(p[1]).toBeGreaterThan(0);
    const q = labelPoint(0.4, 0, Math.PI / 2);
    expect(q[0]).toBeCloseTo(0);
    expect(q[2]).toBeGreaterThan(0);
  });

  it('spreads labels apart vertically, keeping their order', () => {
    expect(spreadVertically([100, 200, 300], 20)).toEqual([100, 200, 300]);
    const ys = spreadVertically([100, 105, 108], 20);
    expect(ys[1]! - ys[0]!).toBeCloseTo(20);
    expect(ys[2]! - ys[1]!).toBeCloseTo(20);
    // Pulled back up by half the overflow, so the stack stays about where the labels point.
    expect(ys[0]).toBeLessThan(100);
    const unordered = spreadVertically([50, 10, 52], 10);
    expect(unordered[1]).toBeLessThan(unordered[0]!);
    expect(unordered[2]! - unordered[0]!).toBeGreaterThanOrEqual(10 - 1e-9);
  });
});

describe('the part', () => {
  const body = (b: Body): [string, Body] => [b.id, b];
  const bodies: Record<string, Body> = Object.fromEntries([
    body({ id: 'b-earth', kind: 'planet', name: 'Earth', meta: { orbit: 3 } }),
    body({ id: 'b-moon', kind: 'moon', name: 'Moon', parentId: 'b-earth', meta: { orbit: 1 } }),
    body({ id: 'b-mars', kind: 'planet', name: 'Mars', meta: { orbit: 4 } }),
    body({ id: 'b-phobos', kind: 'moon', name: 'Phobos', parentId: 'b-mars', meta: { orbit: 1 } }),
    body({ id: 'b-jupiter', kind: 'planet', name: 'Jupiter', meta: { orbit: 5 } }),
    body({ id: 'b-saturn', kind: 'planet', name: 'Saturn', meta: { orbit: 6 } }),
    body({
      id: 'b-demo',
      kind: 'planet',
      name: 'Demo planet 1',
      host: { kind: 'project', id: 'p' },
    }),
    body({
      id: 'b-ast-7',
      kind: 'asteroid',
      name: '7 Iris',
      host: { kind: 'task', id: 't-1' },
      meta: { number: 7 },
    }),
  ]);
  const resolve = (id: string) => resolveDetailBody(bodies, id, 'fake')!;
  const ids = (id: string) => partsFor(resolve(id)).map((p) => p.id);

  it('is registered once, for the rocky, giant and moon views', () => {
    const parts = DETAIL_PARTS.filter((p) => p.id === 'cutaway');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.kinds).toEqual(['rocky', 'giant', 'moon']);
  });

  it('mounts only for bodies with layer data (a rocky planet, a gas giant, the Moon)', () => {
    for (const id of ['b-earth', 'b-mars', 'b-jupiter', 'b-saturn', 'b-moon'])
      expect(ids(id), id).toContain('cutaway');
    for (const id of ['b-phobos', 'b-demo', 'b-ast-7'])
      expect(ids(id), id).not.toContain('cutaway');
    expect(acceptsCutaway(resolve('b-phobos'))).toBe(false);
  });

  it('cuts the body sphere: the planet at its radius and tilt (not the rings), the Moon untilted', () => {
    const saturn = resolve('b-saturn');
    const target = cutawayTarget(saturn)!;
    expect(saturn.kind).toBe('giant');
    if (saturn.kind !== 'giant') return;
    expect(target.radius).toBe(saturn.planet.radius);
    expect(target.radius).toBeLessThan(saturn.radius); // `radius` includes the rings
    expect(target.tiltDeg).toBe(saturn.planet.look.tiltDeg);
    const moon = resolve('b-moon');
    if (moon.kind !== 'moon') throw new Error('kind');
    expect(cutawayTarget(moon)).toMatchObject({ radius: moon.moon.radius, tiltDeg: 0 });
  });

  it('clips sphere meshes and opted-in meshes only', () => {
    const sphere = new Mesh(new SphereGeometry(1));
    const ring = new Mesh(new RingGeometry(1, 2));
    const box = new Mesh(new BoxGeometry());
    const optOut = new Mesh(new SphereGeometry(1));
    optOut.userData.cutaway = false;
    const optIn = new Mesh(new BoxGeometry());
    optIn.userData.cutaway = true;
    expect(isCutMesh(sphere)).toBe(true);
    expect(isCutMesh(ring)).toBe(false);
    expect(isCutMesh(box)).toBe(false);
    expect(isCutMesh(optOut)).toBe(false);
    expect(isCutMesh(optIn)).toBe(true);
    expect(isCutMesh(new Object3D())).toBe(false);
  });
});

describe('clipping the body (no recompile on open, close or fade)', () => {
  function scene() {
    const group = new Group();
    group.userData.bodyId = 'b-earth';
    const surface = new Mesh(new SphereGeometry(1), new MeshStandardMaterial());
    const rings = new Mesh(new RingGeometry(1, 2), new MeshStandardMaterial());
    const moon = new Group();
    moon.userData.bodyId = 'b-moon';
    const moonMesh = new Mesh(new SphereGeometry(0.3), new MeshStandardMaterial());
    moon.add(moonMesh);
    group.add(surface, rings, moon);
    return { group, surface, rings, moonMesh };
  }

  it('keeps the same planes on the materials through open → closed → open; parked, they cut nothing', () => {
    const { group, surface, rings, moonMesh } = scene();
    const planes = [new Plane(new Vector3(1, 0, 0), 0), new Plane(new Vector3(0, 0, 1), 0)];
    const clipped: ClippedMaterials = new Map();
    const material = surface.material as MeshStandardMaterial;
    clipBody(group, 'b-earth', planes, clipped, 1); // open
    expect(material.clippingPlanes).toBe(planes);
    expect(material.clipIntersection).toBe(true);
    expect((rings.material as MeshStandardMaterial).clippingPlanes).toBeNull();
    expect((moonMesh.material as MeshStandardMaterial).clippingPlanes).toBeNull();

    parkPlanes(planes); // closed
    clipBody(group, 'b-earth', planes, clipped, 2);
    // Same array, same count, intersection unchanged: three's program parameters are unchanged.
    expect(material.clippingPlanes).toBe(planes);
    expect(material.clippingPlanes).toHaveLength(2);
    expect(material.clipIntersection).toBe(true);
    for (const p of [
      [0, 0, 0],
      [-1e6, -1e6, -1e6],
      [1e6, 1e6, 1e6],
      [-5, 3, -7],
    ] as const) {
      const point = new Vector3(...p);
      // A point is clipped only when it is on the negative side of every plane (intersection).
      expect(planes.some((plane) => plane.distanceToPoint(point) >= 0)).toBe(true);
      expect(planes.every((plane) => plane.distanceToPoint(point) > 0)).toBe(true);
    }

    clipBody(group, 'b-earth', planes, clipped, 3); // open again
    expect(material.clippingPlanes).toBe(planes);
    expect(clipped.size).toBe(1);

    unclip(clipped); // the view left
    expect(material.clippingPlanes).toBeNull();
    expect(material.clipIntersection).toBe(false);
    expect(clipped.size).toBe(0);
  });

  it('gives a swapped-out material its planes back and forgets it', () => {
    const { group, surface } = scene();
    const planes = [new Plane(), new Plane()];
    const clipped: ClippedMaterials = new Map();
    const before = surface.material as MeshStandardMaterial;
    clipBody(group, 'b-earth', planes, clipped, 1);
    const after = new MeshStandardMaterial(); // the detail level arrived: a new material
    surface.material = after;
    clipBody(group, 'b-earth', planes, clipped, 2);
    expect(before.clippingPlanes).toBeNull();
    expect(before.clipIntersection).toBe(false);
    expect(after.clippingPlanes).toBe(planes);
    expect([...clipped.keys()]).toEqual([after]);
  });
});
