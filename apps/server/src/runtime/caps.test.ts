import { afterEach, describe, expect, it } from 'vitest';
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
      reason: 'concurrency cap: 2 of 2 agents already running',
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
