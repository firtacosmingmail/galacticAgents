import { describe, expect, it } from 'vitest';
import type { EventEnvelope, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { foldReplayStatus } from './replay-model.js';

/** P13-06: the replay shows the Waykeeper's approval as the Steward's activity, as live does. */

const record: StatusRecord = {
  agentId: fx.agent.id,
  state: 'working',
  startedAt: fx.NOW,
  lastEventAt: fx.NOW,
  caps: { wallClockMs: { used: 0, limit: 1 }, toolCalls: { used: 0, limit: 1 } },
};
const waykeeper = { ...fx.harmonizer, id: 'a-wk', role: 'waykeeper' as const, projectId: 'p-1' };
const names = { agents: { [waykeeper.id]: waykeeper }, projects: { 'p-1': fx.project } };
const decided = (extra: object = {}): EventEnvelope => ({
  seq: 9,
  at: '2026-11-09T10:00:00.000Z',
  event: {
    type: 'permission.decided',
    agentId: fx.agent.id,
    toolCall: { toolName: 'Bash', input: { command: 'pnpm test' } },
    decision: 'allow',
    reason: 'it runs the task’s own tests',
    decidedBy: { type: 'agent', id: 'a-wk' },
    ...extra,
  } as EventEnvelope['event'],
});

describe('replayed approval activity (P13-06)', () => {
  it('says who approved and why, with the quote when there is one', () => {
    const one = foldReplayStatus({ [fx.agent.id]: record }, decided(), new Map(), names);
    expect(one[fx.agent.id]).toMatchObject({
      state: 'working',
      currentActivity: `Approved by Waykeeper · ${fx.project.name}: it runs the task’s own tests`,
    });
    const two = foldReplayStatus(
      { [fx.agent.id]: record },
      decided({ quote: 'run the tests' }),
      new Map(),
      names,
    );
    expect(two[fx.agent.id]?.currentActivity).toMatch(/ — you asked: "run the tests"$/);
  });

  it('ignores the system’s decisions', () => {
    const statuses = { [fx.agent.id]: record };
    expect(
      foldReplayStatus(statuses, decided({ decidedBy: { type: 'system' } }), new Map(), names),
    ).toBe(statuses);
  });
});
