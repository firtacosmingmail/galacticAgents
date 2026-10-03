import { useEffect, useState, type RefObject } from 'react';
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

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Whether the user asked for reduced motion; follows changes of the setting. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => queryReducedMotion()?.matches ?? false);
  useEffect(() => {
    const query = queryReducedMotion();
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function queryReducedMotion(): MediaQueryList | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION)
    : undefined;
}
