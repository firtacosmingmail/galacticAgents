import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SettingsPatch, SettingsResponse } from '@galactic/protocol';
import { ApiError, type Api } from '../../console/api.js';
import { isSettingsResponse } from './settings-model.js';

/**
 * The settings as the server holds them (P25-08), read once per panel and shared by the settings
 * page and the first-run gate. Every write goes through `patch`, whose reply replaces the copy.
 *
 * - `loading`: the first read is in flight;
 * - `ready`: `response` is the server's;
 * - `unavailable`: the server has no settings endpoint (an older or a test server) — the panel
 *   works without the page, and no wizard is forced on anyone;
 * - `error`: the read failed (shown on the page, with a retry).
 */
export interface SettingsData {
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  response?: SettingsResponse;
  error?: string;
  reload: () => void;
  /** Sends a patch; resolves with the new settings or rejects with the refusal (`ApiError`). */
  patch: (patch: SettingsPatch) => Promise<SettingsResponse>;
}

const SettingsContext = createContext<SettingsData | undefined>(undefined);

export function useSettingsData(): SettingsData {
  const data = useContext(SettingsContext);
  if (!data) throw new Error('useSettingsData outside <SettingsProvider>');
  return data;
}

/** The settings when a provider is there (a view also rendered outside the panel), else none. */
export function useOptionalSettingsData(): SettingsData | undefined {
  return useContext(SettingsContext);
}

export function SettingsProvider({ api, children }: { api: Api; children: ReactNode }) {
  const [state, setState] = useState<Pick<SettingsData, 'status' | 'response' | 'error'>>({
    status: 'loading',
  });
  const [attempt, setAttempt] = useState(0);

  // A stand-in api without the method (component tests) has no settings at all.
  const hasEndpoint = typeof api.settings === 'function';

  useEffect(() => {
    if (!hasEndpoint) return;
    let cancelled = false;
    api.settings().then(
      (response) => {
        if (cancelled) return;
        setState(
          isSettingsResponse(response) ? { status: 'ready', response } : { status: 'unavailable' },
        );
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) setState({ status: 'unavailable' });
        else setState({ status: 'error', error: (error as Error).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, hasEndpoint, attempt]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, status: s.response ? s.status : 'loading' }));
    setAttempt((n) => n + 1);
  }, []);

  const patch = useCallback(
    async (body: SettingsPatch) => {
      const response = await api.patchSettings(body);
      setState({ status: 'ready', response });
      return response;
    },
    [api],
  );

  const value = useMemo(
    (): SettingsData => ({
      ...(hasEndpoint ? state : { status: 'unavailable' }),
      reload,
      patch,
    }),
    [hasEndpoint, state, reload, patch],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
