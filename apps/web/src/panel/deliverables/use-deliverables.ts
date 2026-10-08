import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import type { DeliverablesResponse, Id } from '@galactic/protocol';
import { ApiError, type Api } from '../../console/api.js';
import { useApi } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { isLoopbackHostname } from '../../scene/device.js';
import { desktopShell } from '../../desktop-shell.js';
import { useOptionalSettingsData } from '../settings/SettingsData.js';
import { clientRules, type ClientRules } from './deliverables-model.js';

/**
 * The deliverables views' data (P9-09): the rows of a project or task read over REST (they carry
 * the live file facts the world does not), read again whenever the stream changes one of them; the
 * client's rules (decisions 131, 134); the effective IDE's name; and the "⋯ Deliverables" focus
 * request of the navigation.
 */

/** Whose deliverables: a project (its own and its tasks') or a task. */
export type DeliverablesScope =
  { projectId: Id; taskId?: undefined } | { taskId: Id; projectId?: undefined };

const scopeKey = (scope: DeliverablesScope) =>
  scope.taskId !== undefined ? `task:${scope.taskId}` : `project:${scope.projectId}`;

/**
 * A fingerprint of the scope's rows in the world: changes when one is added, edited, removed,
 * restored or moved, or its run changes — the moment to read the list (and its facts) again.
 */
export function scopeStamp(world: Pick<WorldState, 'deliverables'>, scope: DeliverablesScope) {
  const parts: string[] = [];
  for (const d of Object.values(world.deliverables ?? {})) {
    const mine =
      scope.taskId !== undefined ? d.taskId === scope.taskId : d.projectId === scope.projectId;
    if (!mine) continue;
    const run = d.lastRun;
    parts.push(
      `${d.id}:${d.version}:${d.removedAt ?? ''}:${run ? `${run.runId}/${run.state}/${run.ports.join(',')}` : ''}`,
    );
  }
  return parts.sort().join('|');
}

export type ListState =
  | { status: 'loading' }
  /** No deliverables endpoint (an older server, a stand-in api in a component test): nothing shows. */
  | { status: 'unavailable' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: DeliverablesResponse };

export function useDeliverables(
  scope: DeliverablesScope,
  removed: boolean,
): ListState & { reload: () => void } {
  const api = useApi();
  const key = scopeKey(scope);
  const stamp = useAppStore((s) => scopeStamp(s.world, scope));
  const [read, setRead] = useState<{ for: string; state: ListState }>({
    for: '',
    state: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);
  const want = `${key}|${removed ? 1 : 0}`;
  const hasEndpoint = typeof api.deliverables === 'function';
  useEffect(() => {
    if (!hasEndpoint) return;
    let live = true;
    api
      .deliverables({
        ...(scope.taskId !== undefined ? { taskId: scope.taskId } : { projectId: scope.projectId }),
        removed,
      })
      .then(
        (data) => {
          if (!live) return;
          setRead({
            for: want,
            state: Array.isArray(data?.deliverables)
              ? { status: 'ready', data }
              : { status: 'unavailable' },
          });
        },
        (e: unknown) => {
          if (!live) return;
          const missing = e instanceof ApiError && e.status === 404 && e.code !== 'not_found';
          setRead({
            for: want,
            state: missing
              ? { status: 'unavailable' }
              : { status: 'error', error: (e as Error).message },
          });
        },
      );
    return () => {
      live = false;
    };
    // `scope` is read through `want`; the stamp re-reads on every change of the scope's rows.
  }, [api, hasEndpoint, want, stamp, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  // A re-read keeps the rows on screen until it lands ("Show removed" too); a different scope
  // never shows the previous one's rows.
  const shown: ListState = !hasEndpoint
    ? { status: 'unavailable' }
    : read.for === want || (read.for.startsWith(`${key}|`) && read.state.status === 'ready')
      ? read.state
      : { status: 'loading' };
  return { ...shown, reload: () => setAttempt((n) => n + 1) };
}

/** Overrides the client's rules (tests; a story of the phone). */
export const RulesContext = createContext<ClientRules | undefined>(undefined);

/** What this page may do (decisions 131, 134): see `clientRules`. */
export function useClientRules(): ClientRules {
  const forced = useContext(RulesContext);
  const settings = useOptionalSettingsData();
  // A response without `writable` (an older server) says nothing: the Mac's own page only
  // (review N4), never "everyone may edit".
  const writable = settings?.status === 'ready' ? settings.response?.writable : undefined;
  return useMemo(
    () =>
      forced ??
      clientRules({
        loopback: isLoopbackHostname(globalThis.location?.hostname),
        desktop: desktopShell() !== undefined,
        writable,
      }),
    [forced, writable],
  );
}

const ides = new WeakMap<Api, Promise<string | undefined>>();

/** The effective IDE's name ("WebStorm"), read once per panel; `undefined` while unknown. */
export function useIdeName(): string | undefined {
  const api = useApi();
  const [name, setName] = useState<string | undefined>();
  useEffect(() => {
    if (typeof api.ide !== 'function') return;
    let read = ides.get(api);
    if (!read) {
      read = api.ide().then(
        (r) => r?.effective?.name,
        () => undefined,
      );
      ides.set(api, read);
    }
    let live = true;
    void read.then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [api]);
  return name;
}

/**
 * The navigation's "⋯ Deliverables" (P9-09): the view to bring into sight once it is mounted —
 * `project:<id>` (the Waykeeper dock's Deliverables view) or `task:<id>` (the Steward view's
 * section). Taken (cleared) by the view that shows it.
 */
export const useDeliverablesFocus = create<{
  request: string | undefined;
  ask: (key: string) => void;
  take: (key: string) => boolean;
}>((set, get) => ({
  request: undefined,
  ask: (key) => set({ request: key }),
  take: (key) => {
    if (get().request !== key) return false;
    set({ request: undefined });
    return true;
  },
}));

export { scopeKey };
