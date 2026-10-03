// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { Object3D, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLACE_BODIES, READ_BODIES } from './frame-order.js';
import { motionSeconds } from './motion.js';

/**
 * The frame order without WebGL: a fake `useFrame` records each callback with its priority and
 * `frame()` runs them the way R3F does — ascending priority, then subscription order.
 */
const r3f = vi.hoisted(() => ({
  frames: [] as { run: () => void; priority: number; order: number }[],
  order: 0,
}));

vi.mock('@react-three/fiber', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useThree: (select: (s: unknown) => unknown) => select({ invalidate: () => {} }),
    useFrame: (callback: () => void, priority = 0) => {
      const latest = useRef(callback);
      latest.current = callback;
      useEffect(() => {
        const entry = { run: () => latest.current(), priority, order: r3f.order++ };
        r3f.frames.push(entry);
        return () => void r3f.frames.splice(r3f.frames.indexOf(entry), 1);
      }, [priority]);
    },
  };
});

const { useFrame } = await import('@react-three/fiber');
const { useOrbit } = await import('./bodies/Bodies.js');

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
  it('bodies are placed before their readers, without taking over rendering', () => {
    expect(PLACE_BODIES).toBeLessThan(READ_BODIES);
    expect(PLACE_BODIES).toBeLessThanOrEqual(0); // > 0 would take over R3F's render
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
