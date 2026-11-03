import { Provider, type ModelChoice } from '@galactic/protocol';
import { DomainError } from '../domain/errors.js';
import type { BrainToolContext } from './definition.js';

/**
 * A brain's provider and model inputs (P11-08): read from a tool call and checked against the
 * provider catalogue before any card is made, so an unknown provider or model, a provider that is
 * not set up, a Gemini step that publishes or an image task on a text model is refused at once,
 * with the reason, and nothing is created.
 */

type Input = Record<string, unknown>;

/** The provider a tool input names under `key`; absent for no value. */
export function providerInput(input: Input, key: string): Provider | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === '') return undefined;
  const parsed = Provider.safeParse(v);
  if (!parsed.success) {
    throw new DomainError(
      'invalid',
      `${key} must be one of ${Provider.options.join(', ')}, not ${JSON.stringify(v)}`,
    );
  }
  return parsed.data;
}

/** The model text a tool input names under `key`; absent for no value. */
export function modelInput(input: Input, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new DomainError('invalid', `${key} must be a string`);
  return v;
}

/**
 * Refuses (a `DomainError` the model reads as `{error, message}`) a provider choice the catalogue
 * cannot run for work that `need`s images or publishes. A model without a provider is refused;
 * with no catalogue wired, the choice is accepted as given. Returns the model to store: the
 * catalogue's listed id for a loose name ("GPT 5.6 terra" → "gpt-5.6-terra").
 */
export async function checkChoice(
  ctx: BrainToolContext,
  choice: { provider?: Provider | undefined; model?: string | undefined },
  need: { images?: boolean; publishes?: boolean } = {},
  where = '',
): Promise<string | undefined> {
  if (choice.model !== undefined && choice.provider === undefined) {
    throw new DomainError('invalid', `${where}a model needs the provider it belongs to`);
  }
  if (choice.provider === undefined || !ctx.catalog) return choice.model;
  const wanted: ModelChoice = {
    provider: choice.provider,
    ...(choice.model !== undefined ? { model: choice.model } : {}),
  };
  const result = await ctx.catalog.check(wanted, need);
  if (!result.ok) throw new DomainError('invalid', `${where}${result.reason}`);
  return result.choice.model;
}
