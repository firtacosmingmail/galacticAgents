import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  Vector3,
  type BufferGeometry,
  type InstancedMesh,
  type Mesh,
  type PerspectiveCamera,
} from 'three';
import type { Id } from '@galactic/protocol';
import { sceneWorld, useAppStore } from '../../state/store.js';
import { getAnchor, onAnchorsChanged } from '../anchors.js';
import { useCameraStore } from '../camera/store.js';
import { PLACE_SATELLITES } from '../frame-order.js';
import { DECOR_LAYER } from '../layers.js';
import { motionSeconds, useReducedMotion } from '../motion.js';
import type { Vec3Tuple } from '../orbit.js';
import { pixelScale } from '../picking/pick.js';
import type { SceneQuality } from '../quality.js';
import {
  instancedPath,
  SatelliteDirector,
  type AnchorLookup,
  type PixelSize,
  type SatelliteFrame,
} from './director.js';
import {
  beamColor,
  beamGeometry,
  beamMatrix,
  bodyColor,
  bodyMatrix,
  satelliteGeometry,
} from './satellite-mesh.js';
import {
  sameSatellites,
  SCENE_SATELLITES,
  satelliteList,
  type SatelliteSpec,
} from './satellite-model.js';
import { getSatellite, onSatellitesChanged, satelliteIds } from './registry.js';
import { HqStation, HqTargets, writeHq } from './hq/HqStation.js';
import { ordinarySatellites } from './hq/hq-model.js';
import { useHeldArchetypes } from './activity/use-held-archetypes.js';

/**
 * The satellites (P4-01; SPEC §4.1, TECHNOLOGY §2.1): one per live Waykeeper and Steward, orbiting
 * the body of its work, scanning it now and then with an additive beam (bloom on tiers with a
 * composer, a soft cone without). The world → satellites list is `satellite-model.ts`, the actor
 * state machine `machine.ts`, the frame logic `director.ts` (all three-free and tested); this
 * component only feeds them the store, the anchors and the clock, and copies the frames into
 * matrices once per frame.
 *
 * Two render paths (corner case 21): up to the tier's `instanceAbove` satellites, a mesh pair each
 * (the satellite and its beam, the beam hidden between scans); above it, one instanced mesh for
 * all satellites and one for the beams being drawn — at most two draw calls whatever the count (the
beam mesh holds only the scanning satellites' beams and is hidden when none scans). Everything is on the
 * decorations' layer (`DECOR_LAYER`), so the selection outline's depth pass skips it (P3-08).
 *
 * P4-02: the list keeps failed agents and adds the Harmonizer's HQ station (`SCENE_SATELLITES`);
 * every frame carries its state's tint and pulse (`look.ts`), copied here into the material or
 * instance colour (no extra draw call). The HQ is the Harmonizer's frame drawn with its own model
 * (`hq/HqStation.tsx`, outside the instancing), written in this same frame loop.
 *
 * Under `prefers-reduced-motion` the satellites stand still on their orbits and never scan; the
 * frame loop is then on demand, so a change of satellites, of anchors or of the scale asks for one
 * frame (`invalidate`). The mobile frame cap needs nothing: the satellites move by the motion
 * clock, not by frames.
 */
