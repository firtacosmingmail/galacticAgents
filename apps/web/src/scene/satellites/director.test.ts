import { afterEach, describe, expect, it } from 'vitest';
import type { AgentState } from '@galactic/protocol';
import type { Vec3Tuple } from '../orbit.js';
import { QUALITY_TIERS } from '../quality.js';
import {
  applyAnimationCap,
  instancedPath,
  SatelliteDirector,
  SURFACE,
  type AnchorLookup,
  type SatelliteFrame,
} from './director.js';
import { TIMING } from './machine.js';
import { SATELLITE_LOOK } from './look.js';
import type { SatelliteSpec } from './satellite-model.js';
import { allSatellites, getSatellite, onSatellitesChanged, publishSatellites } from './registry.js';

const spec = (
  agentId: string,
  bodyId: string,
  state: AgentState = 'working',
  role: SatelliteSpec['role'] = 'steward',
): SatelliteSpec => ({
  agentId,
  role,
  bodyId,
  state,
  activity: undefined,
  archetype: undefined,
  landed: false,
  supervisorId: undefined,
});

/** Bodies at fixed places (a fake anchor registry). */
function anchors(bodies: Record<string, { at: Vec3Tuple; radius: number }>): AnchorLookup {
  return (bodyId, out) => {
    const b = bodies[bodyId];
    if (!b) return undefined;
    out[0] = b.at[0];
    out[1] = b.at[1];
    out[2] = b.at[2];
    return b.radius;
  };
}

const world = anchors({
  'b-mars': { at: [30, 0, 0], radius: 2 },
  'b-jupiter': { at: [0, 0, -80], radius: 5 },
  'b-io': { at: [8, 0, -80], radius: 0.5 },
});

const dist = (p: Vec3Tuple, q: Vec3Tuple) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

const director = (tier: keyof typeof QUALITY_TIERS = 'high', reducedMotion = false) =>
  new SatelliteDirector({ satellites: QUALITY_TIERS[tier].satellites, reducedMotion });

afterEach(() => publishSatellites(new Map()));

describe('placement', () => {
  it('orbits its body at the orbit radius, following the anchor', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const [f] = d.update(1, world) as [SatelliteFrame];
    expect(f.visible).toBe(true);
    expect(f.target).toEqual([30, 0, 0]);
    const r = dist(f.position, f.target);
    expect(r / 2).toBeGreaterThan(1.5);
    // The body moves: the satellite moves with it.
    const moved = anchors({ 'b-mars': { at: [0, 10, 30], radius: 2 } });
    d.update(1, moved);
    expect(dist(f.position, [0, 10, 30])).toBeCloseTo(r, 9);
  });

  it('is hidden (not dropped) while its body has no anchor', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-unknown')], 0);
    const [f] = d.update(1, world) as [SatelliteFrame];
    expect(f.visible).toBe(false);
    expect(f.beam).toBe(0);
  });

  it('size follows the body, with a pixel floor and a ceiling', () => {
    const d = director();
    d.setSpecs([spec('a-w', 'b-jupiter', 'idle', 'waykeeper'), spec('a-s', 'b-io')], 0);
    const [w, s] = d.update(1, world) as [SatelliteFrame, SatelliteFrame];
    expect(w.size).toBeCloseTo(SATELLITE_LOOK.waykeeper.size * 5);
    expect(s.size).toBeCloseTo(SATELLITE_LOOK.steward.size * 0.5);
    // Far away a pixel is big: the floor wins, but never beyond `maxSize` body radii.
    d.update(1, world, () => 0.1);
    expect(s.size).toBeCloseTo(SATELLITE_LOOK.steward.minPx * 0.1);
    d.update(1, world, () => 10);
    expect(s.size).toBeCloseTo(SATELLITE_LOOK.steward.maxSize * 0.5);
  });

  it('several satellites of one body are apart from each other', () => {
    const d = director();
    d.setSpecs(
      Array.from({ length: 8 }, (_, i) => spec(`a-${i}`, 'b-mars')),
      0,
    );
    for (const t of [0, 3.3, 17]) {
      const frames = d.update(t, world);
      for (let i = 0; i < frames.length; i++)
        for (let j = i + 1; j < frames.length; j++)
          expect(dist(frames[i]!.position, frames[j]!.position)).toBeGreaterThan(0.25);
    }
  });
});

