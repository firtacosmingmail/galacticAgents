import type { Id } from '@galactic/protocol';

/**
 * The panel's selection model (P25-02): who the main area shows. The Harmonizer is the default
 * and always one click away (SPEC §4.2); a Waykeeper opens its conversation; a Steward opens its
 * read-only view (decision 13). It lives in the store so the solar-system scene (Phase 3) selects
 * through the same state the side panel does.
 */
export type Selection = { kind: 'harmonizer' } | { kind: 'waykeeper' | 'steward'; id: Id };

/** The compact form: `harmonizer`, `waykeeper:<id>` or `steward:<id>`. */
export type SelectionKey = 'harmonizer' | `waykeeper:${Id}` | `steward:${Id}`;

/**
 * `/` is the panel ("list mode", the only mode for now); `/debug` is the ops console; `/settings`
 * is the settings page (P25-08) and `/history` the history view (P25-10), both shown in the
 * panel's frame.
 */
export type Route = 'panel' | 'debug' | 'settings' | 'history';

export interface PageLocation {
  route: Route;
  selection: Selection;
}

export const HARMONIZER: Selection = { kind: 'harmonizer' };

export function selectionKey(selection: Selection): SelectionKey {
  return selection.kind === 'harmonizer' ? 'harmonizer' : `${selection.kind}:${selection.id}`;
}

export function parseSelectionKey(key: string): Selection | undefined {
  if (key === 'harmonizer') return HARMONIZER;
  const match = /^(waykeeper|steward):(.+)$/.exec(key);
  if (!match) return undefined;
  return { kind: match[1] as 'waykeeper' | 'steward', id: match[2]! };
}

export function sameSelection(a: Selection, b: Selection): boolean {
  return selectionKey(a) === selectionKey(b);
}

/**
 * The URL of a page location: `/`, `/waykeeper/<id>`, `/steward/<id>`, `/debug`, `/settings` or
 * `/history`.
 */
export function pathFor(location: PageLocation): string {
  if (location.route === 'debug') return '/debug';
  if (location.route === 'settings') return '/settings';
  if (location.route === 'history') return '/history';
  const s = location.selection;
  return s.kind === 'harmonizer' ? '/' : `/${s.kind}/${encodeURIComponent(s.id)}`;
}

/** Reads a deep link; anything unrecognised is the panel with the Harmonizer selected. */
export function locationFromPath(pathname: string): PageLocation {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/debug') return { route: 'debug', selection: HARMONIZER };
  if (path === '/settings') return { route: 'settings', selection: HARMONIZER };
  if (path === '/history') return { route: 'history', selection: HARMONIZER };
  const match = /^\/(waykeeper|steward)\/([^/]+)$/.exec(path);
  if (match) {
    let id: string;
    try {
      id = decodeURIComponent(match[2]!);
    } catch {
      return { route: 'panel', selection: HARMONIZER };
    }
    return { route: 'panel', selection: { kind: match[1] as 'waykeeper' | 'steward', id } };
  }
  return { route: 'panel', selection: HARMONIZER };
}

/** The current window's location, or the default outside a browser. */
export function currentLocation(): PageLocation {
  if (typeof window === 'undefined') return { route: 'panel', selection: HARMONIZER };
  return locationFromPath(window.location.pathname);
}
