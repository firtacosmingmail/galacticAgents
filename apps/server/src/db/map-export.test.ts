import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MapExport, type Actor, type HistoryEventsResponse } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { seedDemoProject } from '../domain/demo.js';
import { addDeliverable, recordRunStarted } from '../domain/deliverables.js';
import { EventLog } from '../domain/event-log.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { HistoryEvents } from '../runtime/history-events.js';
import { HistoryView } from '../runtime/history-view.js';
import { History } from '../runtime/history.js';
import { DEFAULT_CAPS } from '../runtime/caps.js';
import { StatusStore } from '../runtime/status-store.js';
import { logDrift } from '../test/drills/drill-checks.js';
import { openDatabase, type Database } from './database.js';
import { exportMap, exportMapText } from './map-export.js';
import { foldRows, importMap, ImportError, isEmptyDatabase } from './map-import.js';
import { listBackups } from './backup.js';

/**
 * P8-03 acceptance — export → wipe → import reproduces the map and history: the snapshot (logId
 * aside), the log event by event, the history and inspector outputs, the status records rebuilt
 * from the log, and tables consistent with the log (P8-04's `logDrift`).
 */

const USER: Actor = { type: 'user' };
const DAY = 24 * 60 * 60 * 1000;

const dirs: string[] = [];
const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'galactic-p8-03-'));
  dirs.push(d);
  return d;
}

