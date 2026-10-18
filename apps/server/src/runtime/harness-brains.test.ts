import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@galactic/protocol';
import type { Commands } from '../domain/commands.js';
import type { EventLog } from '../domain/event-log.js';
import { harnessBrains, type HarnessBrainsOptions } from './harness-brains.js';

/**
 * The scene harness's real brains (P8-21): a Waykeeper brain on the fake runtime under the running
 * Harmonizer, and tool calls only for running fake-runtime brains.
 */

const agent = (id: string, role: Agent['role'], runtime: Agent['runtime']) =>
  ({ id, role, runtime }) as Agent;

function setup(overrides: Partial<HarnessBrainsOptions> = {}) {
  const agents = new Map<string, Agent>([
    ['a-hq', agent('a-hq', 'harmonizer', 'fake')],
    ['a-wk', agent('a-wk', 'waykeeper', 'fake')],
    ['a-real', agent('a-real', 'waykeeper', 'claude-sdk')],
  ]);
  const log = {
    tables: { agents: { get: (id: string) => agents.get(id) } },
    currentSeq: () => 42,
  } as unknown as EventLog;
  const createProject = vi.fn(async (input: { name: string; workspace: string }) => ({
    value: { id: 'p-1', ...input },
  }));
  const commands = { createProject } as unknown as Commands;
  const prepareProject = vi.fn(async () => ({}));
  const startWaykeeper = vi.fn(async () => ({ agentId: 'a-wk' }));
  const callTool = vi.fn(async (name: string, input: unknown) => ({ name, input }));
  const opts: HarnessBrainsOptions = {
    log,
    commands,
    workspaces: { projectsRoot: '/projects', prepareProject },
    liveAgents: () => [agents.get('a-hq')!],
    startWaykeeper,
    runnerOf: (id) => (id === 'a-wk' || id === 'a-real' ? { callTool } : undefined),
    ...overrides,
  };
  return { brains: harnessBrains(opts), createProject, prepareProject, startWaykeeper, callTool };
}

describe('harness brains (P8-21)', () => {
  it('starts a Waykeeper brain on the fake runtime for a new, prepared project under the Harmonizer', async () => {
    const { brains, createProject, prepareProject, startWaykeeper } = setup();
    const out = await brains.startWaykeeper({ name: 'Sets' });
    expect(out).toEqual({ seq: 42, projectId: 'p-1', waykeeperId: 'a-wk', harmonizerId: 'a-hq' });
    expect(createProject.mock.calls[0]![0]).toMatchObject({ name: 'Sets', kind: 'planet' });
    expect(createProject.mock.calls[0]![0].workspace).toMatch(/^\/projects\/harness-brain-/);
    expect(prepareProject).toHaveBeenCalledWith('p-1');
    expect(startWaykeeper).toHaveBeenCalledWith({
      projectId: 'p-1',
      supervisorId: 'a-hq',
      runtime: 'fake',
    });
  });

  it('refuses without a running Harmonizer', async () => {
    const { brains, createProject } = setup({ liveAgents: () => [] });
    await expect(brains.startWaykeeper({})).rejects.toMatchObject({ code: 'conflict' });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('calls a running fake-runtime brain’s tool and returns what the model would read', async () => {
    const { brains, callTool } = setup();
    expect(await brains.callTool('a-wk', 'ask_questions', { title: 't' })).toEqual({
      name: 'ask_questions',
      input: { title: 't' },
    });
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('never drives a brain on a real runtime, a stopped brain or an unknown agent', async () => {
    const { brains, callTool } = setup({ runnerOf: () => undefined });
    await expect(brains.callTool('a-real', 'stop_agent', {})).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(brains.callTool('a-wk', 'stop_agent', {})).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(brains.callTool('a-nobody', 'stop_agent', {})).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(callTool).not.toHaveBeenCalled();
  });
});
