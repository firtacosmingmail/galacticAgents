import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { tickingClock } from '../test/world.js';
import { Archival, type Timers } from './archival.js';
import { composeRuntime } from './compose.js';

/** The archival job's timer and its composition (P2-13): fake timers, fake clock. */

const USER = { type: 'user' } as const;
const DAY = 24 * 60 * 60 * 1000;

function fakeTimers() {
  const ticks: (() => void)[] = [];
  let cleared = 0;
  const timers: Timers = {
    setInterval: (fn, ms) => {
      ticks.push(fn);
      return ms;
    },
    clearInterval: () => void cleared++,
  };
  return { timers, tick: () => ticks.forEach((t) => t()), count: () => ticks.length, cleared: () => cleared };
}

async function closedProject(composed: ReturnType<typeof composeRuntime>) {
  const { commands } = composed;
  const p = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
  await commands.control({ kind: 'project', id: p.id }, { action: 'close' }, USER);
  return p;
}

describe('archival job (P2-13)', () => {
  it('is composed off by default; sweep() runs it by hand', async () => {
    const clock = tickingClock();
    const composed = composeRuntime(openDatabase(':memory:'), {
      log: { now: clock },
      archival: { retentionMs: DAY },
    });
    expect(composed.archival.running).toBe(false);
    const p = await closedProject(composed);
    expect(composed.archival.pending().map((i) => i.id)).toEqual([p.id]);
    clock.advance(DAY + 60_000);
    expect(composed.archival.sweep().archived).toEqual([{ kind: 'project', id: p.id }]);
    expect(composed.log.tables.bodies.get(p.bodyId)?.host).toBeUndefined();
    await composed.dispose();
  });

  it('sweeps on start and on every tick of its timer, and stops with the runtime', async () => {
    const clock = tickingClock();
    const fake = fakeTimers();
    const composed = composeRuntime(openDatabase(':memory:'), {
      log: { now: clock },
      archival: { retentionMs: DAY, intervalMs: 1000, timers: fake.timers },
    });
    expect(composed.archival.running).toBe(true);
    expect(fake.count()).toBe(1);
    const p = await closedProject(composed);
    fake.tick();
    expect(composed.log.tables.projects.get(p.id)?.state).toBe('completed');
    clock.advance(DAY + 60_000);
    fake.tick();
    expect(composed.log.tables.projects.get(p.id)?.state).toBe('archived');
    await composed.dispose();
    expect(composed.archival.running).toBe(false);
    expect(fake.cleared()).toBe(1);
  });

  it('reports a failing sweep through onError and keeps ticking', () => {
    const errors: unknown[] = [];
    const fake = fakeTimers();
    const archival = new Archival({
      log: { runCommand: () => { throw new Error('db gone'); } } as never,
      timers: fake.timers,
      onError: (e) => errors.push(e),
    });
    archival.start(1000);
    fake.tick();
    expect(errors).toHaveLength(2);
    expect(archival.running).toBe(true);
    archival.stop();
  });
});
