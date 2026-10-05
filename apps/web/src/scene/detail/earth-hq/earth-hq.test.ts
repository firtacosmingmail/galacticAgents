import { describe, expect, it } from 'vitest';
import {
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import { AgentState, type Body } from '@galactic/protocol';
import { satelliteFrame } from '../../picking/fixtures.js';
import { hqCoreGeometry } from '../../satellites/hq/hq-mesh.js';
import { claimHqStation, HQ, hqClaimed } from '../../satellites/hq/hq-model.js';
import { HqTargets, writeHq } from '../../satellites/hq/HqStation.js';
import { STATE_LOOK } from '../../satellites/look.js';
import { resolveDetailBody } from '../detail-body.js';
import { DETAIL_PARTS, partsFor } from '../parts.js';
import { EarthHq, EarthHqTargets, writeEarthHq, type EarthHqInput } from './EarthHq.js';
import {
  earthHqCoreGeometry,
  earthHqNavGeometry,
  earthHqRingGeometry,
  earthHqStrobeGeometry,
  EARTH_HQ_RING_RADIUS,
  glowGeometry,
} from './earth-hq-mesh.js';
import {
  EARTH_HQ_PART,
  glowLevel,
  isHeadquarters,
  navLevel,
  restingPose,
  STATION,
  stationLook,
  stationMood,
  strobeLevel,
} from './earth-hq-model.js';

const bodies: Record<string, Body> = {
  'b-sun': { id: 'b-sun', kind: 'star', name: 'Sun', meta: { reserved: true } },
  'b-earth': { id: 'b-earth', kind: 'planet', name: 'Earth', meta: { orbit: 3, reserved: true } },
  'b-moon': { id: 'b-moon', kind: 'moon', parentId: 'b-earth', name: 'Moon', meta: { orbit: 1 } },
  'b-mars': { id: 'b-mars', kind: 'planet', name: 'Mars', meta: { orbit: 4 } },
  'b-jupiter': { id: 'b-jupiter', kind: 'planet', name: 'Jupiter', meta: { orbit: 5 } },
  'b-ast-7': {
    id: 'b-ast-7',
    kind: 'asteroid',
    name: '7 Iris',
    host: { kind: 'task', id: 't-1' },
    meta: { number: 7 },
  },
};

describe("the 'earth-hq' detail part (P6-05)", () => {
  it('is registered once and mounts only in Earth’s detail view', () => {
    const entries = DETAIL_PARTS.filter((p) => p.id === EARTH_HQ_PART);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.Component).toBe(EarthHq);
    const ids = (id: string) => partsFor(resolveDetailBody(bodies, id, 'fake')!).map((p) => p.id);
    expect(ids('b-earth')).toContain(EARTH_HQ_PART);
    for (const other of ['b-mars', 'b-jupiter', 'b-moon', 'b-ast-7']) {
      expect(ids(other)).not.toContain(EARTH_HQ_PART);
    }
    expect(isHeadquarters({ bodyId: 'b-earth' })).toBe(true);
    expect(isHeadquarters({ bodyId: 'b-mars' })).toBe(false);
  });
});

