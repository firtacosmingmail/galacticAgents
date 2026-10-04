import { create } from 'zustand';

/**
 * Per browser (P5-02): what the dock shows for the Harmonizer or a Waykeeper — the conversation
 * or the status view. A device preference like the dock's height and the scene (decisions 62,
 * 71), so it lives in localStorage, not on the server. One choice for both brains: "I keep the
 * status open" is a habit of the user, not of an agent.
 */
export const DOCK_VIEW_KEY = 'galactic.panel.dock.view';

export type DockView = 'chat' | 'status';

export function readDockView(): DockView {
  try {
    return localStorage.getItem(DOCK_VIEW_KEY) === 'status' ? 'status' : 'chat';
  } catch {
    return 'chat';
  }
}

function writeDockView(view: DockView): void {
  try {
    localStorage.setItem(DOCK_VIEW_KEY, view);
  } catch {
    // No storage (private mode): the choice lasts for this page only.
  }
}

interface DockViewState {
  view: DockView;
  setView: (view: DockView) => void;
  /** Reads the stored choice again (tests, another tab's change). */
  reload: () => void;
}

export const useDockView = create<DockViewState>((set) => ({
  view: readDockView(),
  setView: (view) => {
    writeDockView(view);
    set({ view });
  },
  reload: () => set({ view: readDockView() }),
}));
