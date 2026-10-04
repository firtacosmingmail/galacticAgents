import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { AgentState } from '@galactic/protocol';
import { satelliteFrame } from '../../picking/fixtures.js';
import { hqCoreGeometry, hqRingGeometry, hqRingMatrix, HQ_RING_RADIUS } from './hq-mesh.js';
import { HQ, hqFrame, hqRingSpeed, hqThinking, ordinarySatellites, RingSpin } from './hq-model.js';
import { SATELLITE_LOOK } from '../look.js';

describe('HQ station model (P4-02)', () => {
  it('thinks while working: the ring spins fast; idle slowly; still under reduced motion', () => {
    expect(hqThinking('working')).toBe(true);
    expect(hqThinking('idle')).toBe(false);
    expect(hqRingSpeed('working', false)).toBe(HQ.ringSpin.thinking);
    expect(hqRingSpeed('idle', false)).toBe(HQ.ringSpin.idle);
    expect(HQ.ringSpin.thinking).toBeGreaterThan(HQ.ringSpin.idle * 4);
    for (const state of AgentState.options) expect(hqRingSpeed(state, true)).toBe(0);
    expect(hqRingSpeed('paused', false)).toBe(0);
    expect(hqRingSpeed('failed', false)).toBe(0);
  });

  it('the ring angle is integrated: a speed change never jumps', () => {
    const spin = new RingSpin();
    expect(spin.advance(10, 1)).toBe(0);
    expect(spin.advance(11, 1)).toBeCloseTo(1, 9);
    expect(spin.advance(11, 5)).toBeCloseTo(1, 9);
    expect(spin.advance(11.1, 5)).toBeCloseTo(1.5, 9);
  });

  it('is the largest satellite', () => {
    expect(SATELLITE_LOOK.harmonizer.size).toBeGreaterThan(SATELLITE_LOOK.waykeeper.size * 2);
    expect(SATELLITE_LOOK.harmonizer.minPx).toBeGreaterThan(SATELLITE_LOOK.waykeeper.minPx);
  });

  it('finds the HQ frame and keeps it out of the ordinary renderers', () => {
    const frames = [
      satelliteFrame('a-s', 'b-mars', [0, 0, 0]),
      satelliteFrame('a-h', 'b-earth', [1, 0, 0], { role: 'harmonizer' }),
    ];
    expect(hqFrame(frames)?.agentId).toBe('a-h');
    expect(hqFrame(frames.slice(0, 1))).toBeUndefined();
    const roles: Record<string, string> = {
      'a-s': 'steward',
      'a-h': 'harmonizer',
      'a-w': 'waykeeper',
    };
    expect(ordinarySatellites(['a-h', 'a-s', 'a-w'], (id) => roles[id])).toEqual({
      hq: 'a-h',
      others: ['a-s', 'a-w'],
    });
    expect(ordinarySatellites(['a-s'], (id) => roles[id])).toEqual({
      hq: undefined,
      others: ['a-s'],
    });
  });
});

describe('HQ station geometry', () => {
  it('core and ring are vertex-coloured and about one unit across', () => {
    for (const g of [hqCoreGeometry(), hqRingGeometry()]) {
      expect(g.getAttribute('color')).toBeDefined();
      g.computeBoundingBox();
      const size = new Vector3();
      g.boundingBox!.getSize(size);
      expect(Math.max(size.x, size.y, size.z)).toBeGreaterThan(0.4);
      expect(Math.max(size.x, size.y, size.z)).toBeLessThan(1.1);
      g.dispose();
    }
  });

  it('the ring lies around the hub axis (y) and has light and dark segments', () => {
    const ring = hqRingGeometry();
    ring.computeBoundingBox();
    const size = new Vector3();
    ring.boundingBox!.getSize(size);
    expect(size.y).toBeLessThan(0.1);
    expect(size.x).toBeCloseTo(2 * (HQ_RING_RADIUS + 0.032), 2);
    const colors = ring.getAttribute('color');
    const shades = new Set<number>();
    for (let i = 0; i < colors.count; i++) shades.add(Math.round(colors.getX(i) * 100));
    expect(shades.size).toBeGreaterThanOrEqual(2);
    ring.dispose();
  });

  it('the ring turns about the core’s own axis', () => {
    const core = new Matrix4().makeTranslation(5, 0, 0);
    const m = hqRingMatrix(core, Math.PI / 2, new Matrix4());
    const p = new Vector3(1, 0, 0).applyMatrix4(m);
    expect(p.x).toBeCloseTo(5, 9);
    expect(p.z).toBeCloseTo(-1, 9);
    const axis = new Vector3(0, 1, 0).applyMatrix4(m);
    expect(axis.toArray()).toEqual([5, 1, expect.closeTo(0, 9)]);
  });
});
