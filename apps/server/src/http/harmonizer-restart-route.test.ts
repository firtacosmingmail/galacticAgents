import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RestartHarmonizerResponse } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { startHarmonizer } from '../brains/harmonizer/index.js';
import { harmonizerRestarter } from '../brains/harmonizer/restart.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

/** `POST /api/harmonizer/restart` (P5-06; SPEC decision 82). */

const OPTS = { cwd: '/tmp', deps: { projectsRoot: '/tmp' } };
let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
  });
  t = await startTestApp({
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    commands: composed.commands,
    restartHarmonizer: harmonizerRestarter(composed, OPTS),
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
});

const restart = async (token = TEST_TOKEN) => {
  const res = await fetch(`${t.baseUrl}/api/harmonizer/restart`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
};
const liveHq = () => composed.runtime.liveAgents().filter((a) => a.role === 'harmonizer');

describe('POST /api/harmonizer/restart (P5-06)', () => {
  it('needs the token', async () => {
    await startHarmonizer(composed, { runtime: 'fake', ...OPTS });
    const before = liveHq().map((a) => a.id);
    expect((await restart('wrong')).status).toBe(401);
    expect(liveHq().map((a) => a.id)).toEqual(before);
  });

  it('stops the running Harmonizer and answers with the new one', async () => {
    const first = await startHarmonizer(composed, { runtime: 'fake', ...OPTS });
    const res = await restart();
    expect(res.status).toBe(200);
    const body = RestartHarmonizerResponse.parse(res.body);
    expect(body.replaced).toBe(first.agentId);
    expect(liveHq().map((a) => a.id)).toEqual([body.agentId]);
    expect(composed.statuses.get(first.agentId)?.state).toBe('stopped');
  });

  it('refuses with 409 when it cannot start one (no Harmonizer, no runtime configured)', async () => {
    const res = await restart();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'refused', message: expect.stringMatching(/runtime/) });
    expect(liveHq()).toEqual([]);
  });

  it('is absent without a restarter', async () => {
    const other = await startTestApp({
      log: composed.log,
      runtime: composed.runtime,
      commands: composed.commands,
    });
    try {
      const res = await fetch(`${other.baseUrl}/api/harmonizer/restart`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await other.stop();
    }
  });
});
