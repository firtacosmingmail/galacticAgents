import { useEffect, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  Matrix4,
  Raycaster,
  Vector2,
  Vector3,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
} from 'three';
import type { OutlineEffect } from 'postprocessing';
import { anchorList, getAnchor } from '../anchors.js';
import { labelAt } from '../labels/registry.js';
import { anchorPosition } from '../camera/store.js';
import { sceneWorld, useAppStore } from '../../state/store.js';
import { getSatellite, satelliteFrames } from '../satellites/registry.js';
import { prefersReducedMotion } from '../motion.js';
import { bodyName, outlineBody, selectionBody } from './body-action.js';
import { ClickTracker } from './click.js';
import { pixelScale, type PickSphere } from './pick.js';
import {
  hoverTarget,
  occluded,
  pickScene,
  type PickTarget,
  type SatelliteSphere,
  type ScenePick,
} from './scene-pick.js';
import { keepsGrace, startGrace, type Grace, type SatelliteOnScreen } from './hover-grace.js';
import {
  bodyInView,
  depthPassWithoutDecor,
  outlineMeshes,
  sameMeshes,
  viewScratch,
  type OutlineDepthPassOwner,
} from './outline.js';
import { DECOR_LAYER } from '../layers.js';
import type { Vec3 } from '../camera/flight.js';
import {
  activateBody,
  activateSatellite,
  deselectFromScene,
  hoveredBody,
  hoveredSatellite,
  moveHover,
  usePickingStore,
  type Point,
} from './store.js';
import { noteUserCameraInput } from './sync.js';
import { beaconsDrawn, beaconUnder } from '../beacons/registry.js';
import { activateBeacon } from '../beacons/activate.js';

