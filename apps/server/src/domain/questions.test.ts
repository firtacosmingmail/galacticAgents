import { describe, expect, it } from 'vitest';
import type { Actor } from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { DomainError } from './errors.js';
import {
  answerQuestion,
  cancelQuestion,
  escalateQuestion,
  openQuestion,
  reassignQuestion,
} from './questions.js';

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };

/** Harmonizer → Waykeeper → Steward, and a clarification held by the Waykeeper. */
function hierarchy() {
  const w = world();
  const agent = (role: 'harmonizer' | 'waykeeper' | 'steward', supervisorId?: string) =>
    w.run((ctx) =>
      createAgent(ctx, {
        role,
        runtime: 'fake',
        caps: CAPS,
        ...(supervisorId ? { supervisorId } : {}),
      }),
    ).value;
  const harmonizer = agent('harmonizer');
  const waykeeper = agent('waykeeper', harmonizer.id);
  const steward = agent('steward', waykeeper.id);
  const asWaykeeper: Actor = { type: 'agent', id: waykeeper.id };
  const q = w.run((ctx) =>
    openQuestion(ctx, {
      id: 'q-1',
      kind: 'clarification',
      originAgentId: steward.id,
      context: { text: 'Which compression?' },
      holder: asWaykeeper,
    }),
  ).value;
  return { ...w, harmonizer, waykeeper, steward, asWaykeeper, q };
}

describe('answerQuestion', () => {
  it('lets the holding supervisor answer, logged with answeredBy and a bumped version', () => {
    const { run, tables, asWaykeeper } = hierarchy();
    const { value, events } = run((ctx) =>
      answerQuestion(ctx, {
        questionId: 'q-1',
        answer: 'snappy',
        answeredBy: asWaykeeper,
        version: 0,
      }),
    );
    expect(value).toMatchObject({
      status: 'answered',
      answer: 'snappy',
      answeredBy: asWaykeeper,
      version: 1,
    });
    expect(tables.questions.get('q-1')).toEqual(value);
    expect(events).toEqual([
      {
        type: 'question.answered',
        questionId: 'q-1',
        answer: 'snappy',
        answeredBy: asWaykeeper,
        version: 1,
      },
    ]);
  });

  it('first answer wins: a second answer is refused with who answered first', () => {
    const { run, asWaykeeper } = hierarchy();
    run((ctx) => answerQuestion(ctx, { questionId: 'q-1', answer: 'snappy', answeredBy: USER }));
    let error: unknown;
    try {
      run((ctx) =>
        answerQuestion(ctx, { questionId: 'q-1', answer: 'zstd', answeredBy: asWaykeeper }),
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: 'stale',
      message: 'question q-1 was already answered by the user',
    });
  });

  it('refuses an answer against an older version (the question moved meanwhile)', () => {
    const { run, asWaykeeper } = hierarchy();
    run((ctx) => escalateQuestion(ctx, 'q-1', asWaykeeper));
    expect(() =>
      run((ctx) =>
        answerQuestion(ctx, { questionId: 'q-1', answer: 'x', answeredBy: USER, version: 0 }),
      ),
    ).toThrow(/changed since version 0/);
  });

  it('never lets an agent answer a permission question, nor one it does not hold', () => {
    const { run, steward, harmonizer } = hierarchy();
    run((ctx) =>
      openQuestion(ctx, {
        id: 'q-perm',
        kind: 'permission',
        originAgentId: steward.id,
        context: { text: 'May I push?' },
      }),
    );
    const asHarmonizer: Actor = { type: 'agent', id: harmonizer.id };
    expect(() =>
      run((ctx) =>
        answerQuestion(ctx, { questionId: 'q-perm', answer: 'yes', answeredBy: asHarmonizer }),
      ),
    ).toThrow(/policy or the user only/);
    expect(() =>
      run((ctx) =>
        answerQuestion(ctx, { questionId: 'q-1', answer: 'x', answeredBy: asHarmonizer }),
      ),
    ).toThrow(/held by agent/);
    expect(() =>
      run((ctx) =>
        openQuestion(ctx, {
          id: 'q-perm-2',
          kind: 'permission',
          originAgentId: steward.id,
          context: { text: 'rm?' },
          holder: asHarmonizer,
        }),
      ),
    ).toThrow(/held by the user/);
  });

  it('refuses a cancelled question as stale: it was already withdrawn (P9-14)', () => {
    const { run } = hierarchy();
    run((ctx) => cancelQuestion(ctx, 'q-1', 'agent stopped'));
    let error: unknown;
    try {
      run((ctx) => answerQuestion(ctx, { questionId: 'q-1', answer: 'x', answeredBy: USER }));
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'stale', message: 'question q-1 was already withdrawn' });
  });
});

