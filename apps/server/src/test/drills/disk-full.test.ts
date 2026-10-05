import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Id } from '@galactic/protocol';
import type { FakeStep } from '../../adapters/fake/scenario.js';
import type { BrainHarness, HarnessBrain } from '../../brains/testing/index.js';
import { harmonizerBrain } from '../../brains/harmonizer/index.js';
import { waykeeperDefinition } from '../../brains/waykeeper/index.js';
import { isStorageFailure, openDatabase, type Database } from '../../db/database.js';
import { logDrift } from './drill-checks.js';
import { bootDrill, drillDirs, spawnStewards, USER, type DrillDirs } from './drill-world.js';

/**
 * P8-04 drill 4: the disk fills up under a running hierarchy. A tiny disk image is awkward on
 * macOS, so the database file is stopped from growing instead: `PRAGMA max_page_count` at its
 * current size, and the free pages used up — from then on every write fails with SQLITE_FULL,
 * exactly as on a full disk. Raising the limit is "space returns".
 *
 * Checks: the one write rule (TECHNOLOGY §6.1) holds — a refused command leaves neither its
 * mutation nor its event; the error reaches whoever asked; agent events the runtime cannot write
 * are held and written in order once space returns, so nothing a Steward did while the disk was
 * full is lost and its supervisor still hears of it.
 */

const LONG = { timeoutMs: 10_000 };

/** Enough events that the last pages of the log fill up while the Steward still works. */
const TOOL_CALLS = 80;
const BUSY: FakeStep[] = [
  ...Array.from({ length: TOOL_CALLS }, (_, i): FakeStep => ({
    kind: 'tool_call',
    toolName: 'Read',
    input: { file_path: `src/${i}.ts` },
    delayMs: 25,
  })),
  { kind: 'finish', result: 'Done: read everything.' },
];

const roots: string[] = [];
const dbs: Database[] = [];
const lives: BrainHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0).reverse()) await h.dispose().catch(() => {});
  for (const db of dbs.splice(0)) db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * The database file cannot grow any more and has no free page left: every write fails with
 * SQLITE_FULL until the returned function gives the space back.
 */
function fillDisk(db: Database): () => void {
  const pages = db.pragma('page_count', { simple: true }) as number;
  db.pragma(`max_page_count = ${pages}`);
  const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  let n = 0;
  for (const size of [4_000, 400, 40, 1]) {
    for (;;) {
      try {
        insert.run(`drill-filler-${n++}`, 'x'.repeat(size));
      } catch (error) {
        if (!isStorageFailure(error)) throw error;
        break;
      }
    }
  }
  return () => {
    db.pragma('max_page_count = 1073741823');
  };
}

interface World {
  h: BrainHarness;
  d: DrillDirs;
  db: Database;
  hq: HarnessBrain;
  wk: HarnessBrain;
  projectId: Id;
}

async function world(d?: DrillDirs): Promise<World> {
  if (!d) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-full-')));
    roots.push(root);
    d = drillDirs(root);
  }
  const db = openDatabase(d.db);
  dbs.push(db);
  const h = bootDrill(d, db, { scenarios: { busy: { steps: BUSY } } });
  lives.push(h);
  const hq = await h.startHarmonizer({
    definition: harmonizerBrain({ projectsRoot: d.projects }),
    cwd: d.projects,
    scriptOptions: { strict: false },
    script: (s) => s.once('ask me', (t) => t.call('ask_user', { text: 'Which licence?' })),
  });
  const project = (
    await h.commands.createProject({ name: 'Full', workspace: join(d.home, 'Full') })
  ).value;
  await h.composed.workspaces!.prepareProject(project.id);
  const wk = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    {
      scriptOptions: { strict: false },
      script: (s) => s.on(/was added to your project/, spawnStewards),
    },
  );
  return { h, d, db, hq, wk, projectId: project.id };
}

/** What a refused write must not change: every domain table and the log's end. */
const state = (h: BrainHarness) => JSON.stringify(h.log.snapshot());

const eventsOf = (h: BrainHarness, agentId: Id): Event[] =>
  h.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .map(({ event }) => event)
    .filter((e) => 'agentId' in e && e.agentId === agentId);

