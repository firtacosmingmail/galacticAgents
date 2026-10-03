import { create } from 'zustand';
import { useAppStore } from '../../state/store.js';
import { selectionKey, type Selection, type SelectionKey } from '../../state/selection.js';
import { agentLabel } from '../../console/hierarchy/shared.js';
import { useCameraStore } from '../camera/store.js';
import { getSatellite } from '../satellites/registry.js';
import type { SatelliteMode } from '../satellites/machine.js';
import { bodyAction, bodyName, selectionBody, type BodyAction } from './body-action.js';
import { satelliteSelection } from './satellite-card.js';

/**
 * Picking's state outside the canvas (P3-05): what the pointer is over (the hover label) and the
 * popover over the scene (a body's info, or the "what's here" list of corner case 24). The canvas
 * part (`Picking.tsx`) writes it; the overlay (`PickingOverlay.tsx`, ordinary DOM over the canvas)
 * reads it. No three.js: this module is in the panel's chunk.
 *
 * Positions are in CSS pixels from the scene area's top-left corner (the canvas fills the area).
 *
 * Satellites (P4-08) are pick targets too: hovering one shows its agent's card (`SatelliteHover`,
 * positioned at the satellite, not at the pointer), a click selects its agent
 * (`activateSatellite`), and the "what's here" list carries them before the bodies.
 */
export interface Point {
  x: number;
  y: number;
}

/** The pointer over a body: its name, at the pointer. */
export interface BodyHover extends Point {
  kind?: 'body';
  bodyId: string;
  name: string;
  /** How many other things are under the pointer too ("+2"). */
  others: number;
}

/** The pointer over a satellite: its agent's card, at the satellite's point on screen. */
export interface SatelliteHover extends Point {
  kind: 'satellite';
  agentId: string;
  /** What the satellite is doing (the card says "scanning · …", "flying to …"). */
  mode: SatelliteMode;
  /** The body it belongs to (a flight's destination). */
  satelliteBodyId: string;
  others: number;
  bodyId?: undefined;
}

export type Hover = BodyHover | SatelliteHover;

export type Popover =
  | (Point & { kind: 'info'; action: Extract<BodyAction, { kind: 'info' }> })
  | (Point & {
      kind: 'here';
      bodies: { bodyId: string; name: string }[];
      /** P4-08: the satellites under the pointer, listed before the bodies. */
      satellites: { agentId: string; name: string }[];
    });

export interface PickingState {
  hover: Hover | undefined;
  popover: Popover | undefined;
  setHover: (hover: Hover | undefined) => void;
  showHere: (at: Point, bodyIds: string[], agentIds?: string[]) => void;
  closePopover: () => void;
}

export const usePickingStore = create<PickingState>((set, get) => ({
  hover: undefined,
  popover: undefined,
  setHover: (hover) => {
    const was = get().hover;
    if (was === hover) return;
    if (was && hover && sameHover(was, hover)) return;
    set({ hover });
  },
  showHere: (at, bodyIds, agentIds = []) => {
    const world = useAppStore.getState().world;
    set({
      popover: {
        kind: 'here',
        ...at,
        bodies: bodyIds.map((bodyId) => ({ bodyId, name: bodyName(world, bodyId) })),
        satellites: agentIds.map((agentId) => ({
          agentId,
          name: agentLabel(world.agents[agentId], world),
        })),
      },
    });
  },
  closePopover: () => {
    if (get().popover) set({ popover: undefined });
  },
}));

function sameHover(a: Hover, b: Hover): boolean {
  if (a.others !== b.others || a.x !== b.x || a.y !== b.y) return false;
  if (a.kind === 'satellite' || b.kind === 'satellite') {
    return (
      a.kind === 'satellite' &&
      b.kind === 'satellite' &&
      a.agentId === b.agentId &&
      a.mode === b.mode &&
      a.satelliteBodyId === b.satelliteBodyId
    );
  }
  return a.bodyId === b.bodyId && a.name === b.name;
}

/** The body a hover is about (`undefined` over a satellite: its body is not what is hovered). */
export function hoveredBody(hover: Hover | undefined): string | undefined {
  return hover?.kind === 'satellite' ? undefined : hover?.bodyId;
}

/** The agent whose satellite is hovered. */
export function hoveredSatellite(hover: Hover | undefined): string | undefined {
  return hover?.kind === 'satellite' ? hover.agentId : undefined;
}

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

/**
 * Activates a satellite (a click on it, a choice in the "what's here" list): selects its agent
 * (decision 53: `waykeeper:<id>` / `steward:<id>`) and flies the camera to the body it orbits.
 * `false` when the agent is unknown (nothing happens).
 */
export function activateSatellite(agentId: string): boolean {
  const world = useAppStore.getState().world;
  const selection = satelliteSelection(world, agentId);
  if (!selection) return false;
  const bodyId = getSatellite(agentId)?.bodyId ?? selectionBody(world, selection);
  if (bodyId) useCameraStore.getState().flyTo(bodyId);
  usePickingStore.getState().closePopover();
  selectFromScene(selection);
  return true;
}
