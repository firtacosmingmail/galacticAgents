// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld } from '../../../state/reduce.js';
import { useAppStore } from '../../../state/store.js';
import { QUALITY_TIERS } from '../../quality.js';
import { deriveArchetype, HOLD, type HoldInput } from '../archetype.js';
import { getSatellite, publishSatellites } from '../registry.js';
import { InstanceList } from './activity-model.js';
import { writeList } from './Activities.js';
import { useHeldArchetypes } from './use-held-archetypes.js';

/**
 * The archetypes end to end without WebGL (the acceptance: "switching activity in the harness
 * changes the archetype within a second"): the store → `satelliteList` (the hook) →
 * `useHeldArchetypes` → the director's actor. R3F is faked as in `Satellites.test.tsx`; the clock
 * (timers and `performance.now`) is faked.
 */
const r3f = vi.hoisted(() => ({
  state: undefined as unknown as Record<string, unknown>,
  frames: new Set<(state: unknown) => void>(),
}));

vi.mock('@react-three/fiber', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useThree: (select: (s: unknown) => unknown) => select(r3f.state),
    useFrame: (callback: (state: unknown) => void) => {
      const latest = useRef(callback);
      latest.current = callback;
      useEffect(() => {
        const run = (s: unknown) => latest.current(s);
        r3f.frames.add(run);
        return () => void r3f.frames.delete(run);
      }, []);
    },
  };
});

const { Satellites } = await import('../Satellites.js');

const STEWARD = 'a-steward-1';
const steward: Agent = { ...fx.agent, id: STEWARD, taskId: fx.task.id };

function setActivity(currentActivity: string, state: StatusRecord['state'] = 'working'): void {
  const w = emptyWorld();
  w.tasks = { [fx.task.id]: fx.task };
  w.agents[STEWARD] = steward;
  w.statuses[STEWARD] = { ...fx.status, agentId: STEWARD, state, currentActivity };
  useAppStore.setState({ world: w });
}

const drawFrame = () => {
  for (const run of r3f.frames) run(r3f.state);
};

/** Advances the fake clock by `seconds` in 50 ms steps, drawing a frame at each. */
function elapse(seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 0.05) {
    act(() => void vi.advanceTimersByTime(50));
    drawFrame();
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  r3f.state = {
    invalidate: () => {},
    camera: new PerspectiveCamera(45, 1, 0.1, 1000),
    size: { width: 800, height: 600 },
  };
  r3f.frames.clear();
});

afterEach(() => {
  cleanup();
  publishSatellites(new Map());
  useAppStore.setState({ world: emptyWorld() });
  vi.useRealTimers();
});

describe('archetypes in the scene (the acceptance)', () => {
  it('switching the activity changes the satellite archetype within a second', () => {
    // No anchor: the satellite is hidden, but its actor runs (the director advances it anyway).
    setActivity('Read: src/a.ts');
    render(<Satellites quality={QUALITY_TIERS.high} />);
    drawFrame();
    expect(getSatellite(STEWARD)?.mode).not.toBe('gathering'); // not confirmed yet
    elapse(1);
    expect(getSatellite(STEWARD)?.mode).toBe('gathering');
    elapse(HOLD.minDwell); // gathering has been on screen its dwell

    act(() => setActivity('Bash: pnpm test'));
    let at: number | undefined;
    for (let t = 0.05; t <= 1.0001 && at === undefined; t += 0.05) {
      elapse(0.05);
      if (getSatellite(STEWARD)?.mode === 'building') at = t;
    }
    expect(at).toBeDefined();
    expect(at).toBeLessThan(1);

    act(() => setActivity('Bash: git commit -m done'));
    elapse(1);
    expect(getSatellite(STEWARD)?.mode).toBe('building'); // building's dwell is not over yet
    elapse(1.5);
    expect(getSatellite(STEWARD)?.mode).toBe('transporting');

    // Waiting for input: the archetype goes at once (the machine orbits a non-working agent).
    act(() => setActivity('Question: which cache?', 'waiting_for_input'));
    drawFrame();
    expect(getSatellite(STEWARD)?.mode).toBe('orbiting');
  });
});

describe('useHeldArchetypes', () => {
  const spec = (activity: string): HoldInput => ({
    agentId: STEWARD,
    role: 'steward',
    state: 'working',
    activity,
    archetype: deriveArchetype('steward', { state: 'working', currentActivity: activity }),
  });

  it('lands a due switch through a timer while the list stays the same', () => {
    let now = 100;
    const clock = () => now;
    const list = [spec('Read: a.ts')];
    const { result } = renderHook(() => useHeldArchetypes(list, clock));
    expect(result.current[0]?.archetype).toBeUndefined();
    now += HOLD.confirm + 0.01;
    act(() => void vi.advanceTimersByTime(HOLD.confirm * 1000 + 20));
    expect(result.current[0]?.archetype).toBe('gathering');
  });
});

describe('writeList', () => {
  it('copies an instance list into an instanced mesh, hidden when empty', () => {
    const mesh = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 4);
    const list = new InstanceList(4);
    writeList(mesh, list);
    expect(mesh.visible).toBe(false);
    expect(mesh.count).toBe(0);
    list.push([1, 2, 3], [1, 0, 0], 0.5, 2, 0.5, [1, 0.5, 0.25], 2);
    writeList(mesh, list);
    expect(mesh.visible).toBe(true);
    expect(mesh.count).toBe(1);
    const m = new Matrix4();
    mesh.getMatrixAt(0, m);
    const p = new Vector3().setFromMatrixPosition(m);
    expect(p.toArray()).toEqual([1, 2, 3]);
    // The local +y (length 2) now points along +x.
    const y = new Vector3(0, 1, 0).transformDirection(m);
    expect(y.x).toBeCloseTo(1);
    expect(new Vector3().setFromMatrixScale(m).y).toBeCloseTo(2);
    expect(mesh.instanceColor).toBeNull(); // the component creates it; without one, colours skip
  });
});
