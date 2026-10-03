import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  CanvasTexture,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  type PerspectiveCamera,
} from 'three';
import { useAppStore } from '../../state/store.js';
import { getAnchor, onAnchorsChanged } from '../anchors.js';
import { anchorPosition } from '../camera/store.js';
import { DECOR_LAYER } from '../layers.js';
import { motionSeconds, useReducedMotion } from '../motion.js';
import { pixelScale } from '../picking/pick.js';
import {
  BEACON,
  BEACON_COLOR,
  beaconLayout,
  beaconPulse,
  glyphInView,
  glyphKey,
  glyphSpec,
  type BeaconLayout,
  type BeaconPulse,
  type GlyphSpec,
} from './beacon-look.js';
import { beaconHq, beaconList, sameBeacons, type BeaconSpec } from './beacon-model.js';
import { drawGlyph, drawPillar, GLYPH_TEXTURE_PX, PILLAR_TEXTURE } from './glyph-draw.js';
import { placeBeacon, publishBeacons, type BeaconFrame } from './registry.js';

/**
 * The question beacons (P4-05; SPEC §4.1): a beacon above every body with an open question the
 * user holds — an amber light pillar rising from the body and a glyph on top (a padlock diamond
 * for a permission, a "?" disc for a clarification, a count badge when several wait), with a halo
 * that pulses outwards. The world → beacons list is `beacon-model.ts`, the look and the layout
 * `beacon-look.ts`, the sprites `glyph-draw.ts` (all three-free and tested); this component only
 * places the billboards once per frame.
 *
 * Each beacon is a group facing the camera, scaled to world units per screen pixel at its body's
 * depth, so its parts are laid out in pixels: the same size at the whole-system view and up close,
 * and never smaller than the glyph (34 px) and its 36 px click target. Drawn over everything (no
 * depth test, after the highlight rings), on the decorations' layer (`DECOR_LAYER`: the selection
 * outline's depth pass skips it). Three draw calls per beacon on screen (pillar, halo, glyph): a
 * beacon whose glyph is outside the viewport is hidden (`glyphInView`), and every beacon shares one
 * plane and one ring geometry (`BeaconShapes`); one glyph texture per kind and count, drawn at
 * runtime. Instancing them (three draw calls in all, a glyph atlas with a UV offset per instance)
 * was weighed and left out: there is one beacon per body with a question waiting for the user —
 * a handful at most — so it would buy a few draw calls for a custom shader and the loss of the
 * per-beacon render order (TECHNOLOGY §2.1).
 *
 * Lifecycle: the list follows the store — a question opened for the user or escalated to the user
 * lights its body's beacon, an answer, a cancellation or a reassignment away from the user puts it
 * out, at the next render (well within a second). A change asks the on-demand loop for a frame.
 * Only a change of what is drawn does (`useBeaconList`): status flushes leave the beacons alone.
 *
 * Under `prefers-reduced-motion` the halo and the pillar are steady (`STEADY_PULSE`); otherwise
 * the halo pulses on the shared motion clock (the continuous loop is running then anyway).
 *
 * Picking reads the glyphs' positions from `registry.ts` (a beacon wins over the body under it).
 *
 * A beacon is laid out in the camera's pixels, so it must see this frame's camera: the camera rig
 * runs at `PLACE_CAMERA`, before the beacons' default priority (`frame-order.ts`), whatever the
 * mount order (before that, a beacon mounted before the rig was left by the on-demand loop's last
 * frame where the previous camera pose put it — off screen after the rig's first placement).
 */
export function Beacons() {
  const list = useBeaconList();
  const reducedMotion = useReducedMotion();
  const invalidate = useThree((s) => s.invalidate);

  // One live frame per beacon, published for picking; rebuilt when the set changes, carrying each
  // surviving beacon's last placement over (picking and the hover keep it until the next frame).
  const previous = useRef<readonly BeaconFrame[]>([]);
  useEffect(() => {
    const frames = carryFrames(previous.current, list);
    previous.current = frames;
    publishBeacons(frames);
    invalidate();
    return () => publishBeacons([]);
  }, [list, invalidate]);
  useEffect(() => onAnchorsChanged(() => invalidate()), [invalidate]);
  useEffect(() => invalidate(), [reducedMotion, invalidate]);

  const [textures] = useState(() => new BeaconTextures());
  useEffect(() => () => textures.dispose(), [textures]);
  // One plane (pillar and glyph quads) and one ring (halo) for every beacon.
  const [shapes] = useState(beaconShapes);
  useEffect(() => () => shapes.dispose(), [shapes]);

  return (
    <>
      {list.map((b) => (
        <Beacon
          key={b.bodyId}
          spec={b}
          glyph={textures.glyph(glyphSpec(b.kind, b.count))}
          pillar={textures.pillar()}
          shapes={shapes}
          reducedMotion={reducedMotion}
        />
      ))}
    </>
  );
}

