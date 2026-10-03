import { useEffect, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  Matrix4,
  Raycaster,
  Vector2,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
} from 'three';
import type { OutlineEffect } from 'postprocessing';
import { allAnchors, getAnchor } from '../anchors.js';
import { labelAt } from '../labels/registry.js';
import { anchorPosition } from '../camera/store.js';
import { useAppStore } from '../../state/store.js';
import { bodyName, outlineBody, selectionBody } from './body-action.js';
import { ClickTracker } from './click.js';
import { pickBodies, pixelScale, type PickResult } from './pick.js';
import { outlineMeshes, sameMeshes } from './outline.js';
import { activateBody, usePickingStore, type Point } from './store.js';
import { noteUserCameraInput } from './sync.js';

/**
 * Picking, hover and the selection highlight inside the canvas (P3-05).
 *
 * Pointer events on the canvas element itself (R3F's own raycasting stays off: no object has a
 * handler): a hover pick on move, and again when the camera moves under a still pointer (at most
 * once per animation frame either way), a click pick on a release that was not a drag
 * (`ClickTracker`, with a wider slop for touch). Picks are ray-vs-sphere over the anchor registry
 * (`pick.ts`). One pick → `activateBody` (fly there; select who works on it or show what it is);
 * several bodies under the pointer → the "what's here" list (corner case 24); none → closes the
 * popover.
 *
 * Highlights: a faint ring around the hovered body and a brighter one around the selected
 * agent's body — billboards drawn over everything, never smaller than a few pixels, so they read
 * at system scale and on the mobile tier (no composer). With a composer, the selected body also
 * gets the postprocessing outline (`outline` ref, `SolarScene`) and its ring shows only while the
 * body is small on screen — except Earth for the default Harmonizer selection, which keeps its
 * ring and gets no outline (`outlineBody`: an empty outline selection skips the effect's depth
 * pass over the whole scene). The `<Outline>` stays mounted either way (no shader recompiles).
 * The outline's meshes are re-collected every frame from the anchor's subtree, so a mesh swapped
 * by LOD (P3-06) is followed.
 *
 * Labels (P3-07) are extra pick targets resolved here, not DOM click targets: the label layer
 * takes no pointer events, so a wheel, a drag or a press-drag-release that starts on a label
 * reaches the canvas like any other (`labelUnder` has the rule).
 *
 * Unmounting (the scene hidden, the WebGL context lost) clears the hover label and closes the
 * popover: they live in a module store that outlives the canvas.
 */
export interface PickingProps {
  /** The composer's outline effect; absent on tiers without a composer. */
  outline?: RefObject<OutlineEffect | null> | undefined;
}

/** Ring sizes: the body's radius × this, never below `RING_MIN_PX` pixels of radius. */
const RING_SCALE = 1.35;
const RING_MIN_PX = 10;
/** With the outline on, the selection ring stays only while the body is smaller than this. */
const RING_WITH_OUTLINE_PX = 18;

export function Picking({ outline }: PickingProps) {
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const [tools] = useState(() => ({
    raycaster: new Raycaster(),
    ndc: new Vector2(),
    seenCamera: new Matrix4(),
  }));
  /** Asks for a hover pick at the last pointer position (set by the listeners' effect). */
  const repick = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    const canvas = gl.domElement;
    const tracker = new ClickTracker();
    let frame = 0;
    let last: PointerEvent | undefined;
    let pressed = false;

    const pointAt = (e: { clientX: number; clientY: number }): Point => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const pick = (at: Point): PickResult => {
      const { camera, size } = get();
      const cam = camera as PerspectiveCamera;
      tools.ndc.set((at.x / size.width) * 2 - 1, -(at.y / size.height) * 2 + 1);
      tools.raycaster.setFromCamera(tools.ndc, cam);
      const { origin, direction } = tools.raycaster.ray;
      return pickBodies(
        {
          origin: [origin.x, origin.y, origin.z],
          direction: [direction.x, direction.y, direction.z],
        },
        allAnchors().map((a) => ({
          bodyId: a.bodyId,
          center: anchorPosition(a),
          radius: a.radius,
        })),
        pixelScale(size.height, cam.fov ?? 45),
      );
    };
    const hoverNow = () => {
      frame = 0;
      const e = last;
      if (!e) return;
      const at = pointAt(e);
      const result = pick(at);
      const label = labelUnder(result, at);
      const top = label ?? result.choice ?? result.candidates[0]?.bodyId;
      const picking = usePickingStore.getState();
      if (!top) {
        picking.setHover(undefined);
      } else {
        const world = useAppStore.getState().world;
        picking.setHover({
          bodyId: top,
          name: bodyName(world, top),
          others: label || result.choice ? 0 : result.candidates.length - 1,
          ...at,
        });
      }
      canvas.style.cursor = top ? 'pointer' : '';
      invalidate();
    };

    const requestHover = () => {
      if (!frame) frame = requestAnimationFrame(hoverNow);
    };
    // The camera moved under a still pointer (a flight, a follow, the keyboard): the body under it
    // may have changed. Not while a button is held (a drag: OrbitControls' business).
    repick.current = () => {
      if (last && !pressed) requestHover();
    };

    const onDown = (e: PointerEvent) => {
      pressed = true;
      tracker.down({
        pointerId: e.pointerId,
        button: e.button,
        pointerType: e.pointerType,
        ...xy(e),
        at: e.timeStamp,
      });
    };
    const onMove = (e: PointerEvent) => {
      tracker.move({ pointerId: e.pointerId, ...xy(e) });
      if (e.buttons !== 0) return; // dragging: OrbitControls' business
      last = e;
      requestHover();
    };
    const onUp = (e: PointerEvent) => {
      pressed = false;
      if (!tracker.up({ pointerId: e.pointerId, ...xy(e), at: e.timeStamp })) {
        noteUserCameraInput();
        return;
      }
      const at = pointAt(e);
      const result = pick(at);
      const label = labelUnder(result, at);
      const picking = usePickingStore.getState();
      // The camera is about to move: the label comes back once it does (`repick`).
      picking.setHover(undefined);
      if (label) activateBody(label, at);
      else if (result.choice) activateBody(result.choice, at);
      else if (result.candidates.length > 1) {
        picking.showHere(
          at,
          result.candidates.map((c) => c.bodyId),
        );
      } else picking.closePopover();
    };
    const onCancel = () => {
      pressed = false;
      tracker.cancel();
    };
    const onLeave = () => {
      last = undefined;
      usePickingStore.getState().setHover(undefined);
      canvas.style.cursor = '';
      invalidate();
    };
    const onWheel = () => noteUserCameraInput();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.style.cursor = '';
      repick.current = undefined;
      const picking = usePickingStore.getState();
      picking.setHover(undefined);
      picking.closePopover();
    };
  }, [gl, get, invalidate, tools]);

  useFrame((state) => {
    const m = state.camera.matrixWorld;
    if (tools.seenCamera.equals(m)) return;
    tools.seenCamera.copy(m);
    repick.current?.();
  });

  const hovered = usePickingStore((s) => s.hover?.bodyId);
  const selected = useAppStore((s) => selectionBody(s.world, s.selection));
  const outlined = useAppStore((s) => outlineBody(s.world, s.selection));
  useEffect(() => invalidate(), [hovered, selected, invalidate]);
  // The ring yields to the outline only where there is one.
  const outlineShown = outline !== undefined && outlined !== undefined && outlined === selected;

  return (
    <>
      <HighlightRing
        bodyId={hovered !== selected ? hovered : undefined}
        color="#ffffff"
        opacity={0.35}
      />
      <HighlightRing
        bodyId={selected}
        color="#7fb2ff"
        opacity={0.9}
        {...(outlineShown ? { hideAbovePx: RING_WITH_OUTLINE_PX } : {})}
      />
      {outline && <OutlineSync effect={outline} bodyId={outlined} />}
    </>
  );
}