describe('disk full (P8-04 drill 4)', () => {
  it('a refused write leaves neither its mutation nor its event, and the caller gets the error', async () => {
    const { h, db, hq, projectId } = await world();
    hq.tell('ask me');
    await h.until(() => h.log.tables.questions.all().some((q) => q.status === 'open'), LONG);
    await h.settle(LONG);
    const question = h.log.tables.questions.all().find((q) => q.status === 'open')!;

    const restore = fillDisk(db);
    // The log's own last pages still have room: harmless writes until they are full too.
    for (let pinned = true; ; pinned = !pinned) {
      try {
        await h.commands.pinProject(projectId, pinned);
      } catch (error) {
        if (!isStorageFailure(error)) throw error;
        break;
      }
    }
    const before = state(h);
    const attempts: [string, () => Promise<unknown> | unknown][] = [
      ['create a task', () => h.commands.createTask({ description: 'one more', projectId })],
      [
        'answer a question',
        () => h.commands.answerQuestion({ questionId: question.id, answer: 'MIT', by: USER }),
      ],
      [
        'pause the project',
        () => h.commands.control({ kind: 'project', id: projectId }, { action: 'pause' }, USER),
      ],
      [
        'make a card',
        () =>
          h.commands.createProposal({
            requestText: 'rename the logs',
            kind: 'asteroid',
            proposedBody: { kind: 'asteroid', name: 'Rename logs' },
            workspace: '/w/projects/scratch/rename-logs',
            rationale: 'small',
          }),
      ],
    ];
    for (const [what, attempt] of attempts) {
      let failure: unknown;
      try {
        await attempt();
      } catch (error) {
        failure = error;
      }
      expect(isStorageFailure(failure), `${what}: ${String(failure)}`).toBe(true);
      expect(state(h), what).toBe(before);
    }
    expect(logDrift(h.log)).toEqual([]);
    // A chat line is the runtime's to write: accepted, held, not lost (nor half-written).
    const chat = h.tell(hq.agentId, 'how is it going?');
    expect(state(h)).toBe(before);

    // Space returns: the held line lands and reaches the Harmonizer; the same commands go through.
    restore();
    await h.until(
      () =>
        h.log
          .eventsSince(0, Number.MAX_SAFE_INTEGER)
          .some(({ event: e }) => e.type === 'message.delivered' && e.messageId === chat.id),
      { ...LONG, what: 'the held chat line to be delivered' },
    );
    await h.settle(LONG);
    expect(hq.prompts().some((p) => p.includes('how is it going?'))).toBe(true);
    await h.commands.answerQuestion({ questionId: question.id, answer: 'MIT', by: USER });
    await h.commands.createTask({ description: 'one more', projectId });
    expect(h.log.tables.questions.get(question.id)?.status).toBe('answered');
    expect(logDrift(h.log)).toEqual([]);
  });

  it('a Steward working through a full disk loses nothing: its events wait and land in order', async () => {
    const { h, db, wk, projectId } = await world();
    const task = (await h.commands.createTask({ description: 'busy reading', projectId })).value;
    let steward: Id | undefined;
    await h.until(
      () =>
        (steward = h.log.tables.agents.all().find((a) => a.taskId === task.id)?.id) !== undefined &&
        eventsOf(h, steward).some((e) => e.type === 'agent.tool_call'),
      { ...LONG, what: 'the Steward at work' },
    );
    // The file cannot grow: the log's last pages still take a few events, then nothing more.
    const restore = fillDisk(db);
    await h.until(() => h.runtime.heldWrites > 0, { ...LONG, what: 'the first refused write' });
    const seq = h.log.currentSeq();

    // It goes on working and finishes while nothing can be written.
    await h.until(() => h.runtime.liveAgents().every((a) => a.id !== steward), {
      ...LONG,
      what: 'the Steward to finish its session',
    });
    expect(h.log.currentSeq()).toBe(seq);
    expect(h.runtime.heldWrites).toBeGreaterThan(0);
    // The server says so, once — not once per event.
    const full = h.errors.filter((e) => e.startsWith('storage: database or disk is full'));
    expect(full).toHaveLength(1);

    // Space returns: the held events are written in order, the supervisor hears of the finish.
    restore();
    await h.until(() => h.runtime.heldWrites === 0, { ...LONG, what: 'the held events' });
    await h.until(() => h.statuses.get(steward!)?.state === 'finished', LONG);
    const types = eventsOf(h, steward!).map((e) => e.type);
    expect(types.filter((t) => t === 'agent.tool_call')).toHaveLength(TOOL_CALLS);
    expect(types.at(-1)).toBe('agent.finished');
    expect(h.errors.some((e) => /storage: writes work again: \d+ held agent events/.test(e))).toBe(
      true,
    );
    await h.until(() => wk.prompts().some((p) => p.includes(`${steward} finished`)), {
      ...LONG,
      what: 'the Waykeeper to hear of the finish',
    });
    expect(logDrift(h.log)).toEqual([]);
  });
});
