import { create } from 'zustand';

/**
 * Whether the cutaway is on (P6-03): one switch for every body with layer data, remembered for the
 * browser tab's session (`sessionStorage`; a new tab starts with it off). Turning it on in Earth's
 * detail view and then going to Jupiter's shows Jupiter cut open too. No three.js: the toggle in
 * the breadcrumb (panel chunk) and the part in the canvas both read it.
 */
export const CUTAWAY_STORAGE_KEY = 'galactic.scene.cutaway';

function readStored(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(CUTAWAY_STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

function writeStored(on: boolean): void {
  try {
    if (on) globalThis.sessionStorage?.setItem(CUTAWAY_STORAGE_KEY, 'on');
    else globalThis.sessionStorage?.removeItem(CUTAWAY_STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, an iframe): the switch still works for this page.
  }
}

export interface CutawayState {
  on: boolean;
  setOn: (on: boolean) => void;
  toggle: () => void;
}

export const useCutawayStore = create<CutawayState>((set, get) => ({
  on: readStored(),
  setOn: (on) => {
    writeStored(on);
    set({ on });
  },
  toggle: () => get().setOn(!get().on),
}));
