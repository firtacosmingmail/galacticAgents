import { describe, expect, it } from 'vitest';
import { describeDemoClear } from './demo-clear.js';

describe('describeDemoClear (P7-07)', () => {
  it('says what was cleared and retired', () => {
    expect(
      describeDemoClear({
        seq: 9,
        projects: ['p-1', 'p-2'],
        tasks: ['t-1'],
        retired: ['b-1', 'b-2', 'b-3'],
        skipped: [],
      }),
    ).toBe('Cleared 2 demo projects and 1 task; retired 3 demo planets.');
  });

  it('says when there was nothing to clear, and names what was skipped', () => {
    expect(describeDemoClear({ seq: 1, projects: [], tasks: [], retired: [], skipped: [] })).toBe(
      'No demo projects to clear.',
    );
    expect(
      describeDemoClear({
        seq: 1,
        projects: [],
        tasks: [],
        retired: [],
        skipped: [{ id: 'b-4', reason: 'Demo planet 4 still holds project p-real' }],
      }),
    ).toBe(
      'No demo projects to clear; not cleared: b-4 (Demo planet 4 still holds project p-real).',
    );
  });
});
