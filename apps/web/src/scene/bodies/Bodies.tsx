import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { PLACE_BODIES, READ_BODIES } from '../frame-order.js';
import {
  DoubleSide,
  RingGeometry,
  type Group,
  type LineBasicMaterial,
  type LineLoop,
  type Mesh,
  type Object3D,
} from 'three';
import { sceneWorld, useAppStore } from '../../state/store.js';
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
import { motionEnabled, motionSeconds, useReducedMotion } from '../motion.js';
import { placeOnOrbit } from '../orbit.js';
import type { SceneQuality } from '../quality.js';
import { eclipseReceivers, ringsId, type EclipseReceiver } from './eclipse.js';
import { EclipseSystem, useEclipse, type EclipseBinding } from './eclipse-binding.js';
import { DECOR_LAYER } from '../layers.js';
import { useLodLevel } from './lod.js';
import { detailMix, useDetailStore } from '../detail/mode.js';
import {
  drawnBehindBackdrop,
  orbitLineFactor,
  orbitOutsideDome,
  sphereOutsideDome,
} from '../detail/dome.js';
import { useBackdropCulling } from '../detail/dome-binding.js';
import { planetReach } from '../detail/detail-body.js';
import {
  sphereFor,
  useBodyMaps,
  useNearTextureBudget,
  useRingTexture,
  useSphereGeometries,
  type BodyKind,
  type SphereSet,
} from './textures.js';

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
 * Shadows (P3-10, `eclipse.ts`): on tiers with `shadows`, each planet, moon and ring system is
 * darkened analytically by the casters of its own planet system only (the planet and its largest
 * moons, `castsShadow`): a moon's shadow is a spot on its planet, the planet's shadow falls on its
 * rings and eclipses its moons, and no planet ever eclipses another (the Sun's point light used to
 * magnify an inner planet's shadow over a whole outer planet). There is no shadow map.
 *
 * Level of detail (P3-06): each planet and moon picks a level from the tier's `lod` table by the
 * camera's distance in body radii (`lod.ts`, with hysteresis). A level swaps only the sphere mesh's
 * geometry (unit spheres shared by all bodies, scaled by the mesh) and its material's maps (the far
 * map at once; nearer maps, with bump/roughness detail on rocky and Earth-like surfaces, painted
 * lazily off the main thread). The anchor group is never replaced and its binding does not depend
 * on the level, so picking, the camera and labels see the same anchor and radius throughout.
 */
export function Bodies({ quality, sunRadius }: { quality: SceneQuality; sunRadius: number }) {
  const bodies = useAppStore((s) => sceneWorld(s).bodies);
  const mode = useSceneScale((s) => s.mode);
  const motion = motionEnabled(useReducedMotion());
  const list = useMemo(() => buildRenderList(bodies, mode), [bodies, mode]);
  const spheres = useSphereGeometries(quality.lod);
  useNearTextureBudget(quality.textureBudgetMB, quality.tier);
  return (
    <group name="bodies">
      {list.map((planet) => (
        <Planet
          key={planet.bodyId}
          item={planet}
          motion={motion}
          quality={quality}
          spheres={spheres}
          sunRadius={sunRadius}
        />
      ))}
    </group>
  );
}

const DEG = Math.PI / 180;

interface DetailProps {
  quality: SceneQuality;
  spheres: SphereSet;
  /** The Sun's radius: the eclipses' penumbra (`eclipse.ts`). */
  sunRadius: number;
}

