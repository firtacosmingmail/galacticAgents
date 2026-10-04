import { describe, expect, it } from 'vitest';
import type { Event } from '@galactic/protocol';
import { applyEvent, type WorldState } from '../../state/reduce.js';
import {
  beaconCard,
  beaconFor,
  beaconHq,
  beaconList,
  MAX_BEACONS_PER_BODY,
  questionBody,
  sameBeacons,
} from './beacon-model.js';
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

  it("puts the Harmonizer's on headquarters as given, without reading the status records", () => {
    const w = worldWith(question('q-h', 'a-h'));
    expect(beaconHq(w)).toBe('b-earth');
    expect(beaconList({ ...w, hqBodyId: 'b-mars' }).map((b) => b.bodyId)).toEqual(['b-mars']);
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

  it('one beacon per question: a row on its body in the inbox order (P4-13)', () => {
    const w = worldWith(
      question('q-c1', 'a-st-in', { createdAt: T(1) }),
      question('q-p2', 'a-wk-old', { kind: 'permission', createdAt: T(3) }),
      question('q-p1', 'a-st-in', { kind: 'permission', createdAt: T(2) }),
    );
    expect(beaconList(w)).toEqual([
      { questionId: 'q-p1', bodyId: 'b-jupiter', kind: 'permission', slot: 0, slots: 3, more: 0 },
      { questionId: 'q-p2', bodyId: 'b-jupiter', kind: 'permission', slot: 1, slots: 3, more: 0 },
      {
        questionId: 'q-c1',
        bodyId: 'b-jupiter',
        kind: 'clarification',
        slot: 2,
        slots: 3,
        more: 0,
      },
    ]);
  });

  it('two questions on one body: two beacons with distinct, stable places', () => {
    const qs = [
      question('q-1', 'a-st-in', { createdAt: T(1) }),
      question('q-2', 'a-st-in', { kind: 'permission', createdAt: T(2) }),
    ];
    const first = beaconList(worldWith(...qs));
    expect(first.map((b) => [b.questionId, b.slot, b.slots])).toEqual([
      ['q-2', 0, 2],
      ['q-1', 1, 2],
    ]);
    // Rebuilt from the same questions in another order: the same places.
    expect(sameBeacons(first, beaconList(worldWith(...[...qs].reverse())))).toBe(true);
  });

  it('past a full row, the last beacon carries "+n" for the questions without one', () => {
    const n = MAX_BEACONS_PER_BODY + 3;
    const w = worldWith(
      ...Array.from({ length: n }, (_, i) =>
        question(`q-${i}`, 'a-st-in', { createdAt: `2026-10-03T10:${10 + i}:00.000Z` }),
      ),
    );
    const list = beaconList(w);
    expect(list).toHaveLength(MAX_BEACONS_PER_BODY);
    expect(list.map((b) => b.more)).toEqual([0, 0, 0, 0, 0, 3]);
    expect(list.every((b) => b.slots === MAX_BEACONS_PER_BODY)).toBe(true);
    expect(beaconCard(w, `q-${MAX_BEACONS_PER_BODY - 1}`)?.more).toBe(3);
    expect(beaconCard(w, `q-${n - 1}`)).toBeUndefined(); // no beacon of its own
  });

  it('a clarification shows a clarification beacon', () => {
    const w = worldWith(question('q-1', 'a-st'));
    expect(beaconFor(w, 'q-1')).toMatchObject({ kind: 'clarification', bodyId: 'b-ast-7' });
    expect(beaconFor(w, 'q-none')).toBeUndefined();
  });
});

