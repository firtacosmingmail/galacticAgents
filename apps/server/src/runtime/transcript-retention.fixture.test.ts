import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope, HistoryEventsResponse, Id, ServerMessage } from '@galactic/protocol';
import { openDatabase, type Database } from '../db/database.js';
import { pageStats } from '../db/vacuum.js';
import { createAgent } from '../domain/agents.js';
import { Commands } from '../domain/commands.js';
import { recordControl } from '../domain/control.js';
import { EventLog } from '../domain/event-log.js';
import { archiveProject, closeProject, createProject } from '../domain/projects.js';
import { SYSTEM } from '../domain/retention.js';
import { archiveTask, closeTask, createTask } from '../domain/tasks.js';
import { connectWs, startTestApp, TEST_TOKEN } from '../test/harness.js';
import { tickingClock } from '../test/world.js';
import { History } from './history.js';
import { HistoryEvents } from './history-events.js';
import { TranscriptRetention, type CompactionReport } from './transcript-retention.js';

/**
 * P8-02 acceptance on a sizeable fixture database (a file, WAL, incremental auto-vacuum): many
 * agents with many chunks over 120 days, in archived, recently archived, pinned and live work.
 * Compaction runs with the default policy (90 days of age, 30 days after archive); then the event
 * log is unchanged, a client resumes from `lastEventId`, the timeline replay reads the same
 * events, and the file is smaller. `GALACTIC_P802_REPORT=<file>` writes the measurements there;
 * `GALACTIC_P802_SCALE=n` multiplies the chunks per agent (the notes' larger runs);
 * `GALACTIC_P802_FULL_VACUUM=1` also times one full VACUUM of the fixture first (what converting a
 * pre-P8-02 database costs; it leaves the OS flushing the rewritten file, which slows the
 * compaction's fsyncs right after it, so the two are measured in separate runs).
 */

const DAY = 24 * 60 * 60 * 1000;
const USER = { type: 'user' } as const;
const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 10 };
const SCALE = Number(process.env['GALACTIC_P802_SCALE'] ?? 1);
/** A file to write the measurements to (JSON), e.g. for the notes. */
const REPORT = process.env['GALACTIC_P802_REPORT'];
const CHUNKS_PER_AGENT = Math.round(400 * SCALE);
const SPAN = 120 * DAY;
const START = Date.parse('2026-06-01T00:00:00.000Z');
const NOW = START + SPAN;
const iso = (ms: number) => new Date(ms).toISOString();
const TEXT = 'The quick brown fox reads the parser and writes a test for it. '.repeat(6); // ≈ 400 B

let dir: string;
let path: string;
let db: Database;
let log: EventLog;
const agents: { id: Id; group: 'old-archived' | 'recent-archived' | 'pinned' | 'live' }[] = [];
let liveProject: Id;
let oldProject: Id;

const fileSize = () =>
  statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);

function replay(projectId: Id): EventEnvelope[] {
  const reader = new HistoryEvents(db);
  const out: EventEnvelope[] = [];
  let after = 0;
  let membership: string | undefined;
  for (;;) {
    const page: HistoryEventsResponse = reader.read({
      projectId,
      after,
      limit: 2000,
      ...(membership ? { membership } : {}),
    });
    out.push(...page.events);
    membership = page.membership;
    after = page.seq;
    if (!page.hasMore) return out;
  }
}

