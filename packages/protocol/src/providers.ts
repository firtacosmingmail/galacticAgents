import { z } from 'zod';
import type { AgentRuntime } from './enums.js';
import { Id } from './primitives.js';

/**
 * AI providers (P11-02): a provider is the CLI that runs a Steward — Claude Code (`claude`),
 * Codex CLI (`chatgpt`) or Antigravity CLI (`gemini`). A leaf module: it needs only primitives.
 */

export const Provider = z.enum(['claude', 'chatgpt', 'gemini']);
export type Provider = z.infer<typeof Provider>;

/** The runtime each provider's Stewards run on. */
export const PROVIDER_RUNTIME: Record<Provider, AgentRuntime> = {
  claude: 'claude-sdk',
  chatgpt: 'codex',
  gemini: 'agy',
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
};

/** A provider, and optionally one of its models (absent: the provider's default model). */
export const ModelChoice = z.object({
  provider: Provider,
  model: z.string().min(1).max(100).optional(),
});
export type ModelChoice = z.infer<typeof ModelChoice>;

export const ModelCapability = z.enum(['text', 'image']);
export type ModelCapability = z.infer<typeof ModelCapability>;

/** One model a provider's CLI lists. */
export const ModelInfo = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean().default(false),
  capabilities: z.array(ModelCapability).min(1),
  family: z.enum(['claude', 'gpt', 'gemini', 'other']),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** One quota window of a subscription (e.g. "5 hours"). */
export const UsageWindow = z.object({
  label: z.string(),
  remainingFraction: z.number().min(0).max(1),
  resetsAt: z.string().datetime().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const ProviderUsage = z.object({
  plan: z.string().optional(),
  windows: z.array(UsageWindow),
});
export type ProviderUsage = z.infer<typeof ProviderUsage>;

/** "ChatGPT", "ChatGPT · gpt-5.6-terra", or "<label> through Antigravity" for a foreign family. */
export function modelChoiceLabel(choice: ModelChoice, models?: ModelInfo[]): string {
  const base = PROVIDER_LABEL[choice.provider];
  if (choice.model === undefined) return base;
  const info = models?.find((m) => m.id === choice.model);
  if (choice.provider === 'gemini' && info && (info.family === 'claude' || info.family === 'gpt')) {
    return `${info.label} through Antigravity`;
  }
  return `${base} · ${info?.label ?? choice.model}`;
}

/**
 * Lower-case; spaces and underscores become `-`; a dot between letters and digits (not between
 * two digits) becomes `-`. "Gemini 3.8 Flash" → "gemini-3.8-flash".
 */
export function normalizeModelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/(?<=[a-z])\.(?=\d)|(?<=\d)\.(?=[a-z])/g, '-');
}

/** What a usage-limit question carries: who hit the limit and the models it could switch to. */
export const UsageLimitContext = z.object({
  provider: Provider,
  model: z.string().optional(),
  resetsAt: z.string().datetime().optional(),
  taskId: Id.optional(),
  jobId: Id.optional(),
  runId: Id.optional(),
  switchTo: z.array(ModelChoice).max(12),
});
export type UsageLimitContext = z.infer<typeof UsageLimitContext>;

export const LIMIT_WAIT = 'Wait until it resets';

export function limitSwitchOption(choice: ModelChoice, models?: ModelInfo[]): string {
  return `Switch to ${modelChoiceLabel(choice, models)}`;
}
