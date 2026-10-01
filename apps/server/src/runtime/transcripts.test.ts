import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptChunk } from '@galactic/protocol';
import { openDatabase, type Database } from '../db/database.js';
import { redactSecrets } from './redact.js';
import { PRIVATE_KEY_CAP, TranscriptPipeline } from './transcripts.js';

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

  it('a subscription delivers history, then buffered chunks and live batches as they are written', async () => {
    const { p } = make();
    p.append('a-1', 'text', 'one');
    p.append('a-1', 'text', 'two');
    p.flush(); // persisted
    p.append('a-1', 'text', 'three'); // buffered
    const seen: number[] = [];
    const off = p.subscribe('a-1', 1, (chunks) => seen.push(...chunks.map((c) => c.seq)));
    expect(seen).toEqual([2]); // history after `since`; the buffer is not written yet
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

  describe('split secrets through the runtime path (P1-31)', () => {
    /** Everything that left the pipeline: the rows and what a subscriber received. */
    function watch(p: TranscriptPipeline, db: Database, agentId = 'a-1') {
      const received: TranscriptChunk[] = [];
      p.subscribe(agentId, 0, (chunks) => received.push(...chunks));
      const rows = () =>
        (
          db
            .prepare('SELECT chunk FROM transcript_chunks WHERE agent_id = ? ORDER BY seq')
            .all(agentId) as { chunk: string }[]
        ).map((r) => (JSON.parse(r.chunk) as { text: string }).text);
      return { received, rows };
    }

    // A fake 1,200-char RSA key: base64 lines from a fixed generator; not a real key.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let x = 7;
    const body = Array.from({ length: 1_130 }, () => {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      return B64[x % 64]!;
    })
      .join('')
      .replace(/(.{64})/g, '$1\n');
    const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const OUTPUT = `$ cat ~/.ssh/id_rsa\n${PEM}\ndone.`;

    /** Whether any 20-char run of the key body appears in `texts`, together or one by one. */
    function leaksKey(texts: string[]): boolean {
      const flat = body.replace(/\n/g, '');
      const hay = [texts.join(''), ...texts].map((t) => t.replace(/\n/g, ''));
      for (let i = 0; i + 20 <= flat.length; i++) {
        const run = flat.slice(i, i + 20);
        if (hay.some((h) => h.includes(run))) return true;
      }
      return false;
    }

    function splitAt(text: string, cuts: number[]): string[] {
      const parts: string[] = [];
      let from = 0;
      for (const c of [...cuts, text.length]) {
        parts.push(text.slice(from, c));
        from = c;
      }
      return parts;
    }

    it('the fixture is a 1.2 KB key and the check catches a leak', () => {
      expect(PEM.length).toBeGreaterThanOrEqual(1_200);
      expect(leaksKey([OUTPUT])).toBe(true);
    });

    it('a 1,200-char RSA key split at 900 never reaches rows or subscribers', () => {
      const { db, p } = make({ holdMs: 250 });
      const w = watch(p, db);
      for (const part of splitAt(OUTPUT, [900])) p.append('a-1', 'text', part);
      p.flush();
      expect(leaksKey(w.rows())).toBe(false);
      expect(leaksKey(w.received.map((c) => c.text))).toBe(false);
      expect(w.rows().join('')).toBe('$ cat ~/.ssh/id_rsa\n[redacted:private-key]\ndone.');
    });

    it('a key split over four chunks, header and footer lines split too, is masked to its END line', () => {
      const { db, p } = make({ holdMs: 250 });
      const w = watch(p, db);
      // Cut inside the BEGIN line, in the body, and inside the END line.
      const begin = OUTPUT.indexOf('-----BEGIN') + 15;
      const end = OUTPUT.indexOf('-----END') + 12;
      for (const part of splitAt(OUTPUT, [begin, 600, end])) p.append('a-1', 'text', part);
      p.flush();
      expect(leaksKey(w.rows())).toBe(false);
      expect(leaksKey(w.received.map((c) => c.text))).toBe(false);
      expect(w.rows()).toHaveLength(4);
      expect(w.rows().join('')).toBe(
        '$ cat ~/.ssh/id_rsa\n-----BEGIN RSA [redacted:private-key]\ndone.',
      );
    });

    it('a gap longer than holdMs between the chunks of a key changes nothing', async () => {
      const { db, p } = make({ flushMs: 5, holdMs: 15 });
      const w = watch(p, db);
      for (const part of splitAt(OUTPUT, [10, 400, 800, 1_150])) {
        p.append('a-1', 'text', part);
        await sleep(50); // each chunk is flushed before the next arrives
      }
      expect(w.rows()).toHaveLength(5);
      expect(leaksKey(w.rows())).toBe(false);
      expect(leaksKey(w.received.map((c) => c.text))).toBe(false);
      expect(w.rows().join('')).toBe('$ cat ~/.ssh/id_rsa\n[redacted:private-key]\ndone.');
    });

    it('masking without an END line stops after the cap and the state resets', () => {
      const { db, p } = make();
      const w = watch(p, db);
      p.append('a-1', 'text', '-----BEGIN OPENSSH PRIVATE KEY-----\n');
      p.append('a-1', 'text', 'x'.repeat(PRIVATE_KEY_CAP - 1));
      p.append('a-1', 'text', 'yz visible');
      p.flush();
      // The newline after the BEGIN line counts towards the cap.
      expect(w.rows()).toEqual(['[redacted:private-key]', '', 'yz visible']);
      // Back to normal: a second block is caught again.
      p.append('a-1', 'text', `again ${PEM} ok`);
      p.flush();
      expect(w.rows().at(-1)).toBe('again [redacted:private-key] ok');
    });

    it('keys of different agents do not share the masking state', () => {
      const { db, p } = make();
      const w1 = watch(p, db, 'a-1');
      const w2 = watch(p, db, 'a-2');
      p.append('a-1', 'text', '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE');
      p.append('a-2', 'text', 'hello from a-2');
      p.flush();
      expect(w1.rows()).toEqual(['[redacted:private-key]']);
      expect(w2.rows()).toEqual(['hello from a-2']);
    });

    // The runtime hands the RAW agent.output text to `append` (review R4). Acceptance: nothing
    // of the key beyond its `sk-ant-` prefix leaves the pipeline — no 4-char window of the rest
    // of the key appears in any row or delivered chunk.
    const KEY = 'sk-ant-api03-Q7xZp2LmN9vB4kR8tY1wE6uI3oP5aS0dF';
    const leaksBeyondPrefix = (texts: string[]) => {
      const rest = KEY.slice('sk-ant-'.length);
      for (let i = 0; i + 4 <= rest.length; i++)
        if (texts.some((t) => t.includes(rest.slice(i, i + 4)))) return true;
      return false;
    };
    const first = `key ${KEY.slice(0, 32)}`; // already matches on its own
    const second = `${KEY.slice(32)} done`;

    it('the first fragment alone already matches the key rule', () => {
      expect(redactSecrets(first)).toBe('key [redacted:anthropic-key]');
      expect(leaksBeyondPrefix([second])).toBe(true);
    });

    it('an sk-ant key split over two back-to-back appends: nothing beyond the prefix leaves', async () => {
      const { db, p } = make({ holdMs: 250 });
      const w = watch(p, db);
      p.append('a-1', 'text', first);
      p.append('a-1', 'text', second);
      p.flush();
      expect(w.rows()).toEqual(['key ', '[redacted:anthropic-key] done']);
      expect(leaksBeyondPrefix(w.rows())).toBe(false);
      expect(leaksBeyondPrefix(w.received.map((c) => c.text))).toBe(false);
    });

    it('the same split with a gap longer than holdMs: the rest of the key is masked too', async () => {
      const { db, p } = make({ flushMs: 5, holdMs: 15 });
      const w = watch(p, db);
      p.append('a-1', 'text', first);
      await sleep(50);
      expect(w.rows()).toEqual(['key [redacted:anthropic-key]']);
      p.append('a-1', 'text', second);
      await sleep(50);
      expect(w.rows()).toEqual(['key [redacted:anthropic-key]', '[redacted:anthropic-key] done']);
      expect(leaksBeyondPrefix(w.rows())).toBe(false);
      expect(leaksBeyondPrefix(w.received.map((c) => c.text))).toBe(false);
    });

    it('a chunk of another kind is never joined to the previous one', () => {
      const { db, p } = make({ holdMs: 250 });
      const w = watch(p, db);
      p.append('a-1', 'text', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD');
      p.append('a-1', 'tool', 'third');
      p.flush();
      expect(w.rows()).toEqual(['token [redacted:github-token]', 'third']);
    });
  });

  describe('what a subscriber gets is what is stored (P1-31)', () => {
    it('the held chunk is not in the backlog: it arrives once it is final', () => {
      const { db, p } = make({ holdMs: 10_000 });
      p.append('a-1', 'text', 'start\n');
      p.append('a-1', 'text', 'export PASSWORD=hu'); // held; not a secret yet
      const received: TranscriptChunk[] = [];
      p.subscribe('a-1', 0, (chunks) => received.push(...chunks));
      expect(received).toEqual([]); // nothing persisted yet
      p.append('a-1', 'text', 'nter2\n'); // the name and value move into this chunk
      p.flush();
      const stored = p.read('a-1');
      expect(stored.map((c) => c.text)).toEqual([
        'start\n',
        'export ',
        'PASSWORD=[redacted:value]\n',
      ]);
      expect(received).toEqual(stored);
      expect(JSON.stringify(db.prepare('SELECT * FROM transcript_chunks').all())).not.toContain(
        'hunter',
      );
    });

    it('subscribing at any point between appends never delivers text that later changes', () => {
      const parts = [
        'export PASSWORD=hu',
        'nter2 && echo ',
        'sk-ant-api03-abcdefghij',
        'klmnopqrstuvwxyz done\n',
      ];
      for (let at = 0; at <= parts.length; at++) {
        const { p } = make({ holdMs: 10_000, flushMs: 10_000 });
        const received: TranscriptChunk[] = [];
        parts.forEach((part, i) => {
          if (i === at) p.subscribe('a-1', 0, (chunks) => received.push(...chunks));
          p.append('a-1', 'text', part);
          if (i === 1) p.flush(); // some history, some buffer
        });
        if (at === parts.length) p.subscribe('a-1', 0, (chunks) => received.push(...chunks));
        p.flush();
        const stored = new Map(p.read('a-1').map((c) => [c.seq, c.text]));
        for (const c of received)
          expect(c.text, `subscribed at ${at}, seq ${c.seq}`).toBe(stored.get(c.seq));
        expect(received.map((c) => c.seq)).toEqual([...stored.keys()]);
      }
    });
  });

  describe('seq and delivery after a write (P1-31)', () => {
    it('a failed insert delivers nothing; later batches still arrive', () => {
      const errors: unknown[] = [];
      const { db, p } = make({ onError: (e) => errors.push(e) });
      const received: number[] = [];
      p.subscribe('a-1', 0, (chunks) => received.push(...chunks.map((c) => c.seq)));
      p.append('a-1', 'text', 'doomed');
      // Somebody else took seq 1: the batch's insert fails on the primary key.
      db.prepare(
        'INSERT INTO transcript_chunks (agent_id, seq, at, chunk) VALUES (?, ?, ?, ?)',
      ).run('a-1', 1, 'x', JSON.stringify({ kind: 'text', text: 'other' }));
      p.flush();
      expect(errors).toHaveLength(1);
      expect(received).toEqual([]);
      p.append('a-1', 'text', 'fine');
      p.flush();
      expect(received).toEqual([2]);
    });

    it('prune keeps the newest chunk so seq stays monotonic after a restart', () => {
      const db = openDatabase(':memory:');
      dbs.push(db);
      const first = new TranscriptPipeline(db, { flushMs: 5, holdMs: 0 });
      for (const t of ['a', 'b', 'c']) first.append('a-1', 'text', t);
      first.flush();
      expect(first.prune('a-1', 3)).toBe(2);
      expect(first.read('a-1').map((c) => c.seq)).toEqual([3]);
      expect(first.prune('a-1', 99)).toBe(0);
      first.dispose();
      const second = new TranscriptPipeline(db, { flushMs: 5, holdMs: 0 });
      pipes.push(second);
      expect(second.append('a-1', 'text', 'd').seq).toBe(4);
    });
  });
});
