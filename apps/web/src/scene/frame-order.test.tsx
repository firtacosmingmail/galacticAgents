// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { useRef, type Ref } from 'react';
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLACE_BODIES, PLACE_CAMERA, PLACE_SATELLITES, READ_BODIES } from './frame-order.js';
import { motionSeconds } from './motion.js';

/**
 * The frame order without WebGL: a fake `useFrame` records each callback with its priority and
 * `frame()` runs them the way R3F does — ascending priority, then subscription order.
 */
const r3f = vi.hoisted(() => ({
  frames: [] as { run: () => void; priority: number; order: number }[],
  order: 0,
}));

const camera = new PerspectiveCamera(45, 800 / 600, 0.1, 1000);
const frameState = { camera, size: { width: 800, height: 600 } };

vi.mock('@react-three/fiber', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useThree: (select: (s: unknown) => unknown) => select({ invalidate: () => {} }),
    useFrame: (callback: (state: unknown) => void, priority = 0) => {
      const latest = useRef(callback);
      latest.current = callback;
      useEffect(() => {
        const entry = { run: () => latest.current(frameState), priority, order: r3f.order++ };
        r3f.frames.push(entry);
        return () => void r3f.frames.splice(r3f.frames.indexOf(entry), 1);
      }, [priority]);
    },
  };
});

// OrbitControls without a canvas: the controls the rig writes to (its target and limits).
vi.mock('@react-three/drei', async () => {
  const { useImperativeHandle } = await import('react');
  const { Vector3: V } = await import('three');
  return {
    OrbitControls: ({ ref }: { ref: Ref<unknown> }) => {
      useImperativeHandle(ref, () => ({ target: new V() }), []);
      return null;
    },
  };
});

const { useFrame } = await import('@react-three/fiber');
const { useOrbit } = await import('./bodies/Bodies.js');
const { CameraRig } = await import('./camera/CameraRig.js');

function frame(): void {
  const sorted = [...r3f.frames].sort((a, b) => a.priority - b.priority || a.order - b.order);
  for (const f of sorted) f.run();
}

const body = new Object3D();
const seen: Vector3[] = [];

/** A reader of the body's position (like the satellites), subscribed before the body. */
function Reader() {
  useFrame(() => void seen.push(body.getWorldPosition(new Vector3())));
  return null;
}

function Body() {
  const ref = useRef<Object3D>(body);
  useOrbit(ref, 10, 0, 5, true);
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('frame order', () => {
  it('bodies, then satellites, then the camera, then their readers; none takes over rendering', () => {
    expect(PLACE_BODIES).toBeLessThan(PLACE_SATELLITES);
    expect(PLACE_SATELLITES).toBeLessThan(PLACE_CAMERA);
    expect(PLACE_CAMERA).toBeLessThan(READ_BODIES);
    expect(READ_BODIES).toBeLessThanOrEqual(0); // > 0 would take over R3F's render
  });

  it('a camera reader mounted before the rig (beacons, picking) sees this frame’s camera', () => {
    const poses: Vector3[] = [];
    function CameraReader() {
      useFrame(() => void poses.push(camera.position.clone()));
      return null;
    }
    camera.position.set(1, 2, 3);
    render(
      <>
        <CameraReader />
        <CameraRig />
      </>,
    );
    frame(); // the rig's first frame snaps to the overview: the camera moves
    expect(camera.position.distanceTo(new Vector3(1, 2, 3))).toBeGreaterThan(1);
    expect(poses.at(-1)?.distanceTo(camera.position)).toBeCloseTo(0, 9);
  });

  it('a reader subscribed before the body still sees where the body is this frame', () => {
    render(
      <>
        <Reader />
        <Body />
      </>,
    );
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    for (let i = 0; i < 5; i++) {
      now += 400;
      frame();
      const expected = body.getWorldPosition(new Vector3());
      expect(seen.at(-1)?.distanceTo(expected)).toBeCloseTo(0, 9);
    }
    expect(motionSeconds()).toBeGreaterThan(0);
  });
});
