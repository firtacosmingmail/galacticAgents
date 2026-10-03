import { describe, expect, it } from 'vitest';
import type { Id } from '@galactic/protocol';
import type { SatelliteFrame } from '../director.js';
import type { ActivityArchetype, SatelliteMode } from '../machine.js';
import { QUALITY_TIERS } from '../../quality.js';
import {
  ACTIVITY_QUALITY,
  ActivityLayer,
  capacityFor,
  footingOf,
  PER_ARCHETYPE,
  type ActivityContext,
  type Footing,
  type InstanceList,
} from './activity-model.js';

const MARS: [number, number, number] = [30, 0, 0];
const JUPITER: [number, number, number] = [0, 0, -80];

function frame(
  agentId: string,
  mode: SatelliteMode,
  over: Partial<SatelliteFrame> = {},
): SatelliteFrame {
  const target = over.target ?? MARS;
  const bodyRadius = over.bodyRadius ?? 2;
  return {
    agentId,
    role: 'steward',
    bodyId: 'b-mars',
    mode,
    view: { mode, from: 'orbiting', blend: 1, flight: undefined, beam: 0, landing: 0 },
    visible: true,
    position: [target[0], target[1] + bodyRadius * 2, target[2]],
    target,
    bodyRadius,
    size: 0.2,
    beam: 0,
    sweep: 0,
    animated: true,
    presence: 1,
    tint: '#fff',
    beamTint: [1, 1, 1],
    brightness: 1,
    ...over,
  };
}

function context(
  over: Partial<ActivityContext> = {},
  others: SatelliteFrame[] = [],
): ActivityContext {
  const byId = new Map(others.map((f) => [f.agentId, f]));
  const footings: Record<Id, Footing> = { 'b-mars': 'surface', 'b-jupiter': 'platform' };
  return {
    now: 10,
    reducedMotion: false,
    bloom: true,
    quality: ACTIVITY_QUALITY.high,
    footing: (id) => footings[id] ?? 'surface',
    supervisor: (id) => (id.startsWith('a-s') ? 'a-wk' : undefined),
    satellite: (id) => byId.get(id),
    ...over,
  };
}

const points = (list: InstanceList) =>
  Array.from({ length: list.count }, (_, i) => [
    list.position[i * 3] ?? 0,
    list.position[i * 3 + 1] ?? 0,
    list.position[i * 3 + 2] ?? 0,
  ]);
const dist = (p: readonly number[], q: readonly number[]) =>
  Math.hypot((p[0] ?? 0) - (q[0] ?? 0), (p[1] ?? 0) - (q[1] ?? 0), (p[2] ?? 0) - (q[2] ?? 0));

describe('footingOf', () => {
  it('gas and ice giants build platforms; rocky planets, moons and asteroids have a surface', () => {
    for (const name of ['Jupiter', 'Saturn', 'Uranus', 'Neptune'])
      expect(footingOf({ kind: 'planet', name })).toBe('platform');
    for (const name of ['Mercury', 'Venus', 'Earth', 'Mars', 'Unknown-planet'])
      expect(footingOf({ kind: 'planet', name })).toBe('surface');
    for (const name of ['Titan', 'Europa', 'Io', 'Moon'])
      expect(footingOf({ kind: 'moon', name })).toBe('surface');
    expect(footingOf({ kind: 'asteroid', name: 'Task rock' })).toBe('surface');
    expect(footingOf(undefined)).toBe('surface');
  });
});

