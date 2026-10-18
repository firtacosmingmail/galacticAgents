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
        'budget.set',
        'budget.warning',
        'budget.exceeded',
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

  it('wakes the brain that runs budgeted work on its budget notices (P8-01)', () => {
    const exceeded: Event = {
      type: 'budget.exceeded',
      target: { kind: 'project', id: 'p-1' },
      spentUsd: 5.5,
      budgetUsd: 5,
    };
    const line = wakeLine(exceeded, scope());
    expect(line).toMatch(/^budget exceeded: project p-1 has spent \$5\.50 of its \$5\.00 budget/);
    expect(wakeLine(exceeded, scope({ runsProject: () => false }))).toBeUndefined();
    // The Harmonizer is not woken for its Waykeepers' projects: its chat shows the notice already.
    expect(wakeLine(exceeded, scope({ role: 'harmonizer' }))).toBeUndefined();
    // A task's notice wakes whoever runs the task: the Harmonizer for an asteroid task.
    const warning: Event = { ...fixtures['budget.warning'], target: { kind: 'task', id: 't-9' } };
    expect(wakeLine(warning, scope({ role: 'harmonizer' }))).toMatch(/^budget warning: task t-9/);
    expect(wakeLine(warning, scope({ runsTask: () => false }))).toBeUndefined();
    expect(wakeLine(fixtures['budget.set'], scope())).toBe(
      'the budget of project p-1 is now $5.00 (was $2.00) — spawns refused for the budget may be tried again',
    );
    // A refused spawn is the asker's tool error, not a mailbox line.
    expect(wakeLine(fixtures['budget.spawn_refused'], scope())).toBeUndefined();
  });

  it('wakes the Harmonizer on a raised or removed budget of work nobody runs (P8-01 review)', () => {
    const raised = fixtures['budget.set']; // project p-1: $2.00 → $5.00
    const hq = (unattended: boolean) =>
      scope({ role: 'harmonizer', runsProject: () => false, unattended: () => unattended });
    expect(wakeLine(raised, hq(true))).toBe(
      'the budget of project p-1 is now $5.00 (was $2.00) — spawns refused for the budget may be ' +
        'tried again; project p-1 has no running Waykeeper: if the budget now allows it, ' +
        'spawn_waykeeper for it',
    );
    // Its Waykeeper runs: nothing for the Harmonizer to start.
    expect(wakeLine(raised, hq(false))).toBeUndefined();
    // Lowered, or set for the first time: no spawn it refused can now go through.
    const lowered: Event = { ...raised, usd: 1 } as Event;
    expect(wakeLine(lowered, hq(true))).toBeUndefined();
    const first: Event = {
      type: 'budget.set',
      target: raised.target,
      usd: 5,
      by: { type: 'user' },
    };
    expect(wakeLine(first, hq(true))).toBeUndefined();
    // Removed: an asteroid task without its Steward.
    const removed: Event = {
      type: 'budget.set',
      target: { kind: 'task', id: 't-9' },
      previousUsd: 3,
      by: { type: 'user' },
    };
    expect(
      wakeLine(
        removed,
        scope({ role: 'harmonizer', runsTask: () => false, unattended: () => true }),
      ),
    ).toMatch(/was removed .*; task t-9 has no running Steward: .* spawn_steward for it$/);
  });

  it('knows which work is unattended: active, and no running Waykeeper or asteroid Steward', () => {
    const { log } = world();
    const running = new Set<string>();
    const run = <T>(fn: Parameters<typeof log.runCommand<T>>[0]) => log.runCommand(fn).value;
    const project = run((ctx) => createProject(ctx, { name: 'P', workspace: '/w/p' }));
    const asteroid = run((ctx) => createTask(ctx, { description: 'a' }));
    const projectTask = run((ctx) => createTask(ctx, { description: 't', projectId: project.id }));
    const s = createWakeScope(
      log.tables,
      { brainId: 'hq', role: 'harmonizer' },
      { status: (id) => (running.has(id) ? ({ state: 'idle' } as never) : undefined) },
    );
    expect(s.unattended?.({ kind: 'project', id: project.id })).toBe(true);
    expect(s.unattended?.({ kind: 'task', id: asteroid.id })).toBe(true);
    // A project's task is its Waykeeper's to staff.
    expect(s.unattended?.({ kind: 'task', id: projectTask.id })).toBe(false);
    const wk = run((ctx) =>
      createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        caps: d.agent.caps,
      }),
    );
    running.add(wk.id);
    expect(s.unattended?.({ kind: 'project', id: project.id })).toBe(false);
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