export function Satellites({ quality }: { quality: SceneQuality }) {
  const agents = useAppStore((s) => sceneWorld(s).agents);
  const statuses = useAppStore((s) => sceneWorld(s).statuses);
  const tasks = useAppStore((s) => sceneWorld(s).tasks);
  const projects = useAppStore((s) => sceneWorld(s).projects);
  const list = useMemo(
    () => satelliteList({ agents, statuses, tasks, projects }, SCENE_SATELLITES),
    [agents, statuses, tasks, projects],
  );
  const held = useHeldArchetypes(list); // P4-03: Steward archetypes, held against flicker
  const reducedMotion = useReducedMotion();
  const invalidate = useThree((s) => s.invalidate);

  // One director per mounted scene; its options follow the tier and the motion preference.
  const [director] = useState(
    () => new SatelliteDirector({ satellites: quality.satellites, reducedMotion }),
  );
  useEffect(() => {
    director.setOptions({ satellites: quality.satellites, reducedMotion });
    invalidate();
  }, [director, quality.satellites, reducedMotion, invalidate]);

  // The director keeps its actors across list changes; only a real change reaches it.
  const applied = useRef<SatelliteSpec[]>([]);
  useLayoutEffect(() => {
    if (sameSatellites(applied.current, held)) return;
    applied.current = held;
    director.setSpecs(held, motionSeconds());
    invalidate();
  }, [director, held, invalidate]);
  // Unmount forgets everything, and so does StrictMode's rehearsed unmount — which re-runs the
  // layout effect above next, so `applied` must forget too or the satellites never come back.
  useEffect(
    () => () => {
      applied.current = [];
      director.reset();
    },
    [director],
  );
  useEffect(() => onAnchorsChanged(() => invalidate()), [invalidate]);

  // What is drawn is what the director publishes: the live satellites and those shrinking out.
  const agentIds = useSyncExternalStore(onSatellitesChanged, satelliteIds);
  const { hq: hqId, others } = useMemo(
    () => ordinarySatellites(agentIds, (id) => getSatellite(id)?.role),
    [agentIds],
  );
  const instanced = instancedPath(others.length, quality.satellites);
  const bloom = quality.bloom !== null;

  const shapes = useMemo(() => ({ body: satelliteGeometry(), beam: beamGeometry() }), []);
  useEffect(() => () => Object.values(shapes).forEach((g) => g.dispose()), [shapes]);

  const [targets] = useState(() => new RenderTargets());
  const [pixels] = useState(() => new PixelSizer());
  const [hq] = useState(() => new HqTargets());
  const hqState = list.find((s) => s.role === 'harmonizer')?.state;

  useFrame((state) => {
    pixels.follow(state.camera as PerspectiveCamera, state.size.height);
    const frames = director.update(
      motionSeconds(),
      lookupAnchor,
      pixels.size,
      useCameraStore.getState().focusedId,
    );
    if (instanced) writeInstanced(frames, targets, bloom);
    else writeMeshes(frames, targets, bloom);
    writeHq(frames, hq, { bloom, now: motionSeconds(), reducedMotion, state: hqState });
  }, PLACE_SATELLITES);

  if (agentIds.length === 0) return null;
  const station = hqId ? (
    <HqStation key={hqId} agentId={hqId} beamShape={shapes.beam} targets={hq} />
  ) : null;
  if (others.length === 0) return station;
  return (
    <>
      {station}
      {instanced ? (
        <InstancedSatellites
          key={instanceCapacity(others.length)}
          capacity={instanceCapacity(others.length)}
          shapes={shapes}
          targets={targets}
        />
      ) : (
        <group name="satellites">
          {others.map((id) => (
            <SatelliteMeshes key={id} agentId={id} shapes={shapes} targets={targets} />
          ))}
        </group>
      )}
    </>
  );
}

interface MeshPair {
  body: Mesh | null;
  beam: Mesh | null;
}

/** Where the frame loop writes: the per-satellite meshes, or the two instanced meshes. */
export class RenderTargets {
  readonly meshes = new Map<Id, MeshPair>();
  bodies: InstancedMesh | null = null;
  beams: InstancedMesh | null = null;
  setInstanced(bodies: InstancedMesh | null, beams: InstancedMesh | null): () => void {
    this.bodies = bodies;
    this.beams = beams;
    return () => {
      if (this.bodies === bodies) this.bodies = null;
      if (this.beams === beams) this.beams = null;
    };
  }
  register(agentId: Id, pair: MeshPair): () => void {
    this.meshes.set(agentId, pair);
    return () => {
      if (this.meshes.get(agentId) === pair) this.meshes.delete(agentId);
    };
  }
}

const scratch = new Vector3();
const matrix = new Matrix4();

/** World units per pixel at a point, for this frame's camera (one function, not one per frame). */
class PixelSizer {
  private camera: PerspectiveCamera | null = null;
  private perPx = 1;
  /** This frame's camera and canvas height. */
  follow(camera: PerspectiveCamera, height: number): void {
    this.camera = camera;
    this.perPx = pixelScale(height, camera.fov ?? 45);
  }
  readonly size: PixelSize = (p) => {
    if (!this.camera) return 0;
    scratch.set(p[0], p[1], p[2]);
    return Math.max(1e-6, this.camera.position.distanceTo(scratch)) / this.perPx;
  };
}
const color = new Color();

/** The anchor registry as the director's lookup (live world position, no allocation). */
const lookupAnchor: AnchorLookup = (bodyId: Id, out: Vec3Tuple) => {
  const anchor = getAnchor(bodyId);
  if (!anchor) return undefined;
  anchor.object.updateWorldMatrix(true, false);
  const e = anchor.object.matrixWorld.elements;
  out[0] = e[12] ?? 0;
  out[1] = e[13] ?? 0;
  out[2] = e[14] ?? 0;
  return anchor.radius;
};

interface Shapes {
  body: BufferGeometry;
  beam: BufferGeometry;
}

