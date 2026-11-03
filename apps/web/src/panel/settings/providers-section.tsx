import { useEffect, useState } from 'react';
import {
  PROVIDER_LABEL,
  Provider,
  type ModelInfo,
  type PreflightResponse,
  type Settings,
} from '@galactic/protocol';
import { useApi } from '../../console/hierarchy/shared.js';
import type { EditorProps, SectionSpec } from './sections.js';

/**
 * The AI providers section (P11-09; SPEC decision 109): which provider new Stewards use when
 * nothing names one, and each provider's default model. The first-run wizard does not show it.
 */

const PROVIDERS_IN_ORDER = Provider.options;

/** The draft: the default provider and each provider's default model (`''` = the CLI's own). */
export interface ProvidersDraft {
  defaultProvider: Provider;
  models: Record<Provider, string>;
}

function providersDraft(s: Settings): ProvidersDraft {
  return {
    defaultProvider: s.defaultProvider ?? 'claude',
    models: {
      claude: s.providers?.claude?.model ?? '',
      chatgpt: s.providers?.chatgpt?.model ?? '',
      gemini: s.providers?.gemini?.model ?? '',
    },
  };
}

/** What a draft changes: only the default provider and the models that differ from the saved. */
function providersPatch(draft: ProvidersDraft, saved: Settings) {
  const before = providersDraft(saved);
  const providers: Partial<Record<Provider, { model: string | null }>> = {};
  for (const p of PROVIDERS_IN_ORDER) {
    if (draft.models[p] !== before.models[p]) providers[p] = { model: draft.models[p] || null };
  }
  return {
    ...(draft.defaultProvider !== before.defaultProvider
      ? { defaultProvider: draft.defaultProvider === 'claude' ? null : draft.defaultProvider }
      : {}),
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
  };
}

/** The preflight, read once (the server caches it); `undefined` until it answers or if it fails. */
function usePreflight(): PreflightResponse | undefined {
  const api = useApi();
  const [result, setResult] = useState<PreflightResponse>();
  useEffect(() => {
    let cancelled = false;
    api.preflight().then(
      (r) => {
        if (!cancelled) setResult(r);
      },
      () => {
        // Unreadable: only the current choices are offered.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  return result;
}

function ProvidersEditor({ id, draft, setDraft, disabled, settings }: EditorProps<ProvidersDraft>) {
  const preflight = usePreflight();
  const row = (p: Provider) => preflight?.runtimes.find((r) => r.provider === p);
  const setUp = (p: Provider) => row(p)?.ok === true;
  const saved = providersDraft(settings);
  // Only providers that are set up, plus the current value (set outside the panel, or since
  // logged out), which stays shown until another is chosen.
  const offered = PROVIDERS_IN_ORDER.filter(
    (p) => setUp(p) || p === saved.defaultProvider || p === draft.defaultProvider,
  );
  return (
    <div className="set-field">
      <fieldset className="set-field set-radios" disabled={disabled}>
        <legend>Default provider</legend>
        {offered.map((p) => (
          <label key={p} className="set-radio">
            <input
              type="radio"
              name={`${id}-provider`}
              value={p}
              checked={draft.defaultProvider === p}
              onChange={() => setDraft({ ...draft, defaultProvider: p })}
            />
            <span>
              <strong>{PROVIDER_LABEL[p]}</strong>
              {!setUp(p) && preflight && <span className="set-muted"> — not set up</span>}
            </span>
          </label>
        ))}
      </fieldset>
      {PROVIDERS_IN_ORDER.map((p) => {
        const info = row(p);
        if (!info && !draft.models[p]) return null;
        const models: ModelInfo[] = info?.models ?? [];
        const current = draft.models[p];
        const known = current === '' || models.some((m) => m.id === current);
        return (
          <div key={p} className="set-inline set-provider-model">
            <label htmlFor={`${id}-model-${p}`}>{PROVIDER_LABEL[p]} default model</label>
            <select
              id={`${id}-model-${p}`}
              value={current}
              disabled={disabled}
              onChange={(e) =>
                setDraft({ ...draft, models: { ...draft.models, [p]: e.target.value } })
              }
            >
              <option value="">CLI default</option>
              {!known && <option value={current}>{current} (set outside the panel)</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}

export const PROVIDERS: SectionSpec<ProvidersDraft> = {
  field: 'providers',
  title: 'AI providers',
  intro:
    'Which AI tool new Stewards use when a request names none, and the model each tool starts with. Each tool signs in with your own subscription; its login, plan and limits are shown in the runtime check above. A Steward can still be given another provider or model for one project or task. The Harmonizer and Waykeepers always run on Claude Code.',
  fromSettings: providersDraft,
  validate: () => undefined,
  toPatch: providersPatch,
  Editor: ProvidersEditor,
};
