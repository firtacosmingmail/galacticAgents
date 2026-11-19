import { describe, expect, it } from 'vitest';
import {
  PICKED_OPTION_PREFIX,
  quoteFound,
  type Actor,
  type Id,
  type Question,
} from '@galactic/protocol';
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

  it('leaves out his replies and answers to send-permission questions (final review M1)', () => {
    const w = setup();
    const { task, wk, steward } = project(w);
    const send: Question = {
      id: 'q-send',
      kind: 'permission',
      originAgentId: steward.id,
      holder: USER,
      status: 'open',
      context: {
        text: 'Bash: curl -X POST instagram',
        sendPermission: { summary: 'Post to Instagram', parts: [], grants: [], deciderId: wk.id },
      },
      version: 1,
      createdAt: '2026-11-18T10:00:00.000Z',
      updatedAt: '2026-11-18T10:00:00.000Z',
    };
    w.run((ctx) => {
      ctx.tables.questions.insert(send);
      answered(ctx, 'q-plain', steward.id, 'push the parser branch when green', USER);
    });
    w.run((ctx) => {
      ctx.tables.questions.insert({
        ...send,
        id: 'q-send-2',
        status: 'answered',
        answeredBy: USER,
        answer: "deny: don't post to Instagram today",
      });
    });
    const reply = (agentId: Id, text: string, id: Id) =>
      w.run((ctx) =>
        ctx.emit({
          type: 'message.sent',
          messageId: `m-reply-${id}-${agentId}`,
          agentId,
          sender: USER,
          text,
          interrupt: false,
          replyTo: { kind: 'question', id, sender: { type: 'agent', id: steward.id }, text: 'x' },
        }),
      );
    reply(wk.id, "don't post to Instagram today", send.id);
    reply(steward.id, "no, don't post to Instagram today", send.id);
    reply(wk.id, 'yes, use semicolons as the delimiter', 'q-plain');
    w.say(wk.id, 'also push the docs');
    const words = userWordsFor(w.log, task.id);
    expect(words).toEqual(
      expect.arrayContaining([
        'push the parser branch when green',
        'yes, use semicolons as the delimiter',
        'also push the docs',
      ]),
    );
    expect(words.some((t) => t.includes('Instagram'))).toBe(false);
    expect(quoteFound('post to Instagram today', words)).toBe(false);
  });

  it('leaves out a plain chat line a send-permission answer was taken from (P13-33)', () => {
    const w = setup();
    const { task, wk, steward } = project(w);
    w.say(wk.id, 'yes, post to Instagram only today');
    w.say(wk.id, 'and push the parser branch');
    w.run((ctx) =>
      ctx.tables.questions.insert({
        id: 'q-send',
        kind: 'permission',
        originAgentId: steward.id,
        holder: USER,
        status: 'cancelled',
        context: {
          text: 'Bash: curl -X POST instagram',
          sendPermission: { summary: 'Post to Instagram', parts: [], grants: [], deciderId: wk.id },
        },
        meta: { answeredWith: ['m-1'] },
        version: 2,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      }),
    );
    expect(userWordsFor(w.log, task.id)).toEqual(['and push the parser branch']);
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

  it('never counts a picked option that names no action; free text still counts', () => {
    const w = setup();
    const { task, steward } = project(w);
    const offered = (id: Id, answer: string, options: string[], multiSelect = false) =>
      w.run((ctx) => {
        const q = answered(ctx, id, steward.id, answer, USER);
        ctx.tables.questions.upsert({
          ...q,
          context: { ...q.context, options, ...(multiSelect ? { multiSelect: true } : {}) },
        });
      });
    const yes = 'Yes, go ahead with that plan now';
    offered('q-1', yes, [yes, 'No']);
    offered('q-2', 'Go ahead (Recommended)', ['Go ahead (Recommended)', 'Hold']);
    offered('q-3', 'Hold', ['Go ahead (Recommended)', 'Hold']);
    offered('q-4', `${yes}, Keep the tests`, [yes, 'Keep the tests', 'No'], true);
    offered('q-5', `${yes} — and please push the fixes when green`, [yes, 'No']);
    offered('q-6', 'please push the release branch today', [yes, 'No']);
    // A question-set row keeps the structured answer: its text, and no plain choice.
    w.run((ctx) => {
      const q = answered(ctx, 'q-7', steward.id, `${yes} — tag it v2 too`, USER);
      ctx.tables.questions.upsert({
        ...q,
        context: { ...q.context, options: [yes, 'No'] },
        meta: { answerDetail: { choices: [yes], text: 'tag it v2 too' } },
      });
    });
    const words = userWordsFor(w.log, task.id);
    expect(words).toEqual([
      'and please push the fixes when green',
      'please push the release branch today',
      'tag it v2 too',
    ]);
    expect(quoteFound(yes, words)).toBe(false);
    expect(quoteFound('push the release branch', words)).toBe(true);
  });

  it('counts a picked option that names a push or an upload, without "(Recommended)" (P13-10)', () => {
    const w = setup();
    const { task, steward } = project(w);
    const offered = (id: Id, answer: string, options: string[], detail?: object) =>
      w.run((ctx) => {
        const q = answered(ctx, id, steward.id, answer, USER);
        ctx.tables.questions.upsert({
          ...q,
          context: { ...q.context, options },
          ...(detail ? { meta: { answerDetail: detail } } : {}),
        });
      });
    const push = 'Push the branch to origin (Recommended)';
    offered('q-1', push, [push, 'Hold']);
    offered('q-2', 'Upload the screenshot, Open a PR', [
      'Upload the screenshot',
      'Open a PR',
      'No',
    ]);
    offered('q-3', 'Post the replies — and tag Dean', ['Post the replies', 'Hold']);
    offered('q-4', 'x', ['Deploy to staging', 'Hold'], { choices: ['Deploy to staging'] });
    offered('q-5', 'Hold', ['Merge it', 'Hold']);
    const P = PICKED_OPTION_PREFIX;
    expect(userWordsFor(w.log, task.id)).toEqual([
      `${P}Push the branch to origin`,
      `${P}Upload the screenshot`,
      `${P}Open a PR`,
      `${P}Post the replies`,
      'and tag Dean',
      `${P}Deploy to staging`,
    ]);
  });

  it('never counts a picked option that holds or negates; a picked one is quoted whole only (P13-10 review)', () => {
    const w = setup();
    const { task, steward } = project(w);
    const offered = (id: Id, answer: string, options: string[]) =>
      w.run((ctx) => {
        const q = answered(ctx, id, steward.id, answer, USER);
        ctx.tables.questions.upsert({ ...q, context: { ...q.context, options } });
      });
    const hold = 'Hold — do not push the branch to origin main yet';
    offered('q-1', hold, ['Push now', hold]);
    for (const [i, o] of [
      "Don't push the branch yet",
      'Never merge it',
      'No upload, thanks',
      'Wait, then push',
      'Skip the push',
      'Cancel the release',
      'Stop deploying',
      'Merge without the tests',
      'NOT the PR comment',
    ].entries()) {
      offered(`q-n${i}`, o, [o, 'Go']);
    }
    expect(userWordsFor(w.log, task.id)).toEqual([]);
    expect(quoteFound('push the branch to origin main', userWordsFor(w.log, task.id))).toBe(false);

    const push = 'Push and post the 4 replies';
    offered('q-2', push, [push, hold]);
    const words = userWordsFor(w.log, task.id);
    expect(words).toEqual([`${PICKED_OPTION_PREFIX}${push}`]);
    expect(quoteFound(push, words)).toBe(true);
    expect(quoteFound('Push and post the 4', words)).toBe(false);
  });

  describe("the Harmonizer's relay of a project agent's question (P13-10)", () => {
    const OPTIONS = [
      'Push, post the 4 replies and re-request Dean (Recommended)',
      'Push and post the 4 replies',
      'Push only, no replies',
      'Hold',
    ];
    /** Q1 asked by `asker`, held by the Harmonizer; Q2 the Harmonizer's question to the user. */
    function relay(
      w: ReturnType<typeof setup>,
      asker: Id,
      answer: string,
      link: 'relays' | 'none' = 'relays',
    ) {
      w.run((ctx) => {
        const q1 = answered(ctx, 'q-1', asker, 'You may push and post', {
          type: 'agent',
          id: w.hq.id,
        });
        ctx.tables.questions.upsert({
          ...q1,
          context: { text: 'May I push them and post the 4 replies?' },
        });
        const q2 = answered(ctx, 'q-2', w.hq.id, answer, USER);
        ctx.tables.questions.upsert({
          ...q2,
          context: { text: 'The Waykeeper asks: may it push?', options: OPTIONS },
          meta: { source: 'command', ...(link === 'relays' ? { relaysQuestionId: q1.id } : {}) },
        });
      });
    }

    it("counts the user's picked push option (the 2026-11-14 run)", () => {
      const w = setup();
      const { task, wk } = project(w);
      relay(w, wk.id, 'Push and post the 4 replies');
      const words = userWordsFor(w.log, task.id);
      expect(words).toEqual([`${PICKED_OPTION_PREFIX}Push and post the 4 replies`]);
      expect(quoteFound('Push and post the 4 replies', words)).toBe(true);
    });

    it('a "Hold" counts nothing; free text still counts', () => {
      const w = setup();
      const { task, wk } = project(w);
      relay(w, wk.id, 'Hold — wait for Dean first');
      expect(userWordsFor(w.log, task.id)).toEqual(['wait for Dean first']);
    });

    it("never counts a relay of another project's agent", () => {
      const w = setup();
      const { task } = project(w);
      const other = w.run((ctx) => createProject(ctx, { name: 'Other', workspace: '/w/o' })).value;
      const wk2 = w.run((ctx) =>
        createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: other.id }),
      ).value;
      relay(w, wk2.id, 'Push and post the 4 replies');
      expect(userWordsFor(w.log, task.id)).toEqual([]);
    });

    it('never counts a Harmonizer question with no relay link', () => {
      const w = setup();
      const { task, wk } = project(w);
      relay(w, wk.id, 'Push and post the 4 replies', 'none');
      expect(userWordsFor(w.log, task.id)).toEqual([]);
    });
  });

  it('an unknown task has no words', () => {
    const w = setup();
    expect(userWordsFor(w.log, 't-none')).toEqual([]);
  });
});