describe('beacon lifecycle (events through the client reducer)', () => {
  let seq = 0;
  const apply = (w: WorldState, event: Event): WorldState =>
    applyEvent(w, { seq: ++seq, at: T(5), event });
  const beacons = (w: WorldState) =>
    beaconList(w).map((b) => `${b.questionId}@${b.bodyId}:${b.kind}:${b.slot}/${b.slots}`);

  it('each question lights its own beacon and puts out only its own', () => {
    let w = worldWith();
    // A Steward's clarification its Waykeeper holds: not the user's yet.
    w = apply(w, {
      type: 'question.opened',
      question: question('q-1', 'a-st-in', { holder: { type: 'agent', id: 'a-wk-old' } }),
    });
    expect(beacons(w)).toEqual([]);
    w = apply(w, {
      type: 'question.escalated',
      questionId: 'q-1',
      from: { type: 'agent', id: 'a-wk-old' },
      to: { type: 'user' },
      version: 1,
    });
    expect(beacons(w)).toEqual(['q-1@b-jupiter:clarification:0/1']);
    // A permission straight to the user on the same body: a second beacon, first in the row.
    w = apply(w, {
      type: 'question.opened',
      question: question('q-2', 'a-st-in', { kind: 'permission' }),
    });
    expect(beacons(w)).toEqual(['q-2@b-jupiter:permission:0/2', 'q-1@b-jupiter:clarification:1/2']);
    // Answering one puts out only that one.
    w = apply(w, {
      type: 'question.answered',
      questionId: 'q-2',
      answer: 'yes',
      answeredBy: { type: 'user' },
      version: 1,
    });
    expect(beacons(w)).toEqual(['q-1@b-jupiter:clarification:0/1']);
    w = apply(w, {
      type: 'question.reassigned',
      questionId: 'q-1',
      from: { type: 'user' },
      to: { type: 'agent', id: 'a-wk-new' },
      reason: 'test',
      version: 2,
    });
    expect(beacons(w)).toEqual([]);
    w = apply(w, { type: 'question.opened', question: question('q-3', 'a-st') });
    expect(beacons(w)).toEqual(['q-3@b-ast-7:clarification:0/1']);
    w = apply(w, {
      type: 'question.cancelled',
      questionId: 'q-3',
      agentId: 'a-st',
      reason: 'agent ended',
      version: 1,
    });
    expect(beacons(w)).toEqual([]);
  });
});

describe('sameBeacons', () => {
  it('compares questions, bodies, kinds and places', () => {
    const a = beaconList(worldWith(question('q-1', 'a-st')));
    expect(sameBeacons(a, beaconList(worldWith(question('q-1', 'a-st'))))).toBe(true);
    expect(sameBeacons(a, beaconList(worldWith(question('q-2', 'a-st'))))).toBe(false);
    expect(
      sameBeacons(a, beaconList(worldWith(question('q-1', 'a-st', { kind: 'permission' })))),
    ).toBe(false);
    expect(sameBeacons(a, [{ ...a[0]!, slots: 2 }])).toBe(false);
    expect(sameBeacons(a, [])).toBe(false);
  });
});

describe('beaconCard', () => {
  it("says that beacon's question and who asks", () => {
    const w = worldWith(
      question('q-c', 'a-st-in', { text: 'Keep the legacy cookie name?', createdAt: T(1) }),
      question('q-p', 'a-st-in', {
        kind: 'permission',
        text: 'Run rm -rf build?',
        createdAt: T(2),
      }),
    );
    expect(beaconCard(w, 'q-p')).toEqual({
      bodyId: 'b-jupiter',
      where: 'Jupiter',
      heading: 'Permission',
      kind: 'permission',
      text: 'Run rm -rf build?',
      asker: expect.stringMatching(/^Steward · /) as unknown as string,
      more: 0,
      questionId: 'q-p',
    });
    expect(beaconCard(w, 'q-c')).toMatchObject({
      heading: 'Question',
      text: 'Keep the legacy cookie name?',
      more: 0,
    });
    const one = worldWith(question('q-h', 'a-h', { text: 'Which repo?' }));
    expect(beaconCard(one, 'q-h')).toMatchObject({
      bodyId: 'b-earth',
      heading: 'Question',
      asker: 'Harmonizer',
      more: 0,
    });
    expect(beaconCard(one, 'q-none')).toBeUndefined();
  });

  it('shortens a long question to one line', () => {
    const text = `${'word '.repeat(40)}end`;
    const card = beaconCard(worldWith(question('q', 'a-st', { text })), 'q');
    expect(card?.text.length).toBeLessThanOrEqual(80);
    expect(card?.text.endsWith('…')).toBe(true);
  });
});
