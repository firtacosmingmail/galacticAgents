import { describe, expect, it } from 'vitest';
import type { Agent, StatusRecord } from '@galactic/protocol';
import type { BrainToolContext } from './definition.js';
import type { StewardProcessControl } from '../runtime/steward-processes.js';
import {
  listStewardProcessesTool,
  maySupervise,
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
  const T = '2026-10-04T10:00:00.000Z';
  const later = '2026-10-04T11:00:00.000Z';
  const agents: Record<string, Agent> = {
    'a-wk': { id: 'a-wk', role: 'waykeeper', projectId: 'p-1', createdAt: later } as Agent,
    'a-wk-old': { id: 'a-wk-old', role: 'waykeeper', projectId: 'p-1', createdAt: T } as Agent,
    'a-wk-2': { id: 'a-wk-2', role: 'waykeeper', projectId: 'p-2', createdAt: T } as Agent,
    'a-hq': { id: 'a-hq', role: 'harmonizer', createdAt: T } as Agent,
    'a-st-mine': { id: 'a-st-mine', role: 'steward', supervisorId: 'a-wk', taskId: 't-1' } as Agent,
    'a-st-quiet': { id: 'a-st-quiet', role: 'steward', supervisorId: 'a-wk' } as Agent,
    'a-st-theirs': {
      id: 'a-st-theirs',
      role: 'steward',
      supervisorId: 'a-wk-2',
      taskId: 't-other',
    } as Agent,
    // The ended Waykeeper's Steward, of the same project: the replacement takes it over.
    'a-st-inherited': {
      id: 'a-st-inherited',
      role: 'steward',
      supervisorId: 'a-wk-old',
      taskId: 't-2',
    } as Agent,
    // An asteroid's Steward recorded under an earlier Harmonizer.
    'a-st-asteroid': {
      id: 'a-st-asteroid',
      role: 'steward',
      supervisorId: 'a-hq-old',
      taskId: 't-3',
    } as Agent,
    'a-st-long-gone': {
      id: 'a-st-long-gone',
      role: 'steward',
      supervisorId: 'a-wk',
      taskId: 't-1',
    } as Agent,
    'a-wk-sub': { id: 'a-wk-sub', role: 'waykeeper', supervisorId: 'a-wk' } as Agent,
  };
  const tasks: Record<string, { id: string; projectId?: string }> = {
    't-1': { id: 't-1', projectId: 'p-1' },
    't-2': { id: 't-2', projectId: 'p-1' },
    't-3': { id: 't-3' },
    't-other': { id: 't-other', projectId: 'p-2' },
  };
  const ended = new Set(['a-wk-old', 'a-st-long-gone']);
  const proc = (pid: number) => ({
    pid,
    ppid: 1,
    command: 'node server.js',
    ports: [5173],
    startedAt: '2026-10-04T10:00:00.000Z',
    why: 'worktree' as const,
  });
  const withProcs = new Set(['a-st-mine', 'a-st-inherited', 'a-st-long-gone']);

  function processCtx(
    opts: { withProcesses?: boolean; caller?: string; live?: (id: string) => boolean } = {},
  ) {
    const caller = opts.caller ?? 'a-wk';
    const live = opts.live ?? ((id: string) => !ended.has(id));
    const calls: { op: string; agentId?: string; agentIds?: string[]; pids?: number[] }[] = [];
    const response = (agentId: string) => ({
      agentId,
      supported: true,
      processes: withProcs.has(agentId) ? [proc(4242)] : [],
    });
    const processes: StewardProcessControl = {
      list: (agentId) => {
        calls.push({ op: 'list', agentId });
        return Promise.resolve(response(agentId));
      },
      listMany: (agentIds) => {
        calls.push({ op: 'listMany', agentIds: [...agentIds] });
        return Promise.resolve(agentIds.map(response));
      },
      stop: (agentId, o) => {
        calls.push({ op: 'stop', agentId, ...o });
        return Promise.resolve({ agentId, stopped: o.pids ?? [4242], forced: [], alive: [] });
      },
    };
    const status = (id: string): StatusRecord | undefined =>
      agents[id]
        ? ({
            agentId: id,
            state: live(id) ? 'idle' : 'finished',
            // Ended two days ago: not "recently ended".
            lastEventAt:
              id === 'a-st-long-gone' ? '2020-01-01T00:00:00.000Z' : new Date().toISOString(),
          } as StatusRecord)
        : undefined;
    const ctx = {
      brainId: caller,
      role: agents[caller]!.role,
      actor: { type: 'agent', id: caller },
      queries: {
        agent: (id: string) => agents[id],
        agents: () => Object.values(agents),
        task: (id: string) => tasks[id],
        status,
        supervisedAgents: (brainId: string) =>
          Object.values(agents)
            .filter((a) => a.supervisorId === brainId)
            .map((agent) => ({ agent, status: status(agent.id) })),
      },
      send: () => ({ messageId: 'm' }),
      ...(opts.withProcesses === false ? {} : { processes }),
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
    const { ctx } = processCtx({ withProcesses: false });
    await expect(
      listStewardProcessesTool.handler({ agentId: 'a-st-mine' }, ctx),
    ).rejects.toMatchObject({ code: 'invalid', message: /cannot inspect processes/ });
  });

  it('lists one Steward, or — from one snapshot — every live or recently ended one that has processes', async () => {
    const { ctx, calls } = processCtx();
    expect(await listStewardProcessesTool.handler({ agentId: 'a-st-mine' }, ctx)).toMatchObject({
      agentId: 'a-st-mine',
      taskId: 't-1',
      state: 'idle',
      processes: [{ pid: 4242, ports: [5173] }],
    });
    calls.length = 0;
    expect(await listStewardProcessesTool.handler({}, ctx)).toEqual({
      supported: true,
      total: 2,
      stewards: [
        expect.objectContaining({ agentId: 'a-st-mine', processes: [proc(4242)] }),
        expect.objectContaining({ agentId: 'a-st-inherited', processes: [proc(4242)] }),
      ],
    });
    // One call for all of them; the Steward that ended long ago is not asked about.
    expect(calls).toEqual([
      { op: 'listMany', agentIds: ['a-st-mine', 'a-st-quiet', 'a-st-inherited'] },
    ]);
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

  it("a replacement Waykeeper (the project's newest live one) takes its predecessor's Stewards over", async () => {
    const { ctx, calls } = processCtx();
    await stopStewardProcessesTool.handler({ agentId: 'a-st-inherited', pids: [4242] }, ctx);
    expect(calls).toEqual([
      { op: 'stop', agentId: 'a-st-inherited', pids: [4242], by: { type: 'agent', id: 'a-wk' } },
    ]);
    expect(maySupervise(ctx, agents['a-st-inherited']!)).toBe(true);

    // Not the newest live Waykeeper of the project (the old one still runs and the caller is it).
    const old = processCtx({ caller: 'a-wk-old', live: () => true });
    expect(maySupervise(old.ctx, agents['a-st-mine']!)).toBe(false);
    expect(maySupervise(old.ctx, agents['a-st-inherited']!)).toBe(true); // recorded supervisor
    // Another project's Waykeeper, and a Waykeeper that is not running, never.
    expect(maySupervise(processCtx({ caller: 'a-wk-2' }).ctx, agents['a-st-inherited']!)).toBe(
      false,
    );
    const stopped = processCtx({ live: (id) => id !== 'a-wk' && !ended.has(id) });
    expect(maySupervise(stopped.ctx, agents['a-st-inherited']!)).toBe(false);
    // The live Harmonizer for a standalone task's Steward; never for a project's.
    const hq = processCtx({ caller: 'a-hq' });
    expect(maySupervise(hq.ctx, agents['a-st-asteroid']!)).toBe(true);
    expect(maySupervise(hq.ctx, agents['a-st-inherited']!)).toBe(false);
  });
});
