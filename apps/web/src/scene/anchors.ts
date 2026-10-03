import type { Object3D } from 'three';

/**
 * The scene's anchor registry (Phase 3 wave 2): every rendered body registers the `Object3D` that
 * carries its world position, keyed by its domain `Body.id`, with its visual radius. The camera
 * (P3-04) flies to an anchor by id, picking (P3-05) maps a hit back to an id, labels (P3-07)
 * anchor to it. Bodies own their anchors (P3-02 planets and moons, P3-03 task asteroids, the Sun
 * as `SUN_ANCHOR_ID` when no catalogue Sun is in the world); nothing else writes here.
 *
 * Type-only import of three: this module stays out of the panel's first chunk's runtime.
 */
export interface BodyAnchor {
  bodyId: string;
  object: Object3D;
  /** Visual radius in scene units at the current scale (the camera frames the body with it). */
  radius: number;
  kind: 'star' | 'planet' | 'moon' | 'asteroid';
}

export const SUN_ANCHOR_ID = 'sun';

const anchors = new Map<string, BodyAnchor>();
const listeners = new Set<() => void>();

export function registerAnchor(anchor: BodyAnchor): () => void {
  anchors.set(anchor.bodyId, anchor);
  listeners.forEach((l) => l());
  return () => {
    if (anchors.get(anchor.bodyId) === anchor) {
      anchors.delete(anchor.bodyId);
      listeners.forEach((l) => l());
    }
  };
}

export function getAnchor(bodyId: string): BodyAnchor | undefined {
  return anchors.get(bodyId);
}

export function allAnchors(): BodyAnchor[] {
  return [...anchors.values()];
}

/** Called whenever an anchor is added or removed (not when it moves). */
export function onAnchorsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