/**
 * Picking, hover and the selection highlight inside the canvas (P3-05).
 *
 * Pointer events on the canvas element itself (R3F's own raycasting stays off: no object has a
 * handler): a hover pick on move, and again when the camera moves under a still pointer (at most
 * once per animation frame either way), a click pick on a release that was not a drag
 * (`ClickTracker`, with a wider slop for touch). Picks are ray-vs-sphere over the anchor registry
 * (`pick.ts`). One pick → `activateBody` (fly there; select who works on it or show what it is);
 * several bodies under the pointer → the "what's here" list (corner case 24); none → closes the
 * popover, or, with no popover open, deselects: back to the Harmonizer (P5-01,
 * `deselectFromScene`; the camera stays).
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
 * Satellites (P4-08) are pick targets too (`pickScene`: a satellite under the pointer wins over
 * the body behind it and over labels; a body's surface in front of it hides it). Hovering one
 * shows its agent's card at the satellite's point on screen, followed as it orbits: while any
 * satellite is drawn and the pointer rests on the canvas, the hover is re-picked once per frame,
 * inside the frame after the director moved them (satellites move without the camera moving). A
 * picked satellite is kept for a while by the hover grace (`hover-grace.ts`), so an orbiting one
 * can be read. At the system view (a speck of a planet and its satellites under the pointer) the
 * hover names the planet, "+n". The hovered satellite gets the faint ring too; a click selects
 * its agent (`activateSatellite`) and flies to its body — the satellite hovered at the press, if it
 * can still be seen, without re-picking (it may have orbited out from under the pointer).
 *
 * Question beacons (P4-05, `beacons/`) are tested first: a beacon's glyph under the pointer wins
 * over everything (satellites, bodies, labels, a satellite kept by the hover grace) — it is drawn
 * over everything too. There is one per question (P4-13), each hit on its own. Hovering one shows
 * its question's card; a click selects the asking agent, flies to its body and opens that question
 * in the inbox (`activateBeacon`).
 *
 * Per-frame cost: the pick spheres, the ray and the anchors' positions are scratch buffers reused
 * from pick to pick; the canvas's page position is cached (dropped on resize, scroll, re-entry);
 * the hover's position goes through `moveHover`, not the React-selected store state.
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
    projected: new Vector3(),
    ray: { origin: [0, 0, 0], direction: [0, 0, 0] } as {
      origin: [number, number, number];
      direction: [number, number, number];
    },
    eye: [0, 0, 0] as [number, number, number],
    bodies: [] as ScratchBodySphere[],
    satellites: [] as ScratchSatelliteSphere[],
  }));
  /** Asks for a hover pick at the last pointer position, now (set by the listeners' effect). */
  const repick = useRef<(() => void) | undefined>(undefined);
  /** Forgets the canvas's cached position (set by the listeners' effect). */
  const dropRect = useRef<(() => void) | undefined>(undefined);
  /** The canvas size last seen by the frame loop (a change drops the cached position). */
  const seenSize = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const canvas = gl.domElement;
    const tracker = new ClickTracker();
    let frame = 0;
    let last: PointerEvent | undefined;
    let pressed = false;
    /** The pointer's last move (`performance.now()`), for the grace's cap. */
    let movedAt = 0;
    /** The satellite kept hovered by the grace (`hover-grace.ts`). */
    let grace: Grace | undefined;
    /** The satellite hovered when the button went down: a click on it activates it. */
    let pressedSatellite: string | undefined;
    /** The canvas's position on the page, cached: dropped on resize, scroll and re-entry. */
    let rect: DOMRect | undefined;
    const forgetRect = () => {
      rect = undefined;
    };
    dropRect.current = forgetRect;

    const pointAt = (e: { clientX: number; clientY: number }): Point => {
      rect ??= canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const pxScale = () => {
      const { camera, size } = get();
      return pixelScale(size.height, (camera as PerspectiveCamera).fov ?? 45);
    };
    /** The pointer's ray, written into `tools.ray`. */
    const aim = (at: Point) => {
      const { camera, size } = get();
      const cam = camera as PerspectiveCamera;
      tools.ndc.set((at.x / size.width) * 2 - 1, -(at.y / size.height) * 2 + 1);
      tools.raycaster.setFromCamera(tools.ndc, cam);
      const { origin, direction } = tools.raycaster.ray;
      const ray = tools.ray;
      ray.origin[0] = origin.x;
      ray.origin[1] = origin.y;
      ray.origin[2] = origin.z;
      ray.direction[0] = direction.x;
      ray.direction[1] = direction.y;
      ray.direction[2] = direction.z;
      return ray;
    };
    /** The question beacon under the pointer (P4-05), if any. */
    const beaconAt = (at: Point) => beaconUnder(aim(at));
    const pick = (at: Point): ScenePick => {
      const ray = aim(at);
      return pickScene(
        ray,
        bodySpheres(tools.bodies),
        satelliteSpheres(tools.satellites),
        pxScale(),
      );
    };
    /**
     * A drawn satellite as the pointer sees it: its point on screen (CSS pixels from the canvas's
     * corner, whole pixels) and radius in pixels; `undefined` when it is gone (not visible,
     * shrunk out), off screen or behind a body.
     */
    const seen = (agentId: string): SatelliteOnScreen | undefined => {
      const f = getSatellite(agentId);
      if (!f || !f.visible || f.presence <= 0 || f.size <= 0) return undefined;
      const { camera, size } = get();
      const p = tools.projected.set(f.position[0], f.position[1], f.position[2]).project(camera);
      if (p.z < -1 || p.z > 1) return undefined;
      const x = Math.round(((p.x + 1) / 2) * size.width);
      const y = Math.round(((1 - p.y) / 2) * size.height);
      if (x < 0 || y < 0 || x > size.width || y > size.height) return undefined;
      const eye = tools.eye;
      camera.getWorldPosition(tools.projected);
      eye[0] = tools.projected.x;
      eye[1] = tools.projected.y;
      eye[2] = tools.projected.z;
      if (occluded(eye, f.position, bodySpheres(tools.bodies))) return undefined;
      const depth = Math.max(
        1e-6,
        Math.hypot(f.position[0] - eye[0], f.position[1] - eye[1], f.position[2] - eye[2]),
      );
      return { x, y, radius: (f.size / 2) * (pxScale() / depth) };
    };
    const hoverSatellite = (agentId: string, others: number, at: Point) => {
      const f = getSatellite(agentId);
      const point = seen(agentId) ?? at;
      moveHover(point.x, point.y);
      usePickingStore.getState().setHover({
        kind: 'satellite',
        agentId,
        mode: f?.mode ?? 'orbiting',
        satelliteBodyId: f?.bodyId ?? '',
        others,
      });
    };
    const hoverNow = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const e = last;
      if (!e) return;
      const at = pointAt(e);
      const picking = usePickingStore.getState();
      const was = picking.hover;
      // A question beacon wins over everything under it (P4-05).
      const beacon = beaconAt(at);
      if (beacon) {
        grace = undefined;
        moveHover(at.x, at.y);
        picking.setHover({ kind: 'beacon', bodyId: beacon.bodyId, questionId: beacon.questionId });
        canvas.style.cursor = 'pointer';
        if (usePickingStore.getState().hover !== was) invalidate();
        return;
      }
      // A satellite kept by the grace stays hovered, whatever is under the pointer now.
      if (
        grace &&
        !picking.popover &&
        !prefersReducedMotion() &&
        keepsGrace(grace, at, seen(grace.agentId), performance.now() - movedAt)
      ) {
        hoverSatellite(grace.agentId, 0, at);
        canvas.style.cursor = 'pointer';
        if (usePickingStore.getState().hover !== was) invalidate();
        return;
      }
      grace = undefined;
      const result = pick(at);
      const label = labelUnder(result, at);
      const hit = label
        ? { target: { kind: 'body', bodyId: label } as PickTarget, others: 0 }
        : hoverTarget(result);
      if (!hit) {
        picking.setHover(undefined);
      } else if (hit.target.kind === 'satellite') {
        hoverSatellite(hit.target.agentId, hit.others, at);
        if (!picking.popover && !prefersReducedMotion()) {
          grace = startGrace(hit.target.agentId, at);
        }
      } else {
        const world = sceneWorld(useAppStore.getState());
        moveHover(at.x, at.y);
        picking.setHover({
          bodyId: hit.target.bodyId,
          name: bodyName(world, hit.target.bodyId),
          others: hit.others,
        });
      }
      canvas.style.cursor = hit ? 'pointer' : '';
      // Re-picked every frame while satellites are drawn: redraw only when something changed
      // (the demand loop would otherwise never rest).
      if (usePickingStore.getState().hover !== was) invalidate();
    };

    const requestHover = () => {
      if (!frame) frame = requestAnimationFrame(hoverNow);
    };
    // The camera moved under a still pointer (a flight, a follow, the keyboard), or satellites
    // moved: what is under it may have changed. Picked at once, inside the frame (after the
    // satellites' director wrote this frame's positions), so the card is not a frame behind. Not
    // while a button is held (a drag: OrbitControls' business).
    repick.current = () => {
      if (last && !pressed) hoverNow();
    };

    const onDown = (e: PointerEvent) => {
      pressed = true;
      pressedSatellite = hoveredSatellite(usePickingStore.getState().hover);
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
      movedAt = performance.now();
      if (e.buttons !== 0) return; // dragging: OrbitControls' business
      last = e;
      requestHover();
    };
    const onUp = (e: PointerEvent) => {
      pressed = false;
      const kept = pressedSatellite;
      pressedSatellite = undefined;
      if (!tracker.up({ pointerId: e.pointerId, ...xy(e), at: e.timeStamp })) {
        noteUserCameraInput();
        return;
      }
      const picking = usePickingStore.getState();
      // The camera is about to move: the label comes back once it does (`repick`).
      picking.setHover(undefined);
      grace = undefined;
      const at = pointAt(e);
      // A question beacon goes to its asker and opens its question in the inbox (P4-05, P4-13).
      const beacon = beaconAt(at);
      if (beacon) {
        activateBeacon(beacon.questionId);
        return;
      }
      // The satellite hovered at the press (picked, or kept by the grace) may have orbited out
      // from under the pointer since: the click is still meant for it, while it can be seen.
      if (kept && seen(kept) && activateSatellite(kept)) return;
      const result = pick(at);
      const label = labelUnder(result, at);
      const choice = result.choice;
      if (label) activateBody(label, at);
      else if (choice?.kind === 'satellite') activateSatellite(choice.agentId);
      else if (choice) activateBody(choice.bodyId, at);
      else if (result.candidates.length > 1) {
        picking.showHere(
          at,
          result.candidates.flatMap((c) => (c.kind === 'body' ? [c.bodyId] : [])),
          result.candidates.flatMap((c) => (c.kind === 'satellite' ? [c.agentId] : [])),
        );
      } else if (picking.popover || result.candidates.length > 0) picking.closePopover();
      // Empty space (P5-01): the first click closes an open card; with none open, deselects.
      else deselectFromScene();
    };
    const onCancel = () => {
      pressed = false;
      pressedSatellite = undefined;
      tracker.cancel();
    };
    const onLeave = () => {
      last = undefined;
      grace = undefined;
      usePickingStore.getState().setHover(undefined);
      canvas.style.cursor = '';
      invalidate();
    };
    const onWheel = () => noteUserCameraInput();
    const resizes =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(forgetRect);
    resizes?.observe(canvas);

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerenter', forgetRect);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('resize', forgetRect);
    window.addEventListener('scroll', forgetRect, { capture: true, passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizes?.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerenter', forgetRect);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', forgetRect);
      window.removeEventListener('scroll', forgetRect, { capture: true });
      canvas.style.cursor = '';
      repick.current = undefined;
      dropRect.current = undefined;
      const picking = usePickingStore.getState();
      picking.setHover(undefined);
      picking.closePopover();
    };
  }, [gl, get, invalidate, tools]);

  useFrame((state) => {
    const m = state.camera.matrixWorld;
    const moved = !tools.seenCamera.equals(m);
    if (moved) tools.seenCamera.copy(m);
    const { width, height } = state.size;
    const seen = seenSize.current;
    if (seen.width !== width || seen.height !== height) {
      seen.width = width;
      seen.height = height;
      dropRect.current?.();
    }
    // Satellites move on their own: the one under a still pointer changes, the card follows (and
    // a hovered satellite that was just hidden lets go).
    const hoveringSatellite = usePickingStore.getState().hover?.kind === 'satellite';
    // Beacons ride their bodies: the one under a still pointer changes too (P4-05).
    if (moved || hoveringSatellite || satellitesDrawn() || beaconsDrawn()) repick.current?.();
  });

  const hovered = usePickingStore((s) => hoveredBody(s.hover));
  const hoveredAgent = usePickingStore((s) => hoveredSatellite(s.hover));
  const selected = useAppStore((s) => selectionBody(sceneWorld(s), s.selection));
  const outlined = useAppStore((s) => outlineBody(sceneWorld(s), s.selection));
  useEffect(() => invalidate(), [hovered, hoveredAgent, selected, invalidate]);
  // The ring yields to the outline only where there is one.
  const outlineShown = outline !== undefined && outlined !== undefined && outlined === selected;

  return (
    <>
      <HighlightRing
        bodyId={hovered !== selected ? hovered : undefined}
        color="#ffffff"
        opacity={0.35}
      />
      <HighlightRing agentId={hoveredAgent} color="#ffffff" opacity={0.55} />
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

type ScratchBodySphere = PickSphere & { center: [number, number, number] };
type ScratchSatelliteSphere = { -readonly [K in keyof SatelliteSphere]: SatelliteSphere[K] };

/**
 * The anchors as pick spheres, written into `out` (reused from pick to pick: no per-frame arrays
 * or objects once it has grown to the number of anchors).
 */
export function bodySpheres(out: ScratchBodySphere[] = []): readonly PickSphere[] {
  const anchors = anchorList();
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const s = (out[i] ??= { bodyId: '', center: [0, 0, 0], radius: 0 });
    s.bodyId = a.bodyId;
    s.radius = a.radius;
    anchorPosition(a, s.center);
  }
  out.length = anchors.length;
  return out;
}

