import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StewardProcessesResponse, StopProcessesResponse, type Actor } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import type { StewardProcessControl } from '../runtime/steward-processes.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

/**
 * `GET /api/agents/:id/processes` and `POST /api/agents/:id/processes/stop` (P4-14): bearer-guarded,
 * the service's refusals mapped like the other domain routes, the stop made as the user. The
 * service itself (attribution, real processes) is tested in `runtime/steward-processes.test.ts`.
 */

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;
const stops: { agentId: string; pids?: number[]; by: Actor }[] = [];

const processes: StewardProcessControl = {
  list: (agentId) => {
    if (agentId === 'a-nobody') throw new DomainError('not_found', 'no agent a-nobody');
    if (agentId === 'a-brain') throw new DomainError('invalid', 'a-brain is not a Steward');
    return Promise.resolve({
      agentId,
      supported: true,
      processes: [
        {
          pid: 4242,
          ppid: 1,
          command: 'node server.js',
          cwd: '/w/.galactic/worktrees/t-1',
          ports: [5173],
          startedAt: '2026-10-04T10:00:00.000Z',
          why: 'worktree',
        },
      ],
    });
  },
  listMany: (agentIds) => Promise.all(agentIds.map((id) => processes.list(id))),
  stop: (agentId, opts) => {
    if (opts.pids?.includes(1234)) {
      return Promise.reject(new DomainError('invalid', 'not processes of Steward a-st: 1234'));
    }
    stops.push({ agentId, ...opts });
    return Promise.resolve({ agentId, stopped: opts.pids ?? [4242], forced: [], alive: [] });
  },
};

beforeEach(async () => {
  stops.length = 0;
  composed = composeRuntime(openDatabase(':memory:'));
  t = await startTestApp({
    log: composed.log,
    statuses: composed.statuses,
    runtime: composed.runtime,
    commands: composed.commands,
    processes,
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
});

const request = async (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  token = TEST_TOKEN,
) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('a Steward’s processes over REST (P4-14)', () => {
  it('needs the token', async () => {
    expect((await request('GET', '/api/agents/a-st/processes', undefined, 'wrong')).status).toBe(
      401,
    );
    expect((await request('POST', '/api/agents/a-st/processes/stop', {}, 'wrong')).status).toBe(
      401,
    );
    expect(stops).toEqual([]);
  });

  it('lists, and maps refusals: 404 unknown, 400 not a Steward', async () => {
    const ok = await request('GET', '/api/agents/a-st/processes');
    expect(ok.status).toBe(200);
    expect(StewardProcessesResponse.parse(ok.body).processes[0]).toMatchObject({
      pid: 4242,
      ports: [5173],
    });
    expect((await request('GET', '/api/agents/a-nobody/processes')).status).toBe(404);
    expect((await request('GET', '/api/agents/a-brain/processes')).status).toBe(400);
  });

  it('stops as the user: the given pids or all; a foreign pid or a bad body is a 400', async () => {
    const some = await request('POST', '/api/agents/a-st/processes/stop', { pids: [4242] });
    expect(some.status).toBe(200);
    expect(StopProcessesResponse.parse(some.body)).toEqual({
      agentId: 'a-st',
      stopped: [4242],
      forced: [],
      alive: [],
    });
    expect((await request('POST', '/api/agents/a-st/processes/stop', {})).status).toBe(200);
    expect(stops).toEqual([
      { agentId: 'a-st', pids: [4242], by: { type: 'user' } },
      { agentId: 'a-st', by: { type: 'user' } },
    ]);
    const foreign = await request('POST', '/api/agents/a-st/processes/stop', { pids: [1234] });
    expect(foreign).toMatchObject({ status: 400, body: { error: 'invalid' } });
    expect((await request('POST', '/api/agents/a-st/processes/stop', { pids: [] })).status).toBe(
      400,
    );
    expect((await request('POST', '/api/agents/a-st/processes/stop', { pids: ['x'] })).status).toBe(
      400,
    );
    expect(stops).toHaveLength(2);
  });
});
