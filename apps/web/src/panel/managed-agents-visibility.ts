import { useCallback, useMemo, useState } from 'react';

/**
 * Per browser: whether the managed-agents section of the panel's side column is shown (P4-09).
 * A device preference like the scene's (decision 62), so it lives in localStorage, not the server.
 */
export const MANAGED_AGENTS_VISIBLE_KEY = 'galactic.panel.managedAgents.visible';

export function readManagedAgentsVisible(): boolean {
  try {
    return localStorage.getItem(MANAGED_AGENTS_VISIBLE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeManagedAgentsVisible(visible: boolean): void {
  try {
    localStorage.setItem(MANAGED_AGENTS_VISIBLE_KEY, visible ? '1' : '0');
  } catch {
    // No storage (private mode): the choice lasts for this page only.
  }
}

export interface ManagedAgentsControl {
  /** Shown (the default) or hidden; remembered in this browser. */
  visible: boolean;
  setVisible: (visible: boolean) => void;
}

export function useManagedAgentsVisibility(): ManagedAgentsControl {
  const [visible, setVisibleState] = useState(readManagedAgentsVisible);
  const setVisible = useCallback((next: boolean) => {
    writeManagedAgentsVisible(next);
    setVisibleState(next);
  }, []);
  // Stable while nothing changes, so the memoised side column skips unrelated renders.
  return useMemo(() => ({ visible, setVisible }), [visible, setVisible]);
}
