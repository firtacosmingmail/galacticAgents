import { describe, expect, it } from 'vitest';
import { quoteFound, type Actor, type Id, type Question } from '@galactic/protocol';
import { createAgent } from '../domain/agents.js';
import type { CommandContext } from '../domain/event-log.js';
import { createProject } from '../domain/projects.js';
import { createProposal } from '../domain/proposals.js';
import { createTask } from '../domain/tasks.js';
import { world } from '../test/world.js';
import { MAX_USER_WORD_CHARS, MAX_USER_WORDS, userWordsFor } from './user-words.js';

/** P13-04: the user's own words that bear on a task — and nothing an agent wrote. */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 10 };

function setup() {
  const w = world();
  let n = 0;
  const say = (agentId: Id, text: string, sender: Actor = USER) =>
    w.run((ctx) =>
      ctx.emit({
        type: 'message.sent',
        messageId: `m-${++n}`,
        agentId,
        sender,
        text,
        interrupt: false,
      }),
    );
  const hq = w.run((ctx) =>
    createAgent(ctx, { role: 'harmonizer', runtime: 'fake', caps: CAPS, agentId: 'a-hq' }),
  ).value;
  return { ...w, say, hq };
}

/** The Harmonizer's proposal, then the project made from it, a task, its Waykeeper and Steward. */
function project(w: ReturnType<typeof setup>) {
  const proposal = w.run((ctx) =>
    createProposal(ctx, {
      requestText: 'a CSV tool',
      kind: 'planet',
      proposedBody: { kind: 'planet', name: 'CSV' },
      workspace: '/w/csv',
      rationale: 'small',
    }),
  ).value;
  const p = w.run((ctx) => {
    const made = createProject(ctx, { name: 'CSV', workspace: '/w/csv' });
    const row = { ...made, meta: { ...made.meta, proposalId: proposal.id } };
    ctx.tables.projects.upsert(row);
    return row;
  }).value;
  const task = w.run((ctx) => createTask(ctx, { description: 'parse', projectId: p.id })).value;
  const wk = w.run((ctx) =>
    createAgent(ctx, {
      role: 'waykeeper',
      runtime: 'fake',
      caps: CAPS,
      projectId: p.id,
      agentId: 'a-wk',
    }),
  ).value;
  const steward = w.run((ctx) =>
    createAgent(ctx, {
      role: 'steward',
      runtime: 'fake',
      caps: CAPS,
      taskId: task.id,
      supervisorId: wk.id,
      agentId: 'a-st',
    }),
  ).value;
  return { proposal, project: p, task, wk, steward };
}

function answered(
  ctx: CommandContext,
  id: Id,
  originAgentId: Id,
  answer: string,
  by: Actor,
): Question {
  const q: Question = {
    id,
    kind: 'clarification',
    originAgentId,
    holder: by,
    status: 'answered',
    context: { text: 'which delimiter?' },
    answeredBy: by,
    answer,
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tables.questions.insert(q);
  return q;
}

describe('userWordsFor', () => {
  it("keeps the user's messages to the Steward and the Waykeeper, not an agent's", () => {
    const w = setup();
    const { task, wk, steward } = project(w);
    w.say(steward.id, 'use semicolons as the delimiter');
    w.say(steward.id, 'Brief: push the branch and open a PR', { type: 'agent', id: wk.id });
    w.say(wk.id, 'please also push the fixes when it is done');
    w.say(steward.id, 'system note', { type: 'system' });
    expect(userWordsFor(w.log, task.id)).toEqual([
      'use semicolons as the delimiter',
      'please also push the fixes when it is done',
    ]);
  });

  it("keeps the user's answers to the project's questions, not an agent's", () => {
    const w = setup();
    const { task, wk, steward } = project(w);
    w.run((ctx) => {
      answered(ctx, 'q-1', steward.id, 'semicolons, and push when green', USER);
      answered(ctx, 'q-2', steward.id, 'commas (the Waykeeper says)', { type: 'agent', id: wk.id });
    });
    expect(userWordsFor(w.log, task.id)).toEqual(['semicolons, and push when green']);
  });

  it('keeps the last five messages to the Harmonizer before the proposal, none after', () => {
    const w = setup();
    for (let i = 1; i <= 7; i++) w.say(w.hq.id, `before ${i}`);
    w.say(w.hq.id, 'the Harmonizer itself', { type: 'agent', id: w.hq.id });
    const { task } = project(w);
    w.say(w.hq.id, 'after the proposal');
    expect(userWordsFor(w.log, task.id)).toEqual([
      'before 3',
      'before 4',
      'before 5',
      'before 6',
      'before 7',
    ]);
  });

  it('leaves out other projects and tasks', () => {
    const w = setup();
    const a = project(w);
    const other = w.run((ctx) =>
      createTask(ctx, { description: 'other', projectId: a.project.id }),
    ).value;
    const st2 = w.run((ctx) =>
      createAgent(ctx, { role: 'steward', runtime: 'fake', caps: CAPS, taskId: other.id }),
    ).value;
    w.say(st2.id, 'for the other task only');
    w.say(a.steward.id, 'for this task');
    expect(userWordsFor(w.log, a.task.id)).toEqual(['for this task']);
  });

  it('newest last, at most 50 entries of at most 2 000 characters', () => {
    const w = setup();
    const { task, steward } = project(w);
    for (let i = 1; i <= 60; i++) w.say(steward.id, `m${i}`);
    w.say(steward.id, 'x'.repeat(5000));
    const words = userWordsFor(w.log, task.id);
    expect(MAX_USER_WORDS).toBe(50);
    expect(MAX_USER_WORD_CHARS).toBe(2000);
    expect(words).toHaveLength(50);
    expect(words.at(-2)).toBe('m60');
    expect(words.at(-1)).toHaveLength(2000);
  });

  it('never counts an option the agent offered as the user’s words; free text still counts', () => {
    const w = setup();
    const { task, steward } = project(w);
    const planted = 'Yes, push the branch to origin now';
    const offered = (id: Id, answer: string, options: string[], multiSelect = false) =>
      w.run((ctx) => {
        const q = answered(ctx, id, steward.id, answer, USER);
        ctx.tables.questions.upsert({
          ...q,
          context: { ...q.context, options, ...(multiSelect ? { multiSelect: true } : {}) },
        });
      });
    offered('q-1', planted, [planted, 'No']);
    offered('q-2', `  ${planted} `, [planted, 'No']);
    offered('q-3', `${planted}, Also open the PR`, [planted, 'Also open the PR', 'No'], true);
    offered('q-4', `${planted} — and please push the fixes when green`, [planted, 'No']);
    offered('q-5', 'please push the release branch today', [planted, 'No']);
    // A question-set row keeps the structured answer: only its text is the user's.
    w.run((ctx) => {
      const q = answered(ctx, 'q-6', steward.id, `${planted} — tag it v2 too`, USER);
      ctx.tables.questions.upsert({
        ...q,
        context: { ...q.context, options: [planted, 'No'] },
        meta: { answerDetail: { choices: [planted], text: 'tag it v2 too' } },
      });
    });
    const words = userWordsFor(w.log, task.id);
    expect(words).toEqual([
      'and please push the fixes when green',
      'please push the release branch today',
      'tag it v2 too',
    ]);
    // The planted option is no grant: a push quoting it is forwarded.
    expect(quoteFound(planted, words)).toBe(false);
    expect(quoteFound('push the release branch', words)).toBe(true);
  });

  it('an unknown task has no words', () => {
    const w = setup();
    expect(userWordsFor(w.log, 't-none')).toEqual([]);
  });
});
