import type { Object3D } from 'three';
import { registerAnchor, type BodyAnchor } from '../anchors.js';

/**
 * Binding a drawn body to the anchor registry (`anchors.ts`), as a plain function so the
 * register/unregister logic is testable without WebGL: the components call it from an effect
 * (on mount, and again whenever the id, radius or kind changes — the scale toggle changes the
 * radius) and run the returned cleanup on unmount or before re-registering. The id never changes
 * with the scale, so selection and camera targets survive the toggle.
 *
 * Type-only import of three.
 */
export type AnchorBinding = Omit<BodyAnchor, 'object'>;

/** Registers `object` as `binding.bodyId`'s anchor; returns the cleanup (a no-op without an object). */
export function attachAnchor(binding: AnchorBinding, object: Object3D | null): () => void {
  if (!object) return () => {};
  return registerAnchor({ ...binding, object });
}
