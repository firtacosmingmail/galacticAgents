import { afterEach, describe, expect, it } from 'vitest';
import type { AgentState } from '@galactic/protocol';
import type { Vec3Tuple } from '../orbit.js';
import { QUALITY_TIERS } from '../quality.js';
import {
  applyAnimationCap,
  BEAM_FADE_OUT,
  instancedPath,
  PRESENCE,
  SatelliteDirector,
  SURFACE,
  type AnchorLookup,
  type SatelliteFrame,
} from './director.js';
import { TIMING } from './machine.js';
import { BASE_SHELL, ORBIT_TWEEN, SHELL_STEP } from './orbits.js';
import { BEAM, SATELLITE_LOOK, STATE_LOOK, WAITING_AMBER } from './look.js';
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
  it('keeps actors across list changes, adds new ones, drops ended ones once shrunk out', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars'), spec('a-2', 'b-mars')], 0);
    d.update(2, world);
    const actor = d.actor('a-1');
    d.setSpecs([spec('a-1', 'b-mars', 'idle'), spec('a-3', 'b-io')], 3);
    expect(d.actor('a-1')?.seed).toBe(actor?.seed);
    expect(d.actor('a-3')?.mode).toBe('orbiting');
    // a-2 ended: it shrinks out (still drawn, last), then is gone.
    expect(d.frames.map((f) => f.agentId)).toEqual(['a-1', 'a-3', 'a-2']);
    d.update(3 + PRESENCE + 0.01, world);
    expect(d.actor('a-2')).toBeUndefined();
    expect(d.frames.map((f) => f.agentId)).toEqual(['a-1', 'a-3']);
  });

  it('grows in when its agent starts and shrinks out when it ends', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars', 'idle')], 0);
    const [f] = d.update(0, world) as [SatelliteFrame];
    expect(f.presence).toBe(0);
    expect(f.size).toBe(0);
    d.update(PRESENCE / 2, world);
    expect(f.presence).toBeCloseTo(0.5);
    d.update(PRESENCE, world);
    expect(f.presence).toBe(1);
    const full = f.size;
    d.setSpecs([], 1);
    expect(getSatellite('a-1')).toBe(f); // still published while it shrinks
    d.update(1 + PRESENCE / 2, world);
    expect(f.size).toBeCloseTo(full / 2);
    d.update(1 + PRESENCE, world);
    expect(d.frames).toEqual([]);
    expect(getSatellite('a-1')).toBeUndefined();
  });

  it('an agent back before it shrank out grows back from where it was', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars', 'idle')], 0);
    d.update(1, world);
    d.setSpecs([], 1);
    const [f] = d.update(1 + PRESENCE / 2, world) as [SatelliteFrame];
    const seed = d.actor('a-1')?.seed;
    d.setSpecs([spec('a-1', 'b-mars', 'idle')], 1 + PRESENCE / 2);
    d.update(1 + PRESENCE / 2, world);
    expect(f.presence).toBeCloseTo(0.5);
    d.update(2 + PRESENCE, world);
    expect(f.presence).toBe(1);
    expect(d.actor('a-1')?.seed).toBe(seed);
  });

  it('reduced motion: satellites appear and disappear at once', () => {
    const d = director('high', true);
    d.setSpecs([spec('a-1', 'b-mars', 'idle')], 0);
    const [f] = d.update(0, world) as [SatelliteFrame];
    expect(f.presence).toBe(1);
    d.setSpecs([], 1);
    expect(d.frames).toEqual([]);
  });

  it('reset forgets every satellite and publishes none', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    expect(getSatellite('a-1')).toBeDefined();
    d.reset();
    expect(getSatellite('a-1')).toBeUndefined();
    d.setSpecs([spec('a-1', 'b-mars')], 1);
    expect(getSatellite('a-1')).toBeDefined();
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

describe('sticky orbits', () => {
  const W = 'b-mars';
  /** Each satellite's offset from its body at time `t`. */
  const offsets = (d: SatelliteDirector, t: number) =>
    new Map(
      d
        .update(t, world)
        .map((f) => [f.agentId, f.position.map((v, i) => v - (f.target[i] ?? 0))] as const),
    );
  const shell = (o: Map<string, readonly number[]>, id: string) =>
    Math.hypot(...(o.get(id) ?? [])) / 2; // Mars' radius is 2
  const expectSame = (
    a: Map<string, readonly number[]>,
    b: Map<string, readonly number[]>,
    ids: string[],
  ) => {
    for (const id of ids) {
      expect(b.get(id)).toBeDefined();
      a.get(id)?.forEach((v, i) => expect(b.get(id)?.[i] ?? NaN).toBeCloseTo(v, 9));
    }
  };
  /** A director that never saw the change, as the reference. */
  const reference = (specs: SatelliteSpec[], t: number) => {
    const d = director();
    d.setSpecs(specs, 0);
    return offsets(d, t);
  };

  it('a new Steward spawning moves nobody', () => {
    const before = [
      spec('a-w', W, 'idle', 'waykeeper'),
      spec('a-s2', W, 'idle'),
      spec('a-s4', W, 'idle'),
    ];
    const d = director();
    d.setSpecs(before, 0);
    // a-s1 sorts first by id: ranked slots would have pushed a-s2 and a-s4 outward.
    d.setSpecs([spec('a-s1', W, 'idle'), ...before], 1);
    const after = offsets(d, 5);
    expectSame(reference(before, 5), after, ['a-w', 'a-s2', 'a-s4']);
    expect(shell(after, 'a-s1')).toBeCloseTo(BASE_SHELL + 3 * SHELL_STEP, 6);
  });

  it('a Waykeeper replaced: the Stewards stay, the new Waykeeper takes the free slot 0', () => {
    const stewards = [spec('a-s1', W, 'idle'), spec('a-s2', W, 'idle')];
    const d = director();
    d.setSpecs([spec('a-w1', W, 'idle', 'waykeeper'), ...stewards], 0);
    d.setSpecs([spec('a-w2', W, 'idle', 'waykeeper'), ...stewards], 1);
    const after = offsets(d, 5);
    const ref = reference([spec('a-w1', W, 'idle', 'waykeeper'), ...stewards], 5);
    expectSame(ref, after, ['a-s1', 'a-s2']);
    expect(shell(after, 'a-w2')).toBeCloseTo(BASE_SHELL, 6);
  });

  it('a Waykeeper arriving after a Steward took slot 0 takes the lowest free slot', () => {
    const d = director();
    d.setSpecs([spec('a-s1', W, 'idle')], 0);
    d.setSpecs([spec('a-s1', W, 'idle'), spec('a-w', W, 'idle', 'waykeeper')], 1);
    const o = offsets(d, 5);
    expect(shell(o, 'a-s1')).toBeCloseTo(BASE_SHELL, 6);
    expect(shell(o, 'a-w')).toBeCloseTo(BASE_SHELL + SHELL_STEP, 6);
  });

  it('a flight arriving at a crowded body leaves the residents where they were', () => {
    const residents = [
      spec('a-w', W, 'idle', 'waykeeper'),
      spec('a-s3', W, 'idle'),
      spec('a-s5', W, 'idle'),
    ];
    const d = director();
    d.setSpecs([spec('a-s1', 'b-io', 'idle'), ...residents], 0);
    d.update(1, world);
    d.setSpecs([spec('a-s1', W, 'idle'), ...residents], 1); // a-s1's task moved to Mars
    const t = 1 + TIMING.flight + 1;
    const after = offsets(d, t);
    expectSame(
      reference(residents, t),
      after,
      residents.map((r) => r.agentId),
    );
    // The newcomer orbits the next free shell.
    expect(shell(after, 'a-s1')).toBeCloseTo(BASE_SHELL + 3 * SHELL_STEP, 6);
  });

  it('an orbit change that does happen is blended, not jumped', () => {
    const d = director();
    d.setSpecs([spec('a-1', W, 'idle'), spec('a-2', W, 'idle')], 0);
    const [, f] = d.update(2, world) as [SatelliteFrame, SatelliteFrame];
    const at: Vec3Tuple = [...f.position];
    // a-2 becomes a Waykeeper (its orbit's period changes): no jump at the change…
    d.setSpecs([spec('a-1', W, 'idle'), spec('a-2', W, 'idle', 'waykeeper')], 2);
    d.update(2, world);
    expect(dist(f.position, at)).toBeLessThan(1e-9);
    // …and small steps all the way through the blend.
    let last: Vec3Tuple = [...f.position];
    for (let t = 2; t <= 2 + ORBIT_TWEEN + 0.1; t += 1 / 60) {
      d.update(t, world);
      expect(dist(f.position, last)).toBeLessThan(0.1);
      last = [...f.position];
    }
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

  it('a scan cut short (the agent stopped working) fades its beam out instead of popping', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const scanAt = d.actor('a-1')?.nextScanAt ?? NaN;
    d.update(scanAt, world);
    const [f] = d.update(scanAt + 1, world) as [SatelliteFrame];
    expect(f.beam).toBe(1);
    d.setSpecs([spec('a-1', 'b-mars', 'idle')], scanAt + 1);
    d.update(scanAt + 1 + BEAM_FADE_OUT / 2, world);
    expect(f.mode).toBe('orbiting');
    expect(f.beam).toBeCloseTo(0.5);
    d.update(scanAt + 1 + BEAM_FADE_OUT, world);
    expect(f.beam).toBe(0);
  });

  it('a beam that loses the animation budget fades out too', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const scanAt = d.actor('a-1')?.nextScanAt ?? NaN;
    d.update(scanAt, world);
    const [f] = d.update(scanAt + 1, world) as [SatelliteFrame];
    expect(f.beam).toBe(1);
    d.setOptions({ satellites: { instanceAbove: 12, maxAnimated: 0 }, reducedMotion: false });
    d.update(scanAt + 1 + BEAM_FADE_OUT / 2, world);
    expect(f.animated).toBe(false);
    expect(f.beam).toBeCloseTo(0.5);
    d.update(scanAt + 1 + BEAM_FADE_OUT, world);
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

  it('a running scan keeps its budget against a newcomer (no pre-emption)', () => {
    const frames = [frame('scanning', 'waykeeper'), { ...frame('scanning'), animated: true }];
    applyAnimationCap(frames, 1);
    expect(frames.map((f) => f.animated)).toEqual([false, true]);
  });

  it('satellites whose body has no anchor take no budget', () => {
    const frames = [
      { ...frame('scanning', 'waykeeper'), visible: false },
      { ...frame('flying'), visible: false },
      frame('scanning'),
    ];
    expect(applyAnimationCap(frames, 1)).toBe(1);
    expect(frames.map((f) => f.animated)).toEqual([false, false, true]);
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

describe('state look (P4-02)', () => {
  it('every frame carries its state’s tint, pulse, size and beam colour', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars', 'waiting_for_input'), spec('a-2', 'b-mars', 'working')], 0);
    const frames = d.update(1, world);
    const [waiting, working] = frames as [SatelliteFrame, SatelliteFrame];
    expect(waiting.tint).toBe(WAITING_AMBER);
    expect(working.tint).toBe(SATELLITE_LOOK.steward.color);
    expect(waiting.size / working.size).toBeCloseTo(STATE_LOOK.waiting_for_input.scale, 6);
    expect(working.beamTint).toBe(BEAM.color);
    const seen: number[] = [];
    for (let t = 1; t < 3; t += 0.05) {
      d.update(t, world);
      seen.push(waiting.brightness);
    }
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(1); // it blinks
  });

  it('reduced motion: brightness is the still level, constant', () => {
    const d = director('high', true);
    d.setSpecs([spec('a-1', 'b-mars', 'waiting_for_input')], 0);
    const values = new Set<number>();
    for (let t = 1; t < 4; t += 0.1) values.add(d.update(t, world)[0]!.brightness);
    expect([...values]).toEqual([STATE_LOOK.waiting_for_input.still]);
  });

  it('a paused satellite holds still where it is; resuming carries on without a jump', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars', 'working')], 0);
    const [f] = d.update(2, world) as [SatelliteFrame];
    d.setSpecs([spec('a-1', 'b-mars', 'paused')], 2);
    const held: Vec3Tuple = [...f.position];
    d.update(5, world);
    expect(dist(f.position, held)).toBeLessThan(1e-9);
    d.setSpecs([spec('a-1', 'b-mars', 'working')], 5);
    d.update(5, world);
    expect(dist(f.position, held)).toBeLessThan(1e-9);
    d.update(5.05, world);
    expect(dist(f.position, held)).toBeGreaterThan(0);
    expect(dist(f.position, held)).toBeLessThan(0.1); // a small step, not a jump
  });

  it('a failed satellite drifts at its slower rate', () => {
    const rate = STATE_LOOK.failed.orbitRate;
    const a = director();
    const b = director();
    a.setSpecs([spec('a-1', 'b-mars', 'working')], 0);
    b.setSpecs([spec('a-1', 'b-mars', 'failed')], 0);
    const fa = a.update(0, world)[0]!;
    const start: Vec3Tuple = [...fa.position];
    a.update(rate, world);
    const working: Vec3Tuple = [...fa.position];
    const fb = b.update(0, world)[0]!;
    b.update(1, world);
    // One second failed travels as far as `rate` seconds working.
    expect(dist(fb.position, working)).toBeLessThan(1e-9);
    expect(dist(working, start)).toBeGreaterThan(0.05);
  });

  it('the Harmonizer’s HQ is a frame like the others, on its body', () => {
    const d = director();
    const earth = anchors({ 'b-earth': { at: [50, 0, 0], radius: 1 } });
    d.setSpecs([spec('a-harmonizer', 'b-earth', 'idle', 'harmonizer')], 0);
    const [f] = d.update(1, earth) as [SatelliteFrame];
    expect(f).toMatchObject({ role: 'harmonizer', bodyId: 'b-earth', visible: true });
    expect(f.size).toBeCloseTo(SATELLITE_LOOK.harmonizer.size, 6);
    expect(getSatellite('a-harmonizer')).toBe(f);
  });
});
