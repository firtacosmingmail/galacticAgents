import { PerspectiveCamera } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Vec3Tuple } from '../../orbit.js';
import { DETAIL_FRAME_RADII } from '../mode.js';
import { satelliteFrame } from '../../picking/fixtures.js';
import { applyHqPose, overrideHqPose } from '../../satellites/hq/hq-model.js';
import { SATELLITE_LOOK } from '../../satellites/look.js';
import { satelliteOrbit, orbitOffset } from '../../satellites/orbits.js';
import { slotCamera } from './EarthHq.js';
import { HQ_SLOT, HqSlotter, hqSlot, swing, type SlotCamera } from './hq-slot.js';

/** A camera `distance` Earth radii from Earth (radius `radius`, at `centre`), looking at it. */
function cameraAt(
  aspect: number,
  distance = DETAIL_FRAME_RADII,
  radius = 1.7,
  centre: Vec3Tuple = [33, 0, 0],
  from: Vec3Tuple = [0.3, 0.4, 0.866],
): { camera: PerspectiveCamera; slot: SlotCamera } {
  const len = Math.hypot(...from);
  const camera = new PerspectiveCamera(45, aspect, 0.1, 1000);
  camera.position.set(
    centre[0] + (from[0] / len) * distance * radius,
    centre[1] + (from[1] / len) * distance * radius,
    centre[2] + (from[2] / len) * distance * radius,
  );
  camera.lookAt(...centre);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return {
    camera,
    slot: slotCamera(camera, {
      position: [0, 0, 0],
      right: [0, 0, 0],
      up: [0, 0, 0],
      forward: [0, 0, 0],
      tanHalfFov: 1,
      aspect: 1,
    }),
  };
}

const R = 1.7;
const EARTH: Vec3Tuple = [33, 0, 0];
const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
/** Whether the segment from `a` to `b` passes through the sphere (`c`, `r`). */
function blocked(a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple, r: number): boolean {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ll = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2;
  const t = Math.min(1, Math.max(0, (ac[0]! * ab[0]! + ac[1]! * ab[1]! + ac[2]! * ab[2]!) / ll));
  const p: Vec3Tuple = [a[0] + ab[0]! * t, a[1] + ab[1]! * t, a[2] + ab[2]! * t];
  return dist(p, c) < r;
}

afterEach(() => vi.restoreAllMocks());