describe('ActivityLayer', () => {
  it('gathering: drones between the surface under the satellite and the satellite', () => {
    const layer = new ActivityLayer(16);
    const f = frame('a-s1', 'gathering');
    layer.build([f], context());
    expect(layer.glow.count).toBe(ACTIVITY_QUALITY.high.drones);
    expect(layer.solid.count).toBe(0);
    for (const p of points(layer.glow)) {
      const r = dist(p, MARS);
      expect(r).toBeGreaterThanOrEqual(f.bodyRadius * 0.99);
      expect(r).toBeLessThanOrEqual(f.bodyRadius * 2.01);
      expect(p[1] ?? 0).toBeGreaterThan(0); // on the satellite's side of the body
    }
  });

  it("transporting: a shuttle between the Steward and its Waykeeper's satellite on the same body", () => {
    const layer = new ActivityLayer(16);
    const steward = frame('a-s1', 'transporting');
    const waykeeper = frame('a-wk', 'orbiting', {
      role: 'waykeeper',
      position: [MARS[0] + 4, MARS[1], MARS[2]],
    });
    const ctx = context({}, [waykeeper]);
    const positions: number[][] = [];
    for (let t = 0; t < 4; t += 0.1) {
      layer.build([steward, waykeeper], { ...ctx, now: t });
      expect(layer.solid.count).toBe(1);
      positions.push(points(layer.solid)[0] ?? []);
    }
    // It reaches both ends over one cycle.
    const nearest = (q: readonly number[]) => Math.min(...positions.map((p) => dist(p, q)));
    expect(nearest(steward.position)).toBeLessThan(0.1);
    expect(nearest(waykeeper.position)).toBeLessThan(0.1);
    expect(layer.glow.count).toBe(ACTIVITY_QUALITY.high.trail);
  });

  it('transporting without a Waykeeper on the body (an asteroid): down to the surface and back', () => {
    const layer = new ActivityLayer(16);
    const steward = frame('a-s1', 'transporting');
    const elsewhere = frame('a-wk', 'orbiting', { role: 'waykeeper', bodyId: 'b-earth' });
    const ctx = context({}, [elsewhere]);
    let lowest = Infinity;
    for (let t = 0; t < 4; t += 0.05) {
      layer.build([steward], { ...ctx, now: t });
      lowest = Math.min(lowest, dist(points(layer.solid)[0] ?? [], MARS));
    }
    expect(lowest).toBeLessThan(steward.bodyRadius * 1.05);
  });

  it('building on a rocky body: robots standing on the surface near the ground track, fixed', () => {
    const layer = new ActivityLayer(16);
    const f = frame('a-s1', 'building');
    layer.build([f], context({ now: 1 }));
    expect(layer.solid.count).toBe(ACTIVITY_QUALITY.high.robots);
    const site = points(layer.solid);
    for (const p of site) {
      expect(dist(p, MARS)).toBeGreaterThan(f.bodyRadius);
      expect(dist(p, MARS)).toBeLessThan(f.bodyRadius * 1.1);
      // Near the point under the satellite (within ~0.2 rad).
      expect(dist(p, [MARS[0], MARS[1] + f.bodyRadius, MARS[2]])).toBeLessThan(f.bodyRadius * 0.3);
    }
    // The satellite orbits on; the site stays where building began.
    f.position = [MARS[0] + 4, MARS[1], MARS[2]];
    layer.build([f], context({ now: 1.01 }));
    for (const [i, p] of points(layer.solid).entries())
      expect(dist(p, site[i] ?? [])).toBeLessThan(0.05);
  });

  it('building on a gas giant: an orbital platform under the satellite, never inside the body', () => {
    const layer = new ActivityLayer(16);
    const f = frame('a-s1', 'building', {
      bodyId: 'b-jupiter',
      target: JUPITER,
      bodyRadius: 5,
      position: [JUPITER[0], JUPITER[1] + 9, JUPITER[2]],
    });
    let most = 0;
    for (let t = 0; t < 6; t += 0.25) {
      layer.build([f], context({ now: t }));
      most = Math.max(most, layer.solid.count);
      for (const p of points(layer.solid)) {
        expect(dist(p, JUPITER)).toBeGreaterThan(5);
        expect(dist(p, JUPITER)).toBeLessThan(9);
      }
    }
    expect(most).toBe(PER_ARCHETYPE.solid); // the mast and four struts, assembled over a cycle
  });

  it('waykeepers, hidden satellites and satellites out of the budget draw nothing', () => {
    const layer = new ActivityLayer(16);
    layer.build(
      [
        frame('a-wk', 'building', { role: 'waykeeper' }),
        frame('a-s1', 'gathering', { visible: false }),
        frame('a-s2', 'building', { animated: false }),
        frame('a-s3', 'orbiting'),
      ],
      context(),
    );
    expect(layer.solid.count + layer.glow.count).toBe(0);
  });

  it('follows the mode blend in, fades the previous archetype out, and fades on losing the budget', () => {
    const layer = new ActivityLayer(16);
    const f = frame('a-s1', 'building', {
      view: {
        mode: 'building',
        from: 'gathering',
        blend: 0.25,
        flight: undefined,
        beam: 0,
        landing: 0,
      },
    });
    layer.build([f], context({ now: 0 }));
    // Both drawn mid-blend: the drones shrinking out, the robots growing in.
    expect(layer.glow.count).toBeGreaterThan(0);
    expect(layer.solid.count).toBeGreaterThan(0);
    const robotHeight = (l: InstanceList) => l.scale[1] ?? 0;
    const early = robotHeight(layer.solid);
    f.view = { ...f.view, blend: 1 };
    layer.build([f], context({ now: 0.6 }));
    expect(robotHeight(layer.solid)).toBeGreaterThan(early * 2);
    // Out of the budget: fades over `fadeOut`, not at once.
    f.animated = false;
    layer.build([f], context({ now: 0.7 }));
    expect(layer.solid.count).toBeGreaterThan(0);
    layer.build([f], context({ now: 1.2 }));
    expect(layer.solid.count).toBe(0);
  });

  it('reduced motion: static (the same pieces at any time) and at once', () => {
    const layer = new ActivityLayer(16);
    const frames = (['gathering', 'transporting', 'building'] as ActivityArchetype[]).map((m, i) =>
      frame(`a-s${i}`, m, {
        view: { mode: m, from: 'orbiting', blend: 1, flight: undefined, beam: 0, landing: 0 },
      }),
    );
    layer.build(frames, context({ reducedMotion: true, now: 3 }));
    const a = [...points(layer.solid), ...points(layer.glow)];
    layer.build(frames, context({ reducedMotion: true, now: 17.3 }));
    const b = [...points(layer.solid), ...points(layer.glow)];
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('the cap bounds the instances: 40 Stewards, mixed archetypes, any tier', () => {
    for (const tier of ['high', 'balanced', 'mobile'] as const) {
      const cap = QUALITY_TIERS[tier].satellites.maxAnimated;
      const layer = new ActivityLayer(cap);
      const modes: SatelliteMode[] = ['gathering', 'transporting', 'building'];
      const frames = Array.from({ length: 40 }, (_, i) =>
        frame(`a-s${String(i).padStart(2, '0')}`, modes[i % 3] ?? 'gathering', {
          animated: i < cap, // the director's cap
          bodyId: i % 2 ? 'b-jupiter' : 'b-mars',
          view: {
            mode: modes[i % 3] ?? 'gathering',
            from: modes[(i + 1) % 3] ?? 'gathering',
            blend: 0.5,
            flight: undefined,
            beam: 0,
            landing: 0,
          },
        }),
      );
      for (let t = 0; t < 8; t += 0.5) {
        layer.build(frames, context({ quality: ACTIVITY_QUALITY[tier], now: t }));
        expect(layer.solid.count).toBeLessThanOrEqual(capacityFor(cap).solid);
        expect(layer.glow.count).toBeLessThanOrEqual(capacityFor(cap).glow);
      }
      expect(layer.solid.count).toBeGreaterThan(0);
    }
  });

  it('the mobile tier draws fewer pieces and no sparks or trail', () => {
    const count = (tier: 'high' | 'mobile', mode: SatelliteMode) => {
      const layer = new ActivityLayer(16);
      let most = 0;
      for (let t = 0; t < 4; t += 0.05) {
        layer.build([frame('a-s1', mode)], context({ quality: ACTIVITY_QUALITY[tier], now: t }));
        most = Math.max(most, layer.solid.count + layer.glow.count);
      }
      return most;
    };
    for (const mode of ['gathering', 'transporting', 'building'] as const)
      expect(count('mobile', mode)).toBeLessThan(count('high', mode));
  });
});
