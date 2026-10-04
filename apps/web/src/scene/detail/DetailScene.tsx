import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  Color,
  SphereGeometry,
  type Camera,
  type Group,
  type Material,
  type Mesh,
  type Points,
  type Sprite,
} from 'three';
import { sceneWorld, useAppStore } from '../../state/store.js';
import { getAnchor } from '../anchors.js';
import { anchorPosition } from '../camera/store.js';
import { OrbitLine, Rings, SurfaceMaterial, useOrbit } from '../bodies/Bodies.js';
import { EclipseSystem, useEclipse } from '../bodies/eclipse-binding.js';
import { eclipseReceivers, ringsId, type EclipseReceiver } from '../bodies/eclipse.js';
import { SPIN_PERIOD, type MoonItem, type PlanetItem } from '../bodies/layout.js';
import { asteroidSquash, TASK_ROCK_SEED, TASK_ASTEROID_RADIUS } from '../belt/belt-model.js';
import { rockGeometry } from '../belt/belt-mesh.js';
import { PLACE_DETAIL } from '../frame-order.js';
import { DECOR_LAYER } from '../layers.js';
import { motionEnabled, motionSeconds, useReducedMotion } from '../motion.js';
import { SUN_EMISSIVE, type LodConfig, type SceneQuality } from '../quality.js';
import { useSceneScale } from '../scale.js';
import { centreOnCamera, STAR_POINT_PX } from '../starfield.js';
import { sunGlowTexture } from '../sun-glow.js';
import { backdropStars, backdropSun, type BackdropSun } from './backdrop.js';
import { clearDome, publishDome } from './dome.js';
import { backdropRadius, resolveDetailBody, type DetailBody } from './detail-body.js';
import { detailMix, useDetailStore } from './mode.js';
import { partsFor } from './parts.js';
import { registerStandIn } from './stand-ins.js';

/**
 * The detail view's sub-scene (P6-01): a separate tree of meshes, mounted while a body is shown in
 * detail (`DetailLayer`) and disposed when it is left — not the system's meshes at a higher LOD.
 *
 * **Frame.** Everything of the body is drawn in its own frame, which copies the body's anchor
 * matrix every frame (`PLACE_DETAIL`, after the bodies moved): the sub-scene sits exactly where
 * the system draws the body, at the same size, so the anchors (camera, picking, labels,
 * satellites, beacons) stay the system's and simply keep working, and the swap from the system's
 * meshes to these is seamless. The system hides its own meshes of the body while it is shown
 * (`Bodies.tsx`, `Belt.tsx`: `shown`), and these register as the body's stand-ins for the selection
 * outline (`stand-ins.ts`).
 *
 * **Kinds.** One component per kind, a minimal first version each (P6-02 makes them rich):
 * `RockyPlanetDetail` and `GiantPlanetDetail` (the planet at its nearest LOD level's sphere and
 * maps — painted off the main thread, the far map until then —, its rings, its moons on their
 * orbits with their orbit lines, eclipse shading among them as in the system view),
 * `MoonDetail` (the moon at its nearest level, shaded by its planet and the large siblings) and
 * `AsteroidDetail` (the task asteroid's rock; its halo fades out with the cross-fade). Later parts plug in through `parts.ts`.
 *
 * **Backdrop** (`backdrop.ts`): a dark sphere about the body, beyond its scope's bodies, fading in
 * over the system (transparent, blended over whatever is behind it); once the view has settled
 * (`covered`) an opaque copy drawn first takes over, its depth hiding what lies beyond, and the
 * system skips what is wholly outside it (the dome is published for that: `dome.ts`). The
 * sky's own stars on its inside, unchanged across the fade, and the Sun in its real direction.
 * About 4 draw calls; every geometry, material and texture here is disposed on unmount.
 */
export function DetailScene({
  bodyId,
  quality,
  sunRadius,
}: {
  bodyId: string;
  quality: SceneQuality;
  sunRadius: number;
}) {
  const bodies = useAppStore((s) => sceneWorld(s).bodies);
  const scale = useSceneScale((s) => s.mode);
  const body = useMemo(() => resolveDetailBody(bodies, bodyId, scale), [bodies, bodyId, scale]);
  if (!body) return null;
  return <DetailFrame body={body} quality={quality} sunRadius={sunRadius} />;
}