/**
 * The drawn satellites as pick spheres — visible, not fully shrunk out, half their span — written
 * into `out` (reused; each sphere's centre is the live frame's `position`, not a copy).
 */
export function satelliteSpheres(out: ScratchSatelliteSphere[] = []): readonly SatelliteSphere[] {
  const frames = satelliteFrames();
  let n = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (!f.visible || f.presence <= 0 || f.size <= 0) continue;
    const s = (out[n++] ??= { agentId: '', center: f.position, radius: 0 });
    // P4-04: landed satellites are picked only by a direct hit up close (`pickScene`).
    s.agentId = f.agentId;
    s.role = f.role;
    s.landed = f.mode === 'landed';
    s.bodyId = f.bodyId;
    s.center = f.position;
    s.radius = f.size / 2;
  }
  out.length = n;
  return out;
}

/** Whether any satellite is drawn (iterates the registry's own array: no copy). */
export function satellitesDrawn(): boolean {
  const frames = satelliteFrames();
  for (let i = 0; i < frames.length; i++) if (frames[i]!.visible) return true;
  return false;
}

/**
 * The label-vs-body rule (P3-07): a body the pointer's ray passes through (its drawn sphere or its
 * minimum target, `hit`) takes precedence — so a moon under its planet's label stays clickable, and
 * a body in front of a label is what the user sees under the pointer. Otherwise a shown label's
 * rectangle under the pointer means that label's body, over near misses (bodies merely within
 * `CLUSTER_PX`, such as the label's own body just below it). A satellite under the pointer wins
 * over labels too (P4-08). `undefined`: no label decides it.
 */