/**
 * The beacons of the store, kept by reference while they draw the same (`sameBeacons`). It reads
 * the questions, the work rows and headquarters' body (a string), never the status records: a
 * status flush (several a second) neither recomputes nor re-renders the beacons.
 */
export function useBeaconList(): BeaconSpec[] {
  const questions = useAppStore((s) => s.world.questions);
  const agents = useAppStore((s) => s.world.agents);
  const tasks = useAppStore((s) => s.world.tasks);
  const projects = useAppStore((s) => s.world.projects);
  const bodies = useAppStore((s) => s.world.bodies);
  const hqBodyId = useAppStore((s) => beaconHq(s.world));
  const next = useMemo(
    () => beaconList({ questions, agents, tasks, projects, bodies, hqBodyId }),
    [questions, agents, tasks, projects, bodies, hqBodyId],
  );
  // The previous list while it draws the same (state from the previous render, React's pattern).
  const [kept, setKept] = useState(next);
  if (kept !== next && !sameBeacons(kept, next)) {
    setKept(next);
    return next;
  }
  return kept;
}

/** The frames of a new beacon list: a beacon still there keeps its last placement. */
export function carryFrames(
  previous: readonly BeaconFrame[],
  list: readonly BeaconSpec[],
): BeaconFrame[] {
  const before = new Map(previous.map((f) => [f.bodyId, f]));
  return list.map<BeaconFrame>((b) => {
    const was = before.get(b.bodyId);
    return {
      bodyId: b.bodyId,
      visible: was?.visible ?? false,
      center: was ? [was.center[0], was.center[1], was.center[2]] : [0, 0, 0],
      perPx: was?.perPx ?? 0,
    };
  });
}

/**
 * The geometries every beacon shares (one upload, not three per beacon): a unit plane for the
 * pillar and the glyph, and the halo's ring. `count` is how many sets were ever made (tests).
 */
export class BeaconShapes {
  static count = 0;
  readonly plane = new PlaneGeometry(1, 1);
  readonly ring = new RingGeometry(0.86, 1, 48);
  constructor() {
    BeaconShapes.count++;
  }
  dispose(): void {
    this.plane.dispose();
    this.ring.dispose();
  }
}

const beaconShapes = () => new BeaconShapes();

const position = new Vector3();
const inCamera = new Vector3();
const up = new Vector3();
const glyphCentre: [number, number, number] = [0, 0, 0];
const layout: BeaconLayout = { glyphY: 0, pillarFrom: 0, pillarTo: 0 };
const pulseScratch: BeaconPulse = { haloScale: 0, haloOpacity: 0, pillarOpacity: 0 };

