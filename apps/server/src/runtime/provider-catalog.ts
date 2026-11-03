import {
  PROVIDER_LABEL,
  PROVIDER_RUNTIME,
  modelChoiceLabel,
  normalizeModelName,
  type AgentAdapter,
  type ModelChoice,
  type ModelInfo,
  type Provider,
  type ProviderUsage,
  type RuntimePreflight,
} from '@galactic/protocol';
import type { StewardDefaults } from './steward-choice.js';

/**
 * The providers as this server knows them (P11-03; TECHNOLOGY §3.5): each provider's adapter,
 * its model list (cached `ttlMs`, default 5 min), its subscription usage, its default model and
 * whether a choice can run here. `check` is what every provider choice passes before a card is
 * made or a Steward spawned: a loose model name resolves to one listed model or is refused with
 * the list, and a provider that is not set up (no adapter, or its runtime check fails) is refused
 * with the problem and its fix. Nothing here speaks to a CLI: the adapters do.
 */

export interface ProviderCatalogOptions {
  /** The registered adapters, read at every call (a provider's runtime is `PROVIDER_RUNTIME`). */
  adapters: () => AgentAdapter[];
  /** The Settings now: `defaultProvider` and `providers.<p>.model`. */
  settings: () => StewardDefaults;
  /** How long a model list is kept (default 5 min). */
  ttlMs?: number;
  /** How long a runtime check is kept (default 30 s, as the panel's preflight). */
  preflightTtlMs?: number;
  /** Tests: the clock, in ms. */
  now?: () => number;
}

export type CatalogCheck =
  | { ok: true; choice: { provider: Provider; model?: string }; label: string }
  | { ok: false; reason: string };

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_PREFLIGHT_TTL_MS = 30_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export class ProviderCatalog {
  private readonly ttlMs: number;
  private readonly preflightTtlMs: number;
  private readonly now: () => number;
  private readonly lists = new Map<Provider, Cached<ModelInfo[]>>();
  private readonly checks = new Map<Provider, Cached<RuntimePreflight | undefined>>();

  constructor(private readonly opts: ProviderCatalogOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.preflightTtlMs = opts.preflightTtlMs ?? DEFAULT_PREFLIGHT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** The Settings the resolver reads (`stewardChooser`'s `defaults`). */
  defaults(): StewardDefaults {
    return this.opts.settings();
  }

  /** Whether `provider` has an adapter on this server. */
  available(provider: Provider): boolean {
    return this.adapterOf(provider) !== undefined;
  }

  /** The models the provider's CLI lists; `[]` without an adapter or a list. Never throws. */
  models(provider: Provider): Promise<ModelInfo[]> {
    return this.cached(this.lists, provider, this.ttlMs, async () => {
      const adapter = this.adapterOf(provider);
      try {
        return (await adapter?.models?.()) ?? [];
      } catch {
        return [];
      }
    });
  }

  /** The subscription's plan and quota windows, when the adapter reports them. Never throws. */
  async usage(provider: Provider): Promise<ProviderUsage | undefined> {
    try {
      return await this.adapterOf(provider)?.usage?.();
    } catch {
      return undefined;
    }
  }

  /** The model a Steward of `provider` runs when none is named: the Settings', else the CLI's. */
  async defaultModel(provider: Provider): Promise<string | undefined> {
    const configured = this.opts.settings().providers?.[provider]?.model;
    if (configured) return configured;
    return (await this.models(provider)).find((m) => m.isDefault)?.id;
  }

  /**
   * Whether `choice` can run here, for work that `need`s images or publishes. A named model is
   * matched loosely (`normalizeModelName`) against each listed model's id and label; an empty list
   * (a CLI that cannot list) accepts the name as given.
   */
  async check(
    choice: ModelChoice,
    need: { images?: boolean; publishes?: boolean } = {},
    opts: { bare?: boolean } = {},
  ): Promise<CatalogCheck> {
    const { provider } = choice;
    const name = PROVIDER_LABEL[provider];
    const adapter = this.adapterOf(provider);
    if (!adapter) {
      return {
        ok: false,
        reason: `${name} is not set up on this Mac: no ${PROVIDER_RUNTIME[provider]} runtime is registered`,
      };
    }
    const problem = await this.problem(provider, opts.bare ?? false);
    if (problem) return { ok: false, reason: `${name} is not set up on this Mac: ${problem}` };

    const models = await this.models(provider);
    let info: ModelInfo | undefined;
    let model: string | undefined;
    if (choice.model !== undefined) {
      const wanted = normalizeModelName(choice.model);
      info = models.find(
        (m) => normalizeModelName(m.id) === wanted || normalizeModelName(m.label) === wanted,
      );
      if (!info && models.length > 0) {
        return {
          ok: false,
          reason: `${name} has no model "${choice.model}". Available: ${models.map((m) => m.id).join(', ')}`,
        };
      }
      model = info?.id ?? choice.model;
    }
    const resolved = { provider, ...(model !== undefined ? { model } : {}) };
    const label = modelChoiceLabel(resolved, models);
    if (need.images) {
      // The model that would run: the one named, else the default; unknown, any listed model.
      const fallback = await this.defaultModel(provider);
      const runs = info ?? models.find((m) => m.id === fallback);
      const candidates = runs ? [runs] : models;
      if (!candidates.some((m) => m.capabilities.includes('image'))) {
        return { ok: false, reason: `${label} cannot make images` };
      }
    }
    if (need.publishes && adapter.canPublish !== true) {
      return {
        ok: false,
        reason: `${label} cannot publish: GalacticAgents cannot hold its actions back yet`,
      };
    }
    return { ok: true, choice: resolved, label };
  }

  private adapterOf(provider: Provider): AgentAdapter | undefined {
    return this.opts.adapters().find((a) => a.runtime === PROVIDER_RUNTIME[provider]);
  }

  /**
   * What definitely stops the provider here, with its fixes; `undefined` otherwise. Only
   * `not_installed` and `not_logged_in` block (a `bare` spawn does not use the subscription
   * login, so only `not_installed`): an uncertain result — an unreadable login, a check that
   * failed or timed out, a warning — lets the spawn go ahead, as the Harmonizer's does.
   */
  private async problem(provider: Provider, bare: boolean): Promise<string | undefined> {
    const result = await this.cached(this.checks, provider, this.preflightTtlMs, async () => {
      try {
        return await this.adapterOf(provider)?.preflight?.();
      } catch (error) {
        return {
          runtime: PROVIDER_RUNTIME[provider],
          ok: false,
          installed: false,
          problems: [
            {
              code: 'check_failed' as const,
              severity: 'error' as const,
              message: `its check failed: ${(error as Error).message}`,
            },
          ],
        };
      }
    });
    if (!result || result.ok) return undefined;
    const blocking = new Set(bare ? ['not_installed'] : ['not_installed', 'not_logged_in']);
    const shown = result.problems.filter((p) => p.severity === 'error' && blocking.has(p.code));
    if (shown.length === 0) return undefined;
    return shown.map((p) => (p.fix ? `${p.message} (${p.fix})` : p.message)).join('; ');
  }

  private cached<T>(
    cache: Map<Provider, Cached<T>>,
    provider: Provider,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const now = this.now();
    const hit = cache.get(provider);
    if (hit && now - hit.at <= ttlMs) return hit.value;
    const value = load();
    cache.set(provider, { at: now, value });
    return value;
  }
}
