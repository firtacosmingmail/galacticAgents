// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld, type WorldState } from '../../state/reduce.js';
import { useAppStore } from '../../state/store.js';

/**
 * `Colonies` without WebGL (as `Satellites.test.tsx`): R3F's hooks are faked, the intrinsic three
 * elements render as inert DOM placeholders.
 */
const r3f = vi.hoisted(() => ({
  invalidations: 0,
  frames: new Set<() => void>(),
}));

vi.mock('@react-three/fiber', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useThree: (select: (s: unknown) => unknown) =>
      select({ invalidate: () => void r3f.invalidations++ }),
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

const { Colonies } = await import('./Colonies.js');

function seed(projectState: 'in_progress' | 'completed'): void {
  const w: WorldState = emptyWorld();
  w.bodies = { [fx.moon.id]: fx.moon, [fx.asteroid.id]: fx.asteroid };
  w.projects = { [fx.project.id]: { ...fx.project, state: projectState } };
  w.tasks = {
    [fx.task.id]: { ...fx.task, state: 'completed' },
    [fx.asteroidTask.id]: fx.asteroidTask,
  };
  useAppStore.setState({ world: w });
}

beforeEach(() => {
  r3f.invalidations = 0;
  r3f.frames.clear();
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ world: emptyWorld() });
});

const names = (root: HTMLElement) =>
  [...root.querySelectorAll('points')].map((p) => p.getAttribute('name'));

describe('Colonies (P4-04)', () => {
  it('lights a body once its project completes, and asks the on-demand loop for a frame', () => {
    seed('in_progress');
    const { container } = render(
      <StrictMode>
        <Colonies />
      </StrictMode>,
    );
    // A completed task on the project's body does not colonise it.
    expect(names(container)).toEqual([]);
    const before = r3f.invalidations;
    act(() => seed('completed'));
    expect(names(container)).toEqual(['colony:b-luna']);
    expect(r3f.invalidations).toBeGreaterThan(before);
    // No anchor yet: hidden, no crash.
    for (const run of r3f.frames) run();
    act(() => seed('in_progress'));
    expect(names(container)).toEqual([]);
  });
});