/** The cross-fade's value now (0 system … 1 detail), for per-frame readers. */
const currentMix = () => detailMix(useDetailStore.getState(), performance.now() / 1000);

function DetailFrame({
  body,
  quality,
  sunRadius,
}: {
  body: DetailBody;
  quality: SceneQuality;
  sunRadius: number;
}) {
  const root = useRef<Group>(null);
  useFrame(() => {
    const frame = root.current;
    const anchor = getAnchor(body.bodyId);
    if (!frame || !anchor) return;
    anchor.object.updateWorldMatrix(true, false);
    frame.matrix.copy(anchor.object.matrixWorld);
    frame.matrixWorldNeedsUpdate = true;
  }, PLACE_DETAIL);
  const parts = partsFor(body);
  return (
    <>
      <Backdrop
        bodyId={body.bodyId}
        radius={backdropRadius(body)}
        stars={quality.stars}
        sunRadius={sunRadius}
      />
      <group ref={root} name={`detail:${body.bodyId}`} matrixAutoUpdate={false}>
        <BodyOfKind body={body} quality={quality} sunRadius={sunRadius} />
        {parts.map((p) => (
          <p.Component key={p.id} body={body} quality={quality} mix={currentMix} />
        ))}
      </group>
    </>
  );
}

function BodyOfKind({
  body,
  quality,
  sunRadius,
}: {
  body: DetailBody;
  quality: SceneQuality;
  sunRadius: number;
}) {
  switch (body.kind) {
    case 'rocky':
      return <RockyPlanetDetail planet={body.planet} quality={quality} sunRadius={sunRadius} />;
    case 'giant':
      return <GiantPlanetDetail planet={body.planet} quality={quality} sunRadius={sunRadius} />;
    case 'moon':
      return (
        <MoonDetail moon={body.moon} parent={body.parent} quality={quality} sunRadius={sunRadius} />
      );
    case 'asteroid':
      return <AsteroidDetail body={body} />;
  }
}

interface PlanetDetailProps {
  planet: PlanetItem;
  quality: SceneQuality;
  sunRadius: number;
  /** Drawn in the planet's tilted frame (P6-02: clouds, atmosphere). */
  children?: ReactNode;
}

/** A rocky, Earth-like or cloudy planet (Mercury, Venus, Earth, Mars): P6-02 adds atmosphere, clouds. */
export function RockyPlanetDetail(props: PlanetDetailProps) {
  return <PlanetSystemDetail {...props} />;
}

/** A gas or ice giant (Jupiter, Saturn, Uranus, Neptune): P6-02 adds bands, ring detail. */
export function GiantPlanetDetail(props: PlanetDetailProps) {
  return <PlanetSystemDetail {...props} />;
}

/** Unit spheres at the tier's nearest level, for this sub-scene only (disposed with it). */
function useNearSpheres(lod: LodConfig): { planet: SphereGeometry; moon: SphereGeometry } {
  const spheres = useMemo(() => {
    const near = lod.levels[0]!;
    return {
      planet: new SphereGeometry(1, near.planetSegments[0], near.planetSegments[1]),
      moon: new SphereGeometry(1, near.moonSegments[0], near.moonSegments[1]),
    };
  }, [lod]);
  useEffect(
    () => () => {
      spheres.planet.dispose();
      spheres.moon.dispose();
    },
    [spheres],
  );
  return spheres;
}

const DEG = Math.PI / 180;

/**
 * A planet and its moons as the system draws them (`Bodies.tsx`'s `Planet`, same tilt, spin,
 * orbits and clock), at the nearest level of detail whatever the distance.
 */
