import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { pagesOf, RunOutput, RUN_OUTPUT_PAGE_BYTES } from './run-output.js';

/** Review N2: a run's backlog reaches a socket in pages, never as one message. */
describe('pagesOf', () => {
  const chunk = (seq: number, bytes: number) => ({
    runId: 'r-1',
    seq,
    at: '2026-10-08T00:00:00.000Z',
    chunk: 'x'.repeat(bytes),
  });

  it('splits in order at the byte limit; a chunk larger than a page goes alone', () => {
    const chunks = [chunk(1, 100), chunk(2, 100), chunk(3, 250), chunk(4, 50), chunk(5, 10)];
    const pages = pagesOf(chunks, 256);
    expect(pages.map((p) => p.map((c) => c.seq))).toEqual([[1, 2], [3], [4, 5]]);
    expect(pagesOf([chunk(1, 1000)], 256).map((p) => p.length)).toEqual([1]);
    expect(pagesOf([], 256)).toEqual([]);
  });

  it('keeps a page under 256 KB by default', () => {
    const chunks = Array.from({ length: 100 }, (_, i) => chunk(i + 1, 10_000));
    const pages = pagesOf(chunks);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.reduce((n, c) => n + c.chunk.length, 0)).toBeLessThanOrEqual(
        RUN_OUTPUT_PAGE_BYTES,
      );
    }
    expect(pages.flat().map((c) => c.seq)).toEqual(chunks.map((c) => c.seq));
  });
});

/** P9-12 review N7: a subscription's backlog is the newest part only; REST reads the rest. */
describe('the run.subscribe backlog', () => {
  it('sends the newest chunks that fit (at least one), then every new batch', () => {
    const output = new RunOutput(openDatabase(':memory:'), {
      maxBytesPerRun: () => 1_000_000,
      flushMs: 60_000,
      holdMs: 0,
      backlogBytes: 250,
    });
    for (let i = 1; i <= 10; i++) {
      output.append('r-1', String(i).padStart(100, '.'));
      output.flush();
    }
    const got: number[][] = [];
    const stop = output.subscribe('r-1', 0, (chunks) => got.push(chunks.map((c) => c.seq)));
    expect(got.flat()).toEqual([9, 10]);
    // A subscriber already holding most of it gets what it lacks, within the budget.
    const again: number[] = [];
    output.subscribe('r-1', 9, (chunks) => again.push(...chunks.map((c) => c.seq)))();
    expect(again).toEqual([10]);
    // REST still has every chunk.
    expect(output.page('r-1', 0, 100).chunks).toHaveLength(10);
    output.append('r-1', 'live');
    output.flush();
    expect(got.flat()).toEqual([9, 10, 11]);
    stop();
    // One chunk larger than the budget still goes (the newest).
    output.append('r-1', 'y'.repeat(1_000));
    output.flush();
    const big: number[] = [];
    output.subscribe('r-1', 0, (chunks) => big.push(...chunks.map((c) => c.seq)))();
    expect(big).toEqual([12]);
    output.dispose();
  });
});
