import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Mesh, PerspectiveCamera } from 'three';
import { sceneWorld, useAppStore } from '../../state/store.js';
import { getAnchor } from '../anchors.js';
import { anchorPosition } from '../camera/store.js';
import { pixelScale } from '../picking/pick.js';
import { DECOR_LAYER } from '../layers.js';
import { areaMoons, independentMoons } from './label-model.js';

/**
 * The scene's mark of an independent project's moon (P3-07, SPEC §3.2): a thin teal ring around
 * the moon, facing the camera, so a moon that is a project of its own does not read as part of
 * the planet's project even with its label hidden. Sub-project moons get no ring: they read as
 * part of their planet. The teal matches the label's "own project" badge; it is neither the
 * selection's blue nor the "blocked on you" amber. One small mesh per such moon (a handful).
 *
 * An area moon (P10-07, decision 143) gets the same ring in its own violet (`AREA_RING`, matching
 * the label's "n areas" badge): part of its planet's long-term project, yet not a sub-project.
 */
export const OWN_PROJECT_RING = { color: '#3cc8b4', opacity: 0.55, scale: 1.7, minPx: 5 } as const;
export const AREA_RING = { color: '#a58cff', opacity: 0.55, scale: 1.7, minPx: 5 } as const;

type RingLook = typeof OWN_PROJECT_RING | typeof AREA_RING;

export function MoonMarkers() {
  const bodies = useAppStore((s) => sceneWorld(s).bodies);
  const projects = useAppStore((s) => sceneWorld(s).projects);
  const moons = useMemo(
    () => independentMoons({ bodies, projects, tasks: {} }),
    [bodies, projects],
  );
  const areas = useMemo(() => areaMoons({ bodies, projects, tasks: {} }), [bodies, projects]);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [moons, areas, invalidate]);
  return (
    <>
      {moons.map((bodyId) => (
        <MoonRing key={bodyId} bodyId={bodyId} look={OWN_PROJECT_RING} name="own-project" />
      ))}
      {areas.map((bodyId) => (
        <MoonRing key={bodyId} bodyId={bodyId} look={AREA_RING} name="areas" />
      ))}
    </>
  );
}

function MoonRing({ bodyId, look, name }: { bodyId: string; look: RingLook; name: string }) {
  const ref = useRef<Mesh>(null);
  useFrame((state) => {
    const ring = ref.current;
    if (!ring) return;
    const anchor = getAnchor(bodyId);
    if (!anchor) {
      ring.visible = false;
      return;
    }
    const camera = state.camera as PerspectiveCamera;
    const [x, y, z] = anchorPosition(anchor);
    ring.position.set(x, y, z);
    const depth = Math.max(1e-6, camera.position.distanceTo(ring.position));
    const perPx = depth / pixelScale(state.size.height, camera.fov ?? 45);
    ring.visible = true;
    ring.quaternion.copy(camera.quaternion);
    ring.scale.setScalar(Math.max(anchor.radius * look.scale, look.minPx * perPx));
  });
  return (
    <mesh
      ref={ref}
      visible={false}
      frustumCulled={false}
      name={`${name}:${bodyId}`}
      layers={DECOR_LAYER}
    >
      <ringGeometry args={[0.9, 1, 64]} />
      <meshBasicMaterial
        color={look.color}
        transparent
        opacity={look.opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
