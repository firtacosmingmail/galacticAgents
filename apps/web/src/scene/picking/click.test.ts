import { describe, expect, it } from 'vitest';
import { CLICK_MAX_MS, CLICK_SLOP_PX, ClickTracker } from './click.js';

const press = (
  t: ClickTracker,
  x = 100,
  y = 100,
  extra: { pointerId?: number; button?: number } = {},
) => t.down({ pointerId: extra.pointerId ?? 1, button: extra.button ?? 0, x, y, at: 0 });

describe('ClickTracker (click vs drag)', () => {
  it('a press and release in place is a click', () => {
    const t = new ClickTracker();
    press(t);
    expect(t.up({ pointerId: 1, x: 101, y: 100, at: 120 })).toBe(true);
  });

  it('a move beyond the slop is a drag, even if the pointer comes back', () => {
    const t = new ClickTracker();
    press(t);
    t.move({ pointerId: 1, x: 100 + CLICK_SLOP_PX + 3, y: 100 });
    t.move({ pointerId: 1, x: 100, y: 100 });
    expect(t.up({ pointerId: 1, x: 100, y: 100, at: 200 })).toBe(false);
  });

  it('within the slop is still a click; a release beyond it is not', () => {
    const t = new ClickTracker();
    press(t);
    t.move({ pointerId: 1, x: 100 + CLICK_SLOP_PX, y: 100 });
    expect(t.up({ pointerId: 1, x: 100 + CLICK_SLOP_PX, y: 100, at: 50 })).toBe(true);
    press(t);
    expect(t.up({ pointerId: 1, x: 100, y: 100 + CLICK_SLOP_PX + 1, at: 50 })).toBe(false);
  });

  it('not the right button, not a long press, not a second finger', () => {
    const t = new ClickTracker();
    press(t, 100, 100, { button: 2 });
    expect(t.up({ pointerId: 1, x: 100, y: 100, at: 10 })).toBe(false);
    press(t);
    expect(t.up({ pointerId: 1, x: 100, y: 100, at: CLICK_MAX_MS + 1 })).toBe(false);
    press(t);
    press(t, 200, 200, { pointerId: 2 });
    expect(t.up({ pointerId: 2, x: 200, y: 200, at: 10 })).toBe(false);
    expect(t.up({ pointerId: 1, x: 100, y: 100, at: 20 })).toBe(false);
    // Afterwards, a plain click works again.
    press(t);
    expect(t.up({ pointerId: 1, x: 100, y: 100, at: 10 })).toBe(true);
  });

  it('a release without a press, or after a cancel, is not a click', () => {
    const t = new ClickTracker();
    expect(t.up({ pointerId: 1, x: 0, y: 0, at: 0 })).toBe(false);
    press(t);
    t.cancel();
    expect(t.up({ pointerId: 1, x: 100, y: 100, at: 10 })).toBe(false);
  });
});