async function build() {
  const clock = tickingClock(START);
  log = new EventLog(db, { now: clock });
  const commands = new Commands({ log });
  const run = <T>(fn: Parameters<EventLog['runCommand']>[0]) => log.runCommand(fn).value as T;
  const agent = (
    id: Id,
    role: 'harmonizer' | 'waykeeper' | 'steward',
    group: (typeof agents)[number]['group'],
    extra: object,
  ) => {
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
    agents.push({ id, group });
  };
  agent('harmonizer', 'harmonizer', 'live', {});

  /** A project with a Waykeeper and three Stewards. */
  const project = (name: string, group: (typeof agents)[number]['group'], kind?: 'moon') => {
    const p = run<{ id: Id; bodyId: Id }>((ctx) =>
      createProject(ctx, { name, workspace: `/w/${name}`, ...(kind ? { kind } : {}) }),
    );
    agent(`w-${name}`, 'waykeeper', group, { projectId: p.id });
    const tasks: Id[] = [];
    for (let i = 0; i < 3; i++) {
      const t = run<{ id: Id }>((ctx) =>
        createTask(ctx, { projectId: p.id, description: `${name} ${i}` }),
      );
      tasks.push(t.id);
      agent(`s-${name}-${i}`, 'steward', group, { taskId: t.id, supervisorId: `w-${name}` });
    }
    return { p, tasks };
  };
  const finish = (p: { id: Id }, tasks: Id[]) => {
    for (const t of tasks) run((ctx) => closeTask(ctx, t, USER));
    run((ctx) => closeProject(ctx, p.id, USER));
    run((ctx) => archiveProject(ctx, p.id, SYSTEM));
  };

  // Planets are scarce (seven free): recently archived projects are independent moons, and the
  // old ones are made and archived one at a time on day 10 (110 days before NOW).
  const recent = Array.from({ length: 4 }, (_, i) =>
    project(`recent${i}`, 'recent-archived', 'moon'),
  );
  const pinned = project('pinned', 'pinned');
  const live = Array.from({ length: 3 }, (_, i) => project(`live${i}`, 'live'));
  liveProject = live[0]!.p.id;
  const looseOld: Id[] = [];
  for (let i = 0; i < 20; i++) {
    const t = run<{ id: Id }>((ctx) => createTask(ctx, { description: `loose ${i}` }));
    const group = i % 2 === 0 ? 'old-archived' : 'live';
    agent(`s-loose-${i}`, 'steward', group, { taskId: t.id });
    if (group !== 'live') looseOld.push(t.id);
  }
  clock.advance(10 * DAY);
  for (let i = 0; i < 12; i++) {
    const { p, tasks } = project(`old${i}`, 'old-archived');
    if (i === 0) oldProject = p.id;
    finish(p, tasks);
  }
  finish(pinned.p, pinned.tasks);
  run((ctx) =>
    recordControl(ctx, { kind: 'project', id: pinned.p.id }, { action: 'pin', pinned: true }, USER),
  );
  for (const t of looseOld) {
    run((ctx) => closeTask(ctx, t, USER));
    run((ctx) => archiveTask(ctx, t, SYSTEM));
  }
  // Agent activity in the log, which the replay reads.
  for (const a of agents) {
    await commands.recordAgentEvent({
      type: 'agent.spawned',
      agentId: a.id,
      role: 'steward',
      runtime: 'fake',
      bodyId: 'b-earth',
    });
    for (let i = 0; i < 20; i++)
      await commands.recordAgentEvent({
        type: 'agent.tool_call',
        agentId: a.id,
        toolName: 'Bash',
        input: { command: `pnpm test ${i}` },
      });
  }
  // Five days before NOW: recently archived work (age rule only).
  clock.advance(SPAN - 15 * DAY);
  for (const { p, tasks } of recent) finish(p, tasks);

  // The transcripts: CHUNKS_PER_AGENT per agent, evenly over the 120 days, text/tool/thinking.
  const insert = db.prepare(
    'INSERT INTO transcript_chunks (agent_id, seq, at, chunk) VALUES (?, ?, ?, ?)',
  );
  const kinds = ['text', 'tool', 'thinking'] as const;
  db.transaction(() => {
    for (const a of agents) {
      for (let s = 1; s <= CHUNKS_PER_AGENT; s++) {
        const at = START + Math.floor(((s - 1) * SPAN) / CHUNKS_PER_AGENT);
        insert.run(a.id, s, iso(at), JSON.stringify({ kind: kinds[s % 3], text: `${s}: ${TEXT}` }));
      }
    }
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
}

const before: {
  size: number;
  pages: number;
  events: number;
  lastSeq: number;
  tail: EventEnvelope[];
  replayLive: EventEnvelope[];
  replayOld: EventEnvelope[];
  chunks: number;
  buildMs: number;
  fullVacuumMs?: number;
} = {} as never;
let report: CompactionReport;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'galactic-p802-'));
  path = join(dir, 'fixture.sqlite');
  db = openDatabase(path);
  const t = performance.now();
  await build();
  before.buildMs = performance.now() - t;
  if (process.env['GALACTIC_P802_FULL_VACUUM'] === '1') {
    // What converting a pre-P8-02 database costs: one full VACUUM of a file this size.
    const v = performance.now();
    db.exec('VACUUM');
    before.fullVacuumMs = performance.now() - v;
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
  before.size = fileSize();
  before.pages = pageStats(db).pages;
  before.chunks = (
    db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks').get() as { n: number }
  ).n;
  before.events = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  before.lastSeq = log.currentSeq();
  before.tail = log.eventsSince(before.lastSeq - 50);
  before.replayLive = replay(liveProject);
  before.replayOld = replay(oldProject);

  const retention = new TranscriptRetention({
    db,
    tables: log.tables,
    now: () => iso(NOW),
    policy: { maxAgeDays: 90, archivedDays: 30 },
    ...(process.env['GALACTIC_P802_BATCH']
      ? { batchSize: Number(process.env['GALACTIC_P802_BATCH']) }
      : {}),
    ...(process.env['GALACTIC_P802_STEP']
      ? { vacuumStepPages: Number(process.env['GALACTIC_P802_STEP']) }
      : {}),
  });
  report = await retention.run();
}, 120_000);

