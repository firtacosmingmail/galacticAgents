import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

/** P11-09 (ruling R24): the route is behind the bearer guard and answers 404 for no such file. */

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
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
});

describe('GET /api/questions/:id/publish-files/:index', () => {
  it('needs the token', async () => {
    const res = await fetch(`${t.baseUrl}/api/questions/q-x/publish-files/0`);
    expect(res.status).toBe(401);
  });

  it('is 404 for a question that does not exist', async () => {
    const res = await fetch(`${t.baseUrl}/api/questions/q-x/publish-files/0`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
