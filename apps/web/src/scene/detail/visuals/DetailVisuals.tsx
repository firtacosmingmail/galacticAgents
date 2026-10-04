import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  Color,
  ShaderMaterial,
  Vector2,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type SphereGeometry,
} from 'three';
import type { BodyLook } from '../../bodies/appearance.js';
import { BUMP_SCALE } from '../../bodies/Bodies.js';
import type { EclipseBinding } from '../../bodies/eclipse-binding.js';
import { SPIN_PERIOD } from '../../bodies/layout.js';
import { useBodyMaps, type BodyKind } from '../../bodies/textures.js';
import { motionSeconds } from '../../motion.js';
import type { SceneQuality } from '../../quality.js';
import {
  ATMOSPHERE_FRAGMENT,
  ATMOSPHERE_VERTEX,
  atmosphereUniformValues,
} from './atmosphere-shader.js';
import { useCloudMaps, useDetailMaps } from './detail-textures.js';
import {
  atmosphereScale,
  cloudFadeIn,
  cloudScale,
  cloudTurn,
  planetshineColor,
  planetshineStrength,
  type AtmosphereLook,
  type CloudLook,
  type DetailLook,
} from './looks.js';

/**
 * The detail view's visuals (P6-02), drawn by the per-kind components of `DetailScene.tsx`:
 * the shown body's surface material at the detail level, its atmosphere glow and Earth's clouds.
 * Every material here keeps the eclipse patch (P3-10: one shared program cache key) except the
 * atmosphere's own shader.
 */

/** The normal map's scale on the material (the slope is baked into the map by `normalStrength`). */
const NORMAL_SCALE = new Vector2(1, 1);

/**
 * The surface of the body shown in detail: the detail level once painted (bigger colour map, a
 * normal map from the relief, Earth's roughness map), the nearest LOD level's maps until then
 * (shared with the system body through the near cache, with their bump map) — so entering never
 * shows less than the system did. Keyed on which maps it has, so three compiles the matching
 * program instead of a material being mutated.
 */
export function DetailSurfaceMaterial({
  look,
  kind,
  quality,
  detail,
  eclipse,
}: {
  look: BodyLook;
  kind: BodyKind;
  quality: SceneQuality;
  detail: DetailLook;
  eclipse: EclipseBinding;
}) {
  const near = useBodyMaps(look, kind, quality.lod, 0);
  const maps = useDetailMaps(look, kind, quality, detail);
  if (maps) {
    return (
      <meshStandardMaterial
        key={`detail${maps.normal ? '+n' : ''}${maps.roughness ? '+r' : ''}`}
        map={maps.map}
        normalMap={maps.normal}
        normalScale={NORMAL_SCALE}
        // No normal map (a giant, the mobile tier): the nearest level's bump, if it has one.
        bumpMap={maps.normal ? null : near.detail}
        bumpScale={BUMP_SCALE}
        roughnessMap={maps.roughness}
        roughness={maps.roughness ? 1 : detail.roughness}
        metalness={0}
        onBeforeCompile={eclipse.onBeforeCompile}
        customProgramCacheKey={eclipse.customProgramCacheKey}
      />
    );
  }
  return near.detail ? (
    <meshStandardMaterial
      key="near+detail"
      map={near.map}
      bumpMap={near.detail}
      bumpScale={BUMP_SCALE}
      roughnessMap={near.detail}
      roughness={1}
      metalness={0}
      onBeforeCompile={eclipse.onBeforeCompile}
      customProgramCacheKey={eclipse.customProgramCacheKey}
    />
  ) : (
    <meshStandardMaterial
      key="near"
      map={near.map}
      roughness={detail.roughness}
      metalness={0}
      onBeforeCompile={eclipse.onBeforeCompile}
      customProgramCacheKey={eclipse.customProgramCacheKey}
    />
  );
}

/** Drawn after the body and its clouds (transparent, additive). */
const ATMOSPHERE_ORDER = 2;

/**
 * A body's atmosphere glow: a shell `thickness` above the surface with the shared atmosphere
 * shader, fading in with the cross-fade (`mix`) so it does not pop at the start of the transition.
 * Cheap (one draw call, no texture), so every tier draws it.
 */