function writeMeshes(
  frames: readonly SatelliteFrame[],
  targets: RenderTargets,
  bloom: boolean,
): void {
  for (const f of frames) {
    const pair = targets.meshes.get(f.agentId);
    if (!pair) continue;
    const { body, beam } = pair;
    if (body) {
      body.visible = f.visible;
      if (f.visible) {
        bodyMatrix(f, body.matrix);
        body.matrixWorldNeedsUpdate = true; // `matrixAutoUpdate` is off: say the matrix moved
        (body.material as MeshBasicMaterial).color.copy(bodyColor(f, color));
      }
    }
    if (beam) {
      beam.visible = f.visible && f.beam > 0;
      if (beam.visible) {
        beamMatrix(f, beam.matrix);
        beam.matrixWorldNeedsUpdate = true;
        (beam.material as MeshBasicMaterial).color.copy(beamColor(f, bloom, color));
      }
    }
  }
}

/**
 * The instanced path: every ordinary satellite is a body instance (`n`); only the beams being
 * drawn — visible and scanning — are beam instances (`m`), so between scans the beam mesh draws
 * nothing and is skipped (`visible = false`: no draw call, no zero-scaled cones).
 */
export function writeInstanced(
  frames: readonly SatelliteFrame[],
  targets: Pick<RenderTargets, 'bodies' | 'beams'>,
  bloom: boolean,
): void {
  const { bodies, beams } = targets;
  if (!bodies || !beams) return;
  const capacity = bodies.instanceMatrix.count;
  let n = 0;
  let m = 0;
  for (const f of frames) {
    if (n >= capacity) break;
    if (f.role === 'harmonizer') continue; // the HQ station has its own meshes
    bodies.setMatrixAt(n, bodyMatrix(f, matrix));
    bodies.setColorAt(n, bodyColor(f, color));
    n++;
    if (!f.visible || f.beam <= 0) continue;
    beams.setMatrixAt(m, beamMatrix(f, matrix));
    beams.setColorAt(m, beamColor(f, bloom, color));
    m++;
  }
  bodies.count = n;
  beams.count = m;
  beams.visible = m > 0;
  bodies.instanceMatrix.needsUpdate = true;
  beams.instanceMatrix.needsUpdate = true;
  if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
}

/** One satellite and its beam (the per-satellite path); matrices are written by the parent. */
function SatelliteMeshes({
  agentId,
  shapes,
  targets,
}: {
  agentId: Id;
  shapes: Shapes;
  targets: RenderTargets;
}) {
  const body = useRef<Mesh>(null);
  const beam = useRef<Mesh>(null);
  useLayoutEffect(
    () => targets.register(agentId, { body: body.current, beam: beam.current }),
    [agentId, targets],
  );
  return (
    <>
      <mesh
        ref={body}
        name={`satellite:${agentId}`}
        geometry={shapes.body}
        matrixAutoUpdate={false}
        visible={false}
        layers={DECOR_LAYER}
        userData={{ agentId }}
      >
        <meshBasicMaterial vertexColors toneMapped />
      </mesh>
      <mesh
        ref={beam}
        name={`satellite-beam:${agentId}`}
        geometry={shapes.beam}
        matrixAutoUpdate={false}
        visible={false}
        layers={DECOR_LAYER}
      >
        <meshBasicMaterial
          vertexColors
          transparent
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}

/** Room for this many satellites, in steps of 16 (so the buffers are not rebuilt per agent). */
export function instanceCapacity(count: number): number {
  return Math.max(16, Math.ceil(count / 16) * 16);
}

/** All satellites in one instanced mesh, all beams in another (two draw calls). */
function InstancedSatellites({
  capacity,
  shapes,
  targets,
}: {
  capacity: number;
  shapes: Shapes;
  targets: RenderTargets;
}) {
  const materials = useMemo(
    () => ({
      body: new MeshBasicMaterial({ vertexColors: true }),
      beam: new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    }),
    [],
  );
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);
  // Instance colours from the start (the material compiles with them), zero matrices until drawn.
  const bodies = useRef<InstancedMesh>(null);
  const beams = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    for (const mesh of [bodies.current, beams.current]) {
      if (!mesh) continue;
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      const zero = new Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, zero);
      mesh.count = 0;
    }
    return targets.setInstanced(bodies.current, beams.current);
  }, [capacity, targets]);
  return (
    <group name="satellites-instanced">
      <instancedMesh
        ref={bodies}
        args={[shapes.body, materials.body, capacity]}
        frustumCulled={false}
        layers={DECOR_LAYER}
      />
      <instancedMesh
        ref={beams}
        args={[shapes.beam, materials.beam, capacity]}
        frustumCulled={false}
        layers={DECOR_LAYER}
      />
    </group>
  );
}
