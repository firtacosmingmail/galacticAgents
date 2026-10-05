import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Id, SpawnOptions } from '@galactic/protocol';
import { harmonizerBrain } from '../../brains/harmonizer/index.js';
import type { BrainHarness } from '../../brains/testing/index.js';
import { waykeeperDefinition } from '../../brains/waykeeper/index.js';
import { openDatabase, type Database } from '../../db/database.js';
import { logDrift } from './drill-checks.js';
import { bootDrill, drillDirs, spawnStewards, type DrillDirs } from './drill-world.js';

/**
 * P8-04, found by the kill-at-any-moment drill: the server dies after an agent's row was written
 * but before its session started (`agent.created` without `agent.spawned` — with the real CLI,
 * the seconds it takes to start). Such an agent has no status record, so recovery did not see
 * it: the row stayed forever, neither running nor ended, and its task or project kept a
 * Steward or Waykeeper that would never work. Now recovery interrupts it and starts it fresh —
 * a Steward from its own first prompt, a brain re-seeded from the database — once.
 */

const LONG = { timeoutMs: 10_000 };

const roots: string[] = [];
const dbs: Database[] = [];
const lives: BrainHarness[] = [];
/** Ends the spawns a first life left hanging, so its runtime can be disposed. */
const releases: (() => void)[] = [];
afterEach(async () => {
  // The newest life first: an older one's dispose must not write into a live one's database.
  // The first life's hanging spawn ends before its own dispose.
  const all = lives.splice(0).reverse();
  for (const h of all) {
    if (h === all.at(-1)) for (const release of releases.splice(0)) release();
    await h.dispose().catch(() => {});
  }
  for (const db of dbs.splice(0)) db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function world(): { d: DrillDirs; db: Database } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-unstarted-')));
  roots.push(root);
  const db = openDatabase(':memory:');
  dbs.push(db);
  return { d: drillDirs(root), db };
}

function boot(w: { d: DrillDirs; db: Database }): BrainHarness {
  const h = bootDrill(w.d, w.db, { speed: 0 });
  lives.push(h);
  return h;
}

/** The adapter never gets the session of `role` started: the kill comes first. */
function hangSpawns(h: BrainHarness, role: SpawnOptions['role']): void {
  const spawn = h.adapter.spawn.bind(h.adapter);
  h.adapter.spawn = (opts) =>
    opts.role === role
      ? new Promise((_, reject) => releases.push(() => reject(new Error('the drill ended'))))
      : spawn(opts);
}

const eventsOf = (h: BrainHarness, agentId: Id): Event[] =>
  h.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .map(({ event }) => event)
    .filter((e) => 'agentId' in e && e.agentId === agentId);

describe('an agent created but never started before the kill (P8-04)', () => {
  it('a Steward starts from its first prompt, once', async () => {
    const w = world();
    const h1 = boot(w);
    const hq = await h1.startHarmonizer({
      definition: harmonizerBrain({ projectsRoot: w.d.projects }),
      cwd: w.d.projects,
    });
    const project = (
      await h1.commands.createProject({ name: 'Notes', workspace: join(w.d.home, 'Notes') })
    ).value;
    await h1.composed.workspaces!.prepareProject(project.id);
    await h1.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        scriptOptions: { strict: false },
        script: (s) => s.on(/was added to your project/, spawnStewards),
      },
    );
    hangSpawns(h1, 'steward');
    const task = (
      await h1.commands.createTask({ description: 'happy fix the date', projectId: project.id })
    ).value;
    let steward: Id | undefined;
    await h1.until(
      () =>
        (steward = h1.log.tables.agents.all().find((a) => a.taskId === task.id)?.id) !== undefined,
      { ...LONG, what: "the Steward's row" },
    );
    expect(h1.statuses.get(steward!)).toBeUndefined();
    h1.crash();

    const h2 = boot(w);
    const { report } = await h2.recover();
    expect(report.resumed).toContain(steward);
    expect(report.needAttention).toEqual([]);
    await h2.until(() => h2.statuses.get(steward!)?.state === 'finished', {
      ...LONG,
      what: 'the Steward to do its task',
    });
    const types = eventsOf(h2, steward!).map((e) => e.type);
    expect(types.filter((t) => t === 'agent.spawned')).toHaveLength(1);
    expect(eventsOf(h2, steward!).find((e) => e.type === 'agent.interrupted')).toMatchObject({
      reason: 'server restarted before the agent started',
    });
    // Started with its own instructions, on its own row: one Steward for the task.
    expect(h2.log.tables.agents.all().filter((a) => a.taskId === task.id)).toHaveLength(1);
    expect(logDrift(h2.log)).toEqual([]);
  });

  it('a Waykeeper comes back as a brain with a fresh, re-seeded session, once', async () => {
    const w = world();
    const h1 = boot(w);
    const hq = await h1.startHarmonizer({
      definition: harmonizerBrain({ projectsRoot: w.d.projects }),
      cwd: w.d.projects,
    });
    const project = (
      await h1.commands.createProject({ name: 'Docs', workspace: join(w.d.home, 'Docs') })
    ).value;
    await h1.composed.workspaces!.prepareProject(project.id);
    hangSpawns(h1, 'waykeeper');
    // Never settles in this life; refused when the drill ends the hanging spawn.
    h1.composed
      .startBrain(waykeeperDefinition(), {
        runtime: 'fake',
        projectId: project.id,
        supervisorId: hq.agentId,
      })
      .catch(() => {});
    let wk: Id | undefined;
    await h1.until(
      () => (wk = h1.log.tables.agents.all().find((a) => a.role === 'waykeeper')?.id) !== undefined,
      { ...LONG, what: "the Waykeeper's row" },
    );
    h1.crash();

    const h2 = boot(w);
    const { report, resumed } = await h2.recover();
    expect(report.resumed).toEqual(expect.arrayContaining([hq.agentId, wk]));
    expect(report.needAttention).toEqual([]);
    expect(resumed.map((b) => b.agentId)).toContain(wk);
    await h2.settle(LONG);
    const brain = resumed.find((b) => b.agentId === wk)!;
    expect(brain.prompts()[0]).toContain('your previous session could not be resumed');
    expect(h2.statuses.get(wk!)?.state).toBe('idle');
    expect(h2.log.tables.agents.all().filter((a) => a.role === 'waykeeper')).toHaveLength(1);
    expect(logDrift(h2.log)).toEqual([]);
  });
});
