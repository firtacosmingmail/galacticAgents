import { describe, expect, it } from 'vitest';
import type { Agent, StatusRecord } from '@galactic/protocol';
import type { BrainToolContext } from './definition.js';
import type { StewardProcessControl } from '../runtime/steward-processes.js';
import {
  listStewardProcessesTool,
  MAX_TELLS_PER_HOUR,
  noteTell,
  stopStewardProcessesTool,
  tellStewardTool,
} from './steward-tools.js';

/**
 * `tell_steward` bounds a report → tell → report loop (P2-11 / P2-17 review): at most
 * `MAX_TELLS_PER_HOUR` messages to one Steward in any sliding hour.
 */

function ctx(sent: string[]): BrainToolContext {
  const agent = { id: 'a-st-loop', role: 'steward', supervisorId: 'a-wk' } as Agent;
  const status = { agentId: agent.id, state: 'idle' } as StatusRecord;
  return {
    brainId: 'a-wk',
    role: 'waykeeper',
    actor: { type: 'agent', id: 'a-wk' },
    queries: { agent: () => agent, status: () => status },
    send: (_id: string, text: string) => {
      sent.push(text);
      return { messageId: `m-${sent.length}` };
    },
  } as unknown as BrainToolContext;
}

describe('tell_steward (P2-11)', () => {
  it('refuses more than MAX_TELLS_PER_HOUR messages to one Steward in an hour', async () => {
    const sent: string[] = [];
    const c = ctx(sent);
    for (let i = 0; i < MAX_TELLS_PER_HOUR; i++) {
      await tellStewardTool.handler({ agentId: 'a-st-loop', text: `go on ${i}` }, c);
    }
    await expect(
      tellStewardTool.handler({ agentId: 'a-st-loop', text: 'once more' }, c),
    ).rejects.toMatchObject({ code: 'conflict', message: /told 20 times in the last hour/ });
    expect(sent).toHaveLength(MAX_TELLS_PER_HOUR);
  });

  it('counts a sliding hour, per Steward', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_TELLS_PER_HOUR; i++) noteTell('a-st-window', t0 + i);
    expect(() => noteTell('a-st-window', t0 + 100)).toThrow(/limit 20/);
    expect(() => noteTell('a-st-other', t0 + 100)).not.toThrow();
    expect(() => noteTell('a-st-window', t0 + 60 * 60 * 1000 + 1)).not.toThrow();
  });
});

describe('list_steward_processes / stop_steward_processes (P4-14)', () => {
  const agents: Record<string, Agent> = {
    'a-st-mine': { id: 'a-st-mine', role: 'steward', supervisorId: 'a-wk', taskId: 't-1' } as Agent,
    'a-st-quiet': { id: 'a-st-quiet', role: 'steward', supervisorId: 'a-wk' } as Agent,
    'a-st-theirs': { id: 'a-st-theirs', role: 'steward', supervisorId: 'a-wk-2' } as Agent,
    'a-wk-sub': { id: 'a-wk-sub', role: 'waykeeper', supervisorId: 'a-wk' } as Agent,
  };
  const proc = (pid: number) => ({
    pid,
    ppid: 1,
    command: 'node server.js',
    ports: [5173],
    startedAt: '2026-10-04T10:00:00.000Z',
    why: 'worktree' as const,
  });

  function processCtx(withProcesses = true) {
    const calls: { op: string; agentId: string; pids?: number[]; by?: unknown }[] = [];
    const processes: StewardProcessControl = {
      list: (agentId) => {
        calls.push({ op: 'list', agentId });
        return Promise.resolve({
          agentId,
          supported: true,
          processes: agentId === 'a-st-mine' ? [proc(4242)] : [],
        });
      },
      stop: (agentId, opts) => {
        calls.push({ op: 'stop', agentId, ...opts });
        return Promise.resolve({ agentId, stopped: opts.pids ?? [4242], forced: [], alive: [] });
      },
    };
    const ctx = {
      brainId: 'a-wk',
      role: 'waykeeper',
      actor: { type: 'agent', id: 'a-wk' },
      queries: {
        agent: (id: string) => agents[id],
        status: (id: string) => ({ agentId: id, state: 'idle' }) as StatusRecord,
        supervisedAgents: (brainId: string) =>
          Object.values(agents)
            .filter((a) => a.supervisorId === brainId)
            .map((agent) => ({ agent, status: { agentId: agent.id, state: 'idle' } })),
      },
      send: () => ({ messageId: 'm' }),
      ...(withProcesses ? { processes } : {}),
    } as unknown as BrainToolContext;
    return { ctx, calls };
  }

  it("refuses another Waykeeper's Steward, an agent that is not a Steward, and an unknown one", async () => {
    const { ctx, calls } = processCtx();
    for (const tool of [listStewardProcessesTool, stopStewardProcessesTool]) {
      await expect(tool.handler({ agentId: 'a-st-theirs' }, ctx)).rejects.toMatchObject({
        code: 'invalid',
        message: /not one of your Stewards/,
      });
      await expect(tool.handler({ agentId: 'a-wk-sub' }, ctx)).rejects.toMatchObject({
        code: 'invalid',
      });
      await expect(tool.handler({ agentId: 'a-nobody' }, ctx)).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    expect(calls).toEqual([]);
  });

  it('refuses when the server cannot inspect processes', async () => {
    const { ctx } = processCtx(false);
    await expect(
      listStewardProcessesTool.handler({ agentId: 'a-st-mine' }, ctx),
    ).rejects.toMatchObject({ code: 'invalid', message: /cannot inspect processes/ });
  });

  it("lists one Steward, or every Steward of the caller's that has processes", async () => {
    const { ctx } = processCtx();
    expect(await listStewardProcessesTool.handler({ agentId: 'a-st-mine' }, ctx)).toMatchObject({
      agentId: 'a-st-mine',
      taskId: 't-1',
      state: 'idle',
      processes: [{ pid: 4242, ports: [5173] }],
    });
    expect(await listStewardProcessesTool.handler({}, ctx)).toEqual({
      supported: true,
      total: 1,
      stewards: [expect.objectContaining({ agentId: 'a-st-mine', processes: [proc(4242)] })],
    });
  });

  it('stops as the calling brain, the given pids or all of them; refuses malformed pids', async () => {
    const { ctx, calls } = processCtx();
    await stopStewardProcessesTool.handler({ agentId: 'a-st-mine', pids: [4242] }, ctx);
    await stopStewardProcessesTool.handler({ agentId: 'a-st-mine' }, ctx);
    expect(calls).toEqual([
      { op: 'stop', agentId: 'a-st-mine', pids: [4242], by: { type: 'agent', id: 'a-wk' } },
      { op: 'stop', agentId: 'a-st-mine', by: { type: 'agent', id: 'a-wk' } },
    ]);
    for (const pids of [[], [1], ['42'], 42]) {
      await expect(
        stopStewardProcessesTool.handler({ agentId: 'a-st-mine', pids }, ctx),
      ).rejects.toMatchObject({ code: 'invalid' });
    }
  });
});
