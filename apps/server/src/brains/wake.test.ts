import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, type Actor, type Event, type Question } from '@galactic/protocol';
import { events as fixtures, domain as d } from '@galactic/protocol/fixtures';
import { world } from '../test/world.js';
import { createAgent } from '../domain/agents.js';
import { createProject } from '../domain/projects.js';
import { createTask } from '../domain/tasks.js';
import { createWakeScope } from './seed.js';
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
        'question.cancelled',
        'question.escalated',
        'question.reassigned',
        'task.created',
        'proposal.approved',
        'proposal.edited',
        'proposal.rejected',
        'proposal.parked',
        'proposal.unparked',
        'promotion.carried_out',
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

  it('wakes the owner of a carried-out promotion and the Waykeeper of the work’s project (P2-12)', () => {
    const e = fixtures['promotion.carried_out'] as Event;
    const owner = scope({ role: 'harmonizer', ownsProposal: () => true });
    expect(wakeLine(e, owner)).toBe(
      'promotion pr-1 was carried out: task t-2 moved from b-ast-1 to b-luna (project p-1, ' +
        'Waykeeper a-waykeeper-1); its Stewards (a-steward-1) were handed over and resumed',
    );
    // The project's Waykeeper (p-1) learns it took the work over; another project's does not.
    expect(wakeLine(e, scope({ ownsProposal: () => false }))).toContain('was carried out');
    expect(wakeLine(e, scope({ ownsProposal: () => false, projectId: 'p-2' }))).toBeUndefined();
    const failed: Event = {
      type: 'promotion.carried_out',
      proposalId: 'pr-1',
      outcome: { ok: false, target: { kind: 'task', id: 't-2' }, error: 'no free moon' },
    };
    expect(wakeLine(failed, owner)).toBe(
      'promotion pr-1 of task t-2 could not be carried out: no free moon',
    );
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

describe('control wake-ups through concernedSupervisors (P2-14 seam)', () => {
  it('wakes a sub-project’s parent Waykeeper and the Harmonizer of a standalone task', () => {
    const { run, tables } = world();
    const caps = { maxWallClockMs: 1000, maxToolCalls: 10 };
    const parent = run((ctx) => createProject(ctx, { name: 'Planet', workspace: '/w' })).value;
    const sub = run((ctx) =>
      createProject(ctx, {
        name: 'Moon',
        workspace: '/w/m',
        kind: 'moon',
        parentProjectId: parent.id,
      }),
    ).value;
    const solo = run((ctx) => createTask(ctx, { description: 'solo' })).value;
    const harmonizer = run((ctx) =>
      createAgent(ctx, { role: 'harmonizer', runtime: 'fake', caps }),
    ).value;
    const parentWk = run((ctx) =>
      createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        caps,
        projectId: parent.id,
        supervisorId: harmonizer.id,
      }),
    ).value;
    const user = { type: 'user' } as const;
    const pauseSub = {
      type: 'control.pause',
      target: { kind: 'project', id: sub.id },
      by: user,
    } as const;
    const pauseSolo = {
      type: 'control.pause',
      target: { kind: 'task', id: solo.id },
      by: user,
    } as const;
    const wkScope = createWakeScope(tables, {
      brainId: parentWk.id,
      role: 'waykeeper',
      projectId: parent.id,
    });
    const hScope = createWakeScope(tables, { brainId: harmonizer.id, role: 'harmonizer' });
    expect(wakeLine(pauseSub, wkScope)).toBeDefined();
    expect(wakeLine(pauseSolo, hScope)).toBeDefined();
    expect(wakeLine(pauseSolo, wkScope)).toBeUndefined();
  });
});

describe('question resolutions reach every past holder (wave-2 review)', () => {
  it('wakes an earlier holder on answer and on cancel, never for a permission question', () => {
    const s = scope({ supervises: () => false });
    const clarification = {
      ...d.question,
      kind: 'clarification' as const,
      holder: { type: 'user' as const },
    };
    const withQ = { ...s, question: () => clarification };
    const answered: Extract<Event, { type: 'question.answered' }> = {
      type: 'question.answered',
      questionId: clarification.id,
      answer: 'yes',
      answeredBy: { type: 'user' },
      version: 3,
      holders: [BRAIN],
    };
    const cancelled: Event = {
      type: 'question.cancelled',
      questionId: clarification.id,
      agentId: 'a-steward-1',
      reason: 'agent stopped',
      version: 3,
      holders: [BRAIN],
    };
    expect(wakeLine(answered, withQ)).toBeDefined();
    expect(wakeLine(cancelled, withQ)).toContain('withdrawn');
    expect(wakeLine({ ...answered, holders: [] }, withQ)).toBeUndefined();
    const permission = {
      ...withQ,
      question: () => ({ ...clarification, kind: 'permission' as const }),
    };
    expect(wakeLine(answered, permission)).toBeUndefined();
  });
});

describe('the asker hears its own question resolve (wave 3)', () => {
  it('wakes the brain that asked through a tool, on answer and on cancel', () => {
    const own = {
      ...d.question,
      kind: 'clarification' as const,
      originAgentId: BRAIN,
      holder: { type: 'user' as const },
      meta: { source: 'command' },
    };
    const s = { ...scope({ supervises: () => false }), question: () => own };
    const answered: Event = {
      type: 'question.answered',
      questionId: own.id,
      answer: 'ISO 8601',
      answeredBy: { type: 'user' },
      version: 1,
    };
    const cancelled: Event = {
      type: 'question.cancelled',
      questionId: own.id,
      agentId: BRAIN,
      reason: 'withdrawn',
      version: 1,
    };
    expect(wakeLine(answered, s)).toBeDefined();
    expect(wakeLine(cancelled, s)).toBeDefined();
  });
});

describe('a brain’s own blocked questions stay with its adapter (wave-3 review)', () => {
  it('never wakes the asker for its own permission question, nor for one its session raised', () => {
    const base = { ...d.question, originAgentId: BRAIN, holder: { type: 'user' as const } };
    const answered: Event = {
      type: 'question.answered',
      questionId: base.id,
      answer: 'allow',
      answeredBy: { type: 'user' },
      version: 1,
    };
    const permission = { ...base, kind: 'permission' as const, meta: { source: 'command' } };
    const raised = { ...base, kind: 'clarification' as const };
    for (const q of [permission, raised]) {
      const s = { ...scope({ supervises: () => false }), question: () => q };
      expect(wakeLine(answered, s)).toBeUndefined();
    }
  });
});
