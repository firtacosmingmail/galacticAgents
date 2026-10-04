import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Matrix4, type PerspectiveCamera } from 'three';
import { allAnchors, getAnchor, onAnchorsChanged } from '../anchors.js';
import { anchorPosition, useCameraStore } from '../camera/store.js';
import { pixelScale } from '../picking/pick.js';
import { currentDetailScope, useDetailStore } from '../detail/mode.js';
import { PRIORITY } from './label-model.js';
import {
  declutter,
  labelRect,
  movedEnough,
  occluded,
  onScreen,
  projectToScreen,
  Throttle,
  type LabelBox,
  type Occluder,
} from './layout.js';
import {
  hideAll,
  labelEntries,
  labelStats,
  onLabelsChanged,
  setShown,
  writePosition,
  type LabelEntry,
} from './registry.js';

/**
 * Places the domain labels (P3-07) over the canvas: ONE projection pass for all of them, not a
 * drei `<Html>` per body. On a rendered frame, at most `hz` times a second (30 on high and
 * balanced, 15 on mobile — and never more often than the capped loop renders), it projects every
 * registered label's anchor, hides labels whose body is behind the camera, off screen or behind
 * the Sun or a planet (the selected and the focused body's label is clamped to the top edge
 * rather than hidden above it), de-clutters overlaps by priority, and writes a label's transform only when
 * it moved by more than half a pixel (and its visibility only when that changed).
 *
 * A new label, a new or removed anchor, a content change (size, priority) or a resize forces the
 * next update. Under the
 * on-demand loop a skipped frame schedules one render for when the next update is due, so a
 * camera that stops between two updates still leaves its labels in place.
 */
export function LabelProjector({ hz }: { hz: number }) {
  const invalidate = useThree((s) => s.invalidate);
  const [tools] = useState(() => ({
    viewProjection: new Matrix4(),
    throttle: new Throttle(hz),
  }));
  /** The render scheduled for a skipped frame (on-demand loop only). */
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => tools.throttle.setRate(hz), [tools, hz]);

  useEffect(() => {
    const refresh = () => {
      tools.throttle.force();
      invalidate();
    };
    // A label and its body's anchor register independently (the label in a layout effect, the
    // anchor in the body's passive effect, in either order): either one arriving forces a pass.
    const stopLabels = onLabelsChanged(refresh);
    const stopAnchors = onAnchorsChanged(refresh);
    // P6-01: entering or leaving a detail view changes which labels may show.
    const stopMode = useDetailStore.subscribe((s, prev) => {
      if (s.mode !== prev.mode) refresh();
    });
    refresh();
    return () => {
      stopLabels();
      stopAnchors();
      stopMode();
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      hideAll();
    };
  }, [tools, invalidate]);

  const size = useThree((s) => s.size);
  useEffect(() => {
    tools.throttle.force();
    invalidate();
  }, [tools, size, invalidate]);

  useFrame((state) => {
    const now = performance.now();
    if (!tools.throttle.due(now)) {
      // Only the on-demand loop needs the nudge; the others render the next frame anyway.
      if (!timer.current && state.frameloop === 'demand') {
        timer.current = setTimeout(() => {
          timer.current = undefined;
          invalidate();
        }, tools.throttle.wait(now));
      }
      return;
    }
    const camera = state.camera as PerspectiveCamera;
    projectLabels(camera, state.size, tools.viewProjection);
  });

  return null;
}

/** One update: projects, culls, de-clutters and writes every label. Exported for tests. */
export function projectLabels(
  camera: PerspectiveCamera,
  size: { width: number; height: number },
  viewProjection: Matrix4,
): void {
  labelStats.updates++;
  camera.updateMatrixWorld();
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const m = viewProjection.elements;
  const eye: [number, number, number] = [
    camera.matrixWorld.elements[12]!,
    camera.matrixWorld.elements[13]!,
    camera.matrixWorld.elements[14]!,
  ];
  const pxScale = pixelScale(size.height, camera.fov ?? 45);

  let occluders: Occluder[] | undefined;
  const occluderList = () =>
    (occluders ??= allAnchors()
      .filter((a) => a.kind === 'star' || a.kind === 'planet')
      .map((a) => ({ bodyId: a.bodyId, center: anchorPosition(a), radius: a.radius })));

  // Kept inside the top edge rather than hidden there: the selection's and the camera focus's.
  const focusedId = useCameraStore.getState().focusedId;
  // P6-01: in a detail view only its own bodies are labelled (the rest is behind its backdrop).
  const scope = currentDetailScope();
  const candidates: LabelBox[] = [];
  const byId = new Map<string, LabelEntry>();
  for (const entry of labelEntries()) {
    byId.set(entry.bodyId, entry);
    if (scope && !scope.has(entry.bodyId)) continue;
    const anchor = getAnchor(entry.bodyId);
    if (!anchor) continue;
    const position = anchorPosition(anchor);
    const point = projectToScreen(m, position, size.width, size.height);
    if (!point) continue;
    const box: LabelBox = {
      bodyId: entry.bodyId,
      x: point.x,
      y: point.y,
      r: (anchor.radius * pxScale) / point.depth,
      w: entry.w,
      h: entry.h,
      priority: entry.priority,
      depth: point.depth,
      pinTop: entry.priority === PRIORITY.selected || entry.bodyId === focusedId,
    };
    if (!onScreen(box, size.width, size.height)) continue;
    if (occluded(eye, position, entry.bodyId, occluderList())) continue;
    candidates.push(box);
  }

  const shown = declutter(candidates);
  const boxes = new Map(candidates.map((b) => [b.bodyId, b]));
  for (const [bodyId, entry] of byId) {
    const box = shown.has(bodyId) ? boxes.get(bodyId) : undefined;
    if (!box) {
      setShown(entry, false);
      continue;
    }
    const x = box.x;
    const y = labelRect(box).bottom;
    if (movedEnough(entry.written, x, y)) writePosition(entry, x, y);
    setShown(entry, true);
  }
}