function Planet({
  item,
  motion,
  quality,
  spheres,
  sunRadius,
}: { item: PlanetItem; motion: boolean } & DetailProps) {
  const anchor = useRef<Group>(null);
  const spin = useRef<Mesh>(null);
  const system = useMemo(() => new EclipseSystem(), []);
  const receivers = useMemo(
    () => new Map(eclipseReceivers(item).map((r) => [r.id, r] as const)),
    [item],
  );
  const eclipse = useEclipse(system, receivers.get(item.bodyId), quality.shadows, sunRadius);
  useLayoutEffect(() => system.register(item.bodyId, spin.current), [system, item.bodyId]);
  useOrbit(anchor, item.distance, item.phase, item.period, motion);
  useBodyAnchor(anchor, planetAnchor(item));
  const level = useLodLevel(anchor, item.radius, quality.lod);
  useFrame(() => {
    if (!motion || !spin.current) return;
    spin.current.rotation.y = (motionSeconds() / SPIN_PERIOD) * Math.PI * 2;
  });
  useLayoutEffect(() => {
    if (!motion && spin.current) spin.current.rotation.y = 0;
  }, [motion]);
  // P6-01: the detail view draws this planet (and its moons) itself; a settled detail view's
  // backdrop hides it when it is wholly outside (`detail/dome.ts`). The anchor group stays (its
  // world position is read either way).
  const detailHere = useDetailStore((s) => s.shown === item.bodyId);
  const reach = useMemo(() => planetReach(item), [item]);
  useBackdropCulling(anchor, (dome, at) => sphereOutsideDome(at, reach, dome));
  return (
    <>
      <OrbitLine
        radius={item.distance}
        segments={quality.orbitSegments.planet}
        opacity={0.22}
        bodyId={item.bodyId}
        aboutSun
      />
      <group ref={anchor} name={item.name} userData={{ bodyId: item.bodyId }}>
        <group rotation={[0, 0, item.look.tiltDeg * DEG]} visible={!detailHere}>
          <mesh
            ref={spin}
            geometry={sphereFor(spheres, 'planet', level)}
            scale={item.radius}
            onBeforeRender={eclipse.onBeforeRender}
          >
            <SurfaceMaterial
              look={item.look}
              kind="planet"
              quality={quality}
              level={level}
              eclipse={eclipse}
            />
          </mesh>
          {item.look.rings && (
            <Rings
              rings={item.look.rings}
              radius={item.radius}
              segments={quality.ringSegments}
              system={system}
              receiver={receivers.get(ringsId(item.bodyId))}
              shadows={quality.shadows}
              sunRadius={sunRadius}
            />
          )}
          {item.moons.map((moon) => (
            <Moon
              key={moon.bodyId}
              item={moon}
              motion={motion}
              quality={quality}
              spheres={spheres}
              sunRadius={sunRadius}
              system={system}
              receiver={receivers.get(moon.bodyId)}
            />
          ))}
        </group>
      </group>
    </>
  );
}

function Moon({
  item,
  motion,
  quality,
  spheres,
  sunRadius,
  system,
  receiver,
}: {
  item: MoonItem;
  motion: boolean;
  system: EclipseSystem;
  receiver: EclipseReceiver | undefined;
} & DetailProps) {
  const anchor = useRef<Group>(null);
  const sphere = useRef<Mesh>(null);
  const eclipse = useEclipse(system, receiver, quality.shadows, sunRadius);
  useLayoutEffect(() => system.register(item.bodyId, sphere.current), [system, item.bodyId]);
  useOrbit(anchor, item.distance, item.phase, item.period, motion);
  useBodyAnchor(anchor, moonAnchor(item));
  const level = useLodLevel(anchor, item.radius, quality.lod);
  // P6-01: in its own detail view the sub-scene draws this moon (its orbit line, which runs
  // through it, fades out with the cross-fade).
  const detailHere = useDetailStore((s) => s.shown === item.bodyId);
  return (
    <>
      <OrbitLine
        radius={item.distance}
        segments={quality.orbitSegments.moon}
        opacity={0.12}
        bodyId={item.bodyId}
      />
      <group ref={anchor} name={item.name} userData={{ bodyId: item.bodyId }}>
        <mesh
          ref={sphere}
          visible={!detailHere}
          geometry={sphereFor(spheres, 'moon', level)}
          scale={item.radius}
          onBeforeRender={eclipse.onBeforeRender}
        >
          <SurfaceMaterial
            look={item.look}
            kind="moon"
            quality={quality}
            level={level}
            eclipse={eclipse}
          />
        </mesh>
      </group>
    </>
  );
}

/**
 * How strongly the detail map's relief shades the surface (three's `bumpScale`).
 * `SurfaceMaterial`, `Rings` and `OrbitLine` are shared with the detail view (`detail/`, P6-01).
 */
const BUMP_SCALE = 1.5;

/**
 * A body's surface material at its LOD level: the colour map, and on near levels of rocky and
 * Earth-like bodies the detail map as bump (R) and roughness (G: Earth's oceans glossy). Keyed on
 * whether the detail map is there, so adding or removing it builds a new material (three compiles
 * a different shader) instead of mutating the old one.
 */
