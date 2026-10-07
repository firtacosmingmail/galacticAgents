import { describe, expect, it } from 'vitest';
import { pagesOf, RUN_OUTPUT_PAGE_BYTES } from './run-output.js';

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
