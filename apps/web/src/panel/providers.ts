import {
  modelChoiceLabel,
  Provider,
  PROVIDER_RUNTIME,
  type Agent,
  type ModelChoice,
} from '@galactic/protocol';

/**
 * How the panel names AI providers (P11-09): the label of a provider and its model ("Gemini",
 * "ChatGPT · gpt-5.6-terra"), and which provider an agent runs on. The model list is not in the
 * client world, so a model shows as the id the card carries.
 */

/** "ChatGPT · gpt-5.6-terra"; `undefined` when the card names no provider. */
export function choiceText(provider: Provider | undefined, model?: string): string | undefined {
  if (!provider) return undefined;
  const choice: ModelChoice = model === undefined ? { provider } : { provider, model };
  return modelChoiceLabel(choice);
}

const PROVIDER_OF_RUNTIME = Object.fromEntries(
  Object.entries(PROVIDER_RUNTIME).map(([provider, runtime]) => [runtime, provider]),
) as Record<string, Provider>;

/** The provider an agent runs on: its `meta.provider`, else the one its runtime belongs to. */
export function agentProvider(agent: Pick<Agent, 'runtime' | 'meta'>): Provider | undefined {
  const named = Provider.safeParse(agent.meta?.['provider']);
  return named.success ? named.data : PROVIDER_OF_RUNTIME[agent.runtime];
}

/** The model an agent runs, when it says (`meta.model`). */
export function agentModel(agent: Pick<Agent, 'meta'>): string | undefined {
  const model = agent.meta?.['model'];
  return typeof model === 'string' && model ? model : undefined;
}

/** Gemini cannot publish: a job on it with no follow-up provider has nobody to publish (R22). */
export function jobPublishesWith(job: {
  provider: Provider;
  followUpProvider?: Provider | undefined;
  followUpModel?: string | undefined;
}): { ok: true; text: string } | { ok: false; text: string } {
  if (job.followUpProvider) {
    return { ok: true, text: choiceText(job.followUpProvider, job.followUpModel)! };
  }
  if (job.provider === 'gemini') return { ok: false, text: 'nobody — Gemini cannot publish' };
  return { ok: true, text: choiceText(job.provider)! };
}
