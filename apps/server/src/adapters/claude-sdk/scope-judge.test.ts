import { describe, expect, it } from 'vitest';
import type { ScopeJudgeInput } from '@galactic/protocol';
import { FakeSdk, type FakeAction } from './fake-sdk.js';
import { createSdkScopeJudge } from './scope-judge.js';
import { createFakeScopeJudge } from '../fake/fake-scope-judge.js';

const input: ScopeJudgeInput = {
  flag: 'chrome',
  expectedUse: 'screenshot the dashboard on localhost:5173',
  precedents: ['mcp__claude-in-chrome__navigate to http://localhost:5173/', 'second precedent'],
  toolCall: {
    toolName: 'mcp__claude-in-chrome__browser_batch',
    input: { actions: [{ type: 'navigate', url: 'https://evil.example/x' }] },
  },
};

function setup(actions: FakeAction[] | (() => never)) {
  const sdk = new FakeSdk({
    script: () => (typeof actions === 'function' ? actions() : actions),
    spawnChild: false,
  });
  return { sdk, judge: createSdkScopeJudge({ sdk }) };
}
const signal = () => new AbortController().signal;

describe('SDK scope judge', () => {
  it('reads a consistent verdict', async () => {
    const { judge } = setup([{ text: '{"verdict":"consistent","reason":"localhost screenshot"}' }]);
    expect(await judge.judge(input, signal())).toEqual({
      verdict: 'consistent',
      reason: 'localhost screenshot',
    });
  });

  it('reads JSON wrapped in a code fence', async () => {
    const { judge } = setup([
      { text: '```json\n{"verdict":"off_script","reason":"other site"}\n```' },
    ]);
    expect(await judge.judge(input, signal())).toEqual({
      verdict: 'off_script',
      reason: 'other site',
    });
  });

  it.each(['not json at all', '{"verdict":"maybe","reason":"x"}', '{"verdict":"consistent"}', ''])(
    'treats %j as off_script',
    async (text) => {
      const { judge } = setup([{ text }]);
      const v = await judge.judge(input, signal());
      expect(v.verdict).toBe('off_script');
      expect(v.reason).toMatch(/could not read the check/);
    },
  );

  it('fails closed when the SDK throws', async () => {
    const { judge } = setup([{ throwStream: 'boom' }]);
    const v = await judge.judge(input, signal());
    expect(v.verdict).toBe('off_script');
    expect(v.reason).toMatch(/check failed/);
  });

  it('is off_script when the signal is already aborted', async () => {
    const { judge } = setup([{ text: '{"verdict":"consistent","reason":"x"}' }]);
    const ac = new AbortController();
    ac.abort();
    const v = await judge.judge(input, ac.signal).catch(() => ({ verdict: 'off_script' }));
    expect(v.verdict).toBe('off_script');
  });

  it('sends the approvals and the whole call as data, with no tools', async () => {
    const { sdk, judge } = setup([{ text: '{"verdict":"consistent","reason":"ok"}' }]);
    await judge.judge(input, signal());
    expect(sdk.calls).toHaveLength(1);
    const { prompt, options } = sdk.calls[0]!;
    const text = String(prompt);
    expect(text).toContain(input.expectedUse);
    for (const p of input.precedents) expect(text).toContain(p);
    expect(text).toContain(JSON.stringify(input.toolCall.input));
    expect(text).toContain(input.toolCall.toolName);
    expect(text).toMatch(/untrusted/i);
    expect(options.tools).toEqual([]);
    expect(options.maxTurns).toBe(1);
    expect(options.model).toBe('claude-haiku-5-5');
    expect(options.persistSession).toBe(false);
    expect(typeof options.systemPrompt).toBe('string');
    const deny = await options.canUseTool!('Bash', {}, { signal: signal() });
    expect(deny.behavior).toBe('deny');
  });

  it('takes the model from the factory', async () => {
    const sdk = new FakeSdk({
      script: () => [{ text: '{"verdict":"consistent","reason":"ok"}' }],
      spawnChild: false,
    });
    await createSdkScopeJudge({ sdk, model: 'm-x' }).judge(input, signal());
    expect(sdk.calls[0]!.options.model).toBe('m-x');
  });
});

describe('fake scope judge', () => {
  it('answers from its script', async () => {
    const judge = createFakeScopeJudge(() => ({ verdict: 'consistent', reason: 'scripted' }));
    expect(await judge.judge(input, signal())).toEqual({
      verdict: 'consistent',
      reason: 'scripted',
    });
  });
});
