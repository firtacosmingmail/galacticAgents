import { useEffect, useMemo, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Matrix4, PointsMaterial } from 'three';
import { useAppStore } from '../../state/store.js';
import { getAnchor, onAnchorsChanged, SUN_ANCHOR_ID } from '../anchors.js';
import { ASTEROID_ROCK_NAME } from '../belt/belt-model.js';
import { READ_BODIES } from '../frame-order.js';
import { DECOR_LAYER } from '../layers.js';
import {
  COLONY,
  colonyLights,
  colonyList,
  sameColonies,
  writeColony,
  type ColonySpec,
} from './colony-model.js';

/**
 * The colonised mark (P4-04; SPEC §4.1, decision 4): small warm "settlement" lights on the surface
 * of every body whose own work is completed (`colony-model.ts` says which and where). **One**
 * `Points` for every colony together (one draw call): each frame (after the bodies,
 * `READ_BODIES`) every colony's lights are written in world space on its anchor (`writeColony`),
 * an asteroid's through its rock's own matrix so they follow its lumpy shape. Lights fixed in
 * pixels (`sizeAttenuation: false`), depth-tested so the far side's hide behind the body, and
 * per-light opacity by the Sun's angle (brightest at night). A colony whose body is not drawn is
 * skipped. Still: nothing animates, so reduced motion changes nothing and the on-demand loop only
 * needs a frame when the list or the anchors change.
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
        vertexColors: true, // rgba: per-light opacity (`writeColony`)
        transparent: true,
        opacity: COLONY.opacity,
        depthWrite: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  /** The lights (unit vectors) of each colony, and buffers sized for all of them. */
  const drawn = useMemo(() => {
    const lights = list.map((c) => colonyLights(c.seed));
    const vertices = lights.reduce((n, l) => n + l.length / 3, 0);
    const geometry = new BufferGeometry();
    const positions = new BufferAttribute(new Float32Array(vertices * 3), 3);
    const colors = new BufferAttribute(new Float32Array(vertices * 4), 4);
    positions.setUsage(DynamicDrawUsage);
    colors.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', colors);
    geometry.setDrawRange(0, 0);
    return { list, lights, geometry, positions, colors };
  }, [list]);
  useEffect(() => () => drawn.geometry.dispose(), [drawn]);

  useFrame(() => placeColonies(drawn), READ_BODIES);

  if (list.length === 0) return null;
  return (
    <points
      name="colonies"
      geometry={drawn.geometry}
      material={material}
      layers={DECOR_LAYER}
      frustumCulled={false}
    />
  );
}

const matrix = new Matrix4();
const sun: [number, number, number] = [0, 0, 0];

/** Writes every drawn colony's lights on its body's anchor; the rest are left out of the range. */
function placeColonies(drawn: {
  list: readonly ColonySpec[];
  lights: readonly Float32Array[];
  geometry: BufferGeometry;
  positions: BufferAttribute;
  colors: BufferAttribute;
}): void {
  const star = getAnchor(SUN_ANCHOR_ID);
  if (star) {
    star.object.updateWorldMatrix(true, false);
    const e = star.object.matrixWorld.elements;
    sun[0] = e[12] ?? 0;
    sun[1] = e[13] ?? 0;
    sun[2] = e[14] ?? 0;
  } else sun[0] = sun[1] = sun[2] = 0;
  const positions = drawn.positions.array as Float32Array;
  const colors = drawn.colors.array as Float32Array;
  let at = 0;
  for (let i = 0; i < drawn.list.length; i++) {
    const anchor = getAnchor(drawn.list[i]!.bodyId);
    const lights = drawn.lights[i];
    if (!anchor || !lights) continue;
    anchor.object.updateWorldMatrix(true, true);
    const rock =
      anchor.kind === 'asteroid' ? anchor.object.getObjectByName(ASTEROID_ROCK_NAME) : undefined;
    let lift = COLONY.lift;
    if (rock) {
      matrix.copy(rock.matrixWorld); // the rock's squash and rotation: lights follow its shape
      lift = COLONY.asteroidLift;
    } else {
      const e = anchor.object.matrixWorld.elements;
      matrix.makeScale(anchor.radius, anchor.radius, anchor.radius);
      matrix.setPosition(e[12] ?? 0, e[13] ?? 0, e[14] ?? 0);
      if (anchor.kind === 'asteroid') lift = COLONY.asteroidLift;
    }
    at = writeColony(lights, matrix.elements, lift, sun, positions, colors, at);
  }
  drawn.geometry.setDrawRange(0, at);
  drawn.positions.needsUpdate = true;
  drawn.colors.needsUpdate = true;
}