function tickingClock(): (() => string) & { advance(ms: number): void } {
  let t = Date.parse('2026-10-01T09:00:00.000Z');
  const clock = () => new Date((t += 1000)).toISOString();
  return Object.assign(clock, { advance: (ms: number) => void (t += ms) });
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A map with a history: cards, projects, a sub-project, tasks, agents, questions, moves, archives. */
async function buildMap(dbPath: string): Promise<void> {
  const clock = tickingClock();
  const composed = composeRuntime(openDatabase(dbPath), {
    adapters: [new FakeAdapter({ speed: 5 })],
    log: { now: clock },
    flushMs: 10,
    caps: { maxConcurrentAgents: 8 },
  });
  lives.push(composed);
  const { log, commands, statuses } = composed;

  const proposal = (
    await commands.createProposal({
      requestText: 'Build a CLI that converts CSV to Parquet',
      kind: 'planet',
      proposedBody: { kind: 'planet', bodyId: 'b-mars', name: 'Mars' },
      workspace: '/w/csv',
      rationale: 'A new application',
    })
  ).value;
  await commands.decideProposal(
    proposal.id,
    { decision: 'edit', changes: { workspace: '/w/c2' } },
    USER,
  );
  await commands.decideProposal(proposal.id, { decision: 'approve' }, USER);

  const project = (
    await commands.createProject({
      name: 'CSV to Parquet',
      workspace: '/w/csv',
      bodyId: 'b-mars',
      permissionPolicy: { rules: { network: 'allow' } },
    })
  ).value;
  const sub = (
    await commands.createProject({
      name: 'Writer',
      workspace: '/w/csv/writer',
      bodyId: 'b-phobos',
      parentProjectId: project.id,
    })
  ).value;
  await commands.updateProject(project.id, { repoPath: '/w/csv', pinned: true });
  await commands.setBudget({ kind: 'project', id: project.id }, 5, USER, { origin: 'local' });
  await commands.setProjectState(project.id, 'in_progress');
  const parse = (
    await commands.createTask({
      description: 'Parse CSV',
      projectId: project.id,
      state: 'proposed',
    })
  ).value;
  const write = (
    await commands.createTask({
      description: 'Write Parquet',
      projectId: project.id,
      blockedBy: [parse.id],
      priority: 'high',
    })
  ).value;
  await commands.setTaskState(parse.id, 'approved');
  const flaky = (await commands.createTask({ description: 'Fix the flaky test' })).value;

  const harmonizer = (
    await commands.spawnAgent({ role: 'harmonizer', runtime: 'fake', cwd: '/w/hq', prompt: 'x' })
  ).value;
  const waykeeper = (
    await commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      projectId: project.id,
      supervisorId: harmonizer.id,
      prompt: 'scenario:long',
    })
  ).value;
  const steward = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: parse.id,
      supervisorId: waykeeper.id,
      prompt: 'scenario:asks',
    })
  ).value;
  const happy = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: write.id,
      supervisorId: waykeeper.id,
      prompt: 'scenario:happy',
    })
  ).value;
  const asteroidSteward = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: flaky.id,
      supervisorId: harmonizer.id,
      cwd: '/w/scratch',
      prompt: 'scenario:long',
    })
  ).value;
  await until(() => log.tables.questions.all().some((q) => q.originAgentId === steward.id));
  const asked = log.tables.questions.all().find((q) => q.originAgentId === steward.id)!;
  await commands.answerQuestion({ questionId: asked.id, answer: 'ISO 8601', by: USER, version: 0 });

  // Deliverables (P9-01): detected, declared, added by hand; edited, removed, restored, opened,
  // a run that ended and one still live at the export; the standalone task's moves with it.
  const LOCAL = { origin: 'local' as const };
  const SYSTEM: Actor = { type: 'system' };
  const dev = (
    await commands.addDeliverable(
      {
        projectId: project.id,
        kind: 'command',
        title: 'dev',
        source: 'detected',
        detectedKey: 'package.json#dev',
        command: { line: 'pnpm run dev', cwd: '/w/csv', detectedFrom: 'package.json' },
        meta: { important: 0 },
      },
      SYSTEM,
    )
  ).value;
  const shot = (
    await commands.addDeliverable(
      {
        taskId: parse.id,
        kind: 'image',
        title: 'Parsed rows',
        source: 'agent',
        location: { storage: 'worktree', path: '/w/csv/.galactic/worktrees/p/rows.png' },
      },
      { type: 'agent', id: steward.id },
    )
  ).value;
  await commands.updateDeliverable(
    shot.id,
    {
      location: {
        storage: 'copy',
        path: '/w/csv/deliverables/parse-csv/rows.png',
        originalPath: '/w/csv/.galactic/worktrees/p/rows.png',
      },
      meta: { copy: { bytes: 1234 } },
    },
    SYSTEM,
  );
  await commands.recordDeliverableOpened(shot.id, 'reveal', USER);
  const notes = (
    await commands.addDeliverable(
      {
        taskId: flaky.id,
        kind: 'file',
        title: 'Flake notes',
        description: 'what made the test flaky',
        source: 'user',
        location: { storage: 'in_place', path: '/w/scratch/notes.md' },
      },
      USER,
      LOCAL,
    )
  ).value;
  await commands.removeDeliverable(notes.id, USER, 'not needed', LOCAL);
  await commands.restoreDeliverable(notes.id, USER, LOCAL);
  const first = (
    await commands.recordRunStarted(
      { deliverableId: dev.id, line: 'pnpm run dev', cwd: '/w/csv' },
      USER,
    )
  ).value;
  await commands.recordRunPorts(first.id, [5173]);
  await commands.recordRunEnded(first.id, { outcome: 'stopped', by: USER });
  const live = (
    await commands.recordRunStarted(
      { deliverableId: dev.id, line: 'pnpm run dev --port 5174', cwd: '/w/csv' },
      USER,
    )
  ).value;
  await commands.recordRunPorts(live.id, [5174]);

  await commands.moveTask(flaky.id, project.id, USER);
  expect(log.tables.deliverables.get(notes.id)?.projectId).toBe(project.id);
  await until(() => statuses.get(happy.id)?.state === 'finished');

  const held = (
    await commands.openQuestion({
      kind: 'clarification',
      originAgentId: asteroidSteward.id,
      context: { text: 'Snappy or zstd?' },
    })
  ).value;
  await commands.escalateQuestion(held.id, { type: 'agent', id: waykeeper.id });
  await commands.reassignQuestion(held.id, { type: 'agent', id: waykeeper.id }, 'hand back');
  await commands.answerQuestion({ questionId: held.id, answer: 'zstd', by: USER, version: 2 });

  await commands.moveHost({ kind: 'project', id: sub.id }, 'b-deimos');
  const loose = (await commands.createProject({ name: 'Loose', workspace: '/w/loose' })).value;
  await commands.closeProject(loose.id, USER);
  await commands.archiveProject(loose.id, USER);
  await commands.control(
    { kind: 'task', id: write.id },
    { action: 'edit', changes: { priority: 'urgent' } },
    USER,
  );

  await until(() => statuses.get(steward.id)?.state === 'finished');
  await commands.closeTask(parse.id, { type: 'agent', id: waykeeper.id });
  await commands.closeProject(sub.id, USER);
  await commands.archiveProject(sub.id, USER);
  clock.advance(8 * DAY);
  await commands.sweepMarkers(7 * DAY);
  await commands.reopenProject(sub.id, USER, { bodyId: 'b-phobos' });
  await commands.updateProject(sub.id, { parentProjectId: null });

  // A demo planet retires (its tombstone stays) and its reopened project takes a catalogue body.
  const demo = log.runCommand((ctx) => seedDemoProject(ctx)).value;
  await commands.closeProject(demo.id, USER);
  await commands.archiveProject(demo.id, USER);
  await commands.reopenProject(demo.id, USER);

  await commands.stopAgent(asteroidSteward.id, USER);
  await commands.stopAgent(waykeeper.id, USER);
  await until(() => statuses.get(waykeeper.id)?.state === 'stopped');
  // Some agent output for the transcript variant.
  composed.transcripts.flush();
  lives.splice(lives.indexOf(composed), 1);
  await composed.dispose();
  log.db.close();
}