function PlanetSystemDetail({ planet, quality, sunRadius, children }: PlanetDetailProps) {
  const motion = motionEnabled(useReducedMotion());
  const standIn = useRef<Group>(null);
  const spin = useRef<Mesh>(null);
  const spheres = useNearSpheres(quality.lod);
  const system = useMemo(() => new EclipseSystem(), []);
  const receivers = useMemo(
    () => new Map(eclipseReceivers(planet).map((r) => [r.id, r] as const)),
    [planet],
  );
  const eclipse = useEclipse(system, receivers.get(planet.bodyId), quality.shadows, sunRadius);
  useLayoutEffect(() => system.register(planet.bodyId, spin.current), [system, planet.bodyId]);
  useEffect(() => registerStandIn(planet.bodyId, standIn.current), [planet.bodyId]);
  useFrame(() => {
    if (!motion || !spin.current) return;
    spin.current.rotation.y = (motionSeconds() / SPIN_PERIOD) * Math.PI * 2;
  });
  useLayoutEffect(() => {
    if (!motion && spin.current) spin.current.rotation.y = 0;
  }, [motion]);
  return (
    <group ref={standIn} name={`detail-planet:${planet.name}`} userData={{ bodyId: planet.bodyId }}>
      <group rotation={[0, 0, planet.look.tiltDeg * DEG]}>
        <mesh
          ref={spin}
          geometry={spheres.planet}
          scale={planet.radius}
          onBeforeRender={eclipse.onBeforeRender}
        >
          <SurfaceMaterial
            look={planet.look}
            kind="planet"
            quality={quality}
            level={0}
            eclipse={eclipse}
          />
        </mesh>
        {planet.look.rings && (
          <Rings
            rings={planet.look.rings}
            radius={planet.radius}
            segments={quality.ringSegments}
            system={system}
            receiver={receivers.get(ringsId(planet.bodyId))}
            shadows={quality.shadows}
            sunRadius={sunRadius}
          />
        )}
        {planet.moons.map((moon) => (
          <OrbitingMoon
            key={moon.bodyId}
            moon={moon}
            motion={motion}
            quality={quality}
            sphere={spheres.moon}
            sunRadius={sunRadius}
            system={system}
            receiver={receivers.get(moon.bodyId)}
          />
        ))}
        {children}
      </group>
    </group>
  );
}

function OrbitingMoon({
  moon,
  motion,
  quality,
  sphere,
  sunRadius,
  system,
  receiver,
}: {
  moon: MoonItem;
  motion: boolean;
  quality: SceneQuality;
  sphere: SphereGeometry;
  sunRadius: number;
  system: EclipseSystem;
  receiver: EclipseReceiver | undefined;
}) {
  const anchor = useRef<Group>(null);
  const mesh = useRef<Mesh>(null);
  const eclipse = useEclipse(system, receiver, quality.shadows, sunRadius);
  useLayoutEffect(() => system.register(moon.bodyId, mesh.current), [system, moon.bodyId]);
  useEffect(() => registerStandIn(moon.bodyId, anchor.current), [moon.bodyId]);
  useOrbit(anchor, moon.distance, moon.phase, moon.period, motion);
  return (
    <>
      <OrbitLine radius={moon.distance} segments={quality.orbitSegments.moon} opacity={0.12} />
      <group ref={anchor} name={`detail-moon:${moon.name}`} userData={{ bodyId: moon.bodyId }}>
        <mesh
          ref={mesh}
          geometry={sphere}
          scale={moon.radius}
          onBeforeRender={eclipse.onBeforeRender}
        >
          <SurfaceMaterial
            look={moon.look}
            kind="moon"
            quality={quality}
            level={0}
            eclipse={eclipse}
          />
        </mesh>
      </group>
    </>
  );
}

/**
 * A moon on its own (P6-02 adds detail): the frame is the moon's anchor's, so the moon sits at the
 * origin. Its planet and siblings are the system's own meshes, inside the backdrop; their anchors
 * are the eclipse casters (only a caster's position is read).
 */