export function SurfaceMaterial({
  look,
  kind,
  quality,
  level,
  eclipse,
}: {
  look: PlanetItem['look'];
  kind: BodyKind;
  quality: SceneQuality;
  level: number;
  eclipse: EclipseBinding;
}) {
  const { map, detail } = useBodyMaps(look, kind, quality.lod, level);
  const matte = kind === 'planet' ? 0.95 : 1;
  return detail ? (
    <meshStandardMaterial
      key="detail"
      map={map}
      bumpMap={detail}
      bumpScale={BUMP_SCALE}
      roughnessMap={detail}
      roughness={1}
      metalness={0}
      onBeforeCompile={eclipse.onBeforeCompile}
      customProgramCacheKey={eclipse.customProgramCacheKey}
    />
  ) : (
    <meshStandardMaterial
      key="plain"
      map={map}
      roughness={matte}
      metalness={0}
      onBeforeCompile={eclipse.onBeforeCompile}
      customProgramCacheKey={eclipse.customProgramCacheKey}
    />
  );
}

/**
 * A flat ring system in the planet's equatorial plane, its texture laid out radially (u = 0 at
 * the inner edge, 1 at the outer). Receives the planet's shadow (and its moons', `eclipse.ts`); a
 * faint emissive term keeps the rings readable when the Sun grazes them edge-on.
 */
export function Rings({
  rings,
  radius,
  segments,
  system,
  receiver,
  shadows,
  sunRadius,
}: {
  rings: RingLook;
  radius: number;
  segments: number;
  system: EclipseSystem;
  receiver: EclipseReceiver | undefined;
  shadows: boolean;
  sunRadius: number;
}) {
  const texture = useRingTexture(rings);
  const eclipse = useEclipse(system, receiver, shadows, sunRadius);
  const geometry = useMemo(() => {
    const inner = radius * rings.inner;
    const outer = radius * rings.outer;
    const g = new RingGeometry(inner, outer, segments, 1);
    const pos = g.attributes['position']!;
    const uv = g.attributes['uv']!;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (r - inner) / (outer - inner), 0.5);
    }
    return g;
  }, [radius, rings.inner, rings.outer, segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      geometry={geometry}
      rotation={[-Math.PI / 2, 0, 0]}
      onBeforeRender={eclipse.onBeforeRender}
    >
      <meshStandardMaterial
        onBeforeCompile={eclipse.onBeforeCompile}
        customProgramCacheKey={eclipse.customProgramCacheKey}
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

/**
 * An orbit line. P6-01: `bodyId`, the body on this orbit — its line fades out while that body is
 * shown in detail (`orbitLineFactor`); `aboutSun`, the line is centred on the Sun — a settled
 * detail view's backdrop hides it when it is wholly outside (`orbitOutsideDome`; a moon's line
 * goes with its planet's group). Without either (the sub-scene's own lines) it is always drawn.
 */
export function OrbitLine({
  radius,
  segments,
  opacity,
  bodyId,
  aboutSun = false,
}: {
  radius: number;
  segments: number;
  opacity: number;
  bodyId?: string;
  aboutSun?: boolean;
}) {
  const positions = useMemo(() => circlePoints(radius, segments), [radius, segments]);
  const line = useRef<LineLoop>(null);
  useFrame(() => {
    const l = line.current;
    if (!l || (bodyId === undefined && !aboutSun)) return;
    const s = useDetailStore.getState();
    const own = bodyId !== undefined && s.shown === bodyId;
    const factor = orbitLineFactor(own, own ? detailMix(s, performance.now() / 1000) : 0);
    const drawn =
      factor > 0.001 &&
      (!aboutSun || drawnBehindBackdrop(s.covered, (dome) => orbitOutsideDome(radius, dome)));
    if (l.visible !== drawn) l.visible = drawn;
    (l.material as LineBasicMaterial).opacity = opacity * factor;
  }, READ_BODIES);
  return (
    <lineLoop ref={line} layers={DECOR_LAYER}>
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
export function useOrbit(
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
  // Before every reader of the anchors (satellites, labels, picking): see `frame-order.ts`.
  useFrame(() => {
    if (!motion || !ref.current) return;
    placeOnOrbit(ref.current, distance, orbitAngle(phase, period, motionSeconds()));
  }, PLACE_BODIES);
}
