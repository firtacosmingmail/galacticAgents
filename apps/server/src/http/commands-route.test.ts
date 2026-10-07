import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentCommandsResponse } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

/**
 * `GET /api/agents/:id/commands` (P8-13): the slash commands of an agent's live session, read
 * from its adapter through the runtime; `[]` without a live session; 404 for an unknown agent.
 */

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  const fake = new FakeAdapter({
    speed: 0,
    commands: (opts) =>
      opts.prompt.includes('quiet')
        ? undefined
        : [
            { name: 'review', description: 'Review a <b>pull</b> request', argumentHint: '<pr>' },
            { name: '/compact', builtin: true },
          ],
  });
  composed = composeRuntime(openDatabase(':memory:'), { adapters: [fake], flushMs: 10 });
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

const get = async (path: string, token = TEST_TOKEN) => {
  const res = await fetch(`${t.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as unknown };
};

async function spawn(prompt: string): Promise<string> {
  const result = await composed.runtime.spawn({
    runtime: 'fake',
    role: 'steward',
    cwd: '/tmp',
    prompt,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.agent.id;
}

describe('GET /api/agents/:id/commands (P8-13)', () => {
  it('lists the live session’s commands, normalised, and remembers them for hasCommand', async () => {
    const id = await spawn('scenario:echo');
    expect(composed.runtime.hasCommand(id, 'review')).toBe(false); // never read yet
    const res = await get(`/api/agents/${id}/commands`);
    expect(res.status).toBe(200);
    expect(AgentCommandsResponse.parse(res.body)).toEqual({
      commands: [
        // Agent-provided text comes back as it is: the page renders it as text.
        { name: 'review', description: 'Review a <b>pull</b> request', argumentHint: '<pr>' },
        { name: 'compact', builtin: true },
      ],
    });
    expect(composed.runtime.hasCommand(id, 'review')).toBe(true);
    expect(composed.runtime.hasCommand(id, 'nope')).toBe(false);
  });

  it('is empty for a runtime that reports none and for an agent that ended; 404 when unknown', async () => {
    const quiet = await spawn('scenario:echo quiet');
    expect((await get(`/api/agents/${quiet}/commands`)).body).toEqual({ commands: [] });

    const id = await spawn('scenario:echo');
    await composed.runtime.stop(id, { type: 'user' });
    expect((await get(`/api/agents/${id}/commands`)).body).toEqual({ commands: [] });

    expect((await get('/api/agents/a-unknown/commands')).status).toBe(404);
  });

  it('needs the token', async () => {
    const id = await spawn('scenario:echo');
    expect((await get(`/api/agents/${id}/commands`, 'wrong')).status).toBe(401);
  });
});
