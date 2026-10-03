import { describe, expect, it } from 'vitest';
import {
  CLEAR_TARGET_PX,
  MAX_CANDIDATES,
  pickBodies,
  pixelScale,
  type PickRay,
  type PickSphere,
} from './pick.js';

/** The camera at z = 100 looking down -z; the pointer's ray goes through (x, y) on z = 0. */
function rayThrough(x: number, y: number): PickRay {
  const dx = x;
  const dy = y;
  const dz = -100;
  const len = Math.hypot(dx, dy, dz);
  return { origin: [0, 0, 100], direction: [dx / len, dy / len, dz / len] };
}

/** 1000 px per unit at distance 1: at depth 100, one world unit spans 10 px. */
const PX = 1000;
const sphere = (bodyId: string, x: number, y: number, z: number, radius: number): PickSphere => ({
  bodyId,
  center: [x, y, z],
  radius,
});

describe('pickBodies (ray vs bounding spheres over the anchors)', () => {
  it('pixelScale is height / (2 tan(fov / 2))', () => {
    expect(pixelScale(1000, 90)).toBeCloseTo(500);
    expect(pixelScale(800, 45)).toBeCloseTo(800 / (2 * Math.tan(Math.PI / 8)));
  });

  it('picks the body under the pointer; empty space picks nothing', () => {
    const spheres = [sphere('big', 0, 0, 0, 5), sphere('far-off', 40, 0, 0, 2)];
    expect(pickBodies(rayThrough(1, 1), spheres, PX).choice).toBe('big');
    const empty = pickBodies(rayThrough(-30, 20), spheres, PX);
    expect(empty.choice).toBeUndefined();
    expect(empty.candidates).toEqual([]);
  });

  it('a nearer body hides the one behind it (occlusion)', () => {
    const behind = sphere('behind', 0, 0, -50, 8);
    const front = sphere('front', 0, 0, 20, 3); // 3 units at depth 80: 37 px, clear
    const result = pickBodies(rayThrough(0, 0), [behind, front], PX);
    expect(result.choice).toBe('front');
    expect(result.candidates.map((c) => c.bodyId)).toEqual(['front', 'behind']);
    // Past the front body's edge, the one behind is hit and chosen.
    expect(pickBodies(rayThrough(5, 0), [behind, front], PX).choice).toBe('behind');
  });

  it('picks the nearest of several hits, not the biggest', () => {
    const result = pickBodies(
      rayThrough(0, 0),
      [sphere('sun', 0, 0, -200, 30), sphere('planet', 0, 0, 0, 2)],
      PX,
    );
    expect(result.choice).toBe('planet');
  });

  it('a speck is still pickable within its minimum target', () => {
    const rock = sphere('rock', 0, 0, 0, 0.05); // half a pixel
    expect(pickBodies(rayThrough(0.4, 0), [rock], PX).choice).toBe('rock'); // 4 px away
    expect(pickBodies(rayThrough(2, 0), [rock], PX).choice).toBeUndefined(); // 20 px away
  });

  it('a planet and its moons within a few pixels: "what\'s here" lists them, no guess', () => {
    // System scale: a planet 0.8 units (8 px) with moons 0.6 and 0.9 units (6-9 px) away.
    const spheres = [
      sphere('jupiter', 0, 0, 0, 0.8),
      sphere('io', 0.6, 0, 0, 0.1),
      sphere('europa', -0.9, 0.2, 0, 0.1),
      sphere('mars', 20, 0, 0, 0.5),
    ];
    const result = pickBodies(rayThrough(0.1, 0), spheres, PX);
    expect(result.choice).toBeUndefined();
    expect(result.candidates.map((c) => c.bodyId).sort()).toEqual(['europa', 'io', 'jupiter']);
    // The planet the pointer is on comes first, then the moons closest to the pointer.
    expect(result.candidates.map((c) => c.bodyId)).toEqual(['jupiter', 'io', 'europa']);
  });

  it('lists the body under the pointer before a speck in front of it', () => {
    // A 1 px moon 3 px off the ray, in front of an 8 px planet: within the moon's minimum target.
    const spheres = [sphere('planet', 0, 0, 0, 0.8), sphere('moon', 0.3, 0, 20, 0.08)];
    const result = pickBodies(rayThrough(0, 0), spheres, PX);
    expect(result.choice).toBeUndefined();
    expect(result.candidates.map((c) => [c.bodyId, c.hit, c.onBody])).toEqual([
      ['planet', true, true],
      ['moon', true, false],
    ]);
  });

  it('a body big on screen is clearly the target even with a small moon nearby', () => {
    // Jupiter zoomed in: 3 units at depth 100 = 30 px; a moon 1 px of radius 34 px away.
    const spheres = [sphere('jupiter', 0, 0, 0, 3), sphere('io', 3.4, 0, 0, 0.1)];
    const result = pickBodies(rayThrough(2.5, 0), spheres, PX);
    expect(result.candidates.length).toBe(2);
    expect(result.candidates[0]!.screenRadius).toBeGreaterThanOrEqual(CLEAR_TARGET_PX);
    expect(result.choice).toBe('jupiter');
  });

  it('a small body in front of a big one is ambiguous (a moon passing its planet)', () => {
    const spheres = [sphere('planet', 0, 0, 0, 3), sphere('moon', 0, 0, 10, 0.2)];
    const result = pickBodies(rayThrough(0, 0), spheres, PX);
    expect(result.choice).toBeUndefined();
    expect(result.candidates.map((c) => c.bodyId)).toEqual(['moon', 'planet']);
  });

  it('ignores bodies behind the camera and a body the camera is inside', () => {
    const spheres = [sphere('behind-camera', 0, 0, 150, 5), sphere('around', 0, 0, 100, 3)];
    expect(pickBodies(rayThrough(0, 0), spheres, PX).candidates).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => sphere(`r${i}`, i * 0.05, 0, 0, 0.02));
    const result = pickBodies(rayThrough(0.4, 0), many, PX);
    expect(result.candidates).toHaveLength(MAX_CANDIDATES);
    expect(result.choice).toBeUndefined();
  });
});
