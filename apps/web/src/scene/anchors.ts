import type { Object3D } from 'three';

/**
 * The scene's anchor registry (Phase 3 wave 2): every rendered body registers the `Object3D` that
 * carries its world position, keyed by its domain `Body.id`, with its visual radius. The camera
 * (P3-04) flies to an anchor by id, picking (P3-05) maps a hit back to an id, labels (P3-07)
 * anchor to it. Bodies own their anchors (P3-02 planets and moons, P3-03 task asteroids, the Sun
 * under `SUN_ANCHOR_ID`, the catalogue's 'b-sun'); nothing else writes here.
 *
 * Type-only import of three: this module stays out of the panel's first chunk's runtime.
 */
export interface BodyAnchor {
  bodyId: string;
  object: Object3D;
  /** Visual radius in scene units at the current scale (the camera frames the body with it). */
  radius: number;
  kind: 'star' | 'planet' | 'moon' | 'asteroid';
  /**
   * A stable place within its kind, for the camera's next / previous body (P3-04): planets by
   * catalogue orbit, moons by `moonOrder(parent orbit, rank)`, asteroids by `meta.number`. Never a
   * live position (a moon's distance from the Sun changes as it orbits). Without one, a body
   * comes after the ordered ones of its kind, by id.
   */
  order?: number;
}

/** A moon's `order`: its planet's orbit first, then its rank among that planet's moons. */
export function moonOrder(parentOrbit: number, rank: number): number {
  return parentOrbit * 1000 + rank;
}

/** The catalogue Sun's `Body.id` (migration 0005); the Sun registers under it. */
export const SUN_ANCHOR_ID = 'b-sun';

const anchors = new Map<string, BodyAnchor>();
const listeners = new Set<() => void>();
/** `anchors`' values, rebuilt on register / unregister only (per-frame readers do not copy). */
let list: readonly BodyAnchor[] = [];

export function registerAnchor(anchor: BodyAnchor): () => void {
  anchors.set(anchor.bodyId, anchor);
  list = [...anchors.values()];
  listeners.forEach((l) => l());
  return () => {
    if (anchors.get(anchor.bodyId) === anchor) {
      anchors.delete(anchor.bodyId);
      list = [...anchors.values()];
      listeners.forEach((l) => l());
    }
  };
}

export function getAnchor(bodyId: string): BodyAnchor | undefined {
  return anchors.get(bodyId);
}

export function allAnchors(): BodyAnchor[] {
  return [...list];
}

/** The registered anchors: the same array until the next register / unregister. Do not mutate. */
export function anchorList(): readonly BodyAnchor[] {
  return list;
}

/** Called whenever an anchor is added or removed (not when it moves). */
export function onAnchorsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
