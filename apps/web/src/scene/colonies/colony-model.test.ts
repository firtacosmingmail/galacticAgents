import { describe, expect, it } from 'vitest';
import type { Body } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld, type WorldState } from '../../state/reduce.js';
import {
  COLONY,
  colonyLights,
  colonyList,
  isColonised,
  sameColonies,
  writeColony,
} from './colony-model.js';

/** Luna hosts the project `p-1` (with task `t-1` on it); asteroid 1 hosts the standalone `t-2`. */
function world(): WorldState {
  const w = emptyWorld();
  w.bodies = { [fx.body.id]: fx.body, [fx.moon.id]: fx.moon, [fx.asteroid.id]: fx.asteroid };
  w.projects = { [fx.project.id]: fx.project };
  w.tasks = { [fx.task.id]: fx.task, [fx.asteroidTask.id]: fx.asteroidTask };
  return w;
}

describe('which bodies are colonised (P4-04, decision 4)', () => {
  it('none while the work runs', () => {
    expect(colonyList(world())).toEqual([]);
  });

  it('a completed project colonises its body; a completed task on it does not', () => {
    const w = world();
    w.tasks[fx.task.id] = { ...fx.task, state: 'completed' };
    expect(colonyList(w)).toEqual([]); // the project is still open
    w.projects[fx.project.id] = { ...fx.project, state: 'completed' };
    expect(colonyList(w).map((c) => [c.bodyId, c.host])).toEqual([['b-luna', 'project']]);
  });

  it('a completed standalone task colonises its asteroid', () => {
    const w = world();
    w.tasks[fx.asteroidTask.id] = { ...fx.asteroidTask, state: 'completed' };
    expect(colonyList(w).map((c) => [c.bodyId, c.host])).toEqual([['b-ast-1', 'task']]);
  });

  it('archival (the body freed), a reopen, or a move clears the mark', () => {
    const w = world();
    w.projects[fx.project.id] = { ...fx.project, state: 'completed' };
    expect(isColonised(w, fx.moon)).toBe(true);
    w.projects[fx.project.id] = { ...fx.project, state: 'approved' }; // reopened
    expect(isColonised(w, fx.moon)).toBe(false);
    w.projects[fx.project.id] = { ...fx.project, state: 'completed' };
    const { host: _h, ...freed } = fx.moon;
    expect(isColonised(w, freed as Body)).toBe(false); // body.freed: no host
    const moved: Body = {
      ...(freed as Body),
      movedTo: { bodyId: 'b-kepler', host: fx.moon.host!, at: fx.NOW },
    };
    expect(isColonised(w, moved)).toBe(false); // only a "moved to" marker
  });

  it('sameColonies sees changes of what is drawn only', () => {
    const w = world();
    w.projects[fx.project.id] = { ...fx.project, state: 'completed' };
    const a = colonyList(w);
    expect(sameColonies(a, colonyList(w))).toBe(true);
    w.tasks[fx.asteroidTask.id] = { ...fx.asteroidTask, state: 'completed' };
    expect(sameColonies(a, colonyList(w))).toBe(false);
  });
});

describe('colonyLights', () => {
  it('unit vectors, clusters × lights, the same for the same body and different for another', () => {
    const a = colonyLights(42);
    expect(a.length).toBe(COLONY.clusters * COLONY.perCluster * 3);
    for (let i = 0; i < a.length; i += 3) {
      expect(Math.hypot(a[i]!, a[i + 1]!, a[i + 2]!)).toBeCloseTo(1, 6);
      // Within the band (cluster latitude plus its spread).
      expect(Math.abs(Math.asin(a[i + 1]!))).toBeLessThanOrEqual(
        COLONY.latitude + COLONY.spread + 1e-6,
      );
    }
    expect(colonyLights(42)).toEqual(a);
    expect(colonyLights(43)).not.toEqual(a);
  });
});

describe('writeColony (one Points for every colony)', () => {
  /** Column-major: uniform scale `r`, centred at `c`. */
  const placed = (r: number, c: [number, number, number]) =>
    [r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, c[0], c[1], c[2], 1] as const;

  it('writes each colony after the previous one, on its body, just above the surface', () => {
    const lights = colonyLights(7);
    const n = lights.length / 3;
    const positions = new Float32Array(n * 2 * 3);
    const colors = new Float32Array(n * 2 * 4);
    const sun = [0, 0, 0] as const;
    let at = writeColony(lights, placed(2, [40, 0, 0]), COLONY.lift, sun, positions, colors, 0);
    expect(at).toBe(n);
    at = writeColony(lights, placed(0.5, [0, 0, -90]), COLONY.lift, sun, positions, colors, at);
    expect(at).toBe(2 * n);
    const distance = (v: number, c: [number, number, number]) =>
      Math.hypot(
        positions[v * 3]! - c[0],
        positions[v * 3 + 1]! - c[1],
        positions[v * 3 + 2]! - c[2],
      );
    expect(distance(0, [40, 0, 0])).toBeCloseTo(2 * COLONY.lift, 4);
    expect(distance(n + 3, [0, 0, -90])).toBeCloseTo(0.5 * COLONY.lift, 4);
  });

  it('brightest on the night side, dimmed (not hidden) on the side facing the Sun', () => {
    // Two lights: one facing the Sun (+x from the body), one facing away.
    const lights = new Float32Array([1, 0, 0, -1, 0, 0]);
    const positions = new Float32Array(6);
    const colors = new Float32Array(8);
    writeColony(lights, placed(1, [0, 0, 0]), 1, [100, 0, 0], positions, colors, 0);
    expect(colors[3]).toBeCloseTo(COLONY.day);
    expect(colors[7]).toBeCloseTo(1);
    expect(COLONY.day).toBeGreaterThan(0);
  });

  it('an asteroid lift close to its rock (no lights floating half a radius off it)', () => {
    expect(COLONY.asteroidLift).toBeLessThanOrEqual(1.1);
    expect(COLONY.asteroidLift).toBeGreaterThan(1);
  });
});