describe('openQuestion', () => {
  it('re-opens a closed id with a higher version, so an old view fails the version check', () => {
    const { run, steward } = hierarchy();
    run((ctx) => answerQuestion(ctx, { questionId: 'q-1', answer: 'snappy', answeredBy: USER }));
    const again = run((ctx) =>
      openQuestion(ctx, {
        id: 'q-1',
        kind: 'clarification',
        originAgentId: steward.id,
        context: { text: 'Which compression, again?' },
      }),
    ).value;
    expect(again).toMatchObject({ status: 'open', version: 2 });
    expect(() =>
      run((ctx) =>
        answerQuestion(ctx, { questionId: 'q-1', answer: 'x', answeredBy: USER, version: 0 }),
      ),
    ).toThrow(/changed since version 0/);
  });
});

describe('escalateQuestion', () => {
  it('climbs the supervisor chain to the user, one level per call', () => {
    const { run, tables, asWaykeeper, harmonizer } = hierarchy();
    const asHarmonizer: Actor = { type: 'agent', id: harmonizer.id };
    expect(run((ctx) => escalateQuestion(ctx, 'q-1', asWaykeeper)).events).toEqual([
      {
        type: 'question.escalated',
        questionId: 'q-1',
        from: asWaykeeper,
        to: asHarmonizer,
        version: 1,
      },
    ]);
    expect(() => run((ctx) => escalateQuestion(ctx, 'q-1', asWaykeeper))).toThrow(/held by agent/);
    expect(run((ctx) => escalateQuestion(ctx, 'q-1', asHarmonizer)).events).toEqual([
      { type: 'question.escalated', questionId: 'q-1', from: asHarmonizer, to: USER, version: 2 },
    ]);
    expect(tables.questions.get('q-1')).toMatchObject({ holder: USER, version: 2 });
    expect(() => run((ctx) => escalateQuestion(ctx, 'q-1', USER))).toThrow(/already with the user/);
  });
});

describe('reassignQuestion', () => {
  it('moves an orphaned question to another holder with question.reassigned', () => {
    const { run, tables, asWaykeeper, harmonizer } = hierarchy();
    const to: Actor = { type: 'agent', id: harmonizer.id };
    const { events } = run((ctx) => reassignQuestion(ctx, 'q-1', to, 'holder stopped'));
    expect(events).toEqual([
      {
        type: 'question.reassigned',
        questionId: 'q-1',
        from: asWaykeeper,
        to,
        reason: 'holder stopped',
        version: 1,
      },
    ]);
    expect(tables.questions.get('q-1')?.holder).toEqual(to);
    expect(() => run((ctx) => reassignQuestion(ctx, 'q-1', to, 'again'))).toThrow(/already held/);
    expect(() =>
      run((ctx) => reassignQuestion(ctx, 'q-1', { type: 'agent', id: 'a-x' }, 'x')),
    ).toThrow(/no agent a-x/);
  });
});

describe('a delivered answer (wave-2 review)', () => {
  it('is recorded even when the holder moved after the check, as the agent has seen it', () => {
    const { run, tables, asWaykeeper, harmonizer } = hierarchy();
    run((ctx) => reassignQuestion(ctx, 'q-1', { type: 'agent', id: harmonizer.id }, 'moved'));
    expect(() =>
      run((ctx) =>
        answerQuestion(ctx, { questionId: 'q-1', answer: 'x', answeredBy: asWaykeeper }),
      ),
    ).toThrow(/held by agent/);
    run((ctx) =>
      answerQuestion(ctx, {
        questionId: 'q-1',
        answer: 'x',
        answeredBy: asWaykeeper,
        delivered: true,
      }),
    );
    expect(tables.questions.get('q-1')).toMatchObject({ status: 'answered', answer: 'x' });
  });
});
