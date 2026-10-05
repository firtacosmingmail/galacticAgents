import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Id } from '@galactic/protocol';
import { createAgent } from '../domain/agents.js';
import { recordControl } from '../domain/control.js';
import { archiveProject, closeProject, createProject } from '../domain/projects.js';
import { SYSTEM } from '../domain/retention.js';
import { archiveTask, closeTask, createTask } from '../domain/tasks.js';
import { migrate } from '../db/migrate.js';
import { autoVacuumMode, convertToIncrementalVacuum, vacuumIncrementally } from '../db/vacuum.js';
import { world } from '../test/world.js';
import { History } from './history.js';
import { TranscriptPipeline } from './transcripts.js';
import { TranscriptRetention } from './transcript-retention.js';

/**
 * P8-02: transcript retention by age and by archived work, pinned work exempt, the marker the
 * views report, the high-water `seq`, batching and the incremental vacuum.
 */

const USER = { type: 'user' } as const;
const DAY = 24 * 60 * 60 * 1000;
const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 10 };
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const pipes: TranscriptPipeline[] = [];
afterEach(() => {
  for (const p of pipes.splice(0)) p.dispose();
});

/** Writes `n` chunks for an agent, one per hour from `from` (ms). */
function chunks(db: BetterSqlite3.Database, agentId: Id, from: number, n: number, kind = 'text') {
  const insert = db.prepare(
    'INSERT INTO transcript_chunks (agent_id, seq, at, chunk) VALUES (?, ?, ?, ?)',
  );
  const start =
    (
      db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM transcript_chunks WHERE agent_id = ?')
        .get(agentId) as { s: number }
    ).s + 1;
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      insert.run(
        agentId,
        start + i,
        iso(from + i * 3_600_000),
        JSON.stringify({ kind, text: `${agentId} line ${start + i}` }),
      );
    }
  })();
}

const seqs = (db: BetterSqlite3.Database, agentId: Id) =>
  (
    db
      .prepare('SELECT seq FROM transcript_chunks WHERE agent_id = ? ORDER BY seq')
      .all(agentId) as {
      seq: number;
    }[]
  ).map((r) => r.seq);

/**
 * A world with: the Harmonizer (no work); a live project with its Waykeeper; a project archived
 * on day 0 with a Waykeeper and a Steward; a pinned archived project; an archived standalone
 * task's Steward. Every agent has 48 hourly chunks starting on day 0.
 */
function scene() {
  const w = world();
  const { run, log } = w;
  const db = log.db;
  const agent = (id: string, role: 'harmonizer' | 'waykeeper' | 'steward', extra: object = {}) =>
    run((ctx) =>
      createAgent(ctx, {
        agentId: id,
        role,
        runtime: 'fake',
        caps: CAPS,
        bodyId: 'b-earth',
        ...extra,
      }),
    );
  agent('harmonizer', 'harmonizer');
  const live = run((ctx) => createProject(ctx, { name: 'Live', workspace: '/w/live' })).value;
  agent('w-live', 'waykeeper', { projectId: live.id });

  const old = run((ctx) => createProject(ctx, { name: 'Old', workspace: '/w/old' })).value;
  const oldTask = run((ctx) => createTask(ctx, { projectId: old.id, description: 'x' })).value;
  agent('w-old', 'waykeeper', { projectId: old.id });
  agent('s-old', 'steward', { taskId: oldTask.id, supervisorId: 'w-old' });

  const kept = run((ctx) => createProject(ctx, { name: 'Kept', workspace: '/w/kept' })).value;
  agent('w-kept', 'waykeeper', { projectId: kept.id });

  const loose = run((ctx) => createTask(ctx, { description: 'loose' })).value;
  agent('s-loose', 'steward', { taskId: loose.id });

  w.clock.advance(T0 - Date.parse('2026-10-01T09:00:00.000Z')); // the world's clock to day 0
  run((ctx) => closeTask(ctx, oldTask.id, USER));
  for (const p of [old, kept]) {
    run((ctx) => closeProject(ctx, p.id, USER));
    run((ctx) => archiveProject(ctx, p.id, SYSTEM));
  }
  run((ctx) =>
    recordControl(ctx, { kind: 'project', id: kept.id }, { action: 'pin', pinned: true }, USER),
  );
  run((ctx) => closeTask(ctx, loose.id, USER));
  run((ctx) => archiveTask(ctx, loose.id, SYSTEM));

  for (const id of ['harmonizer', 'w-live', 'w-old', 's-old', 'w-kept', 's-loose'])
    chunks(db, id, T0, 48);
  return { ...w, db, live, old, kept, loose };
}