afterAll(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('transcript compaction on a fixture database (P8-02)', () => {
  it('removes what the policy says and gives the space back without long pauses', () => {
    // The WAL as the job left it (auto-checkpointed), then the file once it is checkpointed.
    const walAfterRun = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
    db.pragma('wal_checkpoint(TRUNCATE)');
    const after = {
      size: fileSize(),
      pages: pageStats(db).pages,
      chunks: (db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks').get() as { n: number }).n,
    };
    if (REPORT) {
      writeFileSync(
        REPORT,
        JSON.stringify(
          {
            agents: agents.length,
            chunksPerAgent: CHUNKS_PER_AGENT,
            buildMs: Math.round(before.buildMs),
            fullVacuumMs: before.fullVacuumMs && Math.round(before.fullVacuumMs),
            chunksBefore: before.chunks,
            chunksAfter: after.chunks,
            events: before.events,
            sizeBeforeMB: +(before.size / 2 ** 20).toFixed(1),
            sizeAfterMB: +(after.size / 2 ** 20).toFixed(1),
            walAfterRunMB: +(walAfterRun / 2 ** 20).toFixed(1),
            removed: report.removedChunks,
            batches: report.batches,
            longestBatchMs: +report.longestBatchMs.toFixed(1),
            vacuum: {
              ...report.vacuum,
              longestStepMs: +report.vacuum.longestStepMs.toFixed(1),
              ms: Math.round(report.vacuum.ms),
            },
            totalMs: Math.round(report.ms),
          },
          null,
          2,
        ),
      );
    }
    const byGroup = (g: string) => agents.filter((a) => a.group === g).map((a) => a.id);
    const count = (id: Id) =>
      (
        db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks WHERE agent_id = ?').get(id) as {
          n: number;
        }
      ).n;
    for (const id of byGroup('old-archived')) expect(count(id)).toBe(0);
    for (const id of byGroup('pinned')) expect(count(id)).toBe(CHUNKS_PER_AGENT);
    // Live and recently archived work keeps its last 90 days: three quarters of 120.
    for (const id of [...byGroup('live'), ...byGroup('recent-archived')]) {
      expect(count(id)).toBeGreaterThanOrEqual(Math.floor(CHUNKS_PER_AGENT * 0.75) - 1);
      expect(count(id)).toBeLessThanOrEqual(Math.ceil(CHUNKS_PER_AGENT * 0.75) + 1);
    }
    expect(report.removedChunks).toBe(before.chunks - after.chunks);
    expect(report.vacuum.mode).toBe('incremental');
    expect(report.vacuum.pagesFreed).toBeGreaterThan(0);
    expect(after.pages).toBeLessThan(before.pages * 0.6);
    expect(after.size).toBeLessThan(before.size * 0.6);
    // Bounded synchronous work (generous for CI; the notes have the measured values).
    expect(report.longestBatchMs).toBeLessThan(500);
    expect(report.vacuum.longestStepMs).toBeLessThan(500);
  });

  it('leaves the event log untouched', () => {
    expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(
      before.events,
    );
    expect(log.currentSeq()).toBe(before.lastSeq);
    expect(log.eventsSince(before.lastSeq - 50)).toEqual(before.tail);
  });

  it('the timeline replay reads the same events for live and archived projects', () => {
    expect(before.replayLive.length).toBeGreaterThan(5);
    expect(before.replayOld.length).toBeGreaterThan(5);
    expect(replay(liveProject)).toEqual(before.replayLive);
    expect(replay(oldProject)).toEqual(before.replayOld);
  });

  it('a client resumes from lastEventId and is caught up', async () => {
    const t = await startTestApp({ log });
    try {
      const out = await connectWs(t.wsUrl, {
        send: [
          { type: 'hello', token: TEST_TOKEN, lastEventId: before.lastSeq - 50, logId: log.logId },
        ],
        until: (m: ServerMessage[]) => m.some((x) => x.type === 'caught_up'),
      });
      expect(out.error).toBeUndefined();
      const events = out.messages.filter((m) => m.type === 'event');
      expect(events.map((m) => (m as { seq: number }).seq)).toEqual(before.tail.map((e) => e.seq));
      expect(out.messages.at(-1)).toMatchObject({ type: 'caught_up', seq: before.lastSeq });
    } finally {
      await t.stop();
    }
  });

  it('the transcript views say what was removed', () => {
    const history = new History(db);
    const old = agents.find((a) => a.group === 'old-archived')!.id;
    expect(history.transcript(old, { limit: 10 })).toMatchObject({
      chunks: [],
      lastSeq: CHUNKS_PER_AGENT,
      compacted: { throughSeq: CHUNKS_PER_AGENT, reason: 'archived', removedAt: iso(NOW) },
    });
    const page = history.transcript('harmonizer', { limit: 10 });
    expect(page.compacted).toMatchObject({ reason: 'age' });
    expect(page.chunks.at(-1)?.seq).toBe(CHUNKS_PER_AGENT);
  });
});
