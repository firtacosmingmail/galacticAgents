import { useEffect, type RefObject } from 'react';
import type { Object3D } from 'three';
import { registerAnchor, type BodyAnchor } from '../anchors.js';

/**
 * Registers `ref.current` as the anchor of `bodyId` once it is mounted and unregisters it on
 * unmount (or when the id, radius or kind changes). The object itself carries the position, so a
 * scale change or the belt's spin needs no re-registration.
 */
export function useBodyAnchor(
  bodyId: string,
  ref: RefObject<Object3D | null>,
  radius: number,
  kind: BodyAnchor['kind'],
): void {
  useEffect(() => {
    const object = ref.current;
    if (!object) return;
    return registerAnchor({ bodyId, object, radius, kind });
  }, [bodyId, ref, radius, kind]);
}

/** The shared reduced-motion preference (`scene/motion.ts`, P3-02), under the belt's name. */
export { useReducedMotion as usePrefersReducedMotion } from '../motion.js';
