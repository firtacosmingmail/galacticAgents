import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import {
  AdditiveBlending,
  BackSide,
  SphereGeometry,
  type BufferGeometry,
  type Group,
  type InstancedMesh,
} from 'three';
import { useSceneScale, type ScaleMode } from '../scale.js';
import { useAppStore } from '../../state/store.js';
import {
  asteroidSquash,
  BACKGROUND_BELT_SEED,
  beltSpin,
  generateBelt,
  orbitPosition,
  pickData,
  PICK_TARGET_NAME,
  TASK_ASTEROID_RADIUS,
  taskAsteroids,
  type TaskAsteroid,
} from './belt-model.js';
import { rockGeometry, writeBeltInstances } from './belt-mesh.js';
import { useBodyAnchor } from '../anchor-binding.js';
import { useReducedMotion } from '../motion.js';

/**
 * The asteroid belt (P3-03): thousands of background rocks in ONE instanced mesh (one draw call,
 * TECHNOLOGY §2.1), and the task-hosting asteroids as individual meshes that stand out (bigger,
 * lighter, a warm emissive and a cyan halo), each with an invisible pick target and a name label,
 * registered in the anchor registry under its `Body.id`.
 *
 * The rock count is the tier's `beltRocks` (decision 51), passed in by `SolarScene` with the rest
 * of the quality table.
 *
 * Everything sits in one group that spins slowly about the Sun (decorative, corner case 26). The
 * spin advances in `useFrame` by the frame's delta, so it is still while the canvas renders on
 * demand, and it stops altogether with `prefers-reduced-motion`.
 */
export function Belt({ rocks }: { rocks: number }) {
  const mode = useSceneScale((s) => s.mode);
  const reducedMotion = useReducedMotion();
  const bodies = useAppStore((s) => s.world.bodies);
  const asteroids = useMemo(() => taskAsteroids(bodies), [bodies]);
  const spin = useRef<Group>(null);

  useFrame((_, delta) => {
    const group = spin.current;
    if (group) group.rotation.y += beltSpin(delta, reducedMotion);
  });

  // Shared by every task asteroid: one rock shape (detail 1), one halo sphere, one pick sphere.
  const shapes = useMemo(
    () => ({
      rock: rockGeometry(BACKGROUND_BELT_SEED ^ 0x7a5c, 1),
      halo: new SphereGeometry(1, 24, 16),
      pick: new SphereGeometry(1, 12, 8),
    }),
    [],
  );
  useEffect(() => () => Object.values(shapes).forEach((g) => g.dispose()), [shapes]);

  // The labels' DOM layer, fixed from the start: drei's `Html` otherwise appends to the event
  // layer once the events connect, and that switch remounts its root during a render (React
  // warns, and a label can stay empty).
  const layer = useThree((s) => s.gl.domElement.parentNode as HTMLElement | null);
  const labels = useMemo(() => (layer ? { current: layer } : undefined), [layer]);

  return (
    <group name="asteroid-belt" ref={spin}>
      <BackgroundRocks count={rocks} mode={mode} />
      {asteroids.map((asteroid) => (
        <TaskAsteroidMesh
          key={asteroid.bodyId}
          asteroid={asteroid}
          mode={mode}
          shapes={shapes}
          labels={labels}
        />
      ))}
    </group>
  );
}

function BackgroundRocks({ count, mode }: { count: number; mode: ScaleMode }) {
  const belt = useMemo(() => generateBelt(count), [count]);
  const geometry = useMemo(() => rockGeometry(BACKGROUND_BELT_SEED), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const mesh = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);

  // Before the first frame: matrices, colours and the bounding sphere of the whole ring.
  useLayoutEffect(() => {
    if (!mesh.current) return;
    writeBeltInstances(mesh.current, belt, mode);
    invalidate();
  }, [belt, mode, invalidate]);

  return (
    // A new mesh per count: the instance buffers cannot grow in place.
    <instancedMesh
      key={count}
      ref={mesh}
      name="belt-rocks"
      args={[geometry, undefined, Math.max(1, count)]}
    >
      <meshStandardMaterial flatShading roughness={1} metalness={0} />
    </instancedMesh>
  );
}

const LABEL_STYLE = {
  color: '#cfe9ff',
  font: '11px/1.2 system-ui, sans-serif',
  whiteSpace: 'nowrap',
  textShadow: '0 0 3px #000, 0 0 6px #000',
  pointerEvents: 'none',
  userSelect: 'none',
} as const;

function TaskAsteroidMesh({
  asteroid,
  mode,
  shapes,
  labels,
}: {
  asteroid: TaskAsteroid;
  mode: ScaleMode;
  shapes: { rock: BufferGeometry; halo: BufferGeometry; pick: BufferGeometry };
  labels: { current: HTMLElement } | undefined;
}) {
  const anchor = useRef<Group>(null);
  useBodyAnchor(anchor, {
    bodyId: asteroid.bodyId,
    radius: TASK_ASTEROID_RADIUS,
    kind: 'asteroid',
    ...(asteroid.number !== undefined ? { order: asteroid.number } : {}),
  });
  const position = useMemo(() => orbitPosition(asteroid.orbit, mode), [asteroid.orbit, mode]);
  const scale = useMemo(
    () =>
      asteroidSquash(asteroid.seed).map((s) => s * TASK_ASTEROID_RADIUS) as [
        number,
        number,
        number,
      ],
    [asteroid.seed],
  );
  const data = useMemo(() => pickData(asteroid), [asteroid]);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [position, invalidate]);

  return (
    <group ref={anchor} name={`asteroid:${asteroid.bodyId}`} position={position} userData={data}>
      <mesh
        geometry={shapes.rock}
        scale={scale}
        rotation={[asteroid.orbit.phase, asteroid.seed % 7, 0]}
      >
        <meshStandardMaterial
          color="#d8b48a"
          emissive="#ff9a3c"
          emissiveIntensity={0.3}
          flatShading
          roughness={0.85}
          metalness={0}
        />
      </mesh>
      {/* A soft halo: the back faces of a larger sphere, added on top (below the bloom threshold). */}
      <mesh geometry={shapes.halo} scale={TASK_ASTEROID_RADIUS * 1.5}>
        <meshBasicMaterial
          color="#5fd4ff"
          transparent
          opacity={0.22}
          side={BackSide}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* The pick target (P3-05): larger than the rock, never drawn (`visible: false` material). */}
      <mesh
        name={PICK_TARGET_NAME}
        geometry={shapes.pick}
        scale={TASK_ASTEROID_RADIUS * 1.8}
        userData={data}
      >
        <meshBasicMaterial visible={false} />
      </mesh>
      <Html
        {...(labels ? { portal: labels } : {})}
        center
        position={[0, TASK_ASTEROID_RADIUS * 2.2, 0]}
        style={LABEL_STYLE}
        zIndexRange={[20, 0]}
      >
        {asteroid.name}
      </Html>
    </group>
  );
}