export function MoonDetail({
  moon,
  parent,
  quality,
  sunRadius,
  children,
}: {
  moon: MoonItem;
  parent: PlanetItem;
  quality: SceneQuality;
  sunRadius: number;
  children?: ReactNode;
}) {
  const standIn = useRef<Group>(null);
  const spheres = useNearSpheres(quality.lod);
  const receiver = useMemo(
    () => eclipseReceivers(parent).find((r) => r.id === moon.bodyId),
    [parent, moon.bodyId],
  );
  const system = useMemo(() => new EclipseSystem(), []);
  useEffect(() => {
    const cleanups = (receiver?.casters ?? []).map((c) =>
      system.register(c.bodyId, getAnchor(c.bodyId)?.object ?? null),
    );
    return () => cleanups.forEach((stop) => stop());
  }, [system, receiver]);
  const eclipse = useEclipse(system, receiver, quality.shadows, sunRadius);
  useEffect(() => registerStandIn(moon.bodyId, standIn.current), [moon.bodyId]);
  return (
    <group ref={standIn} name={`detail-moon:${moon.name}`} userData={{ bodyId: moon.bodyId }}>
      <mesh geometry={spheres.moon} scale={moon.radius} onBeforeRender={eclipse.onBeforeRender}>
        <SurfaceMaterial
          look={moon.look}
          kind="moon"
          quality={quality}
          level={0}
          eclipse={eclipse}
        />
      </mesh>
      {children}
    </group>
  );
}

/**
 * A task asteroid (P6-02 adds detail): the system's rock — same shape, squash, turn and colours —
 * and its halo, in the anchor's frame (which turns with the belt).
 */
export function AsteroidDetail({
  body,
  children,
}: {
  body: Extract<DetailBody, { kind: 'asteroid' }>;
  children?: ReactNode;
}) {
  const standIn = useRef<Group>(null);
  const { asteroid } = body;
  const shapes = useMemo(
    () => ({ rock: rockGeometry(TASK_ROCK_SEED, 1), halo: new SphereGeometry(1, 24, 16) }),
    [],
  );
  useEffect(
    () => () => {
      shapes.rock.dispose();
      shapes.halo.dispose();
    },
    [shapes],
  );
  const squash = useMemo(
    () =>
      asteroidSquash(asteroid.seed).map((s) => s * TASK_ASTEROID_RADIUS) as [
        number,
        number,
        number,
      ],
    [asteroid.seed],
  );
  useEffect(() => registerStandIn(body.bodyId, standIn.current), [body.bodyId]);
  // The halo marks a task asteroid at system scale; up close (2.4 radii) it would fill the view
  // with cyan, so it fades out with the cross-fade (and back in on the way out).
  const halo = useRef<Mesh>(null);
  useFrame(() => {
    const mesh = halo.current;
    if (!mesh) return;
    const opacity = HALO_OPACITY * (1 - currentMix());
    mesh.visible = opacity > 0.001;
    setOpacity(mesh.material, opacity);
  });
  return (
    <group ref={standIn} name={`detail-asteroid:${body.name}`} userData={{ bodyId: body.bodyId }}>
      <mesh
        geometry={shapes.rock}
        scale={squash}
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
      <mesh
        ref={halo}
        geometry={shapes.halo}
        scale={TASK_ASTEROID_RADIUS * 1.5}
        layers={DECOR_LAYER}
      >
        <meshBasicMaterial
          color="#5fd4ff"
          transparent
          opacity={HALO_OPACITY}
          side={BackSide}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {children}
    </group>
  );
}

/** The task asteroid halo's opacity in the system view (`Belt.tsx`). */
const HALO_OPACITY = 0.22;

/** The scene's background colour (`SolarScene`): the backdrop is the same dark. */
const BACKDROP_COLOR = '#02030a';
/** Drawn first of all once settled, so everything inside is drawn over it and nothing outside. */
const SOLID_ORDER = -1000;
/** While fading, the stars and the Sun come after the fading dome (z-sorted at 0)… */
const SKY_ORDER = 1;
/**
 * …once settled, first of the transparent objects (right after the solid dome), so rings, halos
 * and beams are drawn over the sky, not the sky's stars over them (they write no depth).
 */
const SKY_SETTLED_ORDER = -999;

/**
 * The backdrop about the body (see the component's header): positioned on the body (no rotation:
 * the Sun's direction is in world space), the stars on the camera.
 */
