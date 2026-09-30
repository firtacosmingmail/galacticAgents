import { describe, expect, it } from 'vitest';
import type { AgentAdapter, SpawnHandle, SpawnOptions } from './adapter.js';
import type { CommandResult, DomainCommands } from './commands.js';
import type { AgentEvent } from './events.js';

/** A no-op adapter: the acceptance criterion of P0-04 is that this type-checks. */
class NoopAdapter implements AgentAdapter {
  readonly runtime = 'fake' as const;
  private queue: AgentEvent[] = [];

  async spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    this.queue.push({
      type: 'agent.spawned',
      agentId: opts.agentId,
      role: opts.role,
      runtime: this.runtime,
      bodyId: 'b-0',
    });
    return { sessionId: `s-${opts.agentId}` };
  }
  async send(): Promise<void> {}
  async answer(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async stop(): Promise<void> {}
  async dispose(): Promise<void> {}

  get events(): AsyncIterable<AgentEvent> {
    const queue = this.queue;
    return {
      async *[Symbol.asyncIterator]() {
        while (queue.length) yield queue.shift()!;
      },
    };
  }
}

const noop = <T>(value: T): Promise<CommandResult<T>> => Promise.resolve({ value, events: [] });
const notImplemented = (): Promise<never> => Promise.reject(new Error('not implemented (Phase 2)'));

/** A no-op command surface; every method exists and type-checks. */
const commands: DomainCommands = {
  createProject: notImplemented,
  updateProject: notImplemented,
  setProjectState: notImplemented,
  closeProject: notImplemented,
  createTask: notImplemented,
  updateTask: notImplemented,
  setTaskState: notImplemented,
  closeTask: notImplemented,
  assignBody: notImplemented,
  moveHost: notImplemented,
  freeBody: notImplemented,
  spawnAgent: notImplemented,
  stopAgent: notImplemented,
  pauseAgent: notImplemented,
  resumeAgent: notImplemented,
  recordAgentEvent: () => noop(undefined),
  createProposal: notImplemented,
  decideProposal: notImplemented,
  openQuestion: notImplemented,
  answerQuestion: notImplemented,
  escalateQuestion: notImplemented,
  reassignQuestion: notImplemented,
  control: () => noop(undefined),
};

describe('interfaces', () => {
  it('a no-op AgentAdapter emits normalised events', async () => {
    const adapter = new NoopAdapter();
    const handle = await adapter.spawn({
      agentId: 'a-1',
      role: 'steward',
      cwd: '/tmp',
      prompt: 'hi',
      permissionPolicy: { rules: {} },
      caps: { maxWallClockMs: 1000, maxToolCalls: 10 },
    });
    expect(handle.sessionId).toBe('s-a-1');
    const seen: AgentEvent[] = [];
    for await (const e of adapter.events) seen.push(e);
    expect(seen.map((e) => e.type)).toEqual(['agent.spawned']);
  });

  it('a no-op DomainCommands type-checks and reports unimplemented commands', async () => {
    await expect(commands.createProject({ name: 'x', workspace: '/w' })).rejects.toThrow(/Phase 2/);
    await expect(
      commands.recordAgentEvent({ type: 'agent.idle', agentId: 'a-1' }),
    ).resolves.toEqual({
      value: undefined,
      events: [],
    });
  });
});
