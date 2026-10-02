import { describe, expect, it } from 'vitest';
import type { Agent, StatusRecord } from '@galactic/protocol';
import type { BrainToolContext } from './definition.js';
import { MAX_TELLS_PER_HOUR, noteTell, tellStewardTool } from './steward-tools.js';

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
