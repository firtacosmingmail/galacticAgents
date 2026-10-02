import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import type { CapsConfig } from '../runtime/caps.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { projectHierarchy } from '../test/hierarchy.js';
import { DomainError } from './errors.js';

/**
 * P2-17: the hierarchy's spawn caps, enforced under `Commands.spawnAgent` (in the runtime's
 * `CapsEnforcer`), so every path — a brain tool, the panel, a test — meets them. A refused spawn
 * is a `DomainError` (`conflict`) naming the cap, the count, the limit and when it frees, and
 * leaves nothing behind.
 */

const lives: ComposedRuntime[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function boot(caps: CapsConfig, path = ':memory:') {
  const composed = composeRuntime(openDatabase(path), {
    adapters: [new FakeAdapter({ speed: 0 })],
    flushMs: 10,
    caps,
  });
  lives.push(composed);
  return composed;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function projectWithTasks(c: ComposedRuntime, n: number) {
  const project = (await c.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
  const { harmonizer, waykeeper } = await projectHierarchy(c.commands, project.id, {
    harmonizer: 'scenario:echo',
    waykeeper: 'scenario:echo',
  });
  const tasks: Id[] = [];
  for (let i = 0; i < n; i++) {
    tasks.push(
      (await c.commands.createTask({ description: `task ${i}`, projectId: project.id })).value.id,
    );
  }
  return { project, harmonizer, waykeeper, tasks };
}

const steward = (c: ComposedRuntime, taskId: Id, supervisorId: Id, prompt = 'scenario:echo') =>
  c.commands.spawnAgent({ role: 'steward', runtime: 'fake', taskId, supervisorId, prompt });

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('spawn caps through Commands.spawnAgent (P2-17)', () => {
  it('refuses a Steward beyond the Waykeeper’s cap with a clear reason, writing nothing', async () => {
    const c = boot({ maxStewardsPerWaykeeper: 2 });
    const { waykeeper, tasks } = await projectWithTasks(c, 3);
    await steward(c, tasks[0]!, waykeeper.id);
    await steward(c, tasks[1]!, waykeeper.id);
    const before = c.log.currentSeq();
    const error = await refusal(steward(c, tasks[2]!, waykeeper.id));
    expect(error.code).toBe('conflict');
    expect(error.message).toBe(
      `Stewards-per-Waykeeper cap: Waykeeper ${waykeeper.id} already supervises 2 of 2 live ` +
        'Stewards; a slot frees when one of them finishes, fails or is stopped',
    );
    expect(c.log.currentSeq()).toBe(before);
    expect(c.log.tables.agents.all().filter((a) => a.taskId === tasks[2])).toEqual([]);

    // A Steward that ends frees its slot.
    const first = c.log.tables.agents.all().find((a) => a.taskId === tasks[0])!;
    await c.commands.stopAgent(first.id, { type: 'user' });
    await until(() => c.runtime.caps.liveCount === 3);
    expect((await steward(c, tasks[2]!, waykeeper.id)).value.taskId).toBe(tasks[2]);
  });

  it('brains never take a concurrency slot: a full house of Stewards still lets brains start', async () => {
    const c = boot({ maxConcurrentAgents: 2, maxStewardsPerWaykeeper: 5 });
    const { harmonizer, waykeeper, tasks } = await projectWithTasks(c, 3);
    await steward(c, tasks[0]!, waykeeper.id);
    await steward(c, tasks[1]!, waykeeper.id);
    expect(c.runtime.caps.liveCount).toBe(4);
    const error = await refusal(steward(c, tasks[2]!, waykeeper.id));
    expect(error.message).toMatch(/^concurrency cap: 2 of 2 agents already running/);
    // A second project's Waykeeper still starts; a restarted Harmonizer would too.
    const other = (await c.commands.createProject({ name: 'Docs', workspace: '/w/docs' })).value;
    const wk2 = await c.commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      projectId: other.id,
      supervisorId: harmonizer.id,
      prompt: 'scenario:echo',
    });
    expect(wk2.value.role).toBe('waykeeper');
  });

  it('caps spawns per hour per spawning brain, even when its earlier Stewards have ended', async () => {
    const c = boot({ maxSpawnsPerHourPerBrain: 2 });
    const { waykeeper, tasks } = await projectWithTasks(c, 3);
    for (const taskId of tasks.slice(0, 2))
      await steward(c, taskId, waykeeper.id, 'scenario:fails');
    await until(() => c.runtime.caps.liveCount === 2);
    const error = await refusal(steward(c, tasks[2]!, waykeeper.id));
    expect(error.message).toMatch(
      new RegExp(
        `^spawn-rate cap: ${waykeeper.id} spawned 2 of 2 agents in the last hour; ` +
          'frees at \\S+Z \\(in (59|60) min\\)$',
      ),
    );
  });

  it('caps spawns per hour globally, and the window survives a restart (counted from the rows)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'galactic-caps-'));
    dirs.push(dir);
    const path = join(dir, 'galactic.sqlite');
    // Harmonizer + Waykeeper + one Steward = 3 spawns in this hour.
    const c1 = boot({ maxSpawnsPerHour: 4 }, path);
    const { waykeeper, tasks } = await projectWithTasks(c1, 2);
    await steward(c1, tasks[0]!, waykeeper.id, 'scenario:fails');
    expect(c1.runtime.caps.spawnsInLastHour()).toBe(3);
    await c1.dispose();
    lives.splice(lives.indexOf(c1), 1);

    const c2 = boot({ maxSpawnsPerHour: 3 }, path);
    expect(c2.runtime.caps.spawnsInLastHour()).toBe(3);
    expect(c2.runtime.caps.spawnsInLastHour(waykeeper.id)).toBe(1);
    const error = await refusal(steward(c2, tasks[1]!, waykeeper.id));
    expect(error.message).toMatch(
      /^spawn-rate cap: 3 of 3 agents spawned in the last hour \(all brains and the panel\); frees at /,
    );
  });
});