function job(
  db: BetterSqlite3.Database,
  tables: ReturnType<typeof scene>['tables'],
  at: number,
  extra = {},
) {
  return new TranscriptRetention({
    db,
    tables,
    now: () => iso(at),
    pause: () => Promise.resolve(),
    ...extra,
  });
}

describe('transcript retention (P8-02)', () => {
  it('removes archived work’s transcripts after `archivedDays`, keeps pinned work whole', async () => {
    const { db, tables } = scene();
    const retention = job(db, tables, T0 + 31 * DAY, {
      policy: { maxAgeDays: null, archivedDays: 30 },
    });
    const report = await retention.run();
    expect(report.agents.map((a) => [a.agentId, a.reason, a.removed]).sort()).toEqual([
      ['s-loose', 'archived', 48],
      ['s-old', 'archived', 48],
      ['w-old', 'archived', 48],
    ]);
    expect(report.pinned).toBe(1);
    expect(seqs(db, 'w-old')).toEqual([]);
    expect(seqs(db, 'w-kept')).toHaveLength(48); // pinned
    expect(seqs(db, 'w-live')).toHaveLength(48); // not archived, no age limit
    expect(seqs(db, 'harmonizer')).toHaveLength(48);

    // Not yet due: 29 days after the archive.
    const early = scene();
    const none = await job(early.db, early.tables, T0 + 29 * DAY, {
      policy: { maxAgeDays: null, archivedDays: 30 },
    }).run();
    expect(none.removedChunks).toBe(0);
  });

  it('removes chunks older than `maxAgeDays` as a prefix, from any agent but pinned work', async () => {
    const { db, tables } = scene();
    // Day 1.5 + 1 day of age: chunks before T0 + 12h go (hours 0..11).
    const at = T0 + 1.5 * DAY;
    const report = await job(db, tables, at, {
      policy: { maxAgeDays: 1, archivedDays: null },
    }).run();
    for (const id of ['harmonizer', 'w-live', 'w-old', 's-old', 's-loose']) {
      expect(seqs(db, id)[0]).toBe(13);
      expect(seqs(db, id)).toHaveLength(36);
    }
    expect(seqs(db, 'w-kept')).toHaveLength(48);
    expect(report.agents.every((a) => a.reason === 'age' && a.throughSeq === 12)).toBe(true);
    // A second run finds nothing more to do.
    expect(
      (await job(db, tables, at, { policy: { maxAgeDays: 1, archivedDays: null } }).run())
        .removedChunks,
    ).toBe(0);
  });

  it('keeps everything with both limits off', async () => {
    const { db, tables } = scene();
    const report = await job(db, tables, T0 + 3650 * DAY, {
      policy: { maxAgeDays: null, archivedDays: null },
    }).run();
    expect(report.removedChunks).toBe(0);
  });

  it('reports the compaction on the transcript and conversation pages', async () => {
    const { db, tables } = scene();
    const history = new History(db);
    expect(history.transcript('harmonizer', { limit: 10 }).compacted).toBeUndefined();
    const at = T0 + 1.5 * DAY;
    await job(db, tables, at, { policy: { maxAgeDays: 1, archivedDays: 30 } }).run();
    const marker = {
      throughSeq: 12,
      throughAt: iso(T0 + 11 * 3_600_000),
      removedAt: iso(at),
      reason: 'age',
    };
    expect(history.transcript('harmonizer', { limit: 10 }).compacted).toEqual(marker);
    expect(history.conversation('harmonizer', { limit: 10 }).compacted).toEqual(marker);
    // The oldest page starts right after the removed prefix: nothing silently missing in between.
    const oldest = history.transcript('harmonizer', { before: 20, limit: 50 });
    expect(oldest.hasMore).toBe(false);
    expect(oldest.chunks[0]?.seq).toBe(13);
    expect(history.transcript('w-kept', { limit: 10 }).compacted).toBeUndefined();
  });

  it('keeps the high-water seq: a fully removed agent’s next chunk numbers after it', async () => {
    const { db, tables } = scene();
    await job(db, tables, T0 + 31 * DAY, { policy: { maxAgeDays: null, archivedDays: 30 } }).run();
    expect(seqs(db, 'w-old')).toEqual([]);
    expect(new History(db).maxSeq('w-old')).toBe(48);
    const pipeline = new TranscriptPipeline(db, { holdMs: 0 });
    pipes.push(pipeline);
    expect(pipeline.append('w-old', 'text', 'after').seq).toBe(49);
    pipeline.flush();
    expect(new History(db).transcript('w-old', { limit: 10 }).compacted).toMatchObject({
      throughSeq: 48,
      reason: 'archived',
    });
  });

  it('deletes in bounded batches, pausing between them, and stops when stopped', async () => {
    const { db, tables } = scene();
    let pauses = 0;
    const retention = job(db, tables, T0 + 31 * DAY, {
      policy: { maxAgeDays: null, archivedDays: 30 },
      batchSize: 10,
      pause: () => {
        pauses += 1;
        return Promise.resolve();
      },
    });
    const report = await retention.run();
    expect(report.batches).toBe(3 * 5); // 48 chunks in batches of 10, three agents
    expect(pauses).toBeGreaterThanOrEqual(report.batches);

    const again = scene();
    const stopping = job(again.db, again.tables, T0 + 31 * DAY, {
      policy: { maxAgeDays: null, archivedDays: 30 },
      batchSize: 10,
      pause: () => {
        stopping.stop();
        return Promise.resolve();
      },
    });
    const partial = await stopping.run();
    expect(partial.batches).toBe(1);
    // What was removed is covered by the marker.
    expect(
      new History(again.db).transcript(partial.agents[0]!.agentId, { limit: 5 }).compacted,
    ).toMatchObject({ throughSeq: 10 });
  });

  it('shares one run between concurrent callers', async () => {
    const { db, tables } = scene();
    const retention = job(db, tables, T0 + 31 * DAY);
    const [a, b] = await Promise.all([retention.run(), retention.run()]);
    expect(a).toBe(b);
  });
});

describe('incremental vacuum (P8-02)', () => {
  it('a new database is created with incremental auto-vacuum; an old one is converted once', () => {
    const { db } = world().log;
    expect(autoVacuumMode(db)).toBe('incremental');
    const legacy = new BetterSqlite3(':memory:');
    migrate(legacy);
    expect(autoVacuumMode(legacy)).toBe('none');
    expect(convertToIncrementalVacuum(legacy).converted).toBe(true);
    expect(autoVacuumMode(legacy)).toBe('incremental');
    expect(convertToIncrementalVacuum(legacy)).toEqual({ converted: false, ms: 0 });
  });

  it('releases the free list in steps', async () => {
    const { db } = world().log;
    chunks(db, 'a', T0, 3000);
    db.prepare('DELETE FROM transcript_chunks').run();
    const free = db.pragma('freelist_count', { simple: true }) as number;
    expect(free).toBeGreaterThan(10);
    const report = await vacuumIncrementally(db, { stepPages: 4, pause: () => Promise.resolve() });
    expect(report.mode).toBe('incremental');
    expect(report.pagesFreed).toBe(free);
    expect(report.steps).toBe(Math.ceil(free / 4));
    expect(db.pragma('freelist_count', { simple: true })).toBe(0);
  });
});
