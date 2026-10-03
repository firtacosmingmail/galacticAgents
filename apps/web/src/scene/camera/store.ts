import { create } from 'zustand';
import { allAnchors, getAnchor, type BodyAnchor } from '../anchors.js';
import type { BodyView, DirectorWorld } from './director.js';
import { DEFAULT_SUN_RADIUS, length, type Vec3 } from './flight.js';

/**
 * The camera's API outside the canvas (P3-04): the panel, the breadcrumb, the keyboard and
 * picking (P3-05) ask for a flight here; the `CameraRig` inside the canvas carries it out and
 * reports back (arrived, interrupted, left). No three.js: this module is in the panel's chunk.
 *
 * `focusedId` is the body the camera is flying to or following; `undefined` means the free camera
 * or the whole system.
 */
export type CameraRequest =
  | { seq: number; kind: 'focus'; bodyId: string }
  | { seq: number; kind: 'overview'; instant?: boolean };

export interface CameraState {
  focusedId: string | undefined;
  /** True while a flight runs. */
  flying: boolean;
  /** The latest request; the rig handles each `seq` once. */
  request: CameraRequest | undefined;
  /** Flies to a body's anchor and follows it; false (nothing changes) when it is not in the scene. */
  flyTo: (bodyId: string) => boolean;
  /** Back to the whole system, from any camera state. */
  back: () => void;
  /** Flies to the next / previous body in `bodyOrder`; returns its id (undefined: no bodies). */
  next: () => string | undefined;
  previous: () => string | undefined;

  /** From the rig: a flight started (it is the rig that knows when). */
  flightStarted: () => void;
  /** From the rig: the camera reached the focused body (now following it). */
  arrived: () => void;
  /** From the rig: the overview flight ended. */
  atOverview: () => void;
  /** From the rig: user input stopped a flight, or panned away, or the body left the scene. */
  released: () => void;
}

let seq = 0;

export const useCameraStore = create<CameraState>((set, get) => ({
  focusedId: undefined,
  flying: false,
  request: undefined,
  flyTo: (bodyId) => {
    if (!getAnchor(bodyId)) return false;
    set({ focusedId: bodyId, request: { seq: ++seq, kind: 'focus', bodyId } });
    return true;
  },
  back: () => set({ focusedId: undefined, request: { seq: ++seq, kind: 'overview' } }),
  next: () => step(get, 1),
  previous: () => step(get, -1),
  flightStarted: () => set({ flying: true }),
  arrived: () => set({ flying: false }),
  atOverview: () => set({ flying: false, focusedId: undefined }),
  released: () => set({ flying: false, focusedId: undefined }),
}));

function step(get: () => CameraState, direction: 1 | -1): string | undefined {
  const order = bodyOrder(allAnchors());
  if (order.length === 0) return undefined;
  const at = order.findIndex((a) => a.bodyId === get().focusedId);
  const index =
    at < 0
      ? direction === 1
        ? 0
        : order.length - 1
      : (at + direction + order.length) % order.length;
  const id = order[index]!.bodyId;
  get().flyTo(id);
  return id;
}

const KIND_RANK: Record<BodyAnchor['kind'], number> = { star: 0, planet: 1, moon: 2, asteroid: 3 };

/** An anchor's world position (its world matrix's translation, brought up to date). */
export function anchorPosition(anchor: BodyAnchor): Vec3 {
  anchor.object.updateWorldMatrix(true, false);
  const e = anchor.object.matrixWorld.elements;
  return [e[12] ?? 0, e[13] ?? 0, e[14] ?? 0];
}

/**
 * The order of next / previous body: the Sun, the planets, the moons, then the asteroids; within
 * a kind, outward from the Sun (the orbit order: Mercury first, a belt asteroid by its orbit
 * radius); ties by id, so the order is stable.
 */
export function bodyOrder(anchors: BodyAnchor[]): BodyAnchor[] {
  const keyed = anchors.map((a) => {
    const [x, y, z] = anchorPosition(a);
    return { a, rank: KIND_RANK[a.kind], d: Math.hypot(x, y, z) };
  });
  keyed.sort((p, q) => p.rank - q.rank || p.d - q.d || (p.a.bodyId < q.a.bodyId ? -1 : 1));
  return keyed.map((k) => k.a);
}

/**
 * The registry as the camera director sees it this frame: every anchor's live position and
 * radius, the Sun's radius (the `star` anchor's, else the default) and the system's extent.
 */
export function anchorWorld(anchors: BodyAnchor[] = allAnchors()): DirectorWorld {
  let sunRadius = DEFAULT_SUN_RADIUS;
  let extent = 0;
  const bodies = new Map<string, BodyView>();
  for (const a of anchors) {
    const position = anchorPosition(a);
    if (a.kind === 'star') sunRadius = a.radius;
    extent = Math.max(extent, length(position) + a.radius);
    bodies.set(a.bodyId, { position, radius: a.radius });
  }
  return { sunRadius, extent, body: (id) => bodies.get(id) };
}

/** The user asked the system for less motion: flights become instant jumps. */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}