function Backdrop({
  bodyId,
  radius,
  stars,
  sunRadius,
}: {
  bodyId: string;
  radius: number;
  stars: number;
  sunRadius: number;
}) {
  const group = useRef<Group>(null);
  const fadeDome = useRef<Mesh>(null);
  const solidDome = useRef<Mesh>(null);
  const sky = useRef<Points>(null);
  const sun = useRef<Group>(null);
  const glow = useRef<Sprite>(null);
  const [scratch] = useState(() => ({
    at: [0, 0, 0] as [number, number, number],
    sun: { position: [0, 0, 0], radius: 0 } as BackdropSun,
  }));
  useEffect(() => () => clearDome(scratch), [scratch]);
  const sphere = useMemo(() => new SphereGeometry(1, 48, 24), []);
  useEffect(() => () => sphere.dispose(), [sphere]);
  const starField = useMemo(() => backdropStars(stars), [stars]);
  const glowTexture = useMemo(() => sunGlowTexture(), []);
  useEffect(() => () => glowTexture.dispose(), [glowTexture]);
  const sunColor = useMemo(
    () => new Color(SUN_EMISSIVE.color).multiplyScalar(SUN_EMISSIVE.intensity),
    [],
  );
  const followCamera = useCallback((_gl: unknown, _scene: unknown, camera: Camera) => {
    if (sky.current) centreOnCamera(sky.current, camera);
  }, []);

  useFrame(() => {
    const anchor = getAnchor(bodyId);
    const g = group.current;
    if (!anchor || !g) return;
    const at = anchorPosition(anchor, scratch.at);
    g.position.set(at[0], at[1], at[2]);
    publishDome(scratch, scratch.at, radius);
    const s = useDetailStore.getState();
    const mix = detailMix(s, performance.now() / 1000);
    const settled = s.covered;
    if (fadeDome.current) {
      fadeDome.current.visible = !settled && mix > 0;
      setOpacity(fadeDome.current.material, mix);
    }
    if (solidDome.current) solidDome.current.visible = settled;
    const skyOrder = settled ? SKY_SETTLED_ORDER : SKY_ORDER;
    if (sky.current) {
      setOpacity(sky.current.material, mix);
      sky.current.renderOrder = skyOrder;
    }
    if (sun.current) for (const child of sun.current.children) child.renderOrder = skyOrder;
    const place = backdropSun(at, radius, sunRadius, scratch.sun);
    if (sun.current) {
      sun.current.visible = place !== undefined && mix > 0;
      if (place) {
        sun.current.position.set(place.position[0], place.position[1], place.position[2]);
        sun.current.scale.setScalar(place.radius);
        for (const child of sun.current.children)
          setOpacity((child as Mesh | Sprite).material, child === glow.current ? mix * 0.6 : mix);
      }
    }
  }, PLACE_DETAIL);

  return (
    <>
      <group ref={group} name="detail-backdrop">
        <mesh
          ref={fadeDome}
          geometry={sphere}
          scale={radius}
          renderOrder={0}
          frustumCulled={false}
          layers={DECOR_LAYER}
          visible={false}
        >
          <meshBasicMaterial
            color={BACKDROP_COLOR}
            side={BackSide}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh
          ref={solidDome}
          geometry={sphere}
          scale={radius}
          renderOrder={SOLID_ORDER}
          frustumCulled={false}
          layers={DECOR_LAYER}
          visible={false}
        >
          <meshBasicMaterial color={BACKDROP_COLOR} side={BackSide} toneMapped={false} />
        </mesh>
        <group ref={sun} visible={false}>
          <mesh geometry={sphere} renderOrder={SKY_ORDER} layers={DECOR_LAYER}>
            <meshBasicMaterial color={sunColor} transparent opacity={0} depthWrite={false} />
          </mesh>
          <sprite ref={glow} scale={6} renderOrder={SKY_ORDER} layers={DECOR_LAYER}>
            <spriteMaterial
              map={glowTexture}
              blending={AdditiveBlending}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
            />
          </sprite>
        </group>
      </group>
      <points
        ref={sky}
        key={stars}
        scale={radius}
        frustumCulled={false}
        onBeforeRender={followCamera}
        renderOrder={SKY_ORDER}
        layers={DECOR_LAYER}
      >
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[starField.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[starField.colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          vertexColors
          size={STAR_POINT_PX}
          sizeAttenuation={false}
          transparent
          opacity={0}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </points>
    </>
  );
}

function setOpacity(material: Material | Material[], opacity: number): void {
  const list = Array.isArray(material) ? material : [material];
  for (const m of list) m.opacity = opacity;
}