describe('the station’s look (state mapping)', () => {
  it('maps the Harmonizer’s state to a mood: none, thinking, waiting, idle, halted', () => {
    expect(stationMood(undefined)).toBe('none');
    expect(stationMood('working')).toBe('thinking');
    expect(stationMood('starting')).toBe('thinking');
    expect(stationMood('waiting_for_input')).toBe('waiting');
    expect(stationMood('idle')).toBe('idle');
    for (const s of ['paused', 'stalled', 'failed'] as const) expect(stationMood(s)).toBe('halted');
    for (const s of ['finished', 'stopped', 'interrupted'] as const)
      expect(stationMood(s)).toBe('none');
    // Every state maps somewhere.
    for (const s of AgentState.options) expect(stationMood(s)).toBeTypeOf('string');
  });

  it('thinking: the ring turns fast, the lights blink, the glow breathes', () => {
    const look = stationLook('working', false);
    expect(look).toMatchObject({ ringSpin: HQ.ringSpin.thinking, lights: 'blink', glow: 1 });
    expect(look.dark).toBe(false);
    const levels = Array.from({ length: 40 }, (_, i) => glowLevel(look, i * 0.05));
    expect(Math.min(...levels)).toBeCloseTo(STATION.glowMin, 1);
    expect(Math.max(...levels)).toBeCloseTo(STATION.glowMax, 1);
  });

  it('idle and waiting: the ring turns slowly, no glow; waiting keeps the amber blink', () => {
    for (const state of ['idle', 'waiting_for_input'] as const) {
      const look = stationLook(state, false);
      expect(look.ringSpin).toBe(HQ.ringSpin.idle);
      expect(look.glow).toBe(0);
      expect(glowLevel(look, 1.3)).toBe(0);
      expect(look.lights).toBe('blink');
    }
    // The hull takes the frame's colour, which is the state look's (amber, blinking, for waiting).
    expect(STATE_LOOK.waiting_for_input.pulse).toBe('blink');
  });

  it('no Harmonizer: dark, the ring still, the lights off', () => {
    const look = stationLook(undefined, false);
    expect(look).toMatchObject({ mood: 'none', dark: true, ringSpin: 0, lights: 'off', glow: 0 });
    expect(navLevel(look, 0.2)).toBe(0);
    expect(strobeLevel(look, 0)).toBe(0);
  });

  it('halted: paused holds still with steady lights; failed has its lights off', () => {
    expect(stationLook('paused', false)).toMatchObject({ ringSpin: 0, lights: 'steady' });
    expect(stationLook('failed', false)).toMatchObject({ ringSpin: 0, lights: 'off' });
  });

  it('blinks: the navigation lights alternate, the strobe double-flashes', () => {
    const look = stationLook('idle', false);
    expect(navLevel(look, 0.1)).toBe(1);
    expect(navLevel(look, STATION.navPeriod * 0.75)).toBe(STATION.navOff);
    const strobe = (x: number) => strobeLevel(look, x * STATION.strobePeriod);
    expect(strobe(0.01)).toBeGreaterThan(1);
    expect(strobe(STATION.strobeFlash * 1.5)).toBe(0);
    expect(strobe(STATION.strobeFlash * 2.5)).toBeGreaterThan(1);
    expect(strobe(0.5)).toBe(0);
  });

  it('reduced motion: nothing turns, blinks or breathes — thinking still shows by its glow', () => {
    for (const state of AgentState.options) {
      const look = stationLook(state, true);
      expect(look.ringSpin).toBe(0);
      expect(look.lights).not.toBe('blink');
      const at = (t: number) => [navLevel(look, t), strobeLevel(look, t), glowLevel(look, t)];
      expect(at(0.03)).toEqual(at(1.17));
    }
    expect(glowLevel(stationLook('working', true), 5)).toBe(STATION.glowStill);
    expect(glowLevel(stationLook('idle', true), 5)).toBe(0);
  });

  it('rests on the innermost shell at the Harmonizer’s size when none is running', () => {
    const rest = restingPose(2);
    expect(Math.hypot(...rest.position)).toBeCloseTo(3.6);
    expect(rest.size).toBeCloseTo(0.84);
  });
});

describe('the station’s model', () => {
  const vertices = (g: BufferGeometry) => g.getAttribute('position').count;
  const all = (simple: boolean) => [
    earthHqCoreGeometry({ simple }),
    earthHqRingGeometry({ simple }),
    earthHqNavGeometry({ simple }),
    earthHqStrobeGeometry({ simple }),
  ];

  it('is vertex-coloured, about one unit across (the frame’s size), and −y faces Earth', () => {
    for (const g of [...all(false), glowGeometry()]) {
      expect(g.getAttribute('color').count).toBe(vertices(g));
      g.computeBoundingBox();
    }
    const core = earthHqCoreGeometry({ simple: false });
    core.computeBoundingBox();
    const box = core.boundingBox!;
    expect(box.max.x - box.min.x).toBeGreaterThan(0.9);
    expect(box.max.x - box.min.x).toBeLessThan(1.2);
    expect(box.min.y).toBeLessThan(-0.4); // the dish's mast toward Earth
  });

  it('is more detailed than the system HQ, and the mobile tier draws a simpler one', () => {
    const system = vertices(hqCoreGeometry());
    const full = all(false).reduce((n, g) => n + vertices(g), 0);
    const simple = all(true).reduce((n, g) => n + vertices(g), 0);
    expect(vertices(earthHqCoreGeometry({ simple: false }))).toBeGreaterThan(system * 2);
    expect(simple).toBeLessThan(full * 0.6);
  });

  it('the habitat ring sits in the spine’s plane', () => {
    const ring = earthHqRingGeometry({ simple: false });
    ring.computeBoundingBox();
    const box = ring.boundingBox!;
    expect(box.max.x).toBeCloseTo(EARTH_HQ_RING_RADIUS + 0.03, 2);
    expect(box.max.y).toBeLessThan(0.04);
  });
});

