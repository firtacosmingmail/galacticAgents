import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, type Actor, type Event, type Question } from '@galactic/protocol';
import { events as fixtures, domain as d } from '@galactic/protocol/fixtures';
import { WAKE_RULES, wakeLine, type WakeScope } from './wake.js';

/**
 * The wake table (P2-06): one data-driven whitelist. Everything not in it never enters a mailbox,
 * in particular transcript traffic and permission questions.
 */

const BRAIN = 'a-waykeeper-1';

function scope(over: Partial<WakeScope> = {}): WakeScope {
  const questions = new Map<string, Question>();
  return {
    brainId: BRAIN,
    role: 'waykeeper',
    projectId: 'p-1',
    // Supervises every agent, runs every task and project, owns every proposal: so the only
    // thing that keeps an event out is the table itself.
    supervises: (id) => id !== undefined && id !== BRAIN,
    runsTask: () => true,
    runsProject: () => true,
    ownsProposal: () => true,
    question: (id) => questions.get(id),
    ...over,
  };
}

describe('WAKE_RULES', () => {
  it('is exactly the whitelist of TECHNOLOGY §5.2', () => {
    expect(Object.keys(WAKE_RULES).sort()).toEqual(
      [
        'message.sent',
        'question.opened',
        'question.answered',
        'question.escalated',
        'question.reassigned',
        'proposal.approved',
        'proposal.edited',
        'proposal.rejected',
        'proposal.parked',
        'agent.finished',
        'agent.failed',
        'agent.stalled',
        'control.stop',
        'control.cancel',
        'control.pause',
        'control.resume',
        'control.edit',
        'control.close',
        'control.archive',
        'control.pin',
        'control.reopen',
      ].sort(),
    );
  });

  it('never wakes on transcript traffic or on events outside the table, however close they are', () => {
    const s = scope();
    for (const type of EVENT_TYPES) {
      if (WAKE_RULES[type]) continue;
      expect(wakeLine(fixtures[type] as Event, s), type).toBeUndefined();
    }
    expect(wakeLine(fixtures['agent.output'], s)).toBeUndefined();
    expect(wakeLine(fixtures['agent.tool_call'], s)).toBeUndefined();
  });

  it('wakes on a user message or a subordinate report to the brain, never on a system message', () => {
    const s = scope({ supervises: (id) => id === 'a-steward-1' });
    const sent = (sender: Actor, agentId = BRAIN): Event => ({
      type: 'message.sent',
      messageId: 'm-1',
      agentId,
      sender,
      text: 'how is it going?',
      interrupt: false,
    });
    expect(wakeLine(sent({ type: 'user' }), s)).toBe('the user said: "how is it going?"');
    expect(wakeLine(sent({ type: 'agent', id: 'a-steward-1' }), s)).toContain('reported');
    expect(wakeLine(sent({ type: 'agent', id: 'a-stranger' }), s)).toBeUndefined();
    expect(wakeLine(sent({ type: 'system' }), s)).toBeUndefined();
    expect(wakeLine(sent({ type: 'user' }, 'a-other-brain'), s)).toBeUndefined();
  });

  it('keeps permission questions out of every mailbox, clarifications in when they concern the brain', () => {
    const s = scope({ supervises: (id) => id === 'a-steward-1' });
    const opened = (q: Partial<Question>): Event => ({
      type: 'question.opened',
      question: { ...d.question, ...q },
    });
    expect(
      wakeLine(opened({ kind: 'clarification', originAgentId: 'a-steward-1' }), s),
    ).toBeDefined();
    expect(
      wakeLine(opened({ kind: 'permission', originAgentId: 'a-steward-1' }), s),
    ).toBeUndefined();
    expect(
      wakeLine(
        opened({
          kind: 'clarification',
          originAgentId: 'a-x',
          holder: { type: 'agent', id: BRAIN },
        }),
        s,
      ),
    ).toBeDefined();
    expect(
      wakeLine(
        opened({ kind: 'clarification', originAgentId: 'a-x', holder: { type: 'user' } }),
        s,
      ),
    ).toBeUndefined();
  });

  it('wakes on finished, failed and stalled only for supervised agents', () => {
    const s = scope({ supervises: (id) => id === 'a-steward-1' });
    expect(wakeLine(fixtures['agent.finished'], s)).toMatch(/^agent a-steward-1 finished/);
    expect(wakeLine({ ...fixtures['agent.finished'], agentId: 'a-other' }, s)).toBeUndefined();
  });

  it('wakes on control actions on the brain, its agents, its tasks and its projects', () => {
    const s = scope({
      supervises: () => false,
      runsTask: (id) => id === 't-1',
      runsProject: () => false,
    });
    expect(wakeLine(fixtures['control.pause'], s)).toBe('user paused task t-1');
    expect(
      wakeLine({ ...fixtures['control.pause'], target: { kind: 'task', id: 't-2' } }, s),
    ).toBeUndefined();
    expect(wakeLine({ ...fixtures['control.stop'], target: { kind: 'agent', id: BRAIN } }, s)).toBe(
      'user stopped you',
    );
  });
});
