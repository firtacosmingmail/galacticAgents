import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusRecord, wallClockLimit } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';

/**
 * P8-10 (SPEC decision 103): the per-agent wall-clock cap stops Stewards and free-form agents
 * only. A brain idle past it keeps running; its status shows its time with no limit.
 */

const CAP_MS = 150;
let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
    caps: { defaults: { maxWallClockMs: CAP_MS, maxToolCalls: 100 } },
  });
  t = await startTestApp({
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    commands: composed.commands,
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred: () => boolean, what: string, ms = 3_000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
};
const state = (id: string) => composed.statuses.get(id)?.state;
const failures = (id: string) =>
  composed.log
    .eventsSince(0)
    .map((e) => e.event)
    .filter((e) => e.type === 'agent.failed' && e.agentId === id);

async function spawn(role: 'harmonizer' | 'waykeeper' | 'steward', prompt: string) {
  const result = await composed.runtime.spawn({ role, runtime: 'fake', prompt, cwd: '/tmp' });
  if (!result.ok) throw new Error(result.reason);
  return result.agent.id;
}

describe('the wall-clock cap is for Stewards only (P8-10, decision 103)', () => {
  it('idle brains outlive the cap; a Steward and a free-form agent are stopped by it', async () => {
    const harmonizer = await spawn('harmonizer', 'scenario:echo');
    const waykeeper = await spawn('waykeeper', 'scenario:echo');
    const steward = await spawn('steward', 'scenario:long');
    // The ops console's free-form spawn, naming a brain role: it is still capped.
    const res = await fetch(`${t.baseUrl}/api/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'waykeeper',
        runtime: 'fake',
        prompt: 'scenario:echo',
        cwd: '/tmp',
      }),
    });
    expect(res.status).toBe(201);
    const freeForm = ((await res.json()) as { agentId: string }).agentId;
    expect(composed.log.tables.agents.get(freeForm)?.meta).toMatchObject({ freeForm: true });

    await waitFor(() => state(steward) === 'failed', 'the cap to stop the Steward');
    await waitFor(() => state(freeForm) === 'failed', 'the cap to stop the free-form agent');
    expect(failures(steward)).toMatchObject([{ reason: 'cap' }]);
    expect(failures(freeForm)).toMatchObject([{ reason: 'cap' }]);

    await sleep(CAP_MS * 2);
    expect(state(harmonizer)).toBe('idle');
    expect(state(waykeeper)).toBe('idle');
    expect(failures(harmonizer)).toEqual([]);
    expect(failures(waykeeper)).toEqual([]);
    expect(composed.runtime.caps.usage(harmonizer)?.wallClockMs.capped).toBe(false);

    // The status views: a brain's time is marked uncapped (its numeric limit stays, so the previous
    // build's parser still reads the record); a Steward's is capped.
    const brainClock = composed.statuses.get(harmonizer)?.caps.wallClockMs;
    expect(brainClock).toMatchObject({ limit: CAP_MS, capped: false });
    expect(wallClockLimit(brainClock!)).toBeUndefined();
    expect(StatusRecord.safeParse(composed.statuses.get(harmonizer)).success).toBe(true);
    for (const capped of [steward, freeForm]) {
      const clock = composed.statuses.get(capped)?.caps.wallClockMs;
      expect(clock?.capped).toBeUndefined();
      expect(wallClockLimit(clock!)).toBe(CAP_MS);
    }
  });
});
