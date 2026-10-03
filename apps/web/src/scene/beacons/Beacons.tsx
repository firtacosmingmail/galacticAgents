import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  CanvasTexture,
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
  glyphKey,
  glyphSpec,
  type GlyphSpec,
} from './beacon-look.js';
import { beaconList, type BeaconSpec } from './beacon-model.js';
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
 * and never smaller than the glyph (30 px) and its 36 px click target. Drawn over everything (no
 * depth test, after the highlight rings), on the decorations' layer (`DECOR_LAYER`: the selection
 * outline's depth pass skips it). Three draw calls per beacon (pillar, halo, glyph); one glyph
 * texture per kind and count, drawn at runtime.
 *
 * Lifecycle: the list follows the store — a question opened for the user or escalated to the user
 * lights its body's beacon, an answer, a cancellation or a reassignment away from the user puts it
 * out, at the next render (well within a second). A change asks the on-demand loop for a frame.
 *
 * Under `prefers-reduced-motion` the halo and the pillar are steady (`STEADY_PULSE`); otherwise
 * the halo pulses on the shared motion clock (the continuous loop is running then anyway).
 *
 * Picking reads the glyphs' positions from `registry.ts` (a beacon wins over the body under it).
 */
export function Beacons() {
  const questions = useAppStore((s) => s.world.questions);
  const agents = useAppStore((s) => s.world.agents);
  const tasks = useAppStore((s) => s.world.tasks);
  const projects = useAppStore((s) => s.world.projects);
  const bodies = useAppStore((s) => s.world.bodies);
  const statuses = useAppStore((s) => s.world.statuses);
  const list = useMemo(
    () => beaconList({ questions, agents, tasks, projects, bodies, statuses }),
    [questions, agents, tasks, projects, bodies, statuses],
  );
  const reducedMotion = useReducedMotion();
  const invalidate = useThree((s) => s.invalidate);

  // One live frame per beacon, published for picking; rebuilt when the set changes.
  const frames = useMemo(
    () =>
      list.map<BeaconFrame>((b) => ({
        bodyId: b.bodyId,
        visible: false,
        center: [0, 0, 0],
        perPx: 0,
      })),
    [list],
  );
  useEffect(() => {
    publishBeacons(frames);
    invalidate();
    return () => publishBeacons([]);
  }, [frames, invalidate]);
  useEffect(() => onAnchorsChanged(() => invalidate()), [invalidate]);
  useEffect(() => invalidate(), [reducedMotion, invalidate]);

  const [textures] = useState(() => new BeaconTextures());
  useEffect(() => () => textures.dispose(), [textures]);

  return (
    <>
      {list.map((b) => (
        <Beacon
          key={b.bodyId}
          spec={b}
          glyph={textures.glyph(glyphSpec(b.kind, b.count))}
          pillar={textures.pillar()}
          reducedMotion={reducedMotion}
        />
      ))}
    </>
  );
}

const position = new Vector3();
const inCamera = new Vector3();
const up = new Vector3();
const glyphCentre: [number, number, number] = [0, 0, 0];

function Beacon({
  spec,
  glyph,
  pillar,
  reducedMotion,
}: {
  spec: BeaconSpec;
  glyph: CanvasTexture;
  pillar: CanvasTexture;
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
      g.visible = false;
      placeBeacon(spec.bodyId, undefined);
      return;
    }
    const height = state.size.height;
    const perPx =
      Math.max(1e-6, camera.position.distanceTo(position)) / pixelScale(height, camera.fov ?? 45);
    const projected = inCamera.copy(position).project(camera);
    const bodyY = ((1 - projected.y) / 2) * height;
    const layout = beaconLayout(anchor.radius / perPx, bodyY);
    const pulse = beaconPulse(motionSeconds(), reducedMotion);

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
        renderOrder={20}
        frustumCulled={false}
        layers={DECOR_LAYER}
        name="beacon-pillar"
      >
        <planeGeometry args={[1, 1]} />
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
        renderOrder={21}
        frustumCulled={false}
        layers={DECOR_LAYER}
        name="beacon-halo"
      >
        <ringGeometry args={[0.86, 1, 48]} />
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
        renderOrder={22}
        frustumCulled={false}
        layers={DECOR_LAYER}
        name={`beacon-glyph-${spec.kind}`}
      >
        <planeGeometry args={[1, 1]} />
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
