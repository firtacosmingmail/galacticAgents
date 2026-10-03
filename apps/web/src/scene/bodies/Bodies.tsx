import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DoubleSide, RingGeometry, type Group, type Mesh, type Object3D } from 'three';
import { useAppStore } from '../../state/store.js';
import { useSceneScale } from '../scale.js';
import type { RingLook } from './appearance.js';
import { useBodyAnchor } from '../anchor-binding.js';
import {
  buildRenderList,
  circlePoints,
  moonAnchor,
  orbitAngle,
  planetAnchor,
  SPIN_PERIOD,
  type MoonItem,
  type PlanetItem,
} from './layout.js';
import { motionEnabled, useReducedMotion } from '../motion.js';
import { placeOnOrbit } from '../orbit.js';
import { MOON_TEXTURE, PLANET_TEXTURE } from './surface.js';
import { useRingTexture, useSurfaceTexture } from './textures.js';

/**
 * Planets, moons, orbits and scale (P3-02). The bodies come from the world (`world.bodies`, the
 * catalogue seeded by migration 0005 and whatever the server adds), dressed by the static
 * appearance table; `layout.ts` turns them into a render list for the current scale mode.
 *
 * Every planet and moon registers its moving group as its anchor (`anchors.ts`) under its domain
 * id, with its visual radius; the group carries `userData.bodyId` for picking (P3-05). Toggling the
 * scale moves and resizes the bodies but keeps every id, so selection and camera targets survive.
 *
 * Motion is decorative: planets go round the Sun, moons round their planet, planets spin. With
 * `prefers-reduced-motion` everything sits at its starting angle (never behind the Sun from the
 * default camera) and the canvas goes back to rendering on demand.
 *
 * Shadows: planets and the largest moons cast (`castsShadow`: each caster is drawn six more times
 * a frame into the Sun's cube shadow map), every body receives, rings receive; they show only when
 * the tier turns the shadow map on (`SolarScene`).
 */
export function Bodies() {
  const bodies = useAppStore((s) => s.world.bodies);
  const mode = useSceneScale((s) => s.mode);
  const motion = motionEnabled(useReducedMotion());
  const list = useMemo(() => buildRenderList(bodies, mode), [bodies, mode]);
  return (
    <group name="bodies">
      {list.map((planet) => (
        <Planet key={planet.bodyId} item={planet} motion={motion} />
      ))}
    </group>
  );
}

const DEG = Math.PI / 180;
const ORBIT_SEGMENTS = 192;
const MOON_ORBIT_SEGMENTS = 96;

function Planet({ item, motion }: { item: PlanetItem; motion: boolean }) {
  const anchor = useRef<Group>(null);
  const spin = useRef<Mesh>(null);
  useOrbit(anchor, item.distance, item.phase, item.period, motion);
  useBodyAnchor(anchor, planetAnchor(item));
  useFrame((state) => {
    if (!motion || !spin.current) return;
    spin.current.rotation.y = (state.clock.elapsedTime / SPIN_PERIOD) * Math.PI * 2;
  });
  useLayoutEffect(() => {
    if (!motion && spin.current) spin.current.rotation.y = 0;
  }, [motion]);
  const texture = useSurfaceTexture(item.look, PLANET_TEXTURE);
  return (
    <>
      <OrbitLine radius={item.distance} segments={ORBIT_SEGMENTS} opacity={0.22} />
      <group ref={anchor} name={item.name} userData={{ bodyId: item.bodyId }}>
        <group rotation={[0, 0, item.look.tiltDeg * DEG]}>
          <mesh ref={spin} castShadow receiveShadow>
            <sphereGeometry args={[item.radius, 48, 32]} />
            <meshStandardMaterial map={texture} roughness={0.95} metalness={0} />
          </mesh>
          {item.look.rings && <Rings rings={item.look.rings} radius={item.radius} />}
          {item.moons.map((moon) => (
            <Moon key={moon.bodyId} item={moon} motion={motion} />
          ))}
        </group>
      </group>
    </>
  );
}

function Moon({ item, motion }: { item: MoonItem; motion: boolean }) {
  const anchor = useRef<Group>(null);
  useOrbit(anchor, item.distance, item.phase, item.period, motion);
  useBodyAnchor(anchor, moonAnchor(item));
  const texture = useSurfaceTexture(item.look, MOON_TEXTURE);
  return (
    <>
      <OrbitLine radius={item.distance} segments={MOON_ORBIT_SEGMENTS} opacity={0.12} />
      <group ref={anchor} name={item.name} userData={{ bodyId: item.bodyId }}>
        <mesh castShadow={item.castShadow} receiveShadow>
          <sphereGeometry args={[item.radius, 24, 16]} />
          <meshStandardMaterial map={texture} roughness={1} metalness={0} />
        </mesh>
      </group>
    </>
  );
}

/**
 * A flat ring system in the planet's equatorial plane, its texture laid out radially (u = 0 at
 * the inner edge, 1 at the outer). Receives the planet's shadow; a faint emissive term keeps the
 * rings readable when the Sun grazes them edge-on.
 */
function Rings({ rings, radius }: { rings: RingLook; radius: number }) {
  const texture = useRingTexture(rings);
  const geometry = useMemo(() => {
    const inner = radius * rings.inner;
    const outer = radius * rings.outer;
    const g = new RingGeometry(inner, outer, 128, 1);
    const pos = g.attributes['position']!;
    const uv = g.attributes['uv']!;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (r - inner) / (outer - inner), 0.5);
    }
    return g;
  }, [radius, rings.inner, rings.outer]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <meshStandardMaterial
        map={texture}
        emissiveMap={texture}
        emissive="#ffffff"
        emissiveIntensity={0.12}
        roughness={1}
        metalness={0}
        transparent
        side={DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

function OrbitLine({
  radius,
  segments,
  opacity,
}: {
  radius: number;
  segments: number;
  opacity: number;
}) {
  const positions = useMemo(() => circlePoints(radius, segments), [radius, segments]);
  return (
    <lineLoop>
      <bufferGeometry key={positions.length + ':' + radius}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial
        color="#6f7fa8"
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </lineLoop>
  );
}

/**
 * Places `ref` on its orbit: once at the starting angle (mount, a scale change, motion turned
 * off — then one frame is requested, for the on-demand loop), and every frame while motion runs.
 */
function useOrbit(
  ref: RefObject<Object3D | null>,
  distance: number,
  phase: number,
  period: number,
  motion: boolean,
) {
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    if (ref.current) placeOnOrbit(ref.current, distance, orbitAngle(phase, period, 0));
    invalidate();
  }, [ref, distance, phase, period, motion, invalidate]);
  useFrame((state) => {
    if (!motion || !ref.current) return;
    placeOnOrbit(ref.current, distance, orbitAngle(phase, period, state.clock.elapsedTime));
  });
}