describe('the satellite list over time', () => {
  it('keeps actors across list changes, adds new ones, drops ended ones', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars'), spec('a-2', 'b-mars')], 0);
    d.update(2, world);
    const actor = d.actor('a-1');
    d.setSpecs([spec('a-1', 'b-mars', 'idle'), spec('a-3', 'b-io')], 3);
    expect(d.actor('a-1')?.seed).toBe(actor?.seed);
    expect(d.actor('a-2')).toBeUndefined();
    expect(d.actor('a-3')?.mode).toBe('orbiting');
    expect(d.frames.map((f) => f.agentId)).toEqual(['a-1', 'a-3']);
  });

  it('publishes the frames for the rest of the scene (and later picking)', () => {
    let changes = 0;
    const off = onSatellitesChanged(() => changes++);
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    expect(changes).toBe(1);
    d.setSpecs([spec('a-1', 'b-mars', 'idle')], 0); // same satellites: no change event
    expect(changes).toBe(1);
    d.update(1, world);
    expect(getSatellite('a-1')?.position).toEqual(d.frames[0]?.position);
    expect(allSatellites()).toHaveLength(1);
    off();
  });

  it('a new body flies the satellite there along an arc; it then orbits the new body', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const [f] = d.update(1, world) as [SatelliteFrame];
    const start: Vec3Tuple = [...f.position];
    d.setSpecs([spec('a-1', 'b-jupiter')], 1);
    d.update(1, world);
    expect(f.mode).toBe('flying');
    expect(dist(f.position, start)).toBeLessThan(0.5); // takes off from where it was
    d.update(1 + TIMING.flight / 2, world);
    const straightMidY = (start[1] + 0) / 2;
    expect(f.position[1]).toBeGreaterThan(straightMidY + 1); // lifted above the straight line
    d.update(1 + TIMING.flight, world);
    expect(f.mode).toBe('orbiting');
    expect(f.target).toEqual([0, 0, -80]);
    expect(dist(f.position, f.target) / 5).toBeGreaterThan(1.5);
  });

  it('a flight completes even if no frame was drawn while it ran', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars', 'idle')], 0);
    d.update(1, world);
    d.setSpecs([spec('a-1', 'b-io', 'idle')], 1);
    // No update during the flight (scene hidden, camera elsewhere and loop on demand…).
    const [f] = d.update(30, world) as [SatelliteFrame];
    expect(f.mode).toBe('orbiting');
    expect(f.bodyId).toBe('b-io');
  });

  it('lands on the surface when its work completes (the P4-04 input)', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars', 'idle')], 0);
    d.update(1, world);
    d.setSpecs([{ ...spec('a-1', 'b-mars', 'idle'), landed: true }], 1);
    const [f] = d.update(1 + TIMING.landing + 0.1, world) as [SatelliteFrame];
    expect(f.mode).toBe('landed');
    expect(dist(f.position, f.target)).toBeCloseTo(SURFACE * 2, 9);
  });
});

describe('scanning beams', () => {
  it('a working satellite beams at its body during a scan, and only then', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const scanAt = d.actor('a-1')?.nextScanAt ?? NaN;
    const [f] = d.update(scanAt - 0.1, world) as [SatelliteFrame];
    expect(f.beam).toBe(0);
    d.update(scanAt, world);
    expect(f.mode).toBe('scanning');
    d.update(scanAt + TIMING.scan / 2, world);
    expect(f.beam).toBe(1);
    expect(Math.abs(f.sweep)).toBeLessThanOrEqual(0.2 + 1e-9);
    d.update(scanAt + TIMING.scan + 0.1, world);
    expect(f.beam).toBe(0);
  });
});

