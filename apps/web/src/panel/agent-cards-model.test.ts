import { describe, expect, it } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import { formatCost, formatDuration, wallClockUsed } from './agent-cards-model.js';

describe('agent card figures (P25-04)', () => {
  const start = Date.parse(fx.status.startedAt);

  it('extrapolates the wall clock of a working agent and freezes a paused or ended one', () => {
    expect(wallClockUsed(fx.status, start + 600_000)).toBe(600_000);
    expect(wallClockUsed({ ...fx.status, state: 'paused' }, start + 600_000)).toBe(120_000);
    expect(wallClockUsed({ ...fx.status, state: 'finished' }, start + 600_000)).toBe(120_000);
    // Never below what the server reported.
    expect(wallClockUsed(fx.status, start)).toBe(120_000);
  });

  it('formats durations and cost', () => {
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05');
    expect(formatCost(fx.status)).toBe('$0.4200');
    expect(formatCost({ ...fx.status, costSoFar: { usd: 3.5 } })).toBe('$3.50');
    expect(formatCost({ ...fx.status, costSoFar: { inputTokens: 1200, outputTokens: 300 } })).toBe(
      '1,500 tokens',
    );
    expect(formatCost({ ...fx.status, costSoFar: undefined })).toBe('—');
  });
});
