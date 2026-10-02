import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Agent,
  ConversationEntry,
  ConversationQuery,
  Proposal,
  Question,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import {
  conversationSince,
  liveEntries,
  mergeEntries,
  threadCards,
  threadItems,
  useConversationStore,
  type ChatEntry,
} from './conversation.js';

const at = (s: number) => `2026-10-02T10:00:${String(s).padStart(2, '0')}.000Z`;

const msg = (n: number, s = n): ConversationEntry => ({
  id: `m:msg-${n}`,
  agentId: 'a-h',
  kind: 'message',
  at: at(s),
  sender: { type: 'user' },
  text: `message ${n}`,
  messageId: `msg-${n}`,
  seq: n,
  cursor: `c-m-${n}`,
});
const reply = (n: number, s = n): ConversationEntry => ({
  id: `r:a-h:${n}`,
  agentId: 'a-h',
  kind: 'reply',
  at: at(s),
  sender: { type: 'agent', id: 'a-h' },
  text: `reply ${n}`,
  chunkSeq: n,
  cursor: `c-r-${n}`,
});

/** A server over a fixed conversation, paging as `GET /api/agents/:id/conversation` does. */
function fakeServer(all: ConversationEntry[], lastSeq = 0) {
  const calls: ConversationQuery[] = [];
  const fetch = async (_agentId: string, q: ConversationQuery) => {
    calls.push(q);
    const limit = Number(q.limit ?? 50);
    const index = (cursor: string) => all.findIndex((e) => e.cursor === cursor);
    if (q.after) {
      const from = index(q.after) + 1;
      const entries = all.slice(from, from + limit);
      return { entries, hasMore: from + limit < all.length, lastSeq };
    }
    const end = q.before ? index(q.before) : all.length;
    const start = Math.max(0, end - limit);
    return { entries: all.slice(start, end), hasMore: start > 0, lastSeq };
  };
  return { fetch, calls };
}

beforeEach(() => useConversationStore.getState().reset());

describe('conversation merge (P25-03)', () => {
  it('dedups by entry id, keeps the server order and prefers the history copy', () => {
    const live: ChatEntry = { ...reply(3), cursor: undefined };
    const a = mergeEntries([], [live, msg(1)]);
    expect(a.map((e) => e.id)).toEqual(['m:msg-1', 'r:a-h:3']);
    const b = mergeEntries(a, [reply(3), msg(2)]);
    expect(b.map((e) => e.id)).toEqual(['m:msg-1', 'm:msg-2', 'r:a-h:3']);
    expect(b.find((e) => e.id === 'r:a-h:3')?.cursor).toBe('c-r-3');
    expect(mergeEntries(b, [live, msg(1)])).toBe(b);
    // Same instant: the message first, then the reply.
    const tie = mergeEntries([], [reply(9, 5), msg(8, 5)]);
    expect(tie.map((e) => e.kind)).toEqual(['message', 'reply']);
  });

  it('turns the stream into entries with the history ids', () => {
    const entries = liveEntries(
      'a-h',
      [
        {
          messageId: 'msg-1',
          agentId: 'a-h',
          seq: 4,
          at: at(1),
          sender: { type: 'user' },
          text: 'hi',
        },
      ],
      [
        { agentId: 'a-h', seq: 3, at: at(2), kind: 'text', text: 'hello' },
        { agentId: 'a-h', seq: 4, at: at(2), kind: 'tool', text: 'Read' },
        { agentId: 'a-h', seq: 5, at: at(2), kind: 'text', text: '  ' },
      ],
    );
    expect(entries.map((e) => e.id)).toEqual(['m:msg-1', 'r:a-h:3']);
  });
});