interface Observed {
  snapshot: ReturnType<EventLog['snapshot']>;
  events: unknown[];
  statuses: unknown[];
  history: unknown;
  /** Each agent's chat: the messages (from the log) and its replies (from the transcript). */
  chats: { entries: { kind: string }[] }[];
  drift: string[];
  /** The run history (P9-01): a projection of `run.*`, rebuilt by the import. */
  runs: unknown[];
}

function observe(dbPath: string): Observed {
  const db = openDatabase(dbPath);
  try {
    const log = new EventLog(db);
    const at = Date.parse('2026-10-20T00:00:00.000Z');
    const statuses = new StatusStore({
      capsOf: (id) => log.tables.agents.get(id)?.caps,
      defaultCaps: DEFAULT_CAPS,
      stallThresholdMs: () => 60_000,
      now: () => at,
    });
    statuses.rebuild(log.eventsSince(0, Number.MAX_SAFE_INTEGER));
    const view = new HistoryView(db, log.tables);
    const events = new HistoryEvents(db);
    const chat = new History(db);
    const work = view.work({ limit: 100 } as Parameters<HistoryView['work']>[0]);
    const strip = (r: HistoryEventsResponse) => {
      const { membership: _m, ...rest } = r;
      return rest;
    };
    const history = {
      work,
      questions: view.questions({ limit: 100 } as Parameters<HistoryView['questions']>[0]),
      details: log.tables.projects
        .all()
        .map((p) => view.detail('project', p.id))
        .concat(log.tables.tasks.all().map((t) => view.detail('task', t.id))),
      replays: log.tables.projects
        .all()
        .map((p) => strip(events.read({ projectId: p.id, limit: 2000 }))),
    };
    return {
      snapshot: log.snapshot(),
      events: db.prepare('SELECT id, at, type, payload FROM events ORDER BY id').all(),
      statuses: statuses.all(),
      history,
      chats: log.tables.agents.all().map((a) => chat.conversation(a.id, { limit: 200 })),
      drift: logDrift(log),
      runs: log.tables.runs.all(),
    };
  } finally {
    db.close();
  }
}

