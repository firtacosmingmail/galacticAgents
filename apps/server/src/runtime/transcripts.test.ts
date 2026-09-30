import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptChunk } from '@galactic/protocol';
import { openDatabase, type Database } from '../db/database.js';
import { TranscriptPipeline } from './transcripts.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dbs: Database[] = [];
const pipes: TranscriptPipeline[] = [];
function make(opts: ConstructorParameters<typeof TranscriptPipeline>[1] = {}) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  let t = 0;
  const p = new TranscriptPipeline(db, {
    flushMs: 20,
    holdMs: 0,
    now: () => `2026-09-30T10:00:${String(t++).padStart(2, '0')}.000Z`,
    ...opts,
  });
  pipes.push(p);
  return { db, p };
}
afterEach(() => {
  for (const p of pipes.splice(0)) p.dispose();
  for (const d of dbs.splice(0)) d.close();
});

const FAKE_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

describe('TranscriptPipeline', () => {
  it('stores and delivers a chunk with the fake key redacted, never the original', async () => {
    const { db, p } = make();
    const received: TranscriptChunk[][] = [];
    p.subscribe('a-1', 0, (chunks) => received.push(chunks));
    const chunk = p.append('a-1', 'text', `here is my key: ${FAKE_KEY}`);
    expect(chunk.text).toBe('here is my key: [redacted:anthropic-key]');
    await sleep(60);
    const rows = db.prepare('SELECT chunk FROM transcript_chunks').all() as { chunk: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chunk).not.toContain(FAKE_KEY);
    expect(rows[0]!.chunk).toContain('[redacted:anthropic-key]');
    expect(received).toEqual([[chunk]]);
    expect(JSON.stringify(received)).not.toContain(FAKE_KEY);
  });

  it('batches writes: many appends, one flush, seq strictly increasing per agent', async () => {
    const { db, p } = make();
    for (let i = 1; i <= 50; i++) p.append('a-1', 'text', `line ${i}`);
    p.append('a-2', 'tool', 'other agent');
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks').get()).toEqual({ n: 0 });
    await sleep(60);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks').get()).toEqual({ n: 51 });
    const seqs = p.read('a-1').map((c) => c.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(p.read('a-2')).toEqual([
      { agentId: 'a-2', seq: 1, at: expect.any(String), kind: 'tool', text: 'other agent' },
    ]);
    expect(p.lastSeq('a-1')).toBe(50);
    expect(p.lastSeq('nobody')).toBe(0);
  });

  it('a subscription delivers history, buffered chunks and live batches in seq order', async () => {
    const { p } = make();
    p.append('a-1', 'text', 'one');
    p.append('a-1', 'text', 'two');
    p.flush(); // persisted
    p.append('a-1', 'text', 'three'); // buffered
    const seen: number[] = [];
    const off = p.subscribe('a-1', 1, (chunks) => seen.push(...chunks.map((c) => c.seq)));
    expect(seen).toEqual([2, 3]); // history after `since`, then the buffer
    p.append('a-1', 'text', 'four');
    p.append('a-1', 'text', 'five');
    await sleep(60);
    expect(seen).toEqual([2, 3, 4, 5]);
    off();
    p.append('a-1', 'text', 'six');
    await sleep(60);
    expect(seen).toEqual([2, 3, 4, 5]);
    expect(p.read('a-1', 4).map((c) => c.text)).toEqual(['five', 'six']);
  });

  it('continues the seq of an agent after a restart (new pipeline, same database)', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const first = new TranscriptPipeline(db, { flushMs: 5, holdMs: 0 });
    first.append('a-1', 'text', 'before');
    first.dispose();
    const second = new TranscriptPipeline(db, { flushMs: 5, holdMs: 0 });
    pipes.push(second);
    expect(second.append('a-1', 'text', 'after').seq).toBe(2);
    second.flush();
    expect(second.read('a-1').map((c) => [c.seq, c.text])).toEqual([
      [1, 'before'],
      [2, 'after'],
    ]);
  });

  it('forces a flush when the buffer is full and survives a listener that throws', async () => {
    const errors: unknown[] = [];
    const { db, p } = make({ maxBuffered: 5, holdMs: 0, onError: (e) => errors.push(e) });
    const good: number[] = [];
    p.subscribe('a-1', 0, () => {
      throw new Error('bad listener');
    });
    p.subscribe('a-1', 0, (chunks) => good.push(...chunks.map((c) => c.seq)));
    for (let i = 0; i < 5; i++) p.append('a-1', 'text', `l${i}`);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks').get()).toEqual({ n: 5 });
    expect(good).toEqual([1, 2, 3, 4, 5]);
    expect(errors).toHaveLength(1);
  });

  it('prune drops chunks up to a seq (retention hook, unused in v1)', () => {
    const { p } = make();
    for (let i = 0; i < 4; i++) p.append('a-1', 'text', `l${i}`);
    p.flush();
    expect(p.prune('a-1', 2)).toBe(2);
    expect(p.read('a-1').map((c) => c.seq)).toEqual([3, 4]);
    expect(p.append('a-1', 'text', 'next').seq).toBe(5);
  });

  it('dispose flushes; later appends are dropped, not thrown', () => {
    const { db, p } = make();
    p.append('a-1', 'text', 'last words');
    p.dispose();
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks').get()).toEqual({ n: 1 });
    expect(p.append('a-1', 'text', 'x').seq).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks').get()).toEqual({ n: 1 });
  });

  describe('boundary-aware redaction (P1-27)', () => {
    it('catches a key split over two chunks: the head moves to the second chunk, both redacted', async () => {
      const { db, p } = make();
      const received: TranscriptChunk[][] = [];
      p.subscribe('a-1', 0, (chunks) => received.push(chunks));
      const head = FAKE_KEY.slice(0, 18);
      const tail = FAKE_KEY.slice(18);
      const first = p.append('a-1', 'text', `export ANTHROPIC_KEY="${head}`);
      const second = p.append('a-1', 'text', `${tail}"\n`);
      expect(first.text).toBe('export ANTHROPIC_KEY="');
      expect(second.text).toBe('[redacted:anthropic-key]"\n');
      await sleep(60);
      const rows = db.prepare('SELECT chunk FROM transcript_chunks ORDER BY seq').all() as {
        chunk: string;
      }[];
      expect(rows.map((r) => r.chunk)).not.toContain(head);
      expect(JSON.stringify(rows)).not.toContain(head);
      expect(JSON.stringify(received)).not.toContain(head);
      expect(received.flat().map((c) => c.seq)).toEqual([1, 2]);
    });

    it('a key split over three chunks is still one redaction', () => {
      const { p } = make();
      const parts = [FAKE_KEY.slice(0, 10), FAKE_KEY.slice(10, 25), FAKE_KEY.slice(25)];
      p.append('a-1', 'text', `key: ${parts[0]}`);
      p.append('a-1', 'text', parts[1]!);
      const last = p.append('a-1', 'text', `${parts[2]} done`);
      p.flush();
      const texts = p.read('a-1').map((c) => c.text);
      expect(texts).toEqual(['key: ', '', '[redacted:anthropic-key] done']);
      expect(last.text).toBe('[redacted:anthropic-key] done');
      expect(texts.join('')).not.toContain(FAKE_KEY.slice(0, 10));
    });

    it('holds the newest chunk of an agent for holdMs so the next delta can complete a secret', async () => {
      const { db, p } = make({ holdMs: 80 });
      p.append('a-1', 'text', 'one');
      p.append('a-1', 'text', 'two');
      await sleep(40);
      const count = () =>
        (db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks').get() as { n: number }).n;
      expect(count()).toBe(1); // 'two' is held, 'one' went out
      await sleep(100);
      expect(count()).toBe(2); // the hold expired and the timer flushed it
      p.append('a-1', 'text', 'three');
      p.flush(); // an explicit flush takes everything
      expect(count()).toBe(3);
    });
  });
});
