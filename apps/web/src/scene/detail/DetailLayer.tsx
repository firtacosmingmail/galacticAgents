import { useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { getAnchor } from '../anchors.js';
import { anchorPosition, useCameraStore } from '../camera/store.js';
import { READ_BODIES } from '../frame-order.js';
import type { SceneQuality } from '../quality.js';
import { DetailScene } from './DetailScene.js';
import {
  applyZoomStep,
  bindCameraToDetail,
  fadeDone,
  useDetailStore,
  zoomStep,
  type DetailState,
} from './mode.js';

/**
 * The detail view inside the canvas (P6-01; the rules in `mode.ts`): mounts the sub-scene of the
 * body being shown (`DetailScene`, keyed by the body, so a new body gets fresh GPU objects and
 * leaving disposes them), watches the camera's distance for the zoom thresholds, ends the
 * cross-fade, and keeps the frame loop going while a fade runs (the `demand` loop of reduced
 * motion has no fade: the switch is instant).
 *
 * The watcher runs at `READ_BODIES`, after the camera rig (`PLACE_CAMERA`): a flight the rig
 * started this frame already counts as flying, so a flight in or out never trips a threshold.
 *
 * Unmounting the canvas (the scene hidden, a tier switch that recreates the context, a lost
 * context) puts the mode back to the system view at once, like the camera rig releasing its focus.
 */
export function DetailLayer({ quality, sunRadius }: { quality: SceneQuality; sunRadius: number }) {
  const shown = useDetailStore((s) => s.shown);
  const invalidate = useThree((s) => s.invalidate);
  const [scratch] = useState(() => ({
    at: [0, 0, 0] as [number, number, number],
    v: new Vector3(),
  }));

  useEffect(() => bindCameraToDetail(), []);
  useEffect(() => () => useDetailStore.getState().reset(), []);
  useEffect(
    () =>
      useDetailStore.subscribe((s: DetailState, prev: DetailState) => {
        if (s.mode !== prev.mode || s.fade !== prev.fade || s.shown !== prev.shown) invalidate();
      }),
    [invalidate],
  );

  useFrame(({ camera }) => {
    const s = useDetailStore.getState();
    const cam = useCameraStore.getState();
    const id = s.mode.kind === 'detail' ? s.mode.bodyId : cam.focusedId;
    const anchor = id ? getAnchor(id) : undefined;
    let distance: number | undefined;
    if (anchor) {
      scratch.v.fromArray(anchorPosition(anchor, scratch.at));
      distance = scratch.v.distanceTo(camera.position) / Math.max(anchor.radius, 1e-6);
    }
    const step = zoomStep({
      mode: s.mode,
      zoomArmed: s.zoomArmed,
      focusedId: cam.focusedId,
      flying: cam.flying,
      distance,
      detailable: anchor !== undefined && anchor.kind !== 'star',
    });
    if (step) applyZoomStep(step, cam.focusedId);

    const now = performance.now() / 1000;
    const after = useDetailStore.getState();
    if (after.fade) {
      if (fadeDone(after, now)) after.settle();
      invalidate();
    }
  }, READ_BODIES);

  return shown ? (
    <DetailScene key={shown} bodyId={shown} quality={quality} sunRadius={sunRadius} />
  ) : null;
}
