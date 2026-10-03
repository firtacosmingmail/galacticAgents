import { create } from 'zustand';
import { useAppStore } from '../../state/store.js';
import { selectionKey, type Selection, type SelectionKey } from '../../state/selection.js';
import { useCameraStore } from '../camera/store.js';
import { bodyAction, bodyName, type BodyAction } from './body-action.js';

/**
 * Picking's state outside the canvas (P3-05): what the pointer is over (the hover label) and the
 * popover over the scene (a body's info, or the "what's here" list of corner case 24). The canvas
 * part (`Picking.tsx`) writes it; the overlay (`PickingOverlay.tsx`, ordinary DOM over the canvas)
 * reads it. No three.js: this module is in the panel's chunk.
 *
 * Positions are in CSS pixels from the scene area's top-left corner (the canvas fills the area).
 */
export interface Point {
  x: number;
  y: number;
}

export interface Hover extends Point {
  bodyId: string;
  name: string;
  /** How many other bodies are under the pointer too ("+2"). */
  others: number;
}

export type Popover =
  | (Point & { kind: 'info'; action: Extract<BodyAction, { kind: 'info' }> })
  | (Point & { kind: 'here'; bodies: { bodyId: string; name: string }[] });

export interface PickingState {
  hover: Hover | undefined;
  popover: Popover | undefined;
  setHover: (hover: Hover | undefined) => void;
  showHere: (at: Point, bodyIds: string[]) => void;
  closePopover: () => void;
}

export const usePickingStore = create<PickingState>((set, get) => ({
  hover: undefined,
  popover: undefined,
  setHover: (hover) => {
    const was = get().hover;
    if (was === hover) return;
    if (
      was &&
      hover &&
      was.bodyId === hover.bodyId &&
      was.others === hover.others &&
      was.x === hover.x &&
      was.y === hover.y
    ) {
      return;
    }
    set({ hover });
  },
  showHere: (at, bodyIds) => {
    const world = useAppStore.getState().world;
    set({
      popover: {
        kind: 'here',
        ...at,
        bodies: bodyIds.map((bodyId) => ({ bodyId, name: bodyName(world, bodyId) })),
      },
    });
  },
  closePopover: () => {
    if (get().popover) set({ popover: undefined });
  },
}));

/**
 * The selection the scene itself just made, so the panel → scene sync (`sync.ts`) does not fly a
 * second time for it. Set and cleared around the (synchronous) store update.
 */
let sceneSelection: SelectionKey | undefined;

export function isSceneSelection(selection: Selection): boolean {
  return sceneSelection !== undefined && sceneSelection === selectionKey(selection);
}

/** Selects from the scene: the panel follows, the sync leaves the camera alone. */
export function selectFromScene(selection: Selection): void {
  sceneSelection = selectionKey(selection);
  try {
    useAppStore.getState().navigate({ route: 'panel', selection });
  } finally {
    sceneSelection = undefined;
  }
}

/**
 * Activates a body (a click, a choice in the "what's here" list, Enter on the focused body): flies
 * the camera there and either selects who works on it or shows what it is (`bodyAction`).
 * `fly: false` when the camera is already there (Enter on the camera's focus).
 */
export function activateBody(bodyId: string, at: Point, opts: { fly?: boolean } = {}): BodyAction {
  const action = bodyAction(useAppStore.getState().world, bodyId);
  const picking = usePickingStore.getState();
  if (opts.fly !== false) useCameraStore.getState().flyTo(bodyId);
  if (action.kind === 'select') {
    picking.closePopover();
    selectFromScene(action.selection);
  } else {
    usePickingStore.setState({ popover: { kind: 'info', ...at, action } });
  }
  return action;
}