describe('the HQ viewing slot in Earth’s detail view (P6-06)', () => {
  it('is on screen, in front of Earth and clear of it, at every aspect from 1:1 to 2.2:1', () => {
    for (const aspect of [1, 1.07, 4 / 3, 1.84, 2, 2.2]) {
      const { camera, slot } = cameraAt(aspect);
      const at: Vec3Tuple = [0, 0, 0];
      const scale = hqSlot(slot, EARTH, R, at);
      expect(scale, `aspect ${aspect}`).toBeDefined();
      // Clear of the globe, its glow and half the station's span, and not hidden by Earth.
      expect(dist(at, EARTH)).toBeGreaterThanOrEqual(HQ_SLOT.clearance * R - 1e-9);
      const eye: Vec3Tuple = [camera.position.x, camera.position.y, camera.position.z];
      expect(blocked(eye, at, EARTH, R * 1.035)).toBe(false);
      // At the slot's pixel…
      const ndc = camera.position
        .clone()
        .set(...at)
        .project(camera);
      expect(ndc.x).toBeCloseTo(HQ_SLOT.ndc[0]);
      expect(ndc.y).toBeCloseTo(HQ_SLOT.ndc[1]);
      // …and the whole station (its span at its size factor) inside the canvas.
      const half = (SATELLITE_LOOK.harmonizer.size * R * scale!) / 2;
      for (const [axis, sign] of [
        [slot.right, 1],
        [slot.right, -1],
        [slot.up, 1],
        [slot.up, -1],
      ] as const) {
        const edge = camera.position
          .clone()
          .set(
            at[0] + axis[0] * half * sign,
            at[1] + axis[1] * half * sign,
            at[2] + axis[2] * half * sign,
          )
          .project(camera);
        expect(Math.abs(edge.x)).toBeLessThan(1);
        expect(Math.abs(edge.y)).toBeLessThan(1);
      }
    }
  });

  it('beside the globe in a wide canvas (its own size), in front of the limb and smaller in a square one', () => {
    const wide: Vec3Tuple = [0, 0, 0];
    const square: Vec3Tuple = [0, 0, 0];
    expect(hqSlot(cameraAt(2.2).slot, EARTH, R, wide)).toBeCloseTo(1);
    const s = hqSlot(cameraAt(1).slot, EARTH, R, square)!;
    expect(s).toBeLessThan(0.7);
    expect(s).toBeGreaterThan(0.4);
    expect(dist(square, EARTH)).toBeCloseTo(HQ_SLOT.clearance * R);
  });

  it('none when the camera is too close to Earth: the station keeps its orbit', () => {
    const slotter = new HqSlotter();
    const { slot } = cameraAt(1, 1.3);
    expect(hqSlot(slot, EARTH, R, [0, 0, 0])).toBeUndefined();
    const orbit: Vec3Tuple = [33 + 1.8 * R, 0, 0];
    const out: Vec3Tuple = [0, 0, 0];
    expect(slotter.place(orbit, EARTH, R, slot, 1, 0, true, out)).toBe(1);
    expect(out).toEqual(orbit);
  });

  it('holds the station in its slot wherever its orbit is (visible all the time)', () => {
    const { slot } = cameraAt(1);
    const target: Vec3Tuple = [0, 0, 0];
    hqSlot(slot, EARTH, R, target);
    const slotter = new HqSlotter();
    const orbit = satelliteOrbit('a-harmonizer', 'harmonizer', 0);
    for (let i = 0; i < 24; i++) {
      const o = orbitOffset(orbit, (i / 24) * 2 * Math.PI, 1.8 * R, [0, 0, 0]);
      const at: Vec3Tuple = [EARTH[0] + o[0], o[1], o[2]];
      const out: Vec3Tuple = [0, 0, 0];
      slotter.place(at, EARTH, R, slot, 1, i, true, out);
      expect(dist(out, target)).toBeLessThan(1e-9);
    }
  });

  it('blends in with the cross-fade and follows the slot with a short lag', () => {
    const { slot } = cameraAt(2);
    const target: Vec3Tuple = [0, 0, 0];
    hqSlot(slot, EARTH, R, target);
    const orbit: Vec3Tuple = [EARTH[0], 1.8 * R, 0];
    const out: Vec3Tuple = [0, 0, 0];
    const slotter = new HqSlotter();
    // Mix 0 (system view): on its orbit.
    expect(slotter.place(orbit, EARTH, R, slot, 0, 10, false, out)).toBe(1);
    expect(out).toEqual(orbit);
    // One follow time later, ≈ 63 % of the way to its slot; at mix 1 drawn there.
    slotter.place(orbit, EARTH, R, slot, 1, 10 + HQ_SLOT.followS, false, out);
    const travelled = 1 - dist(out, target) / dist(orbit, target);
    // (1 − e⁻¹ ≈ 63 % of the turn and of the change of height: about that of the distance.)
    expect(travelled).toBeGreaterThan(0.55);
    expect(travelled).toBeLessThan(0.72);
    // Long after: in the slot. Half-way through a fade out: half-way back along the swing.
    for (let t = 10.5; t < 15; t += 0.25) slotter.place(orbit, EARTH, R, slot, 1, t, false, out);
    expect(dist(out, target)).toBeLessThan(1e-3);
    slotter.place(orbit, EARTH, R, slot, 0.5, 15.0001, false, out);
    const rel = (p: Vec3Tuple): Vec3Tuple => [p[0] - EARTH[0], p[1] - EARTH[1], p[2] - EARTH[2]];
    const half = swing(rel(orbit), rel(target), 0.5, [0, 0, 0]);
    expect(dist(rel(out), half)).toBeLessThan(1e-3);
  });

  it('snaps under reduced motion', () => {
    const { slot } = cameraAt(1);
    const target: Vec3Tuple = [0, 0, 0];
    const scale = hqSlot(slot, EARTH, R, target)!;
    const out: Vec3Tuple = [0, 0, 0];
    expect(new HqSlotter().place([EARTH[0], 3, 0], EARTH, R, slot, 1, 0, true, out)).toBeCloseTo(
      scale,
    );
    expect(dist(out, target)).toBeLessThan(1e-9);
  });
});

