import { describe, expect, it } from 'vitest';
import { resolveStewardChoice, stewardChooser } from './steward-choice.js';

const none = () => undefined;

describe('resolveStewardChoice (P11-03)', () => {
  it('follow-up uses its own provider', () => {
    const job = { provider: 'gemini' as const, followUpProvider: 'chatgpt' as const };
    expect(resolveStewardChoice({ job, followUp: true, defaultModel: none })).toEqual({
      provider: 'chatgpt',
      runtime: 'codex',
    });
    // A normal run of the same job keeps the job's provider.
    expect(resolveStewardChoice({ job, defaultModel: none })).toEqual({
      provider: 'gemini',
      runtime: 'agy',
    });
    // A follow-up of a job without its own follow-up provider runs on the job's.
    expect(
      resolveStewardChoice({ job: { provider: 'gemini' }, followUp: true, defaultModel: none }),
    ).toEqual({ provider: 'gemini', runtime: 'agy' });
  });

  it('task beats job beats project beats settings', () => {
    const task = { provider: 'chatgpt' as const, model: 'gpt-5.6-terra' };
    const job = { provider: 'gemini' as const, model: 'gemini-3.8-flash-high' };
    const project = { defaultProvider: 'claude' as const };
    const all = { task, job, project, defaultProvider: 'gemini' as const, defaultModel: none };
    expect(resolveStewardChoice(all)).toEqual({
      provider: 'chatgpt',
      runtime: 'codex',
      model: 'gpt-5.6-terra',
    });
    expect(resolveStewardChoice({ ...all, task: {} })).toEqual({
      provider: 'gemini',
      runtime: 'agy',
      model: 'gemini-3.8-flash-high',
    });
    expect(resolveStewardChoice({ ...all, task: {}, job: {} })).toEqual({
      provider: 'claude',
      runtime: 'claude-sdk',
    });
    expect(resolveStewardChoice({ ...all, task: {}, job: {}, project: {} })).toEqual({
      provider: 'gemini',
      runtime: 'agy',
    });
  });

  it('named provider without model takes the default model', () => {
    const defaultModel = (p: string) => (p === 'gemini' ? 'gemini-3.8-flash-high' : undefined);
    expect(resolveStewardChoice({ task: { provider: 'gemini' }, defaultModel })).toEqual({
      provider: 'gemini',
      runtime: 'agy',
      model: 'gemini-3.8-flash-high',
    });
    // A model the chosen layer names wins over the provider's default.
    expect(
      resolveStewardChoice({ task: { provider: 'gemini', model: 'gemini-4-pro' }, defaultModel }),
    ).toEqual({ provider: 'gemini', runtime: 'agy', model: 'gemini-4-pro' });
    // A provider without a default model runs the CLI's own default.
    expect(resolveStewardChoice({ task: { provider: 'chatgpt' }, defaultModel })).toEqual({
      provider: 'chatgpt',
      runtime: 'codex',
    });
  });

  it('nothing named means claude', () => {
    expect(resolveStewardChoice({ defaultModel: none })).toEqual({
      provider: 'claude',
      runtime: 'claude-sdk',
    });
    expect(
      resolveStewardChoice({ task: {}, project: {}, defaultModel: (p) => `${p}-default` }),
    ).toEqual({ provider: 'claude', runtime: 'claude-sdk', model: 'claude-default' });
  });
});

describe('stewardChooser (P11-03)', () => {
  it('reads the settings at every choice', () => {
    let settings: { defaultProvider?: 'chatgpt'; providers?: { chatgpt?: { model?: string } } } =
      {};
    const choose = stewardChooser({ defaults: () => settings });
    expect(choose({})).toEqual({ provider: 'claude', runtime: 'claude-sdk' });
    settings = { defaultProvider: 'chatgpt', providers: { chatgpt: { model: 'gpt-5.6-terra' } } };
    expect(choose({})).toEqual({ provider: 'chatgpt', runtime: 'codex', model: 'gpt-5.6-terra' });
  });

  it('the dev override decides the runtime; a fake brain keeps its Claude Stewards on fake', () => {
    let override: 'fake' | undefined = 'fake';
    const choose = stewardChooser({ override: () => override });
    expect(choose({ task: { provider: 'chatgpt' } })).toEqual({
      provider: 'chatgpt',
      runtime: 'fake',
    });
    override = undefined;
    expect(choose({ supervisorRuntime: 'fake' })).toEqual({ provider: 'claude', runtime: 'fake' });
    expect(choose({ supervisorRuntime: 'claude-sdk' })).toEqual({
      provider: 'claude',
      runtime: 'claude-sdk',
    });
    // A provider named for the task is honoured even under a fake brain.
    expect(choose({ task: { provider: 'chatgpt' }, supervisorRuntime: 'fake' })).toEqual({
      provider: 'chatgpt',
      runtime: 'codex',
    });
  });
});
