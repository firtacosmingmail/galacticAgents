import { describe, expect, it } from 'vitest';
import type { RequestJudgeInput } from '@galactic/protocol';
import { createFakeRequestJudge } from './fake-request-judge.js';

const input = {
  request: { toolName: 'Bash', categories: [], parts: [] },
} as unknown as RequestJudgeInput;

describe('fake request judge', () => {
  it('answers from its script', async () => {
    const judge = createFakeRequestJudge(() => ({
      verdict: 'approve',
      reason: 'scripted',
      kind: 'k',
      similarTo: [],
    }));
    expect(await judge.judge(input, new AbortController().signal)).toEqual({
      verdict: 'approve',
      reason: 'scripted',
      kind: 'k',
      similarTo: [],
    });
  });
});