/** The station's objects, as `EarthHq` mounts them, without a renderer. */
function station(glow = true) {
  const mesh = () => new Mesh(undefined, new MeshBasicMaterial());
  const targets = new EarthHqTargets();
  const objects = {
    station: new Group(),
    core: mesh(),
    ring: mesh(),
    nav: mesh(),
    strobe: mesh(),
    glow: glow ? mesh() : null,
  };
  const release = targets.register(objects);
  return { targets, objects, release };
}

const earthAt = new Matrix4().makeTranslation(10, 0, 0);
const input = (over: Partial<EarthHqInput> = {}): EarthHqInput => ({
  frame: undefined,
  state: undefined,
  anchor: earthAt,
  radius: 1,
  cameraQuaternion: new Quaternion(),
  now: 0.05,
  mix: 1,
  reducedMotion: false,
  bloom: true,
  ...over,
});
const position = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const colour = (m: Mesh | null) => (m!.material as MeshBasicMaterial).color;

describe('writeEarthHq (per frame)', () => {
  it('draws at the Harmonizer’s frame, in Earth’s frame, with the frame’s colour', () => {
    const { targets, objects } = station();
    const frame = satelliteFrame('a-h', 'b-earth', [12, 0, 0], { role: 'harmonizer', size: 0.4 });
    frame.target = [10, 0, 0];
    frame.tint = '#ffb547';
    writeEarthHq(targets, input({ frame, state: 'waiting_for_input' }));
    expect(objects.station.visible).toBe(true);
    expect(position(objects.station.matrix).toArray()).toEqual([2, 0, 0]);
    expect(new Vector3().setFromMatrixScale(objects.station.matrix).x).toBeCloseTo(0.4);
    expect(colour(objects.core).getHexString()).toBe('ffb547');
    expect(targets.look?.mood).toBe('waiting');
  });

  it('thinking: the ring turns fast, the glow shows; idle: slower, no glow', () => {
    const { targets, objects } = station();
    const frame = satelliteFrame('a-h', 'b-earth', [12, 0, 0], { role: 'harmonizer' });
    const angle = () => {
      const q = new Quaternion().setFromRotationMatrix(objects.ring.matrix);
      return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    };
    writeEarthHq(targets, input({ frame, state: 'working', now: 1 }));
    writeEarthHq(targets, input({ frame, state: 'working', now: 1.5 }));
    expect(angle()).toBeCloseTo(HQ.ringSpin.thinking * 0.5, 5);
    expect(objects.glow!.visible).toBe(true);
    const before = targets.spin.angle;
    writeEarthHq(targets, input({ frame, state: 'idle', now: 2.5 }));
    expect(targets.spin.angle - before).toBeCloseTo(HQ.ringSpin.idle * 1, 5);
    expect(objects.glow!.visible).toBe(false);
  });

  it('no Harmonizer: rests dark and still at its place, lights and glow off', () => {
    const { targets, objects } = station();
    writeEarthHq(targets, input({ radius: 2 }));
    expect(objects.station.visible).toBe(true);
    expect(position(objects.station.matrix).length()).toBeCloseTo(3.6);
    const dark = colour(objects.core);
    expect(Math.max(dark.r, dark.g, dark.b)).toBeLessThan(0.1);
    expect(objects.nav.visible).toBe(false);
    expect(objects.strobe.visible).toBe(false);
    expect(objects.glow!.visible).toBe(false);
    writeEarthHq(targets, input({ radius: 2, now: 9 }));
    expect(targets.spin.angle).toBe(0);
  });

  it('no Harmonizer, in its viewing slot (P6-06): rests there at its size factor', () => {
    const { targets, objects } = station();
    writeEarthHq(targets, input({ radius: 2, rest: { position: [1.5, 2, -1], scale: 0.5 } }));
    expect(position(objects.station.matrix).toArray()).toEqual([1.5, 2, -1]);
    expect(new Vector3().setFromMatrixScale(objects.station.matrix).x).toBeCloseTo(
      restingPose(2).size * 0.5,
    );
  });

  it('a hidden frame (shrinking out, behind the scenes) hides the station', () => {
    const { targets, objects } = station();
    const frame = satelliteFrame('a-h', 'b-earth', [12, 0, 0], { role: 'harmonizer' });
    frame.visible = false;
    writeEarthHq(targets, input({ frame, state: 'idle' }));
    expect(objects.station.visible).toBe(false);
  });

  it('the lights and glow fade in with the cross-fade', () => {
    const { targets, objects } = station();
    const frame = satelliteFrame('a-h', 'b-earth', [12, 0, 0], { role: 'harmonizer' });
    writeEarthHq(targets, input({ frame, state: 'working', mix: 0 }));
    expect(objects.nav.visible).toBe(false);
    expect(objects.glow!.visible).toBe(false);
    writeEarthHq(targets, input({ frame, state: 'working', mix: 0.5 }));
    expect(colour(objects.nav).r).toBeCloseTo(0.5);
  });

  it('reduced motion: the same picture at any time', () => {
    const { targets, objects } = station();
    const frame = satelliteFrame('a-h', 'b-earth', [12, 0, 0], { role: 'harmonizer' });
    const snap = () => [
      objects.ring.matrix.clone().elements,
      colour(objects.nav).r,
      colour(objects.strobe).r,
      colour(objects.glow).r,
    ];
    writeEarthHq(targets, input({ frame, state: 'working', reducedMotion: true, now: 1 }));
    const a = snap();
    writeEarthHq(targets, input({ frame, state: 'working', reducedMotion: true, now: 7.3 }));
    expect(snap()).toEqual(a);
    expect(objects.glow!.visible).toBe(true);
  });

  it('the mobile tier has no glow; a released target writes nothing', () => {
    const { targets, release } = station(false);
    const frame = satelliteFrame('a-h', 'b-earth', [12, 0, 0], { role: 'harmonizer' });
    expect(() => writeEarthHq(targets, input({ frame, state: 'working' }))).not.toThrow();
    release();
    expect(targets.station).toBeNull();
    expect(() => writeEarthHq(targets, input({ frame, state: 'working' }))).not.toThrow();
  });
});