describe('a dismissal tells the asker not to wait (P9-14)', () => {
  const own = {
    ...d.question,
    kind: 'clarification' as const,
    originAgentId: BRAIN,
    holder: { type: 'user' as const },
    context: { text: 'Which licence?' },
    meta: { source: 'command' },
  };
  const dismissed = (reason: string, by: Actor): Event => ({
    type: 'question.cancelled',
    questionId: own.id,
    agentId: BRAIN,
    reason,
    version: 2,
    by,
    holders: ['a-harmonizer-1'],
  });

  it('the asker: dismissed by the user, or superseded by its message', () => {
    const s = { ...scope({ supervises: () => false }), question: () => own };
    const byUser = wakeLine(dismissed('dismissed by the user', { type: 'user' }), s);
    expect(byUser).toContain(`the user dismissed ${own.id} ("Which licence?") without answering`);
    expect(byUser).toContain('do not wait for an answer');
    const superseded = wakeLine(
      dismissed("superseded by the user's message", { type: 'system' }),
      s,
    );
    expect(superseded).toContain("superseded by the user's message");
    expect(superseded).toContain('read their message');
  });

  it('a former holder hears it needs no answer from it', () => {
    const s = {
      ...scope({ brainId: 'a-harmonizer-1', role: 'harmonizer', supervises: () => false }),
      question: () => own,
    };
    expect(wakeLine(dismissed('dismissed by the user', { type: 'user' }), s)).toContain(
      'needs no answer from you',
    );
    expect(
      wakeLine(dismissed("superseded by the user's message", { type: 'system' }), s),
    ).toContain('the user wrote to its agent directly');
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

describe('a reply carries its quote into the turn prompt (P8-17, decision 139)', () => {
  const clarification: Question = {
    ...d.question,
    id: 'q-clar',
    kind: 'clarification',
    originAgentId: 'a-steward-1',
    holder: { type: 'user' },
    context: { text: 'Which licence?' },
  };
  const permission: Question = { ...clarification, id: 'q-perm', kind: 'permission' };
  const byId = new Map([clarification, permission].map((q) => [q.id, q]));
  const s = scope({ supervises: (id) => id === 'a-steward-1', question: (id) => byId.get(id) });
  const reply = (replyTo: Extract<Event, { type: 'message.sent' }>['replyTo']): Event => ({
    type: 'message.sent',
    messageId: 'm-2',
    agentId: BRAIN,
    sender: { type: 'user' },
    text: 'MIT',
    interrupt: false,
    ...(replyTo ? { replyTo } : {}),
  });

  it('quotes the line the user replied to, from the brain’s side', () => {
    expect(
      wakeLine(
        reply({
          kind: 'reply',
          id: `r:${BRAIN}:4`,
          sender: { type: 'agent', id: BRAIN },
          text: 'Done: the CSV parser.',
        }),
        s,
      ),
    ).toBe('the user said (replying to your reply: "Done: the CSV parser."): "MIT"');
    expect(
      wakeLine(
        reply({ kind: 'message', id: 'm-1', sender: { type: 'user' }, text: 'build it' }),
        s,
      ),
    ).toBe('the user said (replying to their own earlier message: "build it"): "MIT"');
    expect(
      wakeLine(
        reply({
          kind: 'message',
          id: 'm-0',
          sender: { type: 'agent', id: 'a-steward-1' },
          text: 'Blocked.',
        }),
        s,
      ),
    ).toBe('the user said (replying to agent a-steward-1\'s message: "Blocked."): "MIT"');
    expect(
      wakeLine(
        reply({
          kind: 'proposal',
          id: 'pr-1',
          sender: { type: 'agent', id: BRAIN },
          text: 'A CSV tool',
        }),
        s,
      ),
    ).toBe('the user said (replying to your proposal pr-1: "A CSV tool"): "MIT"');
  });

  it('shortens a long quote for the prompt', () => {
    const long = 'x'.repeat(1_500);
    const line = wakeLine(
      reply({ kind: 'message', id: 'm-1', sender: { type: 'user' }, text: long }),
      s,
    )!;
    expect(line).toContain(`${'x'.repeat(999)}…`);
    expect(line).not.toContain('x'.repeat(1_000));
  });

  it('an answered clarification is one line: the reply says it answered, the answer stays quiet', () => {
    const line = wakeLine(
      reply({
        kind: 'question',
        id: 'q-clar',
        sender: { type: 'agent', id: 'a-steward-1' },
        text: 'Which licence?',
        answered: true,
      }),
      s,
    );
    expect(line).toBe(
      'the user answered q-clar (agent a-steward-1\'s question q-clar: "Which licence?") by replying: "MIT"',
    );
    const answered: Event = {
      type: 'question.answered',
      questionId: 'q-clar',
      answer: 'MIT',
      answeredBy: { type: 'user' },
      version: 2,
      holders: [BRAIN],
    };
    // Answered by a reply in this brain's chat: not a second line; in another chat (or by the
    // card's button) it wakes the brain as before.
    expect(wakeLine({ ...answered, repliedIn: BRAIN }, s)).toBeUndefined();
    expect(wakeLine({ ...answered, repliedIn: 'a-harmonizer-1' }, s)).toBeDefined();
    expect(wakeLine(answered, s)).toBeDefined();
  });

  it('a reply to a permission request says it does not decide it', () => {
    expect(
      wakeLine(
        reply({
          kind: 'question',
          id: 'q-perm',
          sender: { type: 'agent', id: 'a-steward-1' },
          text: 'Run git push?',
        }),
        s,
      ),
    ).toBe(
      'the user said (replying to agent a-steward-1\'s permission request q-perm: "Run git push?" — ' +
        'this does not decide the request: only the user\'s buttons on its card do): "MIT"',
    );
  });
});

describe('question sets (P8-19)', () => {
  const set = { id: 'qs-1', index: 1, total: 3, title: 'Export details' };
  const row: Question = {
    ...d.question,
    id: 'q-2',
    kind: 'clarification',
    originAgentId: 'a-steward-1',
    holder: { type: 'agent', id: BRAIN },
    context: { text: 'Which delimiter?', options: [',', ';'], set },
  };

  it('names the row, its place in the set and the set title when a set row is opened', () => {
    const s = scope({ supervises: (id) => id === 'a-steward-1' });
    expect(wakeLine({ type: 'question.opened', question: row }, s)).toBe(
      'agent a-steward-1 asked q-2 (question 2 of 3 in set qs-1 "Export details", held by you): ' +
        '"Which delimiter?"',
    );
    // A plain question keeps today's line.
    const plain = { ...row, context: { text: 'Which delimiter?' } };
    expect(wakeLine({ type: 'question.opened', question: plain }, s)).toBe(
      'agent a-steward-1 asked q-2 (held by you): "Which delimiter?"',
    );
  });

  it('names the row and its place in the set when a set row is answered', () => {
    const s = scope({ supervises: () => false, question: () => row });
    const answered: Event = {
      type: 'question.answered',
      questionId: 'q-2',
      answer: ';',
      answeredBy: { type: 'user' },
      version: 1,
      holders: [BRAIN],
    };
    expect(wakeLine(answered, s)).toBe('user answered q-2 (question 2 of 3 in set qs-1): ";"');
    const plain = scope({
      supervises: () => false,
      question: () => ({ ...row, context: { text: 'Which delimiter?' } }),
    });
    expect(wakeLine(answered, plain)).toBe('user answered q-2: ";"');
  });
});
