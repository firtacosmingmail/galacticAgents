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
  | { seq: number; kind: 'focus'; bodyId: string; radii?: number }
  | { seq: number; kind: 'overview'; instant?: boolean };

export interface CameraState {
  focusedId: string | undefined;
  /** True while a flight runs. */
  flying: boolean;
  /**
   * True while the camera rests at the whole system's framing: a fresh rig (it starts there), or
   * an overview flight that arrived. Any flight, release or user input on the controls clears it.
   * `Escape` uses it to know whether "back" would change anything (P5-01 review): when it would
   * not, the key is left to the replay bar (exit the replay).
   */
  atSystem: boolean;
  /**
   * The latest request; the rig handles each `seq` once. Cleared when the camera is released (the
   * rig also releases it when it unmounts), and a newly mounted rig ignores whatever request is
   * already there (`handledOnMount`), so a remounted rig (the scene hidden and shown, a switch to
   * or from the mobile tier) never replays an old flight.
   */
  request: CameraRequest | undefined;
  /**
   * Flies to a body's anchor and follows it; false (nothing changes) when it is not in the scene.
   * The flight ends at the body's framing distance, or at `focusFraming(bodyId)` radii when the
   * scene says so (P6-01: the body shown in the detail view keeps the detail view's framing).
   */
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
  /** From the rig: the user grabbed the controls (orbit, zoom, pan): no longer at the framing. */
  userMoved: () => void;
  /** From the rig: a new rig mounted; its fresh camera starts at the system's framing. */
  rigMounted: () => void;
}

let seq = 0;

/**
 * The framing a focus flight to `bodyId` ends at, in body radii, when it is not the usual one
 * (P6-01: the detail view's body is framed closer). One provider, set by the scene mode
 * (`detail/mode.ts`) when it loads; `undefined` → the framing distance.
 */
let framingProvider: (bodyId: string) => number | undefined = () => undefined;

export function setFocusFraming(provider: (bodyId: string) => number | undefined): void {
  framingProvider = provider;
}

function focusFraming(bodyId: string): number | undefined {
  return framingProvider(bodyId);
}

export const useCameraStore = create<CameraState>((set, get) => ({
  focusedId: undefined,
  flying: false,
  atSystem: true,
  request: undefined,
  flyTo: (bodyId) => {
    if (!getAnchor(bodyId)) return false;
    const radii = focusFraming(bodyId);
    set({
      focusedId: bodyId,
      atSystem: false,
      request:
        radii === undefined
          ? { seq: ++seq, kind: 'focus', bodyId }
          : { seq: ++seq, kind: 'focus', bodyId, radii },
    });
    return true;
  },
  back: () =>
    set({ focusedId: undefined, atSystem: false, request: { seq: ++seq, kind: 'overview' } }),
  next: () => step(get, 1),
  previous: () => step(get, -1),
  flightStarted: () => set({ flying: true }),
  arrived: () => set({ flying: false }),
  atOverview: () => set({ flying: false, focusedId: undefined, atSystem: true }),
  released: () => set({ flying: false, focusedId: undefined, atSystem: false, request: undefined }),
  userMoved: () => set({ atSystem: false }),
  rigMounted: () => set((s) => ({ atSystem: s.focusedId === undefined && !s.flying })),
}));

/**
 * The seq a newly mounted rig counts as already handled: the store's current request's, so a rig
 * acts only on requests made after it mounted.
 */
export function handledOnMount(): number {
  return useCameraStore.getState().request?.seq ?? 0;
}

/** The request the rig should start now, if any: one whose seq it has not handled yet. */
export function pendingRequest(
  request: CameraRequest | undefined,
  handled: number,
): CameraRequest | undefined {
  return request && request.seq !== handled ? request : undefined;
}

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

/**
 * An anchor's world position (its world matrix's translation, brought up to date), written into
 * `out` when given (per-frame readers reuse one buffer), else a new tuple.
 */
export function anchorPosition(
  anchor: BodyAnchor,
  out: [number, number, number] = [0, 0, 0],
): Vec3 {
  anchor.object.updateWorldMatrix(true, false);
  const e = anchor.object.matrixWorld.elements;
  out[0] = e[12] ?? 0;
  out[1] = e[13] ?? 0;
  out[2] = e[14] ?? 0;
  return out;
}

/**
 * The order of next / previous body: the Sun, the planets, the moons, then the asteroids; within
 * a kind, by the anchor's stable `order` (planets by catalogue orbit, moons by planet then rank,
 * asteroids by number), never by live position, so moons going round do not reshuffle it. Bodies
 * without an order come after the others of their kind; ties go by id.
 */
export function bodyOrder(anchors: readonly BodyAnchor[]): BodyAnchor[] {
  return [...anchors].sort(
    (p, q) =>
      KIND_RANK[p.kind] - KIND_RANK[q.kind] ||
      compareOrder(p.order, q.order) ||
      (p.bodyId < q.bodyId ? -1 : p.bodyId > q.bodyId ? 1 : 0),
  );
}

function compareOrder(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

/**
 * How far a planet's own system reaches, in planet radii, for the overview: moons farther out
 * than that (Nereid, true scale) do not widen the frame. The overview frames the orbits.
 */
export const OVERVIEW_PLANET_REACH = 3;

/**
 * The system's extent for the overview: the farthest star, planet or asteroid from the Sun plus
 * its radius (× `OVERVIEW_PLANET_REACH` for a planet, for its near moons). Moons are left out, so a
 * far moon does not zoom the overview out for a speck. Bodies move on circles about the Sun, so
 * this does not change as they move: it is computed when the anchors change, not every frame.
 */
export function systemExtent(anchors: readonly BodyAnchor[]): number {
  let extent = 0;
  for (const a of anchors) {
    if (a.kind === 'moon') continue;
    const reach = a.kind === 'planet' ? a.radius * OVERVIEW_PLANET_REACH : a.radius;
    extent = Math.max(extent, length(anchorPosition(a)) + reach);
  }
  return extent;
}

/**
 * The registry as the camera director sees it (`DirectorWorld`), read lazily: `body(id)` reads
 * that one anchor's live position when asked (only while flying to or following it), and the
 * Sun's radius and the system's extent are computed once and kept until `invalidate()` (the rig
 * calls it when anchors are added or removed and when the scale changes). A free camera reads no
 * anchor at all.
 */
export class AnchorWorld implements DirectorWorld {
  private stale = true;
  private sun = DEFAULT_SUN_RADIUS;
  private reach = 0;
  private readonly all: () => BodyAnchor[];
  private readonly get: (bodyId: string) => BodyAnchor | undefined;

  constructor(
    all: () => BodyAnchor[] = allAnchors,
    get: (bodyId: string) => BodyAnchor | undefined = getAnchor,
  ) {
    this.all = all;
    this.get = get;
  }

  /** The anchors changed (added, removed, rescaled): recompute the Sun and the extent when next read. */
  invalidate(): void {
    this.stale = true;
  }

  get sunRadius(): number {
    this.refresh();
    return this.sun;
  }

  get extent(): number {
    this.refresh();
    return this.reach;
  }

  body(bodyId: string): BodyView | undefined {
    const a = this.get(bodyId);
    return a ? { position: anchorPosition(a), radius: a.radius } : undefined;
  }

  private refresh(): void {
    if (!this.stale) return;
    this.stale = false;
    const anchors = this.all();
    this.sun = anchors.find((a) => a.kind === 'star')?.radius ?? DEFAULT_SUN_RADIUS;
    this.reach = systemExtent(anchors);
  }
}
