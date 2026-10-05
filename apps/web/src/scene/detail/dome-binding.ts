import { useState, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Object3D } from 'three';
import type { Vec3 } from '../camera/flight.js';
import { READ_BODIES } from '../frame-order.js';
import { sceneWorld, useAppStore } from '../../state/store.js';
import { beltFactor, drawnBehindBackdrop, type Dome } from './dome.js';
import { detailKind, detailMix, useDetailStore } from './mode.js';

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

/**
 * Calls `apply` every frame (at `READ_BODIES`) with the belt's factor now (`beltFactor`: 1 as in
 * the system view, falling to 0 while a planet's or moon's detail view fades in, 0 once it is in,
 * 1 in an asteroid's view). The belt's components dim their rocks with it (P6-07).
 */
export function useBeltFade(apply: (factor: number) => void): void {
  useFrame(() => apply(beltFactorNow(performance.now() / 1000)), READ_BODIES);
}

/**
 * The belt's factor at `now` (seconds). The background belt and every task asteroid call it each
 * frame, so the shown body's kind (a world lookup and `planetLook`) is cached: worked out again
 * only when the shown body or the world's bodies change.
 */
export function beltFactorNow(now: number): number {
  const s = useDetailStore.getState();
  const bodies = s.shown === undefined ? undefined : sceneWorld(useAppStore.getState()).bodies;
  const c = shownKind;
  if (c.shown !== s.shown || c.bodies !== bodies) {
    c.shown = s.shown;
    c.bodies = bodies;
    c.view = s.shown === undefined ? undefined : detailKind(bodies?.[s.shown]);
  }
  return beltFactor(c.view, c.view === undefined ? 0 : detailMix(s, now));
}

const shownKind: {
  shown: string | undefined;
  bodies: object | undefined;
  view: ReturnType<typeof detailKind>;
} = { shown: undefined, bodies: undefined, view: undefined };

/** `object`'s world position this frame, written into `out`. */
function worldPosition(object: Object3D, out: [number, number, number]): Vec3 {
  object.updateWorldMatrix(true, false);
  const e = object.matrixWorld.elements;
  out[0] = e[12] ?? 0;
  out[1] = e[13] ?? 0;
  out[2] = e[14] ?? 0;
  return out;
}