function Beacon({
  spec,
  glyph,
  pillar,
  shapes,
  reducedMotion,
}: {
  spec: BeaconSpec;
  glyph: CanvasTexture;
  pillar: CanvasTexture;
  shapes: BeaconShapes;
  reducedMotion: boolean;
}) {
  const group = useRef<Group>(null);
  const pillarMesh = useRef<Mesh>(null);
  const halo = useRef<Mesh>(null);
  const glyphMesh = useRef<Mesh>(null);
  const [centre] = useState<[number, number, number]>(() => [0, 0, 0]);

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const anchor = getAnchor(spec.bodyId);
    const camera = state.camera as PerspectiveCamera;
    if (anchor) {
      anchorPosition(anchor, centre);
      position.set(centre[0], centre[1], centre[2]);
      inCamera.copy(position).applyMatrix4(camera.matrixWorldInverse);
    }
    // No anchor yet (the body not drawn), or behind the camera: nothing to draw or to click.
    if (!anchor || inCamera.z >= 0) {
      hide(g, spec.bodyId);
      return;
    }
    const { width, height } = state.size;
    const perPx =
      Math.max(1e-6, camera.position.distanceTo(position)) / pixelScale(height, camera.fov ?? 45);
    const projected = inCamera.copy(position).project(camera);
    const bodyY = ((1 - projected.y) / 2) * height;
    beaconLayout(anchor.radius / perPx, bodyY, layout);
    // Off screen (its glyph and halo outside the viewport): not drawn, not clickable.
    if (!glyphInView(projected.x, projected.y, layout.glyphY, width, height)) {
      hide(g, spec.bodyId);
      return;
    }
    const pulse = beaconPulse(motionSeconds(), reducedMotion, pulseScratch);

    g.visible = true;
    g.position.copy(position);
    g.quaternion.copy(camera.quaternion);
    g.scale.setScalar(perPx);
    const glyphMeshNow = glyphMesh.current;
    if (glyphMeshNow) {
      glyphMeshNow.position.set(0, layout.glyphY, 0);
      glyphMeshNow.scale.setScalar(BEACON.glyphPx);
    }
    const haloNow = halo.current;
    if (haloNow) {
      haloNow.position.set(0, layout.glyphY, 0);
      haloNow.scale.setScalar((BEACON.glyphPx / 2) * pulse.haloScale);
      (haloNow.material as MeshBasicMaterial).opacity = pulse.haloOpacity;
    }
    const pillarNow = pillarMesh.current;
    if (pillarNow) {
      const length = layout.pillarTo - layout.pillarFrom;
      pillarNow.visible = length > 1;
      pillarNow.position.set(0, (layout.pillarFrom + layout.pillarTo) / 2, 0);
      pillarNow.scale.set(BEACON.pillarPx, Math.max(length, 1e-3), 1);
      (pillarNow.material as MeshBasicMaterial).opacity = pulse.pillarOpacity;
    }

    // The glyph's centre in the world, for picking: screen up from the body by `glyphY` pixels.
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    glyphCentre[0] = position.x + up.x * layout.glyphY * perPx;
    glyphCentre[1] = position.y + up.y * layout.glyphY * perPx;
    glyphCentre[2] = position.z + up.z * layout.glyphY * perPx;
    placeBeacon(spec.bodyId, glyphCentre, perPx);
  });

  return (
    <group ref={group} visible={false} name={`beacon:${spec.bodyId}`}>
      <mesh
        ref={pillarMesh}
        geometry={shapes.plane}
        renderOrder={20}
        frustumCulled={false}
        layers={DECOR_LAYER}
        name="beacon-pillar"
      >
        <meshBasicMaterial
          map={pillar}
          color={BEACON_COLOR}
          transparent
          blending={AdditiveBlending}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh
        ref={halo}
        geometry={shapes.ring}
        renderOrder={21}
        frustumCulled={false}
        layers={DECOR_LAYER}
        name="beacon-halo"
      >
        <meshBasicMaterial
          color={BEACON_COLOR}
          transparent
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh
        ref={glyphMesh}
        geometry={shapes.plane}
        renderOrder={22}
        frustumCulled={false}
        layers={DECOR_LAYER}
        name={`beacon-glyph-${spec.kind}`}
      >
        <meshBasicMaterial
          map={glyph}
          transparent
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function hide(group: Group, bodyId: string): void {
  group.visible = false;
  placeBeacon(bodyId, undefined);
}

/** The beacons' textures, drawn once each: one per glyph (kind and badge), one pillar. */
class BeaconTextures {
  private readonly glyphs = new Map<string, CanvasTexture>();
  private pillarTexture: CanvasTexture | undefined;

  glyph(spec: GlyphSpec): CanvasTexture {
    const key = glyphKey(spec);
    let t = this.glyphs.get(key);
    if (!t) {
      t = canvasTexture(GLYPH_TEXTURE_PX, GLYPH_TEXTURE_PX, (ctx) => drawGlyph(ctx, spec));
      this.glyphs.set(key, t);
    }
    return t;
  }

  pillar(): CanvasTexture {
    this.pillarTexture ??= canvasTexture(PILLAR_TEXTURE.width, PILLAR_TEXTURE.height, (ctx) =>
      drawPillar(ctx),
    );
    return this.pillarTexture;
  }

  /**
   * Frees the GPU copies. The textures stay cached: StrictMode's rehearsed unmount runs this while
   * the meshes keep them, and three uploads a disposed texture again on its next use.
   */
  dispose(): void {
    this.glyphs.forEach((t) => t.dispose());
    this.pillarTexture?.dispose();
  }
}

function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null; // no 2D canvas (tests): a blank texture
  }
  if (ctx) draw(ctx);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}