describe('map export and import (P8-03)', () => {
  it('export → wipe → import reproduces the map and its history', async () => {
    const home = tempDir();
    const dbPath = join(home, 'galactic.sqlite');
    await buildMap(dbPath);
    const before = observe(dbPath);
    expect(before.drift).toEqual([]);
    expect(before.snapshot.projects.length).toBeGreaterThan(3);
    expect(before.statuses.length).toBeGreaterThan(3);

    const source = openDatabase(dbPath);
    const exported = exportMap(source);
    const full = exportMap(source, { transcripts: true });
    source.close();
    // Through a file, as the CLI does.
    const file = join(tempDir(), 'map.json');
    writeFileSync(file, JSON.stringify(exported));
    const fullFile = join(tempDir(), 'full.json');
    writeFileSync(fullFile, JSON.stringify(full));
    expect(exported.includes.transcripts).toBe(false);
    expect(exported.transcripts).toBeUndefined();
    expect(exported.rows.bodies.some((b) => b.meta?.['retired'] === true)).toBe(true);

    rmSync(home, { recursive: true, force: true }); // the wipe
    const report = await importMap(dbPath, JSON.parse(readFileSync(file, 'utf8')));
    expect(report).toMatchObject({
      rebuilt: 'replayed',
      drift: [],
      events: exported.events.length,
    });
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);

    const after = observe(dbPath);
    expect(after.drift).toEqual([]);
    // Event by event, byte for byte (seq, at, type and payload).
    expect(after.events).toEqual(before.events);
    // The map: every table as it was; a new log identity (clients take a snapshot).
    const { logId: oldId, ...oldMap } = before.snapshot;
    const { logId: newId, ...newMap } = after.snapshot;
    expect(newMap).toEqual(oldMap);
    expect(newId).not.toBe(oldId);
    expect(report.logId).toBe(newId);
    expect(after.snapshot.spend?.length).toBeGreaterThan(0); // folded from the log again
    // Deliverables (P9-01): the rows (removed, moved, with their runs) and the run history.
    expect(exported.rows.deliverables?.length).toBe(3);
    expect(after.snapshot.deliverables).toEqual(before.snapshot.deliverables);
    expect(after.snapshot.deliverables?.some((d) => d.lastRun?.state === 'running')).toBe(true);
    expect(before.runs).toHaveLength(2);
    expect(after.runs).toEqual(before.runs);
    expect(after.statuses).toEqual(before.statuses);
    expect(after.history).toEqual(before.history);
    // Without the transcripts, the chats keep their messages and lose the agents' replies.
    const messages = (o: Observed) =>
      o.chats.map((c) => c.entries.filter((e) => e.kind !== 'reply'));
    expect(messages(after)).toEqual(messages(before));
    expect(before.chats.some((c) => c.entries.some((e) => e.kind === 'reply'))).toBe(true);
    expect(after.chats.some((c) => c.entries.some((e) => e.kind === 'reply'))).toBe(false);

    // With them, the chats come back whole.
    const elsewhere = join(tempDir(), 'galactic.sqlite');
    await importMap(elsewhere, JSON.parse(readFileSync(fullFile, 'utf8')));
    const whole = observe(elsewhere);
    expect(whole.chats).toEqual(before.chats);
    expect(whole.history).toEqual(before.history);
    expect(whole.events).toEqual(before.events);

    // `rows.deliverables` is optional (P9-01): an export without it (a build before Phase 9)
    // imports, nothing checked for them; the rebuild still folds them from the events.
    const { deliverables: _rows, ...olderRows } = exported.rows;
    const older = join(tempDir(), 'galactic.sqlite');
    const olderReport = await importMap(older, { ...exported, rows: olderRows });
    expect(olderReport).toMatchObject({ rebuilt: 'replayed', drift: [] });
    expect(observe(older).snapshot.deliverables).toEqual(before.snapshot.deliverables);
  });

  it('carries the transcripts only when asked, with their compaction markers', async () => {
    const home = tempDir();
    const dbPath = join(home, 'galactic.sqlite');
    await buildMap(dbPath);
    const db = openDatabase(dbPath);
    const agent = db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string };
    db.prepare('INSERT INTO transcript_chunks (agent_id, seq, at, chunk) VALUES (?, ?, ?, ?)').run(
      agent.id,
      7,
      '2026-10-01T10:00:00.000Z',
      '{"kind":"text","text":"hello"}',
    );
    db.prepare(
      `INSERT INTO transcript_compactions
         (agent_id, through_seq, through_at, last_seq, removed_at, removed_chunks, reason)
       VALUES (?, 6, '2026-10-01T09:59:00.000Z', 7, '2026-10-02T00:00:00.000Z', 6, 'age')`,
    ).run(agent.id);
    const chunks = () =>
      db.prepare('SELECT * FROM transcript_chunks ORDER BY agent_id, seq').all() as unknown[];
    const original = chunks();
    expect(original.length).toBeGreaterThan(0);
    const withTranscripts = exportMap(db, { transcripts: true });
    db.close();
    expect(withTranscripts.transcripts?.compactions).toHaveLength(1);

    const target = join(tempDir(), 'galactic.sqlite');
    const report = await importMap(target, JSON.parse(JSON.stringify(withTranscripts)));
    expect(report.transcriptChunks).toBe(original.length);
    const imported = new BetterSqlite3(target);
    expect(
      imported.prepare('SELECT * FROM transcript_chunks ORDER BY agent_id, seq').all(),
    ).toEqual(original);
    expect(imported.prepare('SELECT * FROM transcript_compactions').all()).toHaveLength(1);
    imported.close();
  });

  it('the streamed export (GET /api/export) is the same document, in pages, of one moment', async () => {
    const home = tempDir();
    const dbPath = join(home, 'galactic.sqlite');
    await buildMap(dbPath);
    const db = openDatabase(dbPath);
    const agent = db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string };
    for (let seq = 100; seq < 105; seq++) {
      db.prepare(
        'INSERT INTO transcript_chunks (agent_id, seq, at, chunk) VALUES (?, ?, ?, ?)',
      ).run(agent.id, seq, '2026-10-01T10:00:00.000Z', `{"kind":"text","text":"line ${seq}"}`);
    }
    const now = () => '2026-10-06T12:00:00.000Z';
    for (const transcripts of [false, true]) {
      const whole = exportMap(db, { transcripts, now });
      const reader = new BetterSqlite3(dbPath, { readonly: true });
      const pieces: string[] = [];
      let wroteMeanwhile = false;
      for await (const piece of exportMapText(reader, { transcripts, now, pageSize: 3 })) {
        pieces.push(piece);
        if (!wroteMeanwhile && pieces.length === 3) {
          // The server keeps writing through its own connection: the export does not see it.
          new EventLog(db).runCommand((ctx) => seedDemoProject(ctx));
          wroteMeanwhile = true;
        }
      }
      reader.close();
      expect(pieces.length).toBeGreaterThan(4); // really in pages
      const streamed = MapExport.parse(JSON.parse(pieces.join('')));
      expect(streamed).toEqual(MapExport.parse(whole));
    }
    db.close();
  });

  it('never exports secrets or device configuration', async () => {
    const home = tempDir();
    const dbPath = join(home, 'galactic.sqlite');
    const db = openDatabase(dbPath);
    const log = new EventLog(db);
    log.runCommand((ctx) => seedDemoProject(ctx));
    db.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, kinds, label, origin, created_at, updated_at)
       VALUES ('dev1', 'https://push.example/SECRET-ENDPOINT', 'P256-KEY', 'AUTH-SECRET', '{}', 'phone', 'local', 'x', 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_processes (agent_id, pid, started_at, status) VALUES ('a', 424242, 'x', 'running')`,
    ).run();
    const text = JSON.stringify(exportMap(db));
    db.close();
    for (const secret of ['SECRET-ENDPOINT', 'P256-KEY', 'AUTH-SECRET']) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses a database that holds a map unless --replace, which backs it up first', async () => {
    const home = tempDir();
    const dbPath = join(home, 'galactic.sqlite');
    const db = openDatabase(dbPath);
    const log = new EventLog(db);
    log.runCommand((ctx) => seedDemoProject(ctx));
    const exported = JSON.parse(JSON.stringify(exportMap(db))) as unknown;
    // The target holds other work and a phone's push subscription (device configuration).
    db.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, kinds, label, origin, created_at, updated_at)
       VALUES ('dev1', 'https://push.example/e', 'k', 'a', '{}', 'phone', 'local', 'x', 'x')`,
    ).run();
    log.runCommand((ctx) => seedDemoProject(ctx));
    const eventsBefore = log.currentSeq();
    db.close();

    await expect(importMap(dbPath, exported)).rejects.toMatchObject({ code: 'not_empty' });
    // Refused: untouched.
    const still = new BetterSqlite3(dbPath);
    expect((still.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(
      eventsBefore,
    );
    still.close();

    const report = await importMap(dbPath, exported, { replace: true });
    expect(report.replacedBackup).toBeDefined();
    expect(report.pushSubscriptionsKept).toBe(1);
    const backups = listBackups(join(home, 'backups'));
    expect(backups.map((b) => b.kind)).toEqual(['pre-import']);
    const copy = new BetterSqlite3(join(home, 'backups', backups[0]!.name), { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(
      eventsBefore,
    );
    copy.close();
    const now = new BetterSqlite3(dbPath);
    expect((now.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(
      report.events,
    );
    expect(now.prepare('SELECT id FROM push_subscriptions').all()).toEqual([{ id: 'dev1' }]);
    now.close();
  });

  it('imports into a database that only ran its migrations (an empty data folder)', async () => {
    const home = tempDir();
    const source = openDatabase(join(home, 'a.sqlite'));
    new EventLog(source).runCommand((ctx) => seedDemoProject(ctx));
    const exported = JSON.parse(JSON.stringify(exportMap(source))) as unknown;
    source.close();
    const target = join(home, 'b.sqlite');
    const fresh = openDatabase(target);
    new EventLog(fresh); // a server started once: a log id, no map
    expect(isEmptyDatabase(fresh)).toBe(true);
    fresh.close();
    await expect(importMap(target, exported)).resolves.toMatchObject({ rebuilt: 'replayed' });
  });

  it('refuses when replaying the events does not give the exported rows, unless --prefer-rows', async () => {
    const home = tempDir();
    const source = openDatabase(join(home, 'a.sqlite'));
    const log = new EventLog(source);
    const demo = log.runCommand((ctx) => seedDemoProject(ctx)).value;
    // A row changed without its event (as an early migration did): the log no longer says it.
    source.prepare(`UPDATE projects SET name = 'Renamed by hand' WHERE id = ?`).run(demo.id);
    const exported = JSON.parse(JSON.stringify(exportMap(source))) as unknown;
    source.close();

    const target = join(home, 'b.sqlite');
    const refused = await importMap(target, exported).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ImportError);
    expect((refused as ImportError).code).toBe('drift');
    expect((refused as ImportError).drift.join('\n')).toContain('Renamed by hand');
    expect(() => statSync(target)).toThrow(); // nothing left behind

    const report = await importMap(target, exported, { preferRows: true });
    expect(report.rebuilt).toBe('rows');
    const db = new BetterSqlite3(target);
    expect(db.prepare('SELECT name FROM projects WHERE id = ?').get(demo.id)).toEqual({
      name: 'Renamed by hand',
    });
    db.close();
  });

  it('refuses rows that lack a deliverable a run in the log belongs to (--prefer-rows)', async () => {
    const home = tempDir();
    const source = openDatabase(join(home, 'a.sqlite'));
    const log = new EventLog(source);
    const demo = log.runCommand((ctx) => seedDemoProject(ctx)).value;
    const dev = log.runCommand((ctx) =>
      addDeliverable(
        ctx,
        {
          projectId: demo.id,
          kind: 'command',
          title: 'dev',
          source: 'detected',
          detectedKey: 'package.json#dev',
          command: { line: 'pnpm run dev', cwd: '/w/demo' },
        },
        { type: 'system' },
      ),
    ).value;
    log.runCommand((ctx) =>
      recordRunStarted(
        ctx,
        { runId: 'r-1', deliverableId: dev.id, line: 'pnpm run dev', cwd: '/w/demo' },
        { type: 'user' },
      ),
    );
    const exported = JSON.parse(JSON.stringify(exportMap(source))) as {
      rows: { deliverables?: unknown[] };
    };
    source.close();
    exported.rows.deliverables = []; // edited by hand: the run's deliverable is gone

    const target = join(home, 'b.sqlite');
    const refused = await importMap(target, exported, { preferRows: true }).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ImportError);
    expect(refused).toMatchObject({ code: 'drift' });
    expect((refused as ImportError).message).toMatch(/lack the deliverable of 1 run/);
    expect((refused as ImportError).drift.join('\n')).toContain(`run r-1`);
    expect(() => statSync(target)).toThrow(); // nothing left behind
  });

  it('refuses files it cannot read and exports of another or newer build', async () => {
    const target = join(tempDir(), 'galactic.sqlite');
    await expect(importMap(target, { hello: 'world' })).rejects.toMatchObject({ code: 'invalid' });
    const db = openDatabase(':memory:');
    const exported = exportMap(db);
    db.close();
    const newer = {
      ...exported,
      schema: {
        ...exported.schema,
        migrations: [...exported.schema.migrations, { version: 999, name: 'future' }],
      },
    };
    await expect(importMap(target, newer)).rejects.toMatchObject({ code: 'schema' });
    const other = {
      ...exported,
      schema: {
        ...exported.schema,
        migrations: exported.schema.migrations.map((m) =>
          m.version === 1 ? { ...m, name: 'other' } : m,
        ),
      },
    };
    await expect(importMap(target, other)).rejects.toMatchObject({ code: 'schema' });
    expect(MapExport.safeParse(exported).success).toBe(true);
  });

  it('refuses to export a database this build has not migrated', () => {
    const path = join(tempDir(), 'old.sqlite');
    const db: Database = openDatabase(path, { migrate: false });
    db.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
       INSERT INTO schema_migrations VALUES (1, 'initial', 'x');`,
    );
    expect(() => exportMap(db)).toThrow(/start Mission Control once/);
    db.close();
  });

  it('folds an unknown event type to nothing', () => {
    const rows = foldRows(
      [],
      [{ seq: 1, at: '2026-10-01T00:00:00.000Z', event: { type: 'future.thing' } }],
    );
    expect(rows.projects).toEqual([]);
  });
});
