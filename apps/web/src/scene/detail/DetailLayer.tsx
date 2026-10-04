import { useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { getAnchor } from '../anchors.js';
import { anchorPosition, useCameraStore } from '../camera/store.js';
import { READ_BODIES } from '../frame-order.js';
import type { SceneQuality } from '../quality.js';
import { DetailScene } from './DetailScene.js';
import {
  applyZoomStep,
  bindCameraToDetail,
  radiiFrom,
  settleDue,
  useDetailStore,
  zoomStep,
  type DetailState,
} from './mode.js';

/**
 * The detail view inside the canvas (P6-01; the rules in `mode.ts`): mounts the sub-scene of the
 * body being shown (`DetailScene`, keyed by the body, so a new body gets fresh GPU objects and
 * leaving disposes them), watches the camera's distance for the zoom thresholds, ends the
 * cross-fade once the camera is in place (`settleDue`), and keeps the frame loop going until then
 * (the `demand` loop of reduced motion has no fade: the mix switches at once, `covered` follows
 * when the camera has arrived).
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
    eye: [0, 0, 0] as [number, number, number],
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
      camera.position.toArray(scratch.eye);
      distance = radiiFrom(scratch.eye, anchorPosition(anchor, scratch.at), anchor.radius);
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
    const pending = after.fade !== undefined || (after.mode.kind === 'detail' && !after.covered);
    if (pending) {
      // The camera's state after this frame's step: a flight it started is already `flying`.
      if (settleDue(after, now, { flying: useCameraStore.getState().flying, distance }))
        after.settle();
      invalidate();
    }
  }, READ_BODIES);

  return shown ? (
    <DetailScene key={shown} bodyId={shown} quality={quality} sunRadius={sunRadius} />
  ) : null;
}
