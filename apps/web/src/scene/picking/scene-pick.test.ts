import { describe, expect, it } from 'vitest';
import { MIN_TARGET_PX, type PickRay, type PickSphere } from './pick.js';
import { hoverTarget, pickScene, type SatelliteSphere } from './scene-pick.js';

/** The camera at z = 100 looking down -z; the pointer's ray goes through (x, y) on z = 0. */
function rayThrough(x: number, y: number): PickRay {
  const len = Math.hypot(x, y, -100);
  return { origin: [0, 0, 100], direction: [x / len, y / len, -100 / len] };
}

/** 1000 px per unit at distance 1: at depth 100, one world unit spans 10 px. */
const PX = 1000;
const body = (bodyId: string, x: number, y: number, z: number, radius: number): PickSphere => ({
  bodyId,
  center: [x, y, z],
  radius,
});
const sat = (agentId: string, x: number, y: number, z: number, radius = 0.05): SatelliteSphere => ({
  agentId,
  center: [x, y, z],
  radius,
});

describe('pickScene (bodies and satellites, P4-08)', () => {
  it('a satellite in front of a big planet wins over it', () => {
    // Jupiter 5 units (50 px): clearly a target on its own; its satellite in front of it.
    const result = pickScene(
      rayThrough(0, 0),
      [body('jupiter', 0, 0, 0, 5)],
      [sat('a-wk', 0, 0, 8)],
      PX,
    );
    expect(result.choice).toEqual({ kind: 'satellite', agentId: 'a-wk' });
    expect(result.candidates[0]).toEqual({ kind: 'satellite', agentId: 'a-wk' });
    // Away from the satellite, the planet is picked as before.
    expect(
      pickScene(rayThrough(3, 0), [body('jupiter', 0, 0, 0, 5)], [sat('a-wk', 0, 0, 8)], PX).choice,
    ).toEqual({ kind: 'body', bodyId: 'jupiter' });
  });

  it('a planet in front of a satellite hides it (occlusion)', () => {
    const result = pickScene(
      rayThrough(0, 0),
      [body('jupiter', 0, 0, 0, 5)],
      [sat('a-wk', 0, 0, -8)], // behind the planet
      PX,
    );
    expect(result.satellites).toEqual([]);
    expect(result.choice).toEqual({ kind: 'body', bodyId: 'jupiter' });
  });

  it('a satellite past the limb of the planet is not hidden', () => {
    // Beside the planet (x = 7, outside its 5-unit radius), at the planet's depth.
    const result = pickScene(
      rayThrough(7, 0),
      [body('jupiter', 0, 0, 0, 5)],
      [sat('a-wk', 7, 0, 0)],
      PX,
    );
    expect(result.choice).toEqual({ kind: 'satellite', agentId: 'a-wk' });
  });

  it(`a speck of a satellite is at least ${MIN_TARGET_PX} px wide to the pointer, no more`, () => {
    // 0.05 units at depth 100 = 0.5 px; 0.5 units = 5 px off the pointer → inside the target.
    const s = [sat('a-st', 0, 0, 0)];
    expect(pickScene(rayThrough(0.5, 0), [], s, PX).choice).toEqual({
      kind: 'satellite',
      agentId: 'a-st',
    });
    // 8 px off: outside its target, and satellites have no extra cluster slop.
    const off = pickScene(rayThrough(0.8, 0), [], s, PX);
    expect(off.choice).toBeUndefined();
    expect(off.candidates).toEqual([]);
  });

  it('of two satellites under the pointer, the one nearest the pointer on screen', () => {
    const result = pickScene(
      rayThrough(0, 0),
      [body('jupiter', 0, 0, 0, 5)],
      [sat('far-from-pointer', 0.4, 0, 9), sat('near-pointer', 0.1, 0, 6)],
      PX,
    );
    expect(result.choice).toEqual({ kind: 'satellite', agentId: 'near-pointer' });
  });

  it('a speck of a body under the pointer too: the "what\'s here" list, satellites first', () => {
    // The system view: a planet 2 px wide and its two satellites within a few pixels.
    const result = pickScene(
      rayThrough(0, 0),
      [body('mars', 0, 0, 0, 0.2)],
      [sat('a-wk', 0.3, 0, 0), sat('a-st', -0.2, 0.1, 0)],
      PX,
    );
    expect(result.choice).toBeUndefined();
    expect(result.candidates).toEqual([
      { kind: 'satellite', agentId: 'a-st' },
      { kind: 'satellite', agentId: 'a-wk' },
      { kind: 'body', bodyId: 'mars' },
    ]);
  });

  it('at the system view the list order is stable (role, then id) and the hover names the body', () => {
    const mars = [body('mars', 0, 0, 0, 0.2)];
    const at = (wkX: number, stX: number) =>
      pickScene(
        rayThrough(0, 0),
        mars,
        [
          { ...sat('a-st-2', stX, 0, 0), role: 'steward' },
          { ...sat('a-wk', wkX, 0, 0), role: 'waykeeper' },
          { ...sat('a-st-1', -stX, 0.1, 0), role: 'steward' },
        ],
        PX,
      );
    // Two frames: the satellites swap places around the pointer.
    for (const result of [at(0.3, -0.25), at(-0.25, 0.4)]) {
      expect(result.choice).toBeUndefined();
      expect(result.candidates).toEqual([
        { kind: 'satellite', agentId: 'a-wk' },
        { kind: 'satellite', agentId: 'a-st-1' },
        { kind: 'satellite', agentId: 'a-st-2' },
        { kind: 'body', bodyId: 'mars' },
      ]);
      expect(hoverTarget(result)).toEqual({ target: { kind: 'body', bodyId: 'mars' }, others: 3 });
    }
  });

  it('hoverTarget: the choice; else the first body; else the first candidate; else nothing', () => {
    const clear = pickScene(
      rayThrough(0, 0),
      [body('jupiter', 0, 0, 0, 5)],
      [sat('a', 0, 0, 8)],
      PX,
    );
    expect(hoverTarget(clear)).toEqual({ target: { kind: 'satellite', agentId: 'a' }, others: 0 });
    expect(hoverTarget(pickScene(rayThrough(0, 0), [], [], PX))).toBeUndefined();
  });

  it('no satellite under the pointer: the bodies decide, unchanged', () => {
    const bodies = [body('planet', 0, 0, 0, 3), body('moon', 0, 0, 10, 0.2)];
    const result = pickScene(rayThrough(0, 0), bodies, [sat('elsewhere', 30, 0, 0)], PX);
    expect(result.choice).toBeUndefined();
    expect(result.candidates).toEqual([
      { kind: 'body', bodyId: 'moon' },
      { kind: 'body', bodyId: 'planet' },
    ]);
    expect(pickScene(rayThrough(1, 1), bodies, [], PX).choice).toEqual({
      kind: 'body',
      bodyId: 'planet',
    });
  });

  it('ignores satellites behind the camera', () => {
    expect(pickScene(rayThrough(0, 0), [], [sat('behind', 0, 0, 150)], PX).candidates).toEqual([]);
  });
});
