import { describe, expect, it } from 'vitest';
import type { Agent, Proposal, Question, Task } from './domain.js';
import { domain as d } from './fixtures/index.js';
import {
  excerpt,
  parseReplyEntryId,
  questionOwner,
  REPLY_QUOTE_MAX,
  ReplyQuote,
  threadShowsProposal,
  threadShowsQuestion,
  type ThreadLookup,
} from './reply.js';

/** P8-17 (SPEC decision 139): replies in a chat, and which cards a brain's chat shows. */

const harmonizer: Agent = { ...d.harmonizer, id: 'a-h', role: 'harmonizer' };
const waykeeper: Agent = {
  ...d.harmonizer,
  id: 'a-w',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-h',
};
const projectSteward: Agent = {
  ...d.harmonizer,
  id: 'a-s1',
  role: 'steward',
  taskId: 't-1',
  supervisorId: 'a-w',
};
const soloSteward: Agent = {
  ...d.harmonizer,
  id: 'a-s2',
  role: 'steward',
  taskId: 't-2',
  supervisorId: 'a-h',
};
const tasks: Record<string, Pick<Task, 'projectId'>> = {
  't-1': { projectId: 'p-1' },
  't-2': {},
};
const agents = Object.fromEntries(
  [harmonizer, waykeeper, projectSteward, soloSteward].map((a) => [a.id, a]),
);
const look: ThreadLookup = {
  agent: (id) => agents[id],
  task: (id) => tasks[id] as Task | undefined,
};
const question = (over: Partial<Question>): Question => ({ ...d.question, ...over });

describe('reply helpers', () => {
  it('cuts a quote with "…" and keeps a short one', () => {
    expect(excerpt('short', 10)).toBe('short');
    expect(excerpt('abcdefghijk', 5)).toBe('abcd…');
    expect(Array.from(excerpt('😀'.repeat(10), 4))).toHaveLength(4);
  });

  it('parses a reply entry id', () => {
    expect(parseReplyEntryId('r:a-h:12')).toEqual({ agentId: 'a-h', chunkSeq: 12 });
    expect(parseReplyEntryId('r:a:b:3')).toEqual({ agentId: 'a:b', chunkSeq: 3 });
    expect(parseReplyEntryId('m:m-1')).toBeUndefined();
    expect(parseReplyEntryId('r:a-h:0')).toBeUndefined();
  });

  it('bounds a stored quote', () => {
    const q = { kind: 'reply', id: 'r:a:1', sender: { type: 'agent', id: 'a' } };
    expect(ReplyQuote.safeParse({ ...q, text: 'x'.repeat(REPLY_QUOTE_MAX) }).success).toBe(true);
    expect(ReplyQuote.safeParse({ ...q, text: 'x'.repeat(REPLY_QUOTE_MAX + 1) }).success).toBe(
      false,
    );
    expect(ReplyQuote.safeParse({ ...q, text: 'x', answered: false }).success).toBe(false);
  });
});

describe('the cards a chat shows (decisions 52, 55)', () => {
  it('a project question in its Waykeeper’s chat; a clarification that reached the user in the Harmonizer’s too', () => {
    const permission = question({ kind: 'permission', originAgentId: 'a-s1' });
    const held = question({
      kind: 'clarification',
      originAgentId: 'a-s1',
      holder: { type: 'agent', id: 'a-w' },
    });
    const reached = question({
      kind: 'clarification',
      originAgentId: 'a-s1',
      holder: { type: 'user' },
    });
    expect(questionOwner(look, permission)).toEqual({ role: 'waykeeper', projectId: 'p-1' });
    expect(threadShowsQuestion(look, waykeeper, permission)).toBe(true);
    expect(threadShowsQuestion(look, harmonizer, permission)).toBe(false);
    expect(threadShowsQuestion(look, harmonizer, held)).toBe(false);
    expect(threadShowsQuestion(look, harmonizer, reached)).toBe(true);
    expect(threadShowsQuestion(look, projectSteward, reached)).toBe(false);
  });

  it('a standalone task’s and the Harmonizer’s own questions in the Harmonizer’s chat', () => {
    const solo = question({ kind: 'permission', originAgentId: 'a-s2' });
    const own = question({ kind: 'clarification', originAgentId: 'a-h' });
    expect(threadShowsQuestion(look, harmonizer, solo)).toBe(true);
    expect(threadShowsQuestion(look, harmonizer, own)).toBe(true);
    expect(threadShowsQuestion(look, waykeeper, solo)).toBe(false);
    expect(threadShowsQuestion(look, harmonizer, question({ originAgentId: 'a-gone' }))).toBe(
      false,
    );
  });

  it('a plan card in its project’s Waykeeper’s chat, any other card in the Harmonizer’s', () => {
    const work: Proposal = { ...d.proposal, meta: {} };
    const plan: Proposal = {
      ...d.proposal,
      meta: { plan: { projectId: 'p-1', waykeeperId: 'a-w', taskIds: ['t-1'] } },
    };
    expect(threadShowsProposal(harmonizer, work)).toBe(true);
    expect(threadShowsProposal(waykeeper, work)).toBe(false);
    expect(threadShowsProposal(waykeeper, plan)).toBe(true);
    expect(threadShowsProposal(harmonizer, plan)).toBe(false);
    expect(threadShowsProposal({ ...waykeeper, projectId: 'p-2' }, plan)).toBe(false);
  });
});
