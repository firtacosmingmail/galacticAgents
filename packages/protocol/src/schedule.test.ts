import { describe, expect, it } from 'vitest';
import { missedSince, nextOccurrence, scheduleText } from './schedule.js';

const at = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);

describe('nextOccurrence', () => {
  it('daily: later the same day', () => {
    expect(nextOccurrence({ kind: 'daily', at: '09:00' }, at(2026, 10, 24, 8, 59))).toEqual(
      at(2026, 10, 24, 9),
    );
  });
  it('is strictly after', () => {
    expect(nextOccurrence({ kind: 'daily', at: '09:00' }, at(2026, 10, 24, 9, 0))).toEqual(
      at(2026, 10, 25, 9),
    );
  });
  it('weekdays: Friday to Monday', () => {
    expect(nextOccurrence({ kind: 'weekdays', at: '09:00' }, at(2026, 10, 23, 10))).toEqual(
      at(2026, 10, 26, 9),
    );
  });
  it('weekly: across year end', () => {
    expect(
      nextOccurrence({ kind: 'weekly', days: [1, 4], at: '08:00' }, at(2026, 12, 31, 9)),
    ).toEqual(at(2027, 1, 4, 8));
  });
  it('monthly: clamps to the month length', () => {
    expect(nextOccurrence({ kind: 'monthly', day: 31, at: '09:00' }, at(2027, 2, 1))).toEqual(
      at(2027, 2, 28, 9),
    );
    expect(nextOccurrence({ kind: 'monthly', day: 31, at: '09:00' }, at(2027, 2, 28, 10))).toEqual(
      at(2027, 3, 31, 9),
    );
  });
  it('dst: one occurrence per day across a whole year', () => {
    let cur = at(2026, 1, 1);
    for (let i = 0; i < 365; i++) {
      cur = nextOccurrence({ kind: 'daily', at: '02:30' }, cur);
      const expected = at(2026, 1, 1 + i);
      expect([cur.getFullYear(), cur.getMonth(), cur.getDate()]).toEqual([
        expected.getFullYear(),
        expected.getMonth(),
        expected.getDate(),
      ]);
    }
  });
});

describe('missedSince', () => {
  it('counts occurrences in (from, to]', () => {
    expect(
      missedSince({ kind: 'daily', at: '09:00' }, at(2026, 10, 20, 10), at(2026, 10, 23, 12)),
    ).toBe(3);
  });
});

describe('scheduleText', () => {
  it('speaks plain words', () => {
    expect(scheduleText({ kind: 'monthly', day: 1, at: '09:00' })).toBe('monthly, 1st 9:00');
    expect(scheduleText({ kind: 'monthly', day: 22, at: '09:00' })).toBe('monthly, 22nd 9:00');
    expect(scheduleText({ kind: 'monthly', day: 11, at: '09:00' })).toBe('monthly, 11th 9:00');
    expect(scheduleText({ kind: 'weekly', days: [4, 1], at: '08:30' })).toBe('Mon, Thu 8:30');
    expect(scheduleText({ kind: 'daily', at: '09:00' })).toBe('every day 9:00');
    expect(scheduleText({ kind: 'weekdays', at: '09:00' })).toBe('weekdays 9:00');
  });
});