describe('the animation cap', () => {
  const frame = (
    mode: SatelliteFrame['mode'],
    role: SatelliteFrame['role'] = 'steward',
    bodyId = 'b-x',
  ) => ({ mode, role, bodyId, animated: false });

  it('flights and landings always animate; scans fill the rest, Waykeepers first', () => {
    const frames = [
      frame('scanning'),
      frame('flying'),
      frame('scanning', 'waykeeper'),
      frame('orbiting'),
      frame('landing'),
      frame('gathering'),
    ];
    expect(applyAnimationCap(frames, 3)).toBe(3);
    expect(frames.map((f) => f.animated)).toEqual([false, true, true, false, true, false]);
  });

  it('flights animate even past the cap', () => {
    const frames = [frame('flying'), frame('flying'), frame('scanning', 'waykeeper')];
    expect(applyAnimationCap(frames, 1)).toBe(2);
    expect(frames.map((f) => f.animated)).toEqual([true, true, false]);
  });

  it('the focused body gets its share first', () => {
    const frames = [frame('scanning', 'waykeeper'), frame('scanning', 'steward', 'b-focus')];
    applyAnimationCap(frames, 1, 'b-focus');
    expect(frames.map((f) => f.animated)).toEqual([false, true]);
  });

  it('the tier table: mobile animates fewer than high', () => {
    expect(QUALITY_TIERS.mobile.satellites.maxAnimated).toBeLessThan(
      QUALITY_TIERS.high.satellites.maxAnimated,
    );
    expect(QUALITY_TIERS.balanced.satellites.maxAnimated).toBeLessThanOrEqual(
      QUALITY_TIERS.high.satellites.maxAnimated,
    );
  });

  it('the director applies it: beams beyond the cap are switched off', () => {
    const d = director('mobile');
    const many = Array.from({ length: 20 }, (_, i) =>
      spec(`a-${String(i).padStart(2, '0')}`, 'b-mars'),
    );
    d.setSpecs(many, 0);
    // Every satellite scans at some point in 0–15 s; never more beams than the cap at once.
    let peak = 0;
    for (let t = 0; t < 30; t += 0.1) {
      const frames = d.update(t, world);
      const beams = frames.filter((f) => f.beam > 0).length;
      const animated = frames.filter((f) => f.animated).length;
      peak = Math.max(peak, beams);
      expect(animated).toBeLessThanOrEqual(QUALITY_TIERS.mobile.satellites.maxAnimated);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(QUALITY_TIERS.mobile.satellites.maxAnimated);
  });
});

describe('the instancing switch', () => {
  it('switches to the instanced path above the tier threshold', () => {
    const high = QUALITY_TIERS.high.satellites;
    expect(instancedPath(high.instanceAbove, high)).toBe(false);
    expect(instancedPath(high.instanceAbove + 1, high)).toBe(true);
    const mobile = QUALITY_TIERS.mobile.satellites;
    expect(mobile.instanceAbove).toBeLessThanOrEqual(high.instanceAbove);
    expect(instancedPath(40, mobile)).toBe(true);
  });
});

describe('reduced motion', () => {
  it('satellites stand still on their orbits, never scan, and moves are instant', () => {
    const d = director('high', true);
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const [f] = d.update(1, world) as [SatelliteFrame];
    const at1: Vec3Tuple = [...f.position];
    for (let t = 1; t < 40; t += 0.25) {
      d.update(t, world);
      expect(f.position).toEqual(at1);
      expect(f.beam).toBe(0);
      expect(f.mode).toBe('orbiting');
    }
    d.setSpecs([spec('a-1', 'b-io')], 40);
    d.update(40, world);
    expect(f.mode).toBe('orbiting');
    expect(f.bodyId).toBe('b-io');
  });

  it('turning it on mid-run freezes the satellites', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars', 'idle')], 0);
    const [f] = d.update(1, world) as [SatelliteFrame];
    d.setOptions({ satellites: QUALITY_TIERS.high.satellites, reducedMotion: true });
    d.update(2, world);
    const still: Vec3Tuple = [...f.position];
    d.update(9, world);
    expect(f.position).toEqual(still);
  });
});
