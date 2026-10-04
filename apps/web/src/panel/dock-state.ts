import { useCallback, useMemo, useState } from 'react';

/**
 * Per browser: the docked conversation's state (P4-10) — open or minimised, and its height as a
 * share of the centre column. A device preference like the scene's and the managed agents'
 * (decisions 62, 69), so it lives in localStorage, not the server.
 */
export const DOCK_KEY = 'galactic.panel.dock';

/** The dock's height, in percent of the centre: clamped so the scene and the chat both stay usable. */
export const DOCK_MIN = 25;
export const DOCK_MAX = 75;
export const DOCK_DEFAULT = 45;
/** One arrow-key press on the handle; Page Up / Page Down move twice as far. */
export const DOCK_STEP = 5;

export interface DockPrefs {
  open: boolean;
  /** Percent of the centre column, within DOCK_MIN–DOCK_MAX. */
  size: number;
}

export function clampDockSize(size: number): number {
  if (!Number.isFinite(size)) return DOCK_DEFAULT;
  return Math.round(Math.min(DOCK_MAX, Math.max(DOCK_MIN, size)));
}

export function readDockPrefs(): DockPrefs {
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    if (!raw) return { open: true, size: DOCK_DEFAULT };
    const parsed = JSON.parse(raw) as Partial<DockPrefs>;
    return {
      open: parsed.open !== false,
      size: clampDockSize(typeof parsed.size === 'number' ? parsed.size : DOCK_DEFAULT),
    };
  } catch {
    return { open: true, size: DOCK_DEFAULT };
  }
}

export function writeDockPrefs(prefs: DockPrefs): void {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify(prefs));
  } catch {
    // No storage (private mode): the choice lasts for this page only.
  }
}

export interface DockControl extends DockPrefs {
  setOpen: (open: boolean) => void;
  /** Sets the height (clamped) and saves it; a drag calls it once, when it ends. */
  setSize: (size: number) => void;
}

export function useDockPrefs(): DockControl {
  const [prefs, setPrefs] = useState(readDockPrefs);
  const setOpen = useCallback((open: boolean) => {
    setPrefs((p) => {
      const next = { ...p, open };
      writeDockPrefs(next);
      return next;
    });
  }, []);
  const setSize = useCallback((size: number) => {
    setPrefs((p) => {
      const next = { ...p, size: clampDockSize(size) };
      writeDockPrefs(next);
      return next;
    });
  }, []);
  return useMemo(() => ({ ...prefs, setOpen, setSize }), [prefs, setOpen, setSize]);
}
