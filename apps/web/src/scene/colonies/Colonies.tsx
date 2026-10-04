import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, PointsMaterial, type Points } from 'three';
import type { Id } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { getAnchor, onAnchorsChanged } from '../anchors.js';
import { READ_BODIES } from '../frame-order.js';
import { DECOR_LAYER } from '../layers.js';
import { COLONY, colonyLights, colonyList, sameColonies, type ColonySpec } from './colony-model.js';

/**
 * The colonised mark (P4-04; SPEC §4.1, decision 4): small warm "settlement" lights on the surface
 * of every body whose own work is completed (`colony-model.ts` says which and where). One `Points`
 * per colonised body, its lights fixed in pixels (`sizeAttenuation: false`), depth-tested so the
 * far side's lights hide behind the body, placed on its anchor each frame (after the bodies,
 * `READ_BODIES`). Still: nothing animates, so reduced motion changes nothing and the on-demand
 * loop only needs a frame when the list or the anchors change.
 */
export function Colonies() {
  const bodies = useAppStore((s) => s.world.bodies);
  const projects = useAppStore((s) => s.world.projects);
  const tasks = useAppStore((s) => s.world.tasks);
  const next = useMemo(() => colonyList({ bodies, projects, tasks }), [bodies, projects, tasks]);
  // The previous list while it draws the same (state from the previous render, React's pattern).
  const [kept, setKept] = useState<ColonySpec[]>(next);
  let list = kept;
  if (kept !== next && !sameColonies(kept, next)) {
    setKept(next);
    list = next;
  }

  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [list, invalidate]);
  useEffect(() => onAnchorsChanged(() => invalidate()), [invalidate]);

  const material = useMemo(
    () =>
      new PointsMaterial({
        color: COLONY.color,
        size: COLONY.sizePx,
        sizeAttenuation: false,
        transparent: true,
        opacity: COLONY.opacity,
        depthWrite: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  const [points] = useState(() => new Map<Id, Points>());
  useFrame(() => placeColonies(points), READ_BODIES);

  if (list.length === 0) return null;
  return (
    <group name="colonies">
      {list.map((c) => (
        <Colony key={c.bodyId} spec={c} material={material} registry={points} />
      ))}
    </group>
  );
}

/** Puts every colony on its body's anchor (hidden while the body is not drawn). */
function placeColonies(points: ReadonlyMap<Id, Points>): void {
  for (const [bodyId, p] of points) {
    const anchor = getAnchor(bodyId);
    p.visible = anchor !== undefined;
    if (!anchor) continue;
    anchor.object.updateWorldMatrix(true, false);
    const e = anchor.object.matrixWorld.elements;
    p.position.set(e[12] ?? 0, e[13] ?? 0, e[14] ?? 0);
    const lift = anchor.kind === 'asteroid' ? COLONY.asteroidLift : COLONY.lift;
    p.scale.setScalar(anchor.radius * lift);
  }
}

function Colony({
  spec,
  material,
  registry,
}: {
  spec: ColonySpec;
  material: PointsMaterial;
  registry: Map<Id, Points>;
}) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(colonyLights(spec.seed), 3));
    g.computeBoundingSphere();
    return g;
  }, [spec.seed]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const ref = useRef<Points>(null);
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    registry.set(spec.bodyId, p);
    return () => {
      if (registry.get(spec.bodyId) === p) registry.delete(spec.bodyId);
    };
  }, [registry, spec.bodyId]);
  return (
    <points
      ref={ref}
      name={`colony:${spec.bodyId}`}
      geometry={geometry}
      material={material}
      visible={false}
      layers={DECOR_LAYER}
      frustumCulled={false}
    />
  );
}
