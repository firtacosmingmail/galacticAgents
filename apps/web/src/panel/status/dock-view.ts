import { create } from 'zustand';

/**
 * Per browser (P5-02): what the dock shows for the Harmonizer or a Waykeeper — the conversation
 * or the status view. A device preference like the dock's height and the scene (decisions 62,
 * 71), so it lives in localStorage, not on the server. One choice for both brains: "I keep the
 * status open" is a habit of the user, not of an agent.
 *
 * A transient override (P6-05 review: the HQ station's click shows the Harmonizer's chat) shows a
 * view without storing it: `view` is the override while there is one, else the stored choice; the
 * override ends when the user picks a view (`setView`, stored as usual) or the selection changes
 * (`endTransient`, called by `revealChat`'s watcher in `dock-state.ts`).
 */
export const DOCK_VIEW_KEY = 'galactic.panel.dock.view';

export type DockView = 'chat' | 'status' | 'deliverables';

/**
 * The stored choice. `deliverables` (P9-09) is a project's third view ("Chat | Status |
 * Deliverables"); the Harmonizer has no Deliverables view and shows its chat meanwhile
 * (`brainView`).
 */
export function readDockView(): DockView {
  try {
    const v = localStorage.getItem(DOCK_VIEW_KEY);
    return v === 'status' || v === 'deliverables' ? v : 'chat';
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

/** What a brain's dock shows for `view`: only a Waykeeper has the Deliverables view. */
export function brainView(view: DockView, role: 'harmonizer' | 'waykeeper'): DockView {
  return view === 'deliverables' && role !== 'waykeeper' ? 'chat' : view;
}

interface DockViewState {
  /** What the dock shows: the transient override if any, else the stored choice. */
  view: DockView;
  /** The user's stored choice. */
  stored: DockView;
  /** The transient override, not stored (`undefined`: none). */
  transient: DockView | undefined;
  /** The user's choice: stored, and it ends any transient override. */
  setView: (view: DockView) => void;
  /** Shows `view` for now without storing it (until `setView` or `endTransient`). */
  showTransient: (view: DockView) => void;
  /** Ends the transient override: the stored choice shows again. */
  endTransient: () => void;
  /** Reads the stored choice again, dropping any override (tests, another tab's change). */
  reload: () => void;
}

export const useDockView = create<DockViewState>((set) => {
  const stored = readDockView();
  return {
    view: stored,
    stored,
    transient: undefined,
    setView: (view) => {
      writeDockView(view);
      set({ view, stored: view, transient: undefined });
    },
    showTransient: (view) => set({ view, transient: view }),
    endTransient: () =>
      set((s) => (s.transient === undefined ? s : { view: s.stored, transient: undefined })),
    reload: () => {
      const view = readDockView();
      set({ view, stored: view, transient: undefined });
    },
  };
});
