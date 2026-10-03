import { describe, expect, it } from 'vitest';
import {
  GRACE_CAP_MS,
  GRACE_RADIUS_PX,
  GRACE_STILL_PX,
  keepsGrace,
  startGrace,
} from './hover-grace.js';

describe('hover grace (P4-08 review)', () => {
  it('keeps the satellite while the pointer stays near where it was picked, wherever it orbits', () => {
    const grace = startGrace('a-st', { x: 100, y: 100 });
    const far = { x: 300, y: 100, radius: 3 };
    expect(keepsGrace(grace, { x: 100, y: 100 }, far, 0)).toBe(true);
    expect(keepsGrace(grace, { x: 100 + GRACE_STILL_PX, y: 100 }, far, 0)).toBe(true);
    expect(grace.strayed).toBe(false);
  });

  it('once the pointer moves further, keeps it only within the grace radius of the satellite', () => {
    const grace = startGrace('a-st', { x: 100, y: 100 });
    // The pointer follows the satellite: within 14 px of its centre.
    expect(keepsGrace(grace, { x: 120, y: 100 }, { x: 130, y: 100, radius: 3 }, 0)).toBe(true);
    expect(grace.strayed).toBe(true);
    // Back at the pick point, the still rule no longer applies.
    expect(keepsGrace(grace, { x: 100, y: 100 }, { x: 130, y: 100, radius: 3 }, 0)).toBe(false);
    // Just outside the grace radius.
    expect(
      keepsGrace(grace, { x: 130 + GRACE_RADIUS_PX + 1, y: 100 }, { x: 130, y: 100, radius: 3 }, 0),
    ).toBe(false);
  });

  it("a big satellite's own radius wins over the minimum grace radius", () => {
    const grace = startGrace('a-wk', { x: 0, y: 0 });
    grace.strayed = true;
    expect(keepsGrace(grace, { x: 40, y: 0 }, { x: 0, y: 0, radius: 50 }, 0)).toBe(true);
  });

  it('releases when the satellite is occluded, off screen or gone, and after the cap', () => {
    const grace = startGrace('a-st', { x: 100, y: 100 });
    expect(keepsGrace(grace, { x: 100, y: 100 }, undefined, 0)).toBe(false);
    const on = { x: 100, y: 100, radius: 3 };
    expect(keepsGrace(grace, { x: 100, y: 100 }, on, GRACE_CAP_MS)).toBe(true);
    expect(keepsGrace(grace, { x: 100, y: 100 }, on, GRACE_CAP_MS + 1)).toBe(false);
  });
});
