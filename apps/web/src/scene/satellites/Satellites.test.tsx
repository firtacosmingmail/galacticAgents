// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld } from '../../state/reduce.js';
import { useAppStore } from '../../state/store.js';
import { QUALITY_TIERS } from '../quality.js';
import { getSatellite, publishSatellites, satelliteIds } from './registry.js';

/**
 * `Satellites` without WebGL: R3F's hooks are replaced by a fake canvas state and a manual frame
 * loop; the intrinsic three elements render as inert DOM placeholders.
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

const { Satellites } = await import('./Satellites.js');

const steward = (id: string): Agent => ({ ...fx.agent, id, taskId: fx.task.id });
const working = (agentId: string): StatusRecord => ({ ...fx.status, agentId, state: 'working' });

function seedWorld(ids: string[]): void {
  const w = emptyWorld();
  w.tasks = { [fx.task.id]: fx.task };
  for (const id of ids) {
    w.agents[id] = steward(id);
    w.statuses[id] = working(id);
  }
  useAppStore.setState({ world: w });
}

beforeEach(() => {
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
});

describe('Satellites under StrictMode', () => {
  it('publishes its satellites after the rehearsed unmount and remount (dev)', () => {
    seedWorld(['a-steward-1', 'a-steward-2']);
    const { container } = render(
      <StrictMode>
        <Satellites quality={QUALITY_TIERS.high} />
      </StrictMode>,
    );
    expect(getSatellite('a-steward-1')).toBeDefined();
    expect(getSatellite('a-steward-2')).toBeDefined();
    expect(satelliteIds()).toEqual(['a-steward-1', 'a-steward-2']);
    // One mesh pair per satellite is drawn.
    expect(container.querySelectorAll('mesh')).toHaveLength(4);
    // The frame loop runs without anchors: hidden, not dropped.
    for (const run of r3f.frames) run(r3f.state);
    expect(getSatellite('a-steward-1')?.visible).toBe(false);
  });

  it('follows the world, and publishes none once unmounted', () => {
    seedWorld(['a-steward-1']);
    const view = render(
      <StrictMode>
        <Satellites quality={QUALITY_TIERS.high} />
      </StrictMode>,
    );
    act(() => seedWorld(['a-steward-1', 'a-steward-3']));
    expect(getSatellite('a-steward-3')).toBeDefined();
    view.unmount();
    expect(getSatellite('a-steward-1')).toBeUndefined();
    expect(satelliteIds()).toEqual([]);
  });
});

describe('Satellites (P4-02)', () => {
  it('draws the Harmonizer as the HQ station with its own meshes, and keeps failed agents', () => {
    seedWorld(['a-steward-1', 'a-steward-2']);
    const w = useAppStore.getState().world;
    w.agents[fx.harmonizer.id] = fx.harmonizer;
    w.statuses[fx.harmonizer.id] = { ...fx.status, agentId: fx.harmonizer.id, state: 'idle' };
    // Failed on another task (a live Steward on the same task would supersede it).
    w.agents['a-steward-2'] = { ...steward('a-steward-2'), taskId: 't-other' };
    w.statuses['a-steward-2'] = { ...working('a-steward-2'), state: 'failed' };
    useAppStore.setState({ world: { ...w } });
    const { container } = render(<Satellites quality={QUALITY_TIERS.high} />);
    expect(getSatellite(fx.harmonizer.id)?.bodyId).toBe('b-earth');
    expect(getSatellite('a-steward-2')).toBeDefined();
    const names = [...container.querySelectorAll('mesh')].map((m) => m.getAttribute('name'));
    expect(names.filter((n) => n?.startsWith('hq'))).toEqual([
      `hq:${fx.harmonizer.id}`,
      `hq-ring:${fx.harmonizer.id}`,
      `hq-beam:${fx.harmonizer.id}`,
    ]);
    // Two ordinary satellites, a mesh pair each; none for the Harmonizer.
    expect(names.filter((n) => n?.startsWith('satellite:'))).toEqual([
      'satellite:a-steward-1',
      'satellite:a-steward-2',
    ]);
  });

  it('only the HQ: no ordinary satellite meshes', () => {
    const w = emptyWorld();
    w.agents[fx.harmonizer.id] = fx.harmonizer;
    w.statuses[fx.harmonizer.id] = { ...fx.status, agentId: fx.harmonizer.id, state: 'working' };
    useAppStore.setState({ world: w });
    const { container } = render(<Satellites quality={QUALITY_TIERS.high} />);
    expect(container.querySelectorAll('mesh')).toHaveLength(3);
    for (const run of r3f.frames) run(r3f.state); // no anchor for Earth: hidden, no crash
    expect(getSatellite(fx.harmonizer.id)?.visible).toBe(false);
  });
});
