import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { PublishContext, publishFingerprint } from './long-term-questions.js';
import {
  LIMIT_WAIT,
  limitSwitchOption,
  modelChoiceLabel,
  normalizeModelName,
  PROVIDER_RUNTIME,
  type ModelInfo,
} from './providers.js';

describe('providers', () => {
  test('provider maps to its runtime', () => {
    expect(PROVIDER_RUNTIME).toEqual({ claude: 'claude-sdk', chatgpt: 'codex', gemini: 'agy' });
  });

  test('labels a choice', () => {
    const models: ModelInfo[] = [
      {
        id: 'claude-opus-4-6-thinking',
        label: 'Claude Opus 4.6',
        isDefault: false,
        capabilities: ['text'],
        family: 'claude',
      },
    ];
    expect(modelChoiceLabel({ provider: 'chatgpt' })).toBe('ChatGPT');
    expect(modelChoiceLabel({ provider: 'chatgpt', model: 'gpt-5.6-terra' })).toBe(
      'ChatGPT · gpt-5.6-terra',
    );
    expect(
      modelChoiceLabel({ provider: 'gemini', model: 'claude-opus-4-6-thinking' }, models),
    ).toBe('Claude Opus 4.6 through Antigravity');
  });

  test('builds limit options', () => {
    expect(LIMIT_WAIT).toBe('Wait until it resets');
    expect(limitSwitchOption({ provider: 'chatgpt' })).toBe('Switch to ChatGPT');
  });

  test('normalizes model names', () => {
    expect(normalizeModelName('Gemini 3.8 Flash')).toBe('gemini-3.8-flash');
    expect(normalizeModelName('GPT_5.6 Terra')).toBe('gpt-5.6-terra');
  });

  test('publish fingerprint changes with the text and with a file hash', () => {
    const h = (s: string) => createHash('sha256').update(s).digest('hex');
    const base = {
      platform: 'LinkedIn',
      account: '@app',
      text: 'Hi',
      files: [{ path: 'a.png', sha256: 'a'.repeat(64) }],
    };
    const f = publishFingerprint(base, h);
    expect(publishFingerprint({ ...base, text: 'Hi!' }, h)).not.toBe(f);
    expect(
      publishFingerprint({ ...base, files: [{ path: 'a.png', sha256: 'b'.repeat(64) }] }, h),
    ).not.toBe(f);
    expect(publishFingerprint({ ...base }, h)).toBe(f);
    expect(PublishContext.safeParse({ ...base, fingerprint: f }).success).toBe(true);
  });
});
