import { describe, expect, it } from 'vitest';
import type { Event } from '@galactic/protocol';
import { applyEvent, type WorldState } from '../../state/reduce.js';
import { beaconCard, beaconFor, beaconList, questionBody, sameBeacons } from './beacon-model.js';
import { question, worldWith } from './fixtures.js';

const T = (n: number) => `2026-10-03T10:0${n}:00.000Z`;

describe('beaconList: which body', () => {
  it("puts a Steward's question on its task's body: an asteroid, or its project's planet", () => {
    const w = worldWith(question('q-a', 'a-st'), question('q-p', 'a-st-in'));
    expect(questionBody(w, w.questions['q-a']!)).toBe('b-ast-7');
    expect(questionBody(w, w.questions['q-p']!)).toBe('b-jupiter');
    expect(beaconList(w).map((b) => b.bodyId)).toEqual(['b-ast-7', 'b-jupiter']);
  });

  it("puts a Waykeeper's on its project's body and the Harmonizer's on Earth", () => {
    const w = worldWith(question('q-w', 'a-wk-old'), question('q-h', 'a-h'));
    expect(beaconList(w).map((b) => b.bodyId)).toEqual(['b-earth', 'b-jupiter']);
  });

  it('follows a task that moved: the beacon is on its new body', () => {
    const w = worldWith(question('q-a', 'a-st'));
    w.tasks['t-ast'] = { ...w.tasks['t-ast']!, bodyId: 'b-mars' };
    expect(beaconList(w).map((b) => b.bodyId)).toEqual(['b-mars']);
  });

  it("falls back to the question's recorded origin when its agent is not loaded", () => {
    const q = question('q-x', 'a-gone');
    q.context = { text: 'x', origin: { role: 'steward', taskId: 't-ast', recent: [] } };
    const w = worldWith(q);
    expect(beaconList(w).map((b) => b.bodyId)).toEqual(['b-ast-7']);
    q.context = { text: 'x', origin: { role: 'waykeeper', projectId: 'p-big', recent: [] } };
    expect(beaconList(worldWith(q)).map((b) => b.bodyId)).toEqual(['b-jupiter']);
    expect(beaconList(worldWith(question('q-y', 'a-gone')))).toEqual([]);
  });
});

describe('beaconList: which questions', () => {
  it('lights only open questions the user holds', () => {
    const w = worldWith(
      question('q-agent', 'a-st', { holder: { type: 'agent', id: 'a-wk-old' } }),
      question('q-answered', 'a-st', { status: 'answered' }),
      question('q-cancelled', 'a-st', { status: 'cancelled' }),
    );
    expect(beaconList(w)).toEqual([]);
  });

  it('one beacon per body: permission wins the kind, with the count and the inbox order', () => {
    const w = worldWith(
      question('q-c1', 'a-st-in', { createdAt: T(1) }),
      question('q-p2', 'a-wk-old', { kind: 'permission', createdAt: T(3) }),
      question('q-p1', 'a-st-in', { kind: 'permission', createdAt: T(2) }),
    );
    expect(beaconList(w)).toEqual([
      {
        bodyId: 'b-jupiter',
        kind: 'permission',
        count: 3,
        permissions: 2,
        clarifications: 1,
        questionIds: ['q-p1', 'q-p2', 'q-c1'],
      },
    ]);
  });

  it('a body with clarifications only shows a clarification beacon', () => {
    const w = worldWith(question('q-1', 'a-st'));
    expect(beaconFor(w, 'b-ast-7')).toMatchObject({ kind: 'clarification', count: 1 });
    expect(beaconFor(w, 'b-jupiter')).toBeUndefined();
  });
});

