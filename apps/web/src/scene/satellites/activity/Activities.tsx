import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  BoxGeometry,
  InstancedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import type { Id } from '@galactic/protocol';
import { sceneWorld, useAppStore } from '../../../state/store.js';
import { DECOR_LAYER } from '../../layers.js';
import { motionSeconds, useReducedMotion } from '../../motion.js';
import type { SceneQuality } from '../../quality.js';
import { getSatellite, satelliteFrames } from '../registry.js';
import {
  ACTIVITY_QUALITY,
  ActivityLayer,
  footingOf,
  type ActivityContext,
  type Footing,
  type InstanceList,
} from './activity-model.js';

/**
 * The Steward activity archetypes in the scene (P4-03; SPEC §4.1): drones (gathering), shuttles
 * (transporting), surface robots or an orbital platform (building). The logic is
 * `activity-model.ts` (three-free, tested); this component feeds it the satellites' live frames
 * (the registry, written by `Satellites.tsx` at `PLACE_SATELLITES`, before this reader), the
 * bodies' footing and the Stewards' supervisors, and copies its two instance lists into two
 * instanced meshes — two draw calls whatever the count, none when nothing is drawn. Capacity is
 * fixed by the tier's animation cap. On `DECOR_LAYER` like the satellites (the outline's depth
 * pass skips it). Under reduced motion the pieces stand still; the on-demand frame loop redraws
 * them whenever the satellites change (`Satellites.tsx` invalidates).
 */
export function Activities({ quality }: { quality: SceneQuality }) {
  const bodies = useAppStore((s) => sceneWorld(s).bodies);
  const agents = useAppStore((s) => sceneWorld(s).agents);
  const reducedMotion = useReducedMotion();
  const maxAnimated = quality.satellites.maxAnimated;

  // Capacity follows the tier's cap (a new tier: a new layer and new instanced meshes).
  const layer = useMemo(() => new ActivityLayer(maxAnimated), [maxAnimated]);

  // What the layer asks the world: refreshed when bodies or agents change, read every frame.
  const footings = useMemo(() => {
    const map = new Map<Id, Footing>();
    for (const body of Object.values(bodies)) map.set(body.id, footingOf(body));
    return map;
  }, [bodies]);
  const ctx = useRef<ActivityContext>({
    now: 0,
    reducedMotion,
    bloom: quality.bloom !== null,
    quality: ACTIVITY_QUALITY[quality.tier],
    footing: () => 'surface',
    supervisor: () => undefined,
    satellite: getSatellite,
  });
  useLayoutEffect(() => {
    const c = ctx.current;
    c.reducedMotion = reducedMotion;
    c.bloom = quality.bloom !== null;
    c.quality = ACTIVITY_QUALITY[quality.tier];
    c.footing = (bodyId) => footings.get(bodyId) ?? 'surface';
    c.supervisor = (agentId) => agents[agentId]?.supervisorId;
  }, [reducedMotion, quality.bloom, quality.tier, footings, agents]);

  const shapes = useMemo(
    () => ({
      solid: new BoxGeometry(1, 1, 1),
      glow: new OctahedronGeometry(0.5, 0),
      solidMaterial: new MeshBasicMaterial({ toneMapped: true }),
      glowMaterial: new MeshBasicMaterial({
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    }),
    [],
  );
  useEffect(
    () => () => {
      shapes.solid.dispose();
      shapes.glow.dispose();
      shapes.solidMaterial.dispose();
      shapes.glowMaterial.dispose();
    },
    [shapes],
  );

  const solid = useRef<InstancedMesh>(null);
  const glow = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    for (const [mesh, list] of [
      [solid.current, layer.solid],
      [glow.current, layer.glow],
    ] as const) {
      if (!mesh) continue;
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(list.capacity * 3), 3);
      mesh.count = 0;
      mesh.visible = false;
    }
  }, [layer]);

  useFrame(() => {
    const c = ctx.current;
    c.now = motionSeconds();
    layer.build(satelliteFrames(), c);
    if (solid.current) writeList(solid.current, layer.solid);
    if (glow.current) writeList(glow.current, layer.glow);
  });

  return (
    <group name="satellite-activities" key={layer.solid.capacity}>
      <instancedMesh
        ref={solid}
        args={[shapes.solid, shapes.solidMaterial, layer.solid.capacity]}
        frustumCulled={false}
        layers={DECOR_LAYER}
        visible={false}
      />
      <instancedMesh
        ref={glow}
        args={[shapes.glow, shapes.glowMaterial, layer.glow.capacity]}
        frustumCulled={false}
        layers={DECOR_LAYER}
        visible={false}
      />
    </group>
  );
}

const Y = new Vector3(0, 1, 0);
const axis = new Vector3();
const position = new Vector3();
const scale = new Vector3();
const quaternion = new Quaternion();
const matrix = new Matrix4();

/** Copies an instance list into an instanced mesh (hidden when empty: no draw call). */
export function writeList(mesh: InstancedMesh, list: InstanceList): void {
  const n = Math.min(list.count, mesh.instanceMatrix.count);
  mesh.visible = n > 0;
  mesh.count = n;
  if (n === 0) return;
  const colors = mesh.instanceColor;
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    position.set(list.position[k] ?? 0, list.position[k + 1] ?? 0, list.position[k + 2] ?? 0);
    axis.set(list.axis[k] ?? 0, list.axis[k + 1] ?? 1, list.axis[k + 2] ?? 0);
    quaternion.setFromUnitVectors(Y, axis);
    scale.set(list.scale[k] ?? 0, list.scale[k + 1] ?? 0, list.scale[k + 2] ?? 0);
    mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    colors?.setXYZ(i, list.color[k] ?? 0, list.color[k + 1] ?? 0, list.color[k + 2] ?? 0);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (colors) colors.needsUpdate = true;
}
