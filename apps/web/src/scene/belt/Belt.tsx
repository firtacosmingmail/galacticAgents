import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  Color,
  SphereGeometry,
  type BufferGeometry,
  type Group,
  type InstancedMesh,
  type MeshBasicMaterial,
  type MeshStandardMaterial,
} from 'three';
import { useSceneScale, type ScaleMode } from '../scale.js';
import { DECOR_LAYER } from '../layers.js';
import { sceneWorld, useAppStore } from '../../state/store.js';
import {
  asteroidSquash,
  BACKGROUND_BELT_SEED,
  TASK_ROCK_SEED,
  beltBounds,
  beltSpin,
  generateBelt,
  orbitPosition,
  ASTEROID_ROCK_NAME,
  pickData,
  PICK_TARGET_NAME,
  ROCK_SIZE,
  TASK_ASTEROID_RADIUS,
  taskAsteroids,
  type TaskAsteroid,
} from './belt-model.js';
import { rockGeometry, writeBeltInstances } from './belt-mesh.js';
import { useBodyAnchor } from '../anchor-binding.js';
import { useDetailStore } from '../detail/mode.js';
import { shellOutsideDome, sphereOutsideDome } from '../detail/dome.js';
import { useBackdropCulling, useBeltFade } from '../detail/dome-binding.js';
import { useReducedMotion } from '../motion.js';
import { PLACE_BODIES } from '../frame-order.js';

/**
 * The asteroid belt (P3-03): thousands of background rocks in ONE instanced mesh (one draw call,
 * TECHNOLOGY §2.1), and the task-hosting asteroids as individual meshes that stand out (bigger,
 * lighter, a warm emissive and a cyan halo), each with an invisible pick target, registered in the
 * anchor registry under its `Body.id`. Their labels (the task and its state) are the scene's
 * domain labels (P3-07, `labels/`), drawn in one DOM layer for every body.
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
  const bodies = useAppStore((s) => sceneWorld(s).bodies);
  const asteroids = useMemo(() => taskAsteroids(bodies), [bodies]);
  const spin = useRef<Group>(null);

  // The task asteroids ride the spin: placed before their readers (`frame-order.ts`).
  useFrame((_, delta) => {
    const group = spin.current;
    if (group) group.rotation.y += beltSpin(delta, reducedMotion);
  }, PLACE_BODIES);

  // Shared by every task asteroid: one rock shape (detail 1), one halo sphere, one pick sphere.
  const shapes = useMemo(
    () => ({
      rock: rockGeometry(TASK_ROCK_SEED, 1),
      halo: new SphereGeometry(1, 24, 16),
      pick: new SphereGeometry(1, 12, 8),
    }),
    [],
  );
  useEffect(() => () => Object.values(shapes).forEach((g) => g.dispose()), [shapes]);

  return (
    <group name="asteroid-belt" ref={spin}>
      <BackgroundRocks count={rocks} mode={mode} />
      {asteroids.map((asteroid) => (
        <TaskAsteroidMesh key={asteroid.bodyId} asteroid={asteroid} mode={mode} shapes={shapes} />
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
  // P6-01: a settled detail view's backdrop hides the belt only when it is wholly outside the
  // dome (an asteroid's detail view sits in the belt: the rocks inside its dome stay drawn).
  const bounds = useMemo(() => beltBounds(mode), [mode]);
  useBackdropCulling(mesh, (dome) =>
    shellOutsideDome(bounds.inner - ROCK_MARGIN, bounds.outer + ROCK_MARGIN, dome),
  );
  // P6-07: in a planet's or moon's detail view the rocks inside its dome do not belong to the
  // view: they fade to the backdrop's black with the cross-fade, then are not drawn (`beltFactor`).
  const material = useRef<MeshStandardMaterial>(null);
  useBeltFade((factor) => {
    const m = material.current;
    if (!m) return;
    m.color.setScalar(factor);
    m.visible = factor > FADED;
  });

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
      // Stays on layer 0: the rocks really hide task asteroids, so the outline's depth pass needs
      // them (one instanced draw) to draw a covered outline as hidden (P3-08 review).
      args={[geometry, undefined, Math.max(1, count)]}
    >
      <meshStandardMaterial ref={material} flatShading roughness={1} metalness={0} />
    </instancedMesh>
  );
}

/** A task asteroid's rock colour, emissive intensity and halo opacity in the system view. */
const TASK_ROCK_COLOR = new Color('#d8b48a');
const TASK_ROCK_EMISSIVE = 0.3;
const TASK_HALO_OPACITY = 0.22;
/** Below this belt factor (`beltFactor`) the rocks are not drawn at all. */
const FADED = 0.001;

/** The largest rock's reach beyond its orbit: its size by its largest squash (`generateBelt`). */
const ROCK_MARGIN = ROCK_SIZE.max * 1.2;
/** A task asteroid's farthest part, in its radii: the pick target (the halo is 1.5). */
const TASK_ASTEROID_REACH = 1.8;

function TaskAsteroidMesh({
  asteroid,
  mode,
  shapes,
}: {
  asteroid: TaskAsteroid;
  mode: ScaleMode;
  shapes: { rock: BufferGeometry; halo: BufferGeometry; pick: BufferGeometry };
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
  // P6-01: its detail view draws the rock itself; a settled detail view's backdrop hides it when
  // it is wholly outside the dome (inside, e.g. near another asteroid's view, it stays drawn).
  const detailHere = useDetailStore((s) => s.shown === asteroid.bodyId);
  useBackdropCulling(anchor, (dome, at) =>
    sphereOutsideDome(at, TASK_ASTEROID_RADIUS * TASK_ASTEROID_REACH, dome),
  );
  // P6-07: like the background rocks, it fades out of a planet's or moon's detail view.
  const rock = useRef<MeshStandardMaterial>(null);
  const halo = useRef<MeshBasicMaterial>(null);
  useBeltFade((factor) => {
    if (rock.current) {
      rock.current.color.copy(TASK_ROCK_COLOR).multiplyScalar(factor);
      rock.current.emissiveIntensity = TASK_ROCK_EMISSIVE * factor;
      rock.current.visible = factor > FADED;
    }
    if (halo.current) {
      halo.current.opacity = TASK_HALO_OPACITY * factor;
      halo.current.visible = factor > FADED;
    }
  });

  return (
    <group ref={anchor} name={`asteroid:${asteroid.bodyId}`} position={position} userData={data}>
      <mesh
        name={ASTEROID_ROCK_NAME}
        visible={!detailHere}
        geometry={shapes.rock}
        scale={scale}
        rotation={[asteroid.orbit.phase, asteroid.seed % 7, 0]}
      >
        <meshStandardMaterial
          ref={rock}
          color={TASK_ROCK_COLOR}
          emissive="#ff9a3c"
          emissiveIntensity={TASK_ROCK_EMISSIVE}
          flatShading
          roughness={0.85}
          metalness={0}
        />
      </mesh>
      {/* A soft halo: the back faces of a larger sphere, added on top (below the bloom threshold). */}
      <mesh
        geometry={shapes.halo}
        scale={TASK_ASTEROID_RADIUS * 1.5}
        layers={DECOR_LAYER}
        visible={!detailHere}
      >
        <meshBasicMaterial
          ref={halo}
          color="#5fd4ff"
          transparent
          opacity={TASK_HALO_OPACITY}
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
        scale={TASK_ASTEROID_RADIUS * TASK_ASTEROID_REACH}
        userData={data}
      >
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}