export function labelUnder(result: ScenePick, at: Point): string | undefined {
  if (result.satellites.length > 0) return undefined;
  if (result.bodies.candidates.some((c) => c.hit)) return undefined;
  return labelAt(at.x, at.y);
}

/**
 * A thin ring facing the camera around a body's anchor — or around a satellite (`agentId`,
 * P4-08) — drawn over everything (no depth test), at least `RING_MIN_PX` in radius.
 * `hideAbovePx`: hidden once the body is that big on screen.
 */
function HighlightRing({
  bodyId,
  agentId,
  color,
  opacity,
  hideAbovePx,
}: {
  bodyId?: string | undefined;
  agentId?: string | undefined;
  color: string;
  opacity: number;
  hideAbovePx?: number;
}) {
  const ref = useRef<Mesh>(null);
  useFrame((state) => {
    const ring = ref.current;
    if (!ring) return;
    const target = ringTarget(bodyId, agentId);
    if (!target) {
      ring.visible = false;
      return;
    }
    const camera = state.camera as PerspectiveCamera;
    const [x, y, z] = target.center;
    const depth = Math.max(1e-6, camera.position.distanceTo(ring.position.set(x, y, z)));
    const perPx = depth / pixelScale(state.size.height, camera.fov ?? 45);
    const screenRadius = target.radius / perPx;
    ring.visible = hideAbovePx === undefined || screenRadius < hideAbovePx;
    ring.quaternion.copy(camera.quaternion);
    ring.scale.setScalar(Math.max(target.radius * RING_SCALE, RING_MIN_PX * perPx));
  });
  return (
    <mesh
      ref={ref}
      visible={false}
      renderOrder={10}
      frustumCulled={false}
      name="pick-highlight"
      layers={DECOR_LAYER}
    >
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

/** Where a highlight ring goes: a body's anchor, or a drawn satellite (half its span). */
function ringTarget(
  bodyId: string | undefined,
  agentId: string | undefined,
): { center: Vec3; radius: number } | undefined {
  if (agentId) {
    const f = getSatellite(agentId);
    return f && f.visible && f.presence > 0
      ? { center: f.position, radius: f.size / 2 }
      : undefined;
  }
  const anchor = bodyId ? getAnchor(bodyId) : undefined;
  return anchor ? { center: anchorPosition(anchor), radius: anchor.radius } : undefined;
}

/**
 * Keeps the outline effect's selection on the outlined body's meshes (LOD-proof, per frame). A
 * recreated effect (the composer remounted) gets the selection again even if the meshes are the
 * same.
 *
 * Cost (P3-08): a non-empty selection re-renders the scene into the effect's depth pass every
 * frame. So the selection is emptied while the body is off screen (`bodyInView`), and the depth
 * pass leaves out the decorations (`depthPassWithoutDecor`, `layers.ts`).
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
  const [scratch] = useState(viewScratch);
  useFrame((state) => {
    const outline = effect.current;
    if (!outline) return;
    depthPassWithoutDecor(outline as unknown as Partial<OutlineDepthPassOwner>);
    const anchor = bodyId ? getAnchor(bodyId) : undefined;
    // Off screen, nothing to outline: an empty selection skips the effect's passes (P3-08).
    const meshes =
      anchor && bodyInView(state.camera, anchor.object, anchor.radius, scratch)
        ? outlineMeshes(anchor.object, anchor.bodyId)
        : [];
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
