import { useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MeshBasicMaterial,
  RingGeometry,
  Vector3,
  type Mesh,
  type PerspectiveCamera,
} from 'three';
import { useAppStore } from '../../state/store.js';
import { getAnchor } from '../anchors.js';
import { anchorPosition } from '../camera/store.js';
import { READ_BODIES } from '../frame-order.js';
import { DECOR_LAYER } from '../layers.js';
import { useReducedMotion } from '../motion.js';
import { pixelScale } from '../picking/pick.js';
import {
  TOAST,
  addToasts,
  isFresh,
  lifetime,
  newEnvelopes,
  toastLook,
  toastOf,
  type Toast,
} from './toast-model.js';

/**
 * Event toasts (P4-06; `toast-model.ts` says which events and how they look): a brief ring that
 * expands from a body and fades when work completes there, or when a question starts waiting for
 * the user. A fixed pool of `TOAST.max` camera-facing rings (one shared geometry, a material per
 * ring for its colour and opacity), additive, no depth write, on `DECOR_LAYER`: nothing is drawn
 * and nothing costs a draw call while no toast runs. The feed reads the store's event log (newest
 * first) and keeps the last `seq` it saw, so a snapshot or a replayed backlog never toasts; the
 * rings follow their bodies' anchors (`READ_BODIES`, after the bodies are placed). On-demand frame
 * loops (reduced motion, a capped tier) are kept rendering while a toast runs and asked for one
 * more frame when the last one ends.
 */
export function Toasts() {
  const reducedMotion = useReducedMotion();
  const invalidate = useThree((s) => s.invalidate);
  const [pool] = useState(createPool);
  useEffect(() => setReduced(pool, reducedMotion), [pool, reducedMotion]);
  useEffect(() => () => disposePool(pool), [pool]);

  // The feed: new events since the last one seen; a snapshot resets the mark (history never toasts).
  useEffect(() => {
    let lastSeq = useAppStore.getState().world.seq;
    let snapshots = useAppStore.getState().snapshots;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (state.snapshots !== snapshots) {
        snapshots = state.snapshots;
        lastSeq = state.world.seq;
        return;
      }
      if (state.log === prev.log) return;
      const fresh = newEnvelopes(state.log, lastSeq);
      if (fresh.length === 0) return;
      lastSeq = fresh.at(-1)!.seq;
      const wallNow = Date.now();
      const incoming = fresh
        .filter((e) => isFresh(e, wallNow))
        .map((e) => toastOf(e, state.world))
        .filter((t) => t !== undefined);
      if (incoming.length === 0) return;
      const life = startToasts(pool, incoming, performance.now());
      invalidate();
      // One more frame once they are over, so an on-demand loop clears the last ring.
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(() => invalidate(), life + 50);
    });
    return () => {
      unsubscribe();
      if (endTimer) clearTimeout(endTimer);
    };
  }, [pool, invalidate]);

  useFrame((state) => drawToasts(pool, state), READ_BODIES);

  return (
    <group name="toasts">
      {pool.materials.map((material, i) => (
        <mesh
          key={i}
          ref={(m) => attachMesh(pool, i, m)}
          geometry={pool.geometry}
          material={material}
          layers={DECOR_LAYER}
          visible={false}
          frustumCulled={false}
          renderOrder={15}
        />
      ))}
    </group>
  );
}

/** The rings and what they show: one per component, mutated only by the functions below. */
interface Pool {
  toasts: Toast[];
  reduced: boolean;
  geometry: RingGeometry;
  materials: MeshBasicMaterial[];
  meshes: (Mesh | null)[];
}

function createPool(): Pool {
  return {
    toasts: [],
    reduced: false,
    geometry: new RingGeometry(0.88, 1, 64),
    materials: Array.from(
      { length: TOAST.max },
      () =>
        new MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
          toneMapped: false,
        }),
    ),
    meshes: [],
  };
}

function setReduced(pool: Pool, reduced: boolean): void {
  pool.reduced = reduced;
}

function attachMesh(pool: Pool, i: number, mesh: Mesh | null): void {
  pool.meshes[i] = mesh;
}

function disposePool(pool: Pool): void {
  pool.geometry.dispose();
  for (const m of pool.materials) m.dispose();
}

/** Starts toasts; returns how long they last. */
function startToasts(
  pool: Pool,
  incoming: readonly { kind: Toast['kind']; bodyId: string }[],
  now: number,
): number {
  pool.toasts = addToasts(pool.toasts, incoming, now, pool.reduced);
  return lifetime(pool.reduced);
}

/** One frame: each running toast's ring on its body's anchor, facing the camera. */
function drawToasts(
  pool: Pool,
  state: {
    camera: unknown;
    size: { height: number };
    invalidate: () => void;
  },
): void {
  const now = performance.now();
  const motion = !pool.reduced;
  const camera = state.camera as PerspectiveCamera;
  const list = pool.toasts;
  let running = false;
  for (let i = 0; i < TOAST.max; i++) {
    const mesh = pool.meshes[i];
    if (!mesh) continue;
    const toast = list[i];
    const look = toast ? toastLook(toast, now, !motion) : undefined;
    const anchor = toast ? getAnchor(toast.bodyId) : undefined;
    if (!toast || !look || !anchor) {
      mesh.visible = false;
      continue;
    }
    running = true;
    const [x, y, z] = anchorPosition(anchor, at);
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(camera.quaternion);
    position.set(x, y, z);
    const perPx =
      Math.max(1e-6, camera.position.distanceTo(position)) /
      pixelScale(state.size.height, camera.fov ?? 45);
    // In body radii, never smaller on screen than `minPx` (an asteroid, a far view).
    const radius = Math.max(
      look.radius * anchor.radius,
      ((TOAST.minPx * look.radius) / TOAST.from) * perPx,
    );
    mesh.scale.setScalar(radius);
    const material = pool.materials[i]!;
    material.color.copy(colour.set(TOAST.color[toast.kind]));
    material.opacity = look.opacity;
    mesh.visible = true;
  }
  // Drop the finished ones; keep an on-demand loop going while a flare expands.
  if (list.length > 0) pool.toasts = list.filter((t) => toastLook(t, now, !motion) !== undefined);
  if (running && motion) state.invalidate();
}

const at: [number, number, number] = [0, 0, 0];
const position = new Vector3();
const colour = new Color();
