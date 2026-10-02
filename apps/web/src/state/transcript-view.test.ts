import { beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptChunk } from '@galactic/protocol';
import { mergeChunks } from './transcript-view.js';
import { useAppStore } from './store.js';

const c = (seq: number): TranscriptChunk => ({
  agentId: 'a-1',
  seq,
  at: '2026-09-30T10:00:00.000Z',
  kind: 'text',
  text: `#${seq}`,
});
const seqs = (chunks: TranscriptChunk[]) => chunks.map((x) => x.seq);

describe('transcript view slice (P25-05)', () => {
  beforeEach(() => useAppStore.getState().reset());

  it('merges pages by seq without duplicates', () => {
    expect(seqs(mergeChunks([c(5), c(6)], [c(4), c(5)], 'older'))).toEqual([4, 5, 6]);
    expect(seqs(mergeChunks([c(10), c(11)], [c(9), c(10)], 'newest'))).toEqual([9, 10, 11]);
    const held = [c(1)];
    expect(mergeChunks(held, [], 'newest')).toBe(held);
  });

  it('drops held chunks older than a newest page (they may leave a hole)', () => {
    expect(seqs(mergeChunks([c(1), c(2), c(30)], [c(20), c(21)], 'newest'))).toEqual([20, 21, 30]);
  });

  it('feeds the live stream: a page then overlapping live chunks', () => {
    const s = useAppStore.getState();
    s.addTranscriptPage('a-1', [c(1), c(2)], 'newest');
    s.apply({ type: 'transcript', agentId: 'a-1', chunks: [c(2), c(3)] });
    expect(seqs(useAppStore.getState().transcripts['a-1']!)).toEqual([1, 2, 3]);
    s.setTranscriptView('a-1', { status: 'ready', hasMore: true });
    expect(useAppStore.getState().transcriptViews['a-1']).toMatchObject({
      status: 'ready',
      hasMore: true,
      loadingOlder: false,
    });
    useAppStore.getState().reset();
    expect(useAppStore.getState().transcriptViews).toEqual({});
  });
});
