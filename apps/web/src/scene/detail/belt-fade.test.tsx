// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Body } from '@galactic/protocol';
import { Object3D } from 'three';
import { useAppStore } from '../../state/store.js';
import { registerAnchor } from '../anchors.js';
import { pickingWorld } from '../picking/fixtures.js';
import { useDetailStore } from './mode.js';

/**
 * `useBeltFade` (P6-07) without WebGL: R3F's `useFrame` is replaced by a manual frame loop.
 */
const r3f = vi.hoisted(() => ({ frames: new Set<() => void>() }));
vi.mock('@react-three/fiber', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useFrame: (callback: () => void) => {
      const latest = useRef(callback);
      latest.current = callback;
      useEffect(() => {
        const run = () => latest.current();
        r3f.frames.add(run);
        return () => void r3f.frames.delete(run);
      }, []);
    },
  };
});

const { useBeltFade } = await import('./dome-binding.js');

let seen: number[] = [];
function Probe() {
  useBeltFade((factor) => seen.push(factor));
  return null;
}
const frame = () => r3f.frames.forEach((run) => run());
const last = () => seen[seen.length - 1];

let now = 0;
let unregister: (() => void)[] = [];
beforeEach(() => {
  unregister = (
    [
      ['b-earth', 'planet'],
      ['b-io', 'moon'],
      ['b-ast-7', 'asteroid'],
    ] as const
  ).map(([bodyId, kind]) => registerAnchor({ bodyId, kind, object: new Object3D(), radius: 1 }));
  seen = [];
  now = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const world = pickingWorld();
  const earth: Body = { id: 'b-earth', kind: 'planet', name: 'Earth', meta: { orbit: 3 } };
  world.bodies = { ...world.bodies, 'b-earth': earth };
  useAppStore.setState({ world });
});
afterEach(() => {
  cleanup();
  useDetailStore.getState().reset();
  unregister.forEach((u) => u());
  vi.restoreAllMocks();
});

describe("the belt's rocks in a detail view (P6-07)", () => {
  it("fade to nothing while a planet's view fades in, and come back while it fades out", () => {
    render(<Probe />);
    frame();
    expect(last()).toBe(1);
    useDetailStore.getState().enter('b-earth', { fly: false, now: 10, reducedMotion: false });
    now = 10_450; // half-way through the fade in
    frame();
    expect(last()).toBeCloseTo(0.5);
    now = 11_000;
    frame();
    expect(last()).toBe(0);
    useDetailStore.getState().exit({ fly: false, now: 11, reducedMotion: false });
    now = 11_350; // half-way through the 0.7 s fade out
    frame();
    expect(last()).toBeCloseTo(0.5);
    now = 12_000;
    frame();
    expect(last()).toBe(1);
  });

  it("stay in an asteroid's view (it lives in the belt) and in a moon's view fade like a planet's", () => {
    render(<Probe />);
    useDetailStore.getState().enter('b-ast-7', { fly: false, reducedMotion: true });
    frame();
    expect(last()).toBe(1);
    useDetailStore.getState().reset();
    useDetailStore.getState().enter('b-io', { fly: false, reducedMotion: true });
    frame();
    expect(last()).toBe(0);
  });
});
