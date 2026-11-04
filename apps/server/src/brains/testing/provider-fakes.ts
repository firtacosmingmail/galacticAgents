import type { ModelInfo } from '@galactic/protocol';
import { FakeAdapter } from '../../adapters/fake/fake-adapter.js';
import { CLAUDE_MODELS } from '../../adapters/claude-sdk/claude-sdk-adapter.js';
import { ProviderCatalog } from '../../runtime/provider-catalog.js';

/**
 * The three providers as fakes for brain tests (P11-08): Claude's static list, ChatGPT (publishes)
 * and Gemini (its default model makes images; never publishes), with a catalogue over them. The harness runs its
 * brains on its own fake adapter; `adapters` go beside it and `catalog` into `compose`.
 */

const model = (id: string, label: string, family: ModelInfo['family']): ModelInfo => ({
  id,
  label,
  family,
  isDefault: false,
  capabilities: ['text'],
});

export const FAKE_CHATGPT_MODELS: ModelInfo[] = [
  { ...model('gpt-6-luna', 'GPT-6 Luna', 'gpt'), isDefault: true },
  model('gpt-5.6-terra', 'GPT-5.6 Terra', 'gpt'),
];
export const FAKE_GEMINI_MODELS: ModelInfo[] = [
  {
    ...model('gemini-3.8-flash-high', 'Gemini 3.8 Flash High', 'gemini'),
    isDefault: true,
    capabilities: ['text', 'image'],
  },
];

export function providerFakes() {
  const adapters = [
    new FakeAdapter({ speed: 0, runtime: 'codex', models: FAKE_CHATGPT_MODELS, canPublish: true }),
    new FakeAdapter({ speed: 0, runtime: 'agy', models: FAKE_GEMINI_MODELS, canPublish: false }),
    new FakeAdapter({ speed: 0, runtime: 'claude-sdk', models: CLAUDE_MODELS, canPublish: true }),
  ];
  const catalog = new ProviderCatalog({ adapters: () => adapters, settings: () => ({}) });
  return { adapters, catalog, dispose: () => Promise.all(adapters.map((a) => a.dispose())) };
}
