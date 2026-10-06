import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapsEnforcer, DEFAULT_CAPS } from './caps.js';

const enforcers: CapsEnforcer[] = [];
function make(maxConcurrentAgents = 2) {
  const hits: [string, string][] = [];
  let now = 1_000;
  const caps = new CapsEnforcer({
    maxConcurrentAgents,
    defaults: { maxWallClockMs: 60_000, maxToolCalls: 3 },
    onCapHit: (id, reason) => hits.push([id, reason]),
    now: () => now,
  });
  enforcers.push(caps);
  return { caps, hits, advance: (ms: number) => (now += ms) };
}
afterEach(() => {
  for (const c of enforcers.splice(0)) c.dispose();
});

describe('CapsEnforcer', () => {
  it('fills defaults and refuses spawns over the concurrency cap with a clear reason', () => {
    const { caps } = make(2);
    expect(caps.resolve()).toEqual({ maxWallClockMs: 60_000, maxToolCalls: 3 });
    expect(caps.resolve({ maxToolCalls: 10 })).toEqual({
      maxWallClockMs: 60_000,
      maxToolCalls: 10,
    });
    expect(caps.canSpawn()).toEqual({ ok: true });
    caps.track('a-1', caps.resolve());
    caps.track('a-2', caps.resolve());
    expect(caps.canSpawn()).toEqual({
      ok: false,
      reason:
        'concurrency cap: 2 of 2 agents already running (the Harmonizer and Waykeepers not ' +
        'counted); a slot frees when one of them ends',
    });
    caps.onEvent({ type: 'agent.finished', agentId: 'a-1' });
    expect(caps.canSpawn()).toEqual({ ok: true });
    expect(caps.liveCount).toBe(1);
  });

  it('counts tool calls and hits the cap once', () => {
    const { caps, hits, advance } = make();
    caps.track('a-1', caps.resolve());
    for (let i = 0; i < 3; i++)
      caps.onEvent({ type: 'agent.tool_call', agentId: 'a-1', toolName: 'Read' });
    expect(hits).toEqual([]);
    advance(500);
    expect(caps.usage('a-1')).toEqual({
      wallClockMs: { used: 500, limit: 60_000 },
      toolCalls: { used: 3, limit: 3 },
    });
    caps.onEvent({ type: 'agent.tool_call', agentId: 'a-1', toolName: 'Edit' });
    caps.onEvent({ type: 'agent.tool_call', agentId: 'a-1', toolName: 'Edit' });
    expect(hits).toEqual([['a-1', 'tool-call cap: 4 calls, limit 3']]);
    // Events of untracked agents are ignored.
    caps.onEvent({ type: 'agent.tool_call', agentId: 'ghost', toolName: 'Read' });
    expect(caps.usage('ghost')).toBeUndefined();
  });

  it('hits the wall-clock cap from a timer', async () => {
    const { caps, hits } = make();
    caps.track('a-1', { maxWallClockMs: 30, maxToolCalls: 100 });
    await new Promise((r) => setTimeout(r, 80));
    expect(hits).toEqual([['a-1', 'wall-clock cap: 30 ms elapsed']]);
    expect(caps.usage('a-1')).toBeDefined(); // still tracked until the runtime releases it
    caps.release('a-1');
    expect(caps.usage('a-1')).toBeUndefined();
  });

  it('a paused agent’s wall clock stops; resume starts it again with what is left (review)', async () => {
    const { caps, hits, advance } = make();
    caps.track('a-1', { maxWallClockMs: 60, maxToolCalls: 100 });
    advance(20);
    caps.pause('a-1');
    advance(1_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(hits).toEqual([]);
    expect(caps.usage('a-1')?.wallClockMs).toEqual({ used: 20, limit: 60 });
    caps.resume('a-1');
    advance(5);
    expect(caps.usage('a-1')?.wallClockMs).toEqual({ used: 25, limit: 60 });
    await new Promise((r) => setTimeout(r, 100));
    expect(hits).toEqual([['a-1', 'wall-clock cap: 60 ms elapsed']]);
  });

  it('release clears the timer; DEFAULT_CAPS are sane', async () => {
    const { caps, hits } = make();
    caps.track('a-1', { maxWallClockMs: 20, maxToolCalls: 100 });
    caps.onEvent({ type: 'agent.stopped', agentId: 'a-1', by: { type: 'user' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toEqual([]);
    expect(DEFAULT_CAPS.maxWallClockMs).toBeGreaterThan(60_000);
    expect(DEFAULT_CAPS.maxToolCalls).toBeGreaterThan(10);
  });
});

describe('CapsEnforcer — spawn caps (P2-17)', () => {
  const HOUR = 60 * 60 * 1000;
  const T0 = Date.parse('2026-10-02T10:00:00.000Z');
  function spawnCaps(spawn: Record<string, number>, maxConcurrentAgents = 10) {
    let now = T0;
    const caps = new CapsEnforcer({
      maxConcurrentAgents,
      defaults: DEFAULT_CAPS,
      spawn,
      onCapHit: () => {},
      now: () => now,
    });
    enforcers.push(caps);
    return { caps, advance: (ms: number) => (now += ms) };
  }
  const under = (w: string) => ({
    role: 'steward' as const,
    supervisorId: w,
    supervisorRole: 'waykeeper' as const,
  });

  it('brains do not count against the concurrency cap, and the Harmonizer is never refused', () => {
    const { caps } = spawnCaps({}, 2);
    caps.track('h', caps.resolve(), { role: 'harmonizer' });
    caps.track('w', caps.resolve(), { role: 'waykeeper', supervisorId: 'h' });
    caps.track('s-1', caps.resolve(), { role: 'steward', supervisorId: 'w' });
    expect(caps.canSpawn(under('w'))).toEqual({ ok: true });
    caps.track('s-2', caps.resolve(), { role: 'steward', supervisorId: 'h' });
    // A full house of Stewards: no third Steward, but brains still start.
    expect(caps.canSpawn({ role: 'steward' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^concurrency cap: 2 of 2/),
    });
    expect(caps.canSpawn({ role: 'waykeeper', supervisorId: 'h' })).toEqual({ ok: true });
    expect(caps.canSpawn({ role: 'harmonizer' })).toEqual({ ok: true });
  });

  it('caps the live Stewards of one Waykeeper, not those of another or of the Harmonizer', () => {
    const { caps } = spawnCaps({ maxStewardsPerWaykeeper: 2 });
    caps.track('s-1', caps.resolve(), { role: 'steward', supervisorId: 'w-1' });
    caps.track('s-2', caps.resolve(), { role: 'steward', supervisorId: 'w-1' });
    expect(caps.canSpawn(under('w-1'))).toEqual({
      ok: false,
      reason:
        'Stewards-per-Waykeeper cap: Waykeeper w-1 already supervises 2 of 2 live Stewards; ' +
        'a slot frees when one of them finishes, fails or is stopped',
    });
    expect(caps.canSpawn(under('w-2'))).toEqual({ ok: true });
    // Asteroid Stewards under the Harmonizer are bounded by the global caps only.
    caps.track('s-3', caps.resolve(), { role: 'steward', supervisorId: 'h' });
    caps.track('s-4', caps.resolve(), { role: 'steward', supervisorId: 'h' });
    expect(
      caps.canSpawn({ role: 'steward', supervisorId: 'h', supervisorRole: 'harmonizer' }),
    ).toEqual({ ok: true });
    caps.onEvent({ type: 'agent.finished', agentId: 's-1' });
    expect(caps.canSpawn(under('w-1'))).toEqual({ ok: true });
  });

  it('reads placement from agentOf when given: a moved Steward counts under its new supervisor', () => {
    const rows = new Map([['s-1', { role: 'steward' as const, supervisorId: 'w-2' }]]);
    const caps = new CapsEnforcer({
      maxConcurrentAgents: 10,
      defaults: DEFAULT_CAPS,
      spawn: { maxStewardsPerWaykeeper: 1 },
      agentOf: (id) => rows.get(id),
      onCapHit: () => {},
    });
    enforcers.push(caps);
    caps.track('s-1', caps.resolve(), { role: 'steward', supervisorId: 'w-1' });
    expect(caps.canSpawn(under('w-1')).ok).toBe(true);
    expect(caps.canSpawn(under('w-2')).ok).toBe(false);
  });

  it('caps spawns per sliding hour, globally and per spawning brain, and says when it frees', () => {
    const { caps, advance } = spawnCaps({ maxSpawnsPerHour: 3, maxSpawnsPerHourPerBrain: 2 });
    caps.noteSpawn('w-1');
    advance(10 * 60_000);
    caps.noteSpawn('w-1');
    expect(caps.canSpawn(under('w-1'))).toEqual({
      ok: false,
      reason:
        'spawn-rate cap: w-1 spawned 2 of 2 agents in the last hour; ' +
        'frees at 2026-10-02T11:00:00.000Z (in 50 min)',
    });
    // Another brain may still spawn, until the global window is full.
    expect(caps.canSpawn({ role: 'waykeeper', supervisorId: 'h' })).toEqual({ ok: true });
    caps.noteSpawn(undefined);
    expect(caps.canSpawn({ role: 'waykeeper', supervisorId: 'h' })).toEqual({
      ok: false,
      reason:
        'spawn-rate cap: 3 of 3 agents spawned in the last hour (all brains and the panel); ' +
        'frees at 2026-10-02T11:00:00.000Z (in 50 min)',
    });
    // Resuming a saved session is not a new spawn; the Harmonizer is never refused.
    expect(caps.canSpawn({ ...under('w-1'), again: true })).toEqual({ ok: true });
    expect(caps.canSpawn({ role: 'harmonizer' })).toEqual({ ok: true });
    advance(50 * 60_000);
    expect(caps.spawnsInLastHour()).toBe(2);
    expect(caps.spawnsInLastHour('w-1')).toBe(1);
    expect(caps.canSpawn(under('w-1'))).toEqual({ ok: true });
  });

  it('does not count a Harmonizer in the per-hour window (decision 43; P5-06 restarts)', () => {
    const { caps } = spawnCaps({ maxSpawnsPerHour: 2 });
    for (let i = 0; i < 5; i++) caps.noteSpawn(undefined, undefined, 'harmonizer');
    caps.noteSpawn(undefined, T0 - 10 * 60_000, 'harmonizer');
    expect(caps.spawnsInLastHour()).toBe(0);
    expect(caps.canSpawn({ role: 'steward' })).toEqual({ ok: true });
    caps.noteSpawn('w-1', undefined, 'steward');
    caps.noteSpawn('h-1', undefined, 'waykeeper');
    expect(caps.spawnsInLastHour()).toBe(2);
    expect(caps.canSpawn({ role: 'steward' }).ok).toBe(false);
  });

  it('counts spawns noted with a past time (a restart) only inside the window', () => {
    const { caps } = spawnCaps({ maxSpawnsPerHour: 2 });
    caps.noteSpawn('w-1', T0 - 2 * HOUR);
    caps.noteSpawn('w-1', T0 - 30 * 60_000);
    caps.noteSpawn('w-2', T0 - 50 * 60_000);
    expect(caps.spawnsInLastHour()).toBe(2);
    expect(caps.canSpawn({ role: 'steward' })).toMatchObject({
      ok: false,
      // The oldest spawn inside the window (50 min ago) leaves it first.
      reason: expect.stringContaining('frees at 2026-10-02T10:10:00.000Z (in 10 min)'),
    });
  });
});

describe('CapsEnforcer — the wall-clock cap is for Stewards only (P8-10, SPEC decision 103)', () => {
  const H2 = 2 * 60 * 60 * 1000;
  afterEach(() => {
    vi.useRealTimers();
  });
  function fakeClock() {
    vi.useFakeTimers({ now: Date.parse('2026-10-06T08:00:00.000Z') });
    const hits: [string, string][] = [];
    const caps = new CapsEnforcer({
      maxConcurrentAgents: 10,
      defaults: { maxWallClockMs: H2, maxToolCalls: 3 },
      onCapHit: (id, reason) => hits.push([id, reason]),
    });
    enforcers.push(caps);
    return { caps, hits };
  }

  it('an idle Harmonizer and Waykeeper run past the cap; a Steward is stopped by it', () => {
    const { caps, hits } = fakeClock();
    caps.track('h', caps.resolve(), { role: 'harmonizer' });
    caps.track('w', caps.resolve(), { role: 'waykeeper', supervisorId: 'h' });
    caps.track('s', caps.resolve(), { role: 'steward', supervisorId: 'w' });
    vi.advanceTimersByTime(H2 + 1);
    expect(hits).toEqual([['s', 'wall-clock cap: 120 min elapsed']]);
    vi.advanceTimersByTime(10 * H2);
    expect(hits).toHaveLength(1);
    // The brains' time still counts, with no limit to show.
    expect(caps.usage('h')?.wallClockMs).toEqual({ used: 11 * H2 + 1 });
    expect(caps.usage('s')?.wallClockMs).toEqual({ used: 11 * H2 + 1, limit: H2 });
  });

  it('a brain paused and resumed still has no wall-clock timer', () => {
    const { caps, hits } = fakeClock();
    caps.track('w', caps.resolve(), { role: 'waykeeper' });
    caps.pause('w');
    caps.resume('w');
    vi.advanceTimersByTime(3 * H2);
    expect(hits).toEqual([]);
  });

  it('a brain keeps its tool-call cap', () => {
    const { caps, hits } = fakeClock();
    caps.track('h', caps.resolve(), { role: 'harmonizer' });
    for (let i = 0; i < 4; i++)
      caps.onEvent({ type: 'agent.tool_call', agentId: 'h', toolName: 'report_status' });
    expect(hits).toEqual([['h', 'tool-call cap: 4 calls, limit 3']]);
  });

  it('a free-form agent keeps the wall-clock cap, whatever its role', () => {
    const { caps, hits } = fakeClock();
    caps.track('f', caps.resolve(), { role: 'waykeeper', freeForm: true });
    caps.track('g', caps.resolve(), { role: 'steward', freeForm: true });
    vi.advanceTimersByTime(H2 + 1);
    expect(hits.map(([id]) => id).sort()).toEqual(['f', 'g']);
  });
});
