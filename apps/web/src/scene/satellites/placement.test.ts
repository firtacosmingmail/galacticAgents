import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, InstancedMesh, MeshBasicMaterial as Basic } from 'three';
import type { Vec3Tuple } from '../orbit.js';
import { QUALITY_TIERS } from '../quality.js';
import { SatelliteDirector, type AnchorLookup, type SatelliteFrame } from './director.js';
import {
  CLAIM_AT,
  clearPlacement,
  placedAgents,
  placementFor,
  setPlacement,
  type PlacementOverride,
} from './placement.js';
import type { SatelliteSpec } from './satellite-model.js';
import { publishSatellites } from './registry.js';
import { satelliteSpheres } from '../picking/Picking.js';
import { writeInstanced } from './Satellites.js';

/*
 * P6-04: placement overrides — a view (the detail view's project overlay) shows a Steward by its
 * task: the director moves its frame there by `k`, claims it from `CLAIM_AT` (the renderer draws
 * neither satellite nor beam), and never takes over a flight, a landing or a landed satellite.
 */

const spec = (agentId: string, bodyId: string, landed = false): SatelliteSpec => ({
  agentId,
  role: 'steward',
  bodyId,
  state: landed ? 'finished' : 'working',
  activity: undefined,
  archetype: undefined,
  landed,
  supervisorId: undefined,
});

const anchors: AnchorLookup = (bodyId, out) => {
  const at: Record<string, Vec3Tuple> = { 'b-mars': [30, 0, 0], 'b-venus': [-20, 0, 0] };
  const p = at[bodyId];
  if (!p) return undefined;
  out[0] = p[0];
  out[1] = p[1];
  out[2] = p[2];
  return 2;
};

const director = () =>
  new SatelliteDirector({ satellites: QUALITY_TIERS.high.satellites, reducedMotion: false });

const dist = (p: Vec3Tuple, q: Vec3Tuple) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

afterEach(() => {
  for (const id of placedAgents()) clearPlacement(id);
  publishSatellites(new Map());
});

describe('placement overrides in the director', () => {
  it('moves an orbiting frame toward the override by k, claimed from half way', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const [f] = d.update(1, anchors) as [SatelliteFrame];
    const orbit: Vec3Tuple = [...f.position];
    expect(f.claimed).toBe(false);
    const target: Vec3Tuple = [32.1, 0, 0];
    const o: PlacementOverride = { position: target, k: 0.25 };
    setPlacement('a-1', o);
    d.update(1, anchors);
    expect(f.claimed).toBe(false);
    const quarter = [0, 1, 2].map((i) => orbit[i]! + (target[i]! - orbit[i]!) * 0.25);
    for (const i of [0, 1, 2]) expect(f.position[i]).toBeCloseTo(quarter[i]!, 9);
    o.k = CLAIM_AT;
    d.update(1, anchors);
    expect(f.claimed).toBe(true);
    o.k = 1;
    d.update(1, anchors);
    expect(dist(f.position, target)).toBeLessThan(1e-9);
  });

  it('scales the span of a claimed frame (activities and pick target follow the model)', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const [f] = d.update(1, anchors) as [SatelliteFrame];
    const span = f.size;
    setPlacement('a-1', { position: [32, 0, 0], k: 1, scale: 0.5 });
    d.update(1, anchors);
    expect(f.size).toBeCloseTo(span * 0.5, 9);
  });

  it('k = 0 changes nothing; clearing gives the satellite back to its orbit', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const [f] = d.update(1, anchors) as [SatelliteFrame];
    const orbit: Vec3Tuple = [...f.position];
    const o: PlacementOverride = { position: [99, 0, 0], k: 0 };
    setPlacement('a-1', o);
    d.update(1, anchors);
    expect(f.position).toEqual(orbit);
    o.k = 1;
    d.update(1, anchors);
    expect(f.claimed).toBe(true);
    clearPlacement('a-1', { position: [0, 0, 0], k: 1 }); // not its override: kept
    expect(placementFor('a-1')).toBe(o);
    clearPlacement('a-1', o);
    d.update(1, anchors);
    expect(f.claimed).toBe(false);
    expect(dist(f.position, orbit)).toBeLessThan(1e-9);
  });

  it('a hidden override (a robot on the cut-away wedge) makes the claimed frame invisible', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars'), spec('a-2', 'b-mars')], 0);
    const frames = d.update(1, anchors);
    const f = frames.find((x) => x.agentId === 'a-1')!;
    publishSatellites(new Map(frames.map((x) => [x.agentId, x])));
    const o: PlacementOverride = { position: [32, 0, 0], k: 0.25, hidden: true };
    setPlacement('a-1', o);
    // Not claimed yet: the satellite is still the director's, and drawn.
    d.update(1, anchors);
    expect(f.visible).toBe(true);
    // Claimed and hidden: no pick target (and no rings or activities: they skip invisible frames).
    o.k = 1;
    d.update(1, anchors);
    expect(f.claimed).toBe(true);
    expect(f.visible).toBe(false);
    expect(satelliteSpheres().map((x) => x.agentId)).toEqual(['a-2']);
    // Back in sight.
    o.hidden = false;
    d.update(1, anchors);
    expect(f.visible).toBe(true);
    expect(
      satelliteSpheres()
        .map((x) => x.agentId)
        .sort(),
    ).toEqual(['a-1', 'a-2']);
  });

  it('never takes over a flight or a landed satellite', () => {
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars')], 0);
    const [f] = d.update(1, anchors) as [SatelliteFrame];
    setPlacement('a-1', { position: [31, 0, 0], k: 1 });
    // A move to Venus: it flies, the override is ignored meanwhile.
    d.setSpecs([spec('a-1', 'b-venus')], 2);
    d.update(2.5, anchors);
    expect(f.mode).toBe('flying');
    expect(f.claimed).toBe(false);
    expect(dist(f.position, [31, 0, 0])).toBeGreaterThan(1);
    // Landed work stays the director's.
    const e = director();
    e.setSpecs([spec('a-2', 'b-mars', true)], 0);
    setPlacement('a-2', { position: [31, 0, 0], k: 1 });
    const [g] = e.update(10, anchors) as [SatelliteFrame];
    expect(g.mode).toBe('landed');
    expect(g.claimed).toBe(false);
  });
});

describe('the renderer leaves claimed frames out', () => {
  it('the instanced path draws no satellite and no beam for a claimed frame', () => {
    const material = new Basic();
    const bodies = new InstancedMesh(new BoxGeometry(), material, 4);
    const beams = new InstancedMesh(new BoxGeometry(), material, 4);
    const d = director();
    d.setSpecs([spec('a-1', 'b-mars'), spec('a-2', 'b-mars')], 0);
    const frames = d.update(1, anchors);
    writeInstanced(frames, { bodies, beams }, false);
    expect(bodies.count).toBe(2);
    setPlacement('a-1', { position: [32, 0, 0], k: 1 });
    writeInstanced(d.update(1, anchors), { bodies, beams }, false);
    expect(bodies.count).toBe(1);
  });
});