export function Atmosphere({
  atmosphere,
  radius,
  sphere,
  mix,
}: {
  atmosphere: AtmosphereLook;
  radius: number;
  sphere: SphereGeometry;
  mix: () => number;
}) {
  const material = useMemo(() => {
    const u = atmosphereUniformValues(atmosphere);
    return new ShaderMaterial({
      name: 'atmosphere',
      vertexShader: ATMOSPHERE_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      uniforms: {
        atmosphereColor: { value: new Color(u.color) },
        atmosphereIntensity: { value: u.intensity },
        atmosphereInner: { value: u.inner },
        atmospherePower: { value: u.power },
        atmosphereOpacity: { value: 0 },
      },
      // The cutaway (P6-03) gives the shell its clipping planes: cut with the surface.
      clipping: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
  }, [atmosphere]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(() => setUniform(material, 'atmosphereOpacity', mix()));
  const scale = radius * atmosphereScale({ atmosphere, normalStrength: 0, roughness: 1 });
  return (
    <mesh
      name="atmosphere"
      geometry={sphere}
      scale={scale}
      material={material}
      renderOrder={ATMOSPHERE_ORDER}
      raycast={noRaycast}
    />
  );
}

/** Decorations are never pick targets (picking uses the anchors anyway). */
function noRaycast(): void {}

function setUniform(material: ShaderMaterial, name: string, value: number): void {
  const uniform = material.uniforms[name];
  if (uniform) uniform.value = value;
}

/** Positions scratch for `applyPlanetshine` (one frame at a time, so one is enough). */
const shineAt = {
  planet: [0, 0, 0] as [number, number, number],
  moon: [0, 0, 0] as [number, number, number],
};

/** Sets a moon mesh's material emissive to its planet's planetshine now. */
function applyPlanetshine(mesh: Mesh, planet: Object3D, color: Color, planetRadius: number): void {
  const material = mesh.material as MeshStandardMaterial;
  if (!material.emissive) return;
  const pe = planet.matrixWorld.elements;
  const me = mesh.matrixWorld.elements;
  shineAt.planet[0] = pe[12]!;
  shineAt.planet[1] = pe[13]!;
  shineAt.planet[2] = pe[14]!;
  shineAt.moon[0] = me[12]!;
  shineAt.moon[1] = me[13]!;
  shineAt.moon[2] = me[14]!;
  material.emissive.copy(color);
  material.emissiveIntensity = planetshineStrength(shineAt.planet, shineAt.moon, planetRadius);
}

/**
 * Planetshine on a moon's mesh (`planetshineStrength`): every frame, the moon material's emissive
 * is set to its planet's colour at the strength for where the moon is now. Set per frame on
 * whatever material the mesh has (a level change swaps it); no recompile, emissive is always in
 * the standard shader. `planet()` is the planet's object (its world position is read).
 */
export function usePlanetshine(
  moon: RefObject<Mesh | null>,
  planet: () => Object3D | null | undefined,
  planetRadius: number,
  palette: readonly string[],
): void {
  const color = useMemo(() => new Color(planetshineColor(palette)), [palette]);
  useFrame(() => {
    const mesh = moon.current;
    const body = planet();
    if (mesh && body) applyPlanetshine(mesh, body, color, planetRadius);
  });
}

/** Drawn after the body, before the atmosphere. */
const CLOUD_ORDER = 1;

/**
 * Earth's clouds: a shell `altitude` above the surface with the procedural cloud texture as its
 * alpha map (white, lit by the Sun like the surface, eclipse-shaded with it), turning with the
 * surface plus a slow drift; still under reduced motion. Fades in with the cross-fade and, as the
 * texture may arrive after it, from when the texture arrives too (`cloudFadeIn`). The texture is
 * painted in the worker at the tier's size (mobile: 512 × 256); nothing is drawn until then.
 * A sphere under the body's group, so P6-03's cutaway cuts it with the surface (a cloud deck
 * floating over the open wedge would hide the layers).
 */
export function Clouds({
  clouds,
  radius,
  sphere,
  quality,
  motion,
  eclipse,
  mix,
}: {
  clouds: CloudLook;
  radius: number;
  sphere: SphereGeometry;
  quality: SceneQuality;
  motion: boolean;
  eclipse: EclipseBinding;
  mix: () => number;
}) {
  const mesh = useRef<Mesh>(null);
  /** When the texture arrived (the mesh's first frame), `performance.now()` seconds. */
  const arrivedAt = useRef<number | undefined>(undefined);
  const invalidate = useThree((s) => s.invalidate);
  const maps = useCloudMaps(clouds, quality);
  useFrame(() => {
    const m = mesh.current;
    if (!m) {
      arrivedAt.current = undefined;
      return;
    }
    const now = performance.now() / 1000;
    arrivedAt.current ??= now;
    const fade = cloudFadeIn(arrivedAt.current, now, motion);
    m.rotation.y = cloudTurn(clouds, motionSeconds(), SPIN_PERIOD, motion);
    (m.material as MeshStandardMaterial).opacity = mix() * fade;
    if (fade < 1) invalidate(); // the demand frame loop: keep frames coming through the fade
  });
  if (!maps) return null;
  return (
    <mesh
      ref={mesh}
      name="clouds"
      geometry={sphere}
      scale={radius * cloudScale(clouds)}
      renderOrder={CLOUD_ORDER}
      rotation={[0, cloudTurn(clouds, motionSeconds(), SPIN_PERIOD, motion), 0]}
      onBeforeRender={eclipse.onBeforeRender}
      raycast={noRaycast}
    >
      <meshStandardMaterial
        color="#ffffff"
        alphaMap={maps.alpha}
        transparent
        opacity={0}
        depthWrite={false}
        roughness={1}
        metalness={0}
        onBeforeCompile={eclipse.onBeforeCompile}
        customProgramCacheKey={eclipse.customProgramCacheKey}
      />
    </mesh>
  );
}
