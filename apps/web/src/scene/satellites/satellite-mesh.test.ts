import { describe, expect, it } from 'vitest';
import { Color, Matrix4, Vector3 } from 'three';
import type { SatelliteFrame } from './director.js';
import { sampleActor, createActor } from './machine.js';
import { BEAM } from './look.js';
import {
  beamColor,
  beamGeometry,
  beamMatrix,
  bodyColor,
  bodyMatrix,
  satelliteGeometry,
} from './satellite-mesh.js';
import { instanceCapacity } from './Satellites.js';

const frame = (over: Partial<SatelliteFrame> = {}): SatelliteFrame => ({
  agentId: 'a-1',
  role: 'steward',
  bodyId: 'b-mars',
  mode: 'scanning',
  view: sampleActor(createActor('a-1', { bodyId: 'b-mars', state: 'working' }, 0), 0),
  visible: true,
  position: [10, 0, 0],
  target: [0, 0, 0],
  bodyRadius: 4,
  size: 0.5,
  beam: 1,
  sweep: 0,
  animated: true,
  tint: '#ffffff',
  brightness: 1,
  ...over,
});

const apply = (m: Matrix4, v: [number, number, number]) => new Vector3(...v).applyMatrix4(m);

describe('satellite geometry', () => {
  it('is one merged mesh with vertex colours, about one unit across', () => {
    const g = satelliteGeometry();
    expect(g.getAttribute('color')).toBeDefined();
    expect(g.boundingSphere?.radius).toBeGreaterThan(0.4);
    expect(g.boundingSphere?.radius).toBeLessThan(0.8);
  });

  it('the beam is brightest at its apex', () => {
    const g = beamGeometry();
    const pos = g.getAttribute('position');
    const col = g.getAttribute('color');
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i)) < 1e-6) expect(col.getX(i)).toBeCloseTo(1);
      if (Math.abs(pos.getY(i) + 1) < 1e-6) expect(col.getX(i)).toBeCloseTo(BEAM.baseFade);
    }
  });
});

describe('frame → matrices', () => {
  it('the satellite sits at its position, dish (−y) facing its body, `size` across', () => {
    const m = bodyMatrix(frame(), new Matrix4());
    expect(apply(m, [0, 0, 0]).toArray()).toEqual([10, 0, 0]);
    const dish = apply(m, [0, -1, 0]);
    expect(dish.x).toBeCloseTo(9.5);
    expect(Math.hypot(dish.y, dish.z)).toBeCloseTo(0);
  });

  it('the beam runs from the satellite to the body surface', () => {
    const m = beamMatrix(frame(), new Matrix4());
    expect(apply(m, [0, 0, 0]).distanceTo(new Vector3(10, 0, 0))).toBeCloseTo(0);
    const base = apply(m, [0, -1, 0]);
    expect(base.length()).toBeCloseTo(4 * 0.97);
    // Its footprint is BEAM.width body radii.
    const rim = apply(m, [1, -1, 0]);
    expect(rim.distanceTo(base)).toBeCloseTo(BEAM.width * 4);
  });

  it('a sweep swings the beam off the centre', () => {
    const base = apply(beamMatrix(frame({ sweep: 0.2 }), new Matrix4()), [0, -1, 0]);
    expect(Math.hypot(base.y, base.z)).toBeGreaterThan(0.5);
  });

  it('hidden satellites and spent beams collapse to nothing', () => {
    const zero = (m: Matrix4) => apply(m, [1, 1, 1]).length();
    expect(zero(bodyMatrix(frame({ visible: false }), new Matrix4()))).toBe(0);
    expect(zero(beamMatrix(frame({ beam: 0 }), new Matrix4()))).toBe(0);
  });

  it('beam colour scales with strength, and blooms only with a composer', () => {
    const c = new Color();
    const bloom = beamColor(frame(), true, c).g;
    const plain = beamColor(frame(), false, c).g;
    expect(bloom).toBeGreaterThan(1); // HDR: over the bloom threshold
    expect(plain).toBeLessThan(1);
    expect(beamColor(frame({ beam: 0.5 }), true, c).g).toBeCloseTo(bloom / 2);
  });

  it('body colour is the tint times its brightness', () => {
    const c = bodyColor(frame({ tint: '#ffffff', brightness: 0.5 }), new Color());
    expect(c.r).toBeCloseTo(0.5);
  });
});

describe('instanced capacity', () => {
  it('grows in steps of 16 so the buffers are not rebuilt per agent', () => {
    expect(instanceCapacity(1)).toBe(16);
    expect(instanceCapacity(16)).toBe(16);
    expect(instanceCapacity(17)).toBe(32);
    expect(instanceCapacity(40)).toBe(48);
  });
});
