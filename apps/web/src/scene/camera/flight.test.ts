import { describe, expect, it } from 'vitest';
import {
  approachDirection,
  azimuth,
  DEFAULT_OVERVIEW_DISTANCE,
  distance,
  dot,
  easeInOutCubic,
  flightDuration,
  flightPose,
  FOCUS_FILL,
  framingDistance,
  halfFov,
  length,
  MAX_FLIGHT_S,
  MIN_FLIGHT_S,
  MIN_OUTWARD,
  normalize,
  overviewPose,
  pushOutside,
  rotateY,
  segmentClearance,
  SIGHT_CLEARANCE,
  sub,
  type Vec3,
  type View,
} from './flight.js';

const VIEW: View = { fovDeg: 45, aspect: 16 / 9 };

describe('easing', () => {
  it('starts at 0, ends at 1, is symmetric and monotonic, clamps outside [0, 1]', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      const v = easeInOutCubic(i / 100);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    // Slow start and stop.
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
  });
});

describe('framing distance', () => {
  it('makes the body fill FOCUS_FILL of the half field of view', () => {
    const d = framingDistance(2, VIEW);
    expect(Math.asin(2 / d)).toBeCloseTo(halfFov(VIEW) * FOCUS_FILL);
  });

  it('scales with the radius and uses the narrower axis on a portrait screen', () => {
    expect(framingDistance(4, VIEW)).toBeCloseTo(framingDistance(2, VIEW) * 2);
    const portrait = { fovDeg: 45, aspect: 0.5 };
    expect(halfFov(portrait)).toBeLessThan(halfFov(VIEW));
    expect(framingDistance(2, portrait)).toBeGreaterThan(framingDistance(2, VIEW));
  });

  it('frames a tiny asteroid close up, never inside it', () => {
    const d = framingDistance(0.01, VIEW);
    expect(d).toBeGreaterThan(0.05);
    expect(d).toBeLessThan(2);
    expect(framingDistance(0.2, VIEW)).toBeGreaterThan(0.2 * 1.5);
  });
});

describe('approach direction (corner case 26)', () => {
  const SUN = 6;

  it('keeps the current direction when the line of sight clears the Sun', () => {
    const body: Vec3 = [50, 0, 0];
    // From outside the orbit, and from the overview (above, on the Sun's side: the lit face).
    for (const camera of [
      [80, 20, 10],
      [0, 96, 336],
    ] as Vec3[]) {
      expect(approachDirection(body, camera, SUN, 10)).toEqual(normalize(sub(camera, body)));
    }
  });

  it('never leaves the Sun between the camera and the body', () => {
    const body: Vec3 = [30, 0, 0];
    // The camera on the far side of the Sun, the worst case.
    for (const camera of [
      [-200, 0, 0],
      [-200, 40, 5],
      [-30, 0, -30],
      [0, 300, 0],
      [30, 0, 0.0001],
    ] as Vec3[]) {
      for (const radius of [0.1, 1, 3, 10]) {
        const d = framingDistance(radius, VIEW);
        const dir = approachDirection(body, camera, SUN, d);
        expect(length(dir)).toBeCloseTo(1);
        const at: Vec3 = [body[0] + dir[0] * d, body[1] + dir[1] * d, body[2] + dir[2] * d];
        expect(segmentClearance(at, body)).toBeGreaterThan(SUN);
      }
    }
  });

  it('turns a blocked direction just enough to the far side of the body', () => {
    const body: Vec3 = [30, 0, 0];
    const dir = approachDirection(body, [-200, 0, 0], SUN, 60);
    expect(dot(dir, normalize(body))).toBeCloseTo(MIN_OUTWARD);
    // Straight across the Sun there is no sideways part: it leans up.
    expect(dir[1]).toBeGreaterThan(0);
    const at: Vec3 = [body[0] + dir[0] * 60, body[1] + dir[1] * 60, body[2] + dir[2] * 60];
    expect(segmentClearance(at, body)).toBeGreaterThan(SUN * SIGHT_CLEARANCE);
  });

  it('approaches the Sun itself from wherever the camera is', () => {
    expect(approachDirection([0, 0, 0], [0, 0, -100], SUN, 20)).toEqual([0, 0, -1]);
  });

  it('segment clearance is the closest approach to the Sun', () => {
    expect(segmentClearance([-10, 5, 0], [10, 5, 0])).toBeCloseTo(5);
    expect(segmentClearance([10, 0, 0], [20, 0, 0])).toBeCloseTo(10);
    expect(segmentClearance([3, 4, 0], [3, 4, 0])).toBeCloseTo(5);
  });
});

describe('overview', () => {
  it('is the initial camera when nothing is registered', () => {
    const pose = overviewPose(0, VIEW);
    expect(pose.target).toEqual([0, 0, 0]);
    expect(length(pose.position)).toBeCloseTo(DEFAULT_OVERVIEW_DISTANCE);
    expect(pose.position[0]).toBeCloseTo(0);
    expect(pose.position[1]).toBeCloseTo(40);
    expect(pose.position[2]).toBeCloseTo(140);
  });

  it('backs off until the whole system spans the view', () => {
    const pose = overviewPose(250, VIEW);
    expect(length(pose.position)).toBeCloseTo(250 / Math.tan(halfFov(VIEW)));
  });
});

describe('flight', () => {
  const a = { position: [0, 40, 140] as Vec3, target: [0, 0, 0] as Vec3 };
  const b = { position: [60, 5, 0] as Vec3, target: [50, 0, 0] as Vec3 };

  it('lasts 0.8–1.5 s by travel, 0 for reduced motion', () => {
    expect(flightDuration(a, a, false)).toBe(MIN_FLIGHT_S);
    const far = { position: [3000, 0, 0] as Vec3, target: [3000, 0, 0] as Vec3 };
    expect(flightDuration(a, far, false)).toBe(MAX_FLIGHT_S);
    const mid = flightDuration(a, b, false);
    expect(mid).toBeGreaterThan(MIN_FLIGHT_S);
    expect(mid).toBeLessThan(MAX_FLIGHT_S);
    expect(flightDuration(a, b, true)).toBe(0);
  });

  it('runs from the start pose to the goal', () => {
    expect(flightPose(a, b, 0, 12)).toEqual(a);
    expect(flightPose(a, b, 1, 12)).toEqual(b);
    const half = flightPose(a, b, 0.5, 12);
    expect(distance(half.target, [25, 0, 0])).toBeCloseTo(0);
  });

  it('goes around the Sun, not through it', () => {
    const from = { position: [-100, 0, 0] as Vec3, target: [-90, 0, 0] as Vec3 };
    const to = { position: [100, 0, 0] as Vec3, target: [90, 0, 0] as Vec3 };
    for (let i = 0; i <= 20; i++) {
      expect(length(flightPose(from, to, i / 20, 12).position)).toBeGreaterThanOrEqual(12 - 1e-9);
    }
  });

  it('pushOutside leaves points outside alone and lifts the centre up', () => {
    const p: Vec3 = [20, 0, 0];
    expect(pushOutside(p, 8)).toBe(p);
    expect(pushOutside([1, 0, 0], 8)).toEqual([8, 0, 0]);
    expect(pushOutside([0, 0, 0], 8)).toEqual([0, 8, 0]);
  });

  it('rotateY and azimuth agree', () => {
    const v: Vec3 = [3, 1, 4];
    const r = rotateY(v, 0.7);
    expect(azimuth(r) - azimuth(v)).toBeCloseTo(0.7);
    expect(r[1]).toBe(1);
    expect(length(r)).toBeCloseTo(length(v));
  });
});