describe('beacon lifecycle (events through the client reducer)', () => {
  let seq = 0;
  const apply = (w: WorldState, event: Event): WorldState =>
    applyEvent(w, { seq: ++seq, at: T(5), event });
  const bodies = (w: WorldState) => beaconList(w).map((b) => `${b.bodyId}:${b.kind}:${b.count}`);

  it('appears on escalation to the user, goes on answer, cancel and reassignment away', () => {
    let w = worldWith();
    // A Steward's clarification its Waykeeper holds: not the user's yet.
    w = apply(w, {
      type: 'question.opened',
      question: question('q-1', 'a-st-in', { holder: { type: 'agent', id: 'a-wk-old' } }),
    });
    expect(bodies(w)).toEqual([]);
    w = apply(w, {
      type: 'question.escalated',
      questionId: 'q-1',
      from: { type: 'agent', id: 'a-wk-old' },
      to: { type: 'user' },
      version: 1,
    });
    expect(bodies(w)).toEqual(['b-jupiter:clarification:1']);
    // A permission straight to the user on the same body: one beacon, now a permission, count 2.
    w = apply(w, {
      type: 'question.opened',
      question: question('q-2', 'a-st-in', { kind: 'permission' }),
    });
    expect(bodies(w)).toEqual(['b-jupiter:permission:2']);
    w = apply(w, {
      type: 'question.answered',
      questionId: 'q-2',
      answer: 'yes',
      answeredBy: { type: 'user' },
      version: 1,
    });
    expect(bodies(w)).toEqual(['b-jupiter:clarification:1']);
    w = apply(w, {
      type: 'question.reassigned',
      questionId: 'q-1',
      from: { type: 'user' },
      to: { type: 'agent', id: 'a-wk-new' },
      reason: 'test',
      version: 2,
    });
    expect(bodies(w)).toEqual([]);
    w = apply(w, { type: 'question.opened', question: question('q-3', 'a-st') });
    expect(bodies(w)).toEqual(['b-ast-7:clarification:1']);
    w = apply(w, {
      type: 'question.cancelled',
      questionId: 'q-3',
      agentId: 'a-st',
      reason: 'agent ended',
      version: 1,
    });
    expect(bodies(w)).toEqual([]);
  });
});

describe('sameBeacons', () => {
  it('compares bodies, kinds, counts and questions', () => {
    const a = beaconList(worldWith(question('q-1', 'a-st')));
    expect(sameBeacons(a, beaconList(worldWith(question('q-1', 'a-st'))))).toBe(true);
    expect(sameBeacons(a, beaconList(worldWith(question('q-2', 'a-st'))))).toBe(false);
    expect(
      sameBeacons(a, beaconList(worldWith(question('q-1', 'a-st', { kind: 'permission' })))),
    ).toBe(false);
    expect(sameBeacons(a, [])).toBe(false);
  });
});

describe('beaconCard', () => {
  it('says the first question, who asks and how many more', () => {
    const w = worldWith(
      question('q-c', 'a-st-in', { text: 'Keep the legacy cookie name?', createdAt: T(1) }),
      question('q-p', 'a-st-in', {
        kind: 'permission',
        text: 'Run rm -rf build?',
        createdAt: T(2),
      }),
    );
    expect(beaconCard(w, 'b-jupiter')).toEqual({
      bodyId: 'b-jupiter',
      where: 'Jupiter',
      heading: 'Permission',
      kind: 'permission',
      text: 'Run rm -rf build?',
      asker: expect.stringMatching(/^Steward · /) as unknown as string,
      more: 1,
      questionId: 'q-p',
    });
    const one = worldWith(question('q-h', 'a-h', { text: 'Which repo?' }));
    expect(beaconCard(one, 'b-earth')).toMatchObject({
      heading: 'Question',
      asker: 'Harmonizer',
      more: 0,
    });
    expect(beaconCard(one, 'b-mars')).toBeUndefined();
  });

  it('shortens a long question to one line', () => {
    const text = `${'word '.repeat(40)}end`;
    const card = beaconCard(worldWith(question('q', 'a-st', { text })), 'b-ast-7');
    expect(card?.text.length).toBeLessThanOrEqual(80);
    expect(card?.text.endsWith('…')).toBe(true);
  });
});