describe('swing: the station moves about Earth, never through it', () => {
  it('turns along the great circle and changes height linearly', () => {
    const out: Vec3Tuple = [0, 0, 0];
    for (const [a, b] of [
      [
        [3, 0, 0],
        [-2.3, 0.1, 0],
      ],
      [
        [0, 3, 0],
        [0, -3, 0],
      ],
      [
        [1, 2, 2],
        [2, 1, -2],
      ],
    ] as [Vec3Tuple, Vec3Tuple][]) {
      const la = Math.hypot(...a);
      const lb = Math.hypot(...b);
      expect(dist(swing(a, b, 0, out), a)).toBeLessThan(1e-9);
      expect(dist(swing(a, b, 1, out), b)).toBeLessThan(1e-9);
      for (let t = 0; t <= 1; t += 0.05) {
        const p = swing(a, b, t, out);
        expect(Math.hypot(...p)).toBeCloseTo(la + (lb - la) * t);
        expect(Math.hypot(...p)).toBeGreaterThanOrEqual(Math.min(la, lb) - 1e-9);
      }
    }
  });

  it('entering and leaving, the station stays clear of Earth all the way', () => {
    const { slot } = cameraAt(1);
    const out: Vec3Tuple = [0, 0, 0];
    // Its orbit on Earth's far side: a straight blend would cross the globe.
    const orbit: Vec3Tuple = [EARTH[0] - 1.8 * R * 0.3, -1.8 * R * 0.4, -1.8 * R * 0.866];
    const slotter = new HqSlotter();
    let t = 0;
    for (let mix = 0; mix <= 1; mix += 0.05, t += 0.05) {
      slotter.place(orbit, EARTH, R, slot, mix, t, false, out);
      expect(dist(out, EARTH)).toBeGreaterThanOrEqual(HQ_SLOT.clearance * R - 1e-6);
    }
    for (let mix = 1; mix >= 0; mix -= 0.05, t += 0.05) {
      slotter.place(orbit, EARTH, R, slot, mix, t, false, out);
      expect(dist(out, EARTH)).toBeGreaterThanOrEqual(HQ_SLOT.clearance * R - 1e-6);
    }
  });
});

describe('the HQ pose override (P6-06)', () => {
  it("moves only the Harmonizer's drawn frame, while installed", () => {
    const { camera } = cameraAt(1);
    const hq = satelliteFrame('a-h', 'b-earth', [1, 2, 3], { role: 'harmonizer' });
    const steward = satelliteFrame('a-st', 'b-earth', [4, 5, 6]);
    const seen: string[] = [];
    const stop = overrideHqPose((frame, cam) => {
      expect(cam).toBe(camera);
      seen.push(frame.agentId);
      frame.position[0] = 99;
    });
    applyHqPose([steward, hq], camera);
    expect(seen).toEqual(['a-h']);
    expect(hq.position[0]).toBe(99);
    expect(steward.position).toEqual([4, 5, 6]);
    hq.visible = false;
    applyHqPose([hq], camera);
    expect(seen).toEqual(['a-h']);
    hq.visible = true;
    stop();
    applyHqPose([hq], camera);
    expect(seen).toEqual(['a-h']);
  });

  it('a stale removal does not remove a newer override', () => {
    const { camera } = cameraAt(1);
    const hq = satelliteFrame('a-h', 'b-earth', [1, 2, 3], { role: 'harmonizer' });
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = overrideHqPose(first);
    const stopSecond = overrideHqPose(second);
    stopFirst();
    applyHqPose([hq], camera);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    stopSecond();
  });
});