describe('no double HQ: the claim hides the system station', () => {
  function systemHq() {
    const mesh = () => new Mesh(undefined, new MeshBasicMaterial());
    const targets = new HqTargets();
    const meshes = { core: mesh(), ring: mesh(), beam: mesh() };
    targets.register(meshes.core, meshes.ring, meshes.beam);
    return { targets, meshes };
  }
  const options = { bloom: true, now: 1, reducedMotion: false, state: 'working' as const };

  it('while claimed, the system core and ring are hidden but the beam still scans', () => {
    const { targets, meshes } = systemHq();
    const frame = satelliteFrame('a-h', 'b-earth', [12, 0, 0], { role: 'harmonizer' });
    frame.beam = 0.8;
    writeHq([frame], targets, options);
    expect([meshes.core.visible, meshes.ring.visible, meshes.beam.visible]).toEqual([
      true,
      true,
      true,
    ]);
    const release = claimHqStation();
    expect(hqClaimed()).toBe(true);
    writeHq([frame], targets, options);
    expect([meshes.core.visible, meshes.ring.visible, meshes.beam.visible]).toEqual([
      false,
      false,
      true,
    ]);
    release();
    release(); // idempotent
    expect(hqClaimed()).toBe(false);
    writeHq([frame], targets, options);
    expect(meshes.core.visible).toBe(true);
  });

  it('claims count: a remount (StrictMode) keeps the system station hidden', () => {
    const a = claimHqStation();
    const b = claimHqStation();
    a();
    expect(hqClaimed()).toBe(true);
    b();
    expect(hqClaimed()).toBe(false);
  });
});