describe('conversation paging and the live seam (P25-03)', () => {
  const all = [msg(1), reply(2), msg(3), reply(4), msg(5), reply(6)];

  it('reads the newest page, pages back to the start, and records lastSeq', async () => {
    const server = fakeServer(all, 6);
    const store = useConversationStore.getState();
    await store.open('a-h', server.fetch);
    const t = useConversationStore.getState().threads['a-h']!;
    expect(t.entries.map((e) => e.id)).toEqual(all.map((e) => e.id));
    expect(t.hasOlder).toBe(false);
    expect(t.liveFrom).toBe(6);
    expect(conversationSince('a-h')).toBe(6);
    store.close('a-h');
    expect(conversationSince('a-h')).toBe(0);
  });

  it('pages back without duplicates or gaps', async () => {
    const many = Array.from({ length: 120 }, (_, i) => (i % 2 ? reply(i + 1, 0) : msg(i + 1, 0)));
    // Distinct times so the order is the array's.
    many.forEach((e, i) => (e.at = new Date(Date.UTC(2026, 9, 2, 10, 0, i)).toISOString()));
    const server = fakeServer(many, 120);
    const store = useConversationStore.getState();
    await store.open('a-h', server.fetch);
    expect(useConversationStore.getState().threads['a-h']!.entries).toHaveLength(50);
    await store.loadOlder('a-h', server.fetch);
    await store.loadOlder('a-h', server.fetch);
    const t = useConversationStore.getState().threads['a-h']!;
    expect(t.entries.map((e) => e.id)).toEqual(many.map((e) => e.id));
    expect(t.hasOlder).toBe(false);
    expect(server.calls.map((c) => c.before)).toEqual([undefined, 'c-m-71', 'c-m-21']);
  });

  it('catches up forward after a snapshot and on reopening, and absorbs live lines', async () => {
    const server = fakeServer(all.slice(0, 2), 2);
    const store = useConversationStore.getState();
    await store.open('a-h', server.fetch);
    store.absorb('a-h', [{ ...reply(4), cursor: undefined }]);
    // Meanwhile the server got more (the events a snapshot skipped).
    const later = fakeServer(all, 6);
    await store.catchUp('a-h', later.fetch);
    expect(later.calls).toEqual([{ after: 'c-r-2', limit: 200 }]);
    let t = useConversationStore.getState().threads['a-h']!;
    expect(t.entries.map((e) => e.id)).toEqual(all.map((e) => e.id));
    expect(t.newestCursor).toBe('c-r-6');

    store.close('a-h');
    const reopened = fakeServer([...all, msg(7)], 9);
    await store.open('a-h', reopened.fetch);
    expect(reopened.calls).toEqual([{ after: 'c-r-6', limit: 200 }]);
    t = useConversationStore.getState().threads['a-h']!;
    expect(t.entries.at(-1)?.id).toBe('m:msg-7');
    expect(t.liveFrom).toBe(9);
  });

  it('drops every thread when the log changes and reports a failed read', async () => {
    const store = useConversationStore.getState();
    store.forLog('log-a');
    await store.open('a-h', fakeServer(all).fetch);
    store.forLog('log-a');
    expect(useConversationStore.getState().threads['a-h']).toBeDefined();
    store.forLog('log-b');
    expect(useConversationStore.getState().threads).toEqual({});
    await store.open('a-h', async () => ({ nope: true }));
    const t = useConversationStore.getState().threads['a-h']!;
    expect(t.loaded).toBe(true);
    expect(t.error).toMatch(/not understood/);
    expect(t.liveFrom).toBeUndefined();
  });
});

describe('thread cards (P25-03)', () => {
  const waykeeper: Agent = {
    ...fx.harmonizer,
    id: 'a-waykeeper-1',
    role: 'waykeeper',
    projectId: 'p-1',
    supervisorId: 'a-harmonizer',
  };
  const steward: Agent = fx.agent; // supervised by a-waykeeper-1
  const asteroidSteward: Agent = { ...fx.agent, id: 'a-steward-2', supervisorId: 'a-harmonizer' };
  const agents = {
    [fx.harmonizer.id]: fx.harmonizer,
    [waykeeper.id]: waykeeper,
    [steward.id]: steward,
    [asteroidSteward.id]: asteroidSteward,
  };
  const plan: Proposal = {
    ...fx.proposal,
    id: 'pr-plan',
    createdAt: at(5),
    meta: { plan: { projectId: 'p-1', waykeeperId: 'a-old-waykeeper', taskIds: ['t-1'] } },
  };
  const promotion: Proposal = {
    ...fx.proposal,
    id: 'pr-promo',
    meta: { promotion: { taskId: 't-1', fromProjectId: 'p-1', requestedBy: waykeeper.id } },
  };
  const work: Proposal = { ...fx.proposal, id: 'pr-work', createdAt: at(2) };
  const q1: Question = fx.question; // asked by a Steward of the Waykeeper
  const q2: Question = { ...fx.question, id: 'q-ast', originAgentId: 'a-steward-2' };
  const world = {
    agents,
    proposals: { [plan.id]: plan, [promotion.id]: promotion, [work.id]: work },
    questions: { [q1.id]: q1, [q2.id]: q2 },
  };

  it('gives a Waykeeper its project’s plan and promotion cards, the Harmonizer the rest', () => {
    expect(
      threadCards(world, waykeeper)
        .map((c) => c.id)
        .sort(),
    ).toEqual(['pr-plan', 'pr-promo', 'q-1']);
    expect(
      threadCards(world, fx.harmonizer)
        .map((c) => c.id)
        .sort(),
    ).toEqual(['pr-work', 'q-ast']);
    expect(threadCards(world, steward)).toEqual([]);
  });

  it('places cards by creation time, holding back older ones while history is unread', () => {
    const cards = threadCards(world, fx.harmonizer).filter((c) => c.kind === 'proposal');
    const entries = [msg(1), reply(3)];
    expect(threadItems(entries, cards, false).map((i) => i.key)).toEqual([
      'm:msg-1',
      'card-pr-work',
      'r:a-h:3',
    ]);
    expect(threadItems([reply(3)], cards, true).map((i) => i.key)).toEqual(['r:a-h:3']);
    expect(threadItems([], cards, false).map((i) => i.key)).toEqual(['card-pr-work']);
  });
});
