import { useState, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Object3D } from 'three';
import type { Vec3 } from '../camera/flight.js';
import { READ_BODIES } from '../frame-order.js';
import { drawnBehindBackdrop, type Dome } from './dome.js';
import { useDetailStore } from './mode.js';

/**
 * Hides `ref`'s object while a settled detail view's dome hides it entirely (`dome.ts`'s rule):
 * `outside` gets the dome and the object's world position this frame. Evaluated every frame from
 * the stores' current state (at `READ_BODIES`, after the bodies moved and the backdrop published
 * its dome), so a body added, moved or brought into the view while it is settled is drawn
 * correctly without waiting for a store selector to fire.
 */
export function useBackdropCulling(
  ref: RefObject<Object3D | null>,
  outside: (dome: Dome, at: Vec3) => boolean,
): void {
  const [at] = useState(() => [0, 0, 0] as [number, number, number]);
  useFrame(() => {
    const object = ref.current;
    if (!object) return;
    const { covered } = useDetailStore.getState();
    let drawn = true;
    if (covered) {
      const where = worldPosition(object, at);
      drawn = drawnBehindBackdrop(true, (dome) => outside(dome, where));
    }
    if (object.visible !== drawn) object.visible = drawn;
  }, READ_BODIES);
}

/** `object`'s world position this frame, written into `out`. */
function worldPosition(object: Object3D, out: [number, number, number]): Vec3 {
  object.updateWorldMatrix(true, false);
  const e = object.matrixWorld.elements;
  out[0] = e[12] ?? 0;
  out[1] = e[13] ?? 0;
  out[2] = e[14] ?? 0;
  return out;
}
