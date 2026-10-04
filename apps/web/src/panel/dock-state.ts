import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDockView } from './status/dock-view.js';

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

/** The mounted docks' "restore" handlers (`requestDockOpen`). */
const openRequests = new Set<() => void>();

/**
 * Restores the docked conversation from outside the panel (P6-05: a click on the scene's HQ
 * station opens the Harmonizer's chat). The mounted dock restores (and remembers it, like its own
 * button); with none mounted, the stored preference is set to open for the next one.
 */
export function requestDockOpen(): void {
  if (openRequests.size > 0) {
    openRequests.forEach((restore) => restore());
    return;
  }
  const prefs = readDockPrefs();
  if (!prefs.open) writeDockPrefs({ ...prefs, open: true });
}

/**
 * Shows the conversation of the selected brain: the dock restored if minimised (decision 71) and
 * its "Chat | Status" switch on Chat (decision 80). Used with the Harmonizer selected by the HQ
 * station's click (P6-05).
 */
export function revealChat(): void {
  requestDockOpen();
  if (useDockView.getState().view !== 'chat') useDockView.getState().setView('chat');
}

export function useDockPrefs(): DockControl {
  const [prefs, setPrefs] = useState(readDockPrefs);
  const setOpen = useCallback((open: boolean) => {
    setPrefs((p) => {
      if (p.open === open) return p;
      const next = { ...p, open };
      writeDockPrefs(next);
      return next;
    });
  }, []);
  useEffect(() => {
    const restore = () => setOpen(true);
    openRequests.add(restore);
    return () => void openRequests.delete(restore);
  }, [setOpen]);
  const setSize = useCallback((size: number) => {
    setPrefs((p) => {
      const next = { ...p, size: clampDockSize(size) };
      writeDockPrefs(next);
      return next;
    });
  }, []);
  return useMemo(() => ({ ...prefs, setOpen, setSize }), [prefs, setOpen, setSize]);
}
