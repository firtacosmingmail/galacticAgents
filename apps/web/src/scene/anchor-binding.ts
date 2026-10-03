import { useEffect, type RefObject } from 'react';
import type { Object3D } from 'three';
import { registerAnchor, type BodyAnchor } from './anchors.js';

/**
 * Binding a drawn body to the anchor registry (`anchors.ts`), shared by every body of the scene
 * (the Sun, P3-02 planets and moons, P3-03 task asteroids). `attachAnchor` is a plain function, so
 * the register/unregister logic is testable without WebGL; `useBodyAnchor` calls it from an effect
 * (on mount, and again whenever the id, radius, kind or order changes — the scale toggle changes
 * the radius) and runs the returned cleanup on unmount or before re-registering. The id never
 * changes with the scale, so selection and camera targets survive the toggle. The object itself
 * carries the position, so motion (orbits, the belt's spin) needs no re-registration.
 *
 * Type-only import of three.
 */
export type AnchorBinding = Omit<BodyAnchor, 'object'>;

/** Registers `object` as `binding.bodyId`'s anchor; returns the cleanup (a no-op without an object). */
export function attachAnchor(binding: AnchorBinding, object: Object3D | null): () => void {
  if (!object) return () => {};
  return registerAnchor({ ...binding, object });
}

/** Registers `ref.current` as the body's anchor while it is drawn. */
export function useBodyAnchor(ref: RefObject<Object3D | null>, binding: AnchorBinding): void {
  const { bodyId, radius, kind, order } = binding;
  useEffect(
    () =>
      attachAnchor(
        order === undefined ? { bodyId, radius, kind } : { bodyId, radius, kind, order },
        ref.current,
      ),
    [ref, bodyId, radius, kind, order],
  );
}
