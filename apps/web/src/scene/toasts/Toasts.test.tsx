// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Event } from '@galactic/protocol';
import { emptyWorld, type WorldState } from '../../state/reduce.js';
import { useAppStore } from '../../state/store.js';
import { TOAST } from './toast-model.js';

/**
 * `Toasts` without WebGL (as `Colonies.test.tsx`): R3F's hooks are faked, the intrinsic three
 * elements render as inert DOM placeholders. What is tested is the feed — which store events ask
 * the scene for a frame — and that a frame without anchors draws nothing and does not throw.
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
    useFrame: (callback: (state: unknown) => void) => {
      const latest = useRef(callback);
      latest.current = callback;
      useEffect(() => {
        const run = () =>
          latest.current({
            camera: { quaternion: {}, position: { distanceTo: () => 1 }, fov: 45 },
            size: { width: 800, height: 600 },
            invalidate: () => void r3f.invalidations++,
          });
        r3f.frames.add(run);
        return () => void r3f.frames.delete(run);
      }, []);
    },
  };
});

const { Toasts } = await import('./Toasts.js');

let seq = 0;
function seed(): void {
  const w: WorldState = emptyWorld();
  w.projects = { [fx.project.id]: fx.project };
  w.tasks = { [fx.task.id]: fx.task };
  w.seq = seq;
  useAppStore.getState().reset();
  useAppStore.getState().apply({
    type: 'snapshot',
    seq,
    logId: 'log-1',
    bodies: [],
    projects: [fx.project],
    tasks: [fx.task],
    agents: [],
    questions: [],
    proposals: [],
    statuses: [],
  } as never);
}
const apply = (event: Event, at = new Date().toISOString()) =>
  act(() => useAppStore.getState().apply({ type: 'event', seq: ++seq, at, event }));

beforeEach(() => {
  r3f.invalidations = 0;
  r3f.frames.clear();
  seq = 10;
  seed();
});
afterEach(() => {
  cleanup();
  useAppStore.getState().reset();
});

describe('Toasts (P4-06)', () => {
  it('a fresh completion asks for a frame; quiet events and old ones do not', () => {
    const { container } = render(<Toasts />);
    expect(container.querySelectorAll('mesh')).toHaveLength(TOAST.max);
    const before = r3f.invalidations;
    apply({ type: 'agent.idle', agentId: 'a-1' });
    expect(r3f.invalidations).toBe(before);
    // A replayed backlog (an old `at`) is history.
    apply(
      { type: 'task.state_changed', taskId: 't-1', from: 'in_progress', to: 'completed' },
      '2020-01-01T00:00:00.000Z',
    );
    expect(r3f.invalidations).toBe(before);
    apply({
      type: 'project.state_changed',
      projectId: 'p-1',
      from: 'in_progress',
      to: 'completed',
    });
    expect(r3f.invalidations).toBeGreaterThan(before);
    // No anchor for the body (no scene here): nothing drawn, no throw.
    for (const run of r3f.frames) run();
    for (const mesh of container.querySelectorAll('mesh')) {
      expect((mesh as unknown as { visible: boolean }).visible).toBe(false);
    }
  });

  it('does not flare live events over a timeline replay (P4-07)', () => {
    render(<Toasts />);
    const before = r3f.invalidations;
    act(() => useAppStore.setState({ replayWorld: emptyWorld() }));
    apply({
      type: 'project.state_changed',
      projectId: 'p-1',
      from: 'in_progress',
      to: 'completed',
    });
    expect(r3f.invalidations).toBe(before);
    act(() => useAppStore.setState({ replayWorld: undefined }));
    apply({ type: 'task.state_changed', taskId: 't-1', from: 'in_progress', to: 'completed' });
    expect(r3f.invalidations).toBeGreaterThan(before);
  });

  it('a snapshot is history: nothing toasts for it', () => {
    render(<Toasts />);
    const before = r3f.invalidations;
    seq = 50;
    act(() => seed());
    expect(r3f.invalidations).toBe(before);
  });
});
