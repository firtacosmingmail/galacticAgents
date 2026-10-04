import { create } from 'zustand';
import { sceneWorld, useAppStore } from '../../state/store.js';
import {
  HARMONIZER,
  selectionKey,
  type Selection,
  type SelectionKey,
} from '../../state/selection.js';
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
 * The hover's position is not in the store's state (P4-08 review): it changes every frame while a
 * satellite is followed, and the overlay must not re-render at frame rate. It lives in a plain
 * module value (`hoverAt`) with its own listeners (`onHoverMove`), notified from the canvas's
 * frame; the hover label and the card write their `transform` from it. The store's `hover` only
 * changes when *what* is hovered does.
 *
 * Satellites (P4-08) are pick targets too: hovering one shows its agent's card (`SatelliteHover`,
 * positioned at the satellite, not at the pointer), a click selects its agent
 * (`activateSatellite`), and the "what's here" list carries them before the bodies.
 */
export interface Point {
  x: number;
  y: number;
}

/** The pointer over a body: its name, at the pointer (`hoverAt`). */
export interface BodyHover {
  kind?: 'body';
  bodyId: string;
  name: string;
  /** How many other things are under the pointer too ("+2"). */
  others: number;
}

/** The pointer over a satellite: its agent's card, at the satellite's point on screen (`hoverAt`). */
export interface SatelliteHover {
  kind: 'satellite';
  agentId: string;
  /** What the satellite is doing (the card says "scanning · …", "flying to …"). */
  mode: SatelliteMode;
  /** The body it belongs to (a flight's destination). */
  satelliteBodyId: string;
  others: number;
  bodyId?: undefined;
}

/**
 * The pointer over a question beacon (P4-05; one per question, P4-13): that question's card, at
 * the pointer (`beacons/BeaconHoverCard.tsx`). `bodyId` is the beacon's body (it gets the faint
 * hover ring).
 */
export interface BeaconHover {
  kind: 'beacon';
  questionId: string;
  bodyId: string;
}

export type Hover = BodyHover | SatelliteHover | BeaconHover;

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
  /** What is hovered; with `x` / `y`, moves the hover there too (`moveHover`). */
  setHover: (hover: (Hover & Partial<Point>) | undefined) => void;
  showHere: (at: Point, bodyIds: string[], agentIds?: string[]) => void;
  closePopover: () => void;
}

export const usePickingStore = create<PickingState>((set, get) => ({
  hover: undefined,
  popover: undefined,
  setHover: (input) => {
    let hover: Hover | undefined = input;
    if (input && input.x !== undefined && input.y !== undefined) {
      const { x, y, ...rest } = input;
      moveHover(x, y);
      hover = rest as Hover;
    }
    const was = get().hover;
    if (was === hover) return;
    if (was && hover && sameHover(was, hover)) return;
    set({ hover });
  },
  showHere: (at, bodyIds, agentIds = []) => {
    const world = sceneWorld(useAppStore.getState());
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
  if (a.kind === 'beacon' || b.kind === 'beacon') {
    return (
      a.kind === 'beacon' &&
      b.kind === 'beacon' &&
      a.questionId === b.questionId &&
      a.bodyId === b.bodyId
    );
  }
  if (a.others !== b.others) return false;
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

const hoverPoint: Point = { x: 0, y: 0 };
const moveListeners = new Set<(at: Readonly<Point>) => void>();

/** Where the hover is (live: the same object, rewritten in place). */
export function hoverAt(): Readonly<Point> {
  return hoverPoint;
}

/** Moves the hover (the canvas, once per frame at most); listeners hear only real moves. */
export function moveHover(x: number, y: number): void {
  if (hoverPoint.x === x && hoverPoint.y === y) return;
  hoverPoint.x = x;
  hoverPoint.y = y;
  moveListeners.forEach((l) => l(hoverPoint));
}

/** Called when the hover moves (not when what is hovered changes: that is the store's `hover`). */
export function onHoverMove(listener: (at: Readonly<Point>) => void): () => void {
  moveListeners.add(listener);
  return () => void moveListeners.delete(listener);
}

/**
 * The body a hover is about (`undefined` over a satellite: its body is not what is hovered; a
 * beacon's body, P4-05).
 */
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
 * Deselects from the scene (P5-01; SPEC §4.2: "the Harmonizer is always one click away (deselect,
 * or click Earth)"): a click on empty space, or `Escape` once nothing else is left to close,
 * goes back to the Harmonizer's chat. The camera stays where it is (decision 65: going back to the
 * Harmonizer never flies). False when the Harmonizer is already selected (nothing to deselect).
 */
export function deselectFromScene(): boolean {
  if (useAppStore.getState().selection.kind === 'harmonizer') return false;
  usePickingStore.getState().closePopover();
  selectFromScene(HARMONIZER);
  return true;
}

/**
 * Activates a body (a click, a choice in the "what's here" list, Enter on the focused body): flies
 * the camera there and either selects who works on it or shows what it is (`bodyAction`).
 * `fly: false` when the camera is already there (Enter on the camera's focus).
 */
export function activateBody(bodyId: string, at: Point, opts: { fly?: boolean } = {}): BodyAction {
  const action = bodyAction(sceneWorld(useAppStore.getState()), bodyId);
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
  const world = sceneWorld(useAppStore.getState());
  const selection = satelliteSelection(world, agentId);
  if (!selection) return false;
  const bodyId = getSatellite(agentId)?.bodyId ?? selectionBody(world, selection);
  if (bodyId) useCameraStore.getState().flyTo(bodyId);
  usePickingStore.getState().closePopover();
  selectFromScene(selection);
  return true;
}