const xy = (e: PointerEvent) => ({ x: e.clientX, y: e.clientY });

/**
 * The label-vs-body rule (P3-07): a body the pointer's ray passes through (its drawn sphere or its
 * minimum target, `hit`) takes precedence — so a moon under its planet's label stays clickable, and
 * a body in front of a label is what the user sees under the pointer. Otherwise a shown label's
 * rectangle under the pointer means that label's body, over near misses (bodies merely within
 * `CLUSTER_PX`, such as the label's own body just below it). `undefined`: no label decides it.
 */
export function labelUnder(result: PickResult, at: Point): string | undefined {
  if (result.candidates.some((c) => c.hit)) return undefined;
  return labelAt(at.x, at.y);
}

/**
 * A thin ring facing the camera around a body's anchor, drawn over everything (no depth test), at
 * least `RING_MIN_PX` in radius. `hideAbovePx`: hidden once the body is that big on screen.
 */
function HighlightRing({
  bodyId,
  color,
  opacity,
  hideAbovePx,
}: {
  bodyId: string | undefined;
  color: string;
  opacity: number;
  hideAbovePx?: number;
}) {
  const ref = useRef<Mesh>(null);
  useFrame((state) => {
    const ring = ref.current;
    if (!ring) return;
    const anchor = bodyId ? getAnchor(bodyId) : undefined;
    if (!anchor) {
      ring.visible = false;
      return;
    }
    const camera = state.camera as PerspectiveCamera;
    const [x, y, z] = anchorPosition(anchor);
    const depth = Math.max(1e-6, camera.position.distanceTo(ring.position.set(x, y, z)));
    const perPx = depth / pixelScale(state.size.height, camera.fov ?? 45);
    const screenRadius = anchor.radius / perPx;
    ring.visible = hideAbovePx === undefined || screenRadius < hideAbovePx;
    ring.quaternion.copy(camera.quaternion);
    ring.scale.setScalar(Math.max(anchor.radius * RING_SCALE, RING_MIN_PX * perPx));
  });
  return (
    <mesh ref={ref} visible={false} renderOrder={10} frustumCulled={false} name="pick-highlight">
      <ringGeometry args={[0.95, 1, 96]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/**
 * Keeps the outline effect's selection on the outlined body's meshes (LOD-proof, per frame). A
 * recreated effect (the composer remounted) gets the selection again even if the meshes are the
 * same.
 */
export function OutlineSync({
  effect,
  bodyId,
}: {
  effect: RefObject<OutlineEffect | null>;
  bodyId: string | undefined;
}) {
  const current = useRef<{ effect: OutlineEffect | null; meshes: Object3D[] }>({
    effect: null,
    meshes: [],
  });
  const invalidate = useThree((s) => s.invalidate);
  useFrame(() => {
    const outline = effect.current;
    if (!outline) return;
    const anchor = bodyId ? getAnchor(bodyId) : undefined;
    const meshes = anchor ? outlineMeshes(anchor.object, anchor.bodyId) : [];
    const was = current.current;
    if (was.effect === outline && sameMeshes(meshes, was.meshes)) return;
    current.current = { effect: outline, meshes };
    outline.selection.set(meshes);
    invalidate();
  });
  useEffect(
    () => () => {
      effect.current?.selection.clear();
      current.current = { effect: null, meshes: [] };
    },
    [effect],
  );
  return null;
}
