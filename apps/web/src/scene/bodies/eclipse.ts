import type { PlanetItem } from './layout.js';

/**
 * Eclipse shadows (P3-10), replacing the Sun light's cube shadow map: each receiver (a planet, a
 * moon, a ring system) is darkened only by the casters of its **own planet system**, computed
 * analytically in its fragment shader (a ray from the fragment to the Sun against a few spheres).
 *
 * Why not the shadow map: the Sun is a point light, so a caster's shadow widens with distance
 * (radius × d_receiver / d_caster), and the readable layout enlarges the bodies while it compresses
 * the distances. Venus (radius 1.6 at 24) threw a shadow of radius 6 on Jupiter (4.5 at 90);
 * Mercury, Earth and Mars did the same to Jupiter, Saturn, Uranus and Neptune whenever they lined
 * up, about 13 % of the time (`docs/tasks/notes/P3-10-shadows.md`). A planet never eclipses
 * another here, the other systems' casters are simply not in the list; and nothing renders into a
 * cube map any more (six passes a frame).
 *
 * The rules are plain data (`eclipseCasters`, `eclipseReceivers`) and the shading is mirrored in
 * TypeScript (`eclipseLight`) so both are testable without WebGL.
 */

/** The most casters one receiver takes (the shader's array size); the largest first beyond it. */
export const MAX_ECLIPSE_CASTERS = 6;

/**
 * The penumbra's half-width as a fraction of the caster's radius, at most. The Sun's real size
 * would widen it with the gap between caster and receiver (`t × R_sun / d_sun`); the cap keeps a
 * moon's shadow a spot with a dark core, not a smudge, at the readable layout's short gaps.
 */
export const ECLIPSE_PENUMBRA_MAX = 0.25;

export interface EclipseCaster {
  bodyId: string;
  /** Visual radius, scene units (the mesh's scale). */
  radius: number;
}

/** A receiver: a planet, a moon, or a planet's rings (`ringsId`). */
export interface EclipseReceiver {
  id: string;
  /** The casters that can darken it: its own system's, never itself. */
  casters: EclipseCaster[];
}

/** The receiver id of a planet's rings. */
export function ringsId(planetId: string): string {
  return `${planetId}:rings`;
}

/**
 * A planet system's casters: the planet, and its moons that cast (`MoonItem.castShadow`, the
 * largest ones), biggest first, at most `MAX_ECLIPSE_CASTERS`.
 */
export function eclipseCasters(planet: PlanetItem): EclipseCaster[] {
  const all: EclipseCaster[] = [
    { bodyId: planet.bodyId, radius: planet.radius },
    ...planet.moons
      .filter((m) => m.castShadow)
      .map((m) => ({ bodyId: m.bodyId, radius: m.radius })),
  ];
  return all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.radius - a.c.radius || a.i - b.i)
    .slice(0, MAX_ECLIPSE_CASTERS)
    .map(({ c }) => c);
}

/**
 * Every receiver of a planet system and the casters it takes: the planet (from its moons), each
 * moon (from the planet and the other casting moons), the rings if any (from the planet and its
 * moons). Casters from another planet's system never appear.
 */
export function eclipseReceivers(planet: PlanetItem): EclipseReceiver[] {
  const casters = eclipseCasters(planet);
  const without = (id: string) => casters.filter((c) => c.bodyId !== id);
  return [
    { id: planet.bodyId, casters: without(planet.bodyId) },
    ...planet.moons.map((m) => ({ id: m.bodyId, casters: without(m.bodyId) })),
    ...(planet.look.rings ? [{ id: ringsId(planet.bodyId), casters }] : []),
  ];
}

export type Vec3 = readonly [number, number, number];

/**
 * How much of the Sun's light (the Sun at the origin, radius `sunRadius`) reaches the point `p`
 * past the spheres `casters` ([x, y, z, radius]): 1 lit, 0 in a full shadow. The TypeScript mirror
 * of the shader's `eclipseLight` (`ECLIPSE_FRAGMENT_PARS`).
 */
export function eclipseLight(
  p: Vec3,
  casters: readonly (readonly [number, number, number, number])[],
  sunRadius: number,
): number {
  const dSun = Math.hypot(p[0], p[1], p[2]);
  if (dSun < 1e-4) return 1;
  const l = [-p[0] / dSun, -p[1] / dSun, -p[2] / dSun] as const;
  let lit = 1;
  for (const [cx, cy, cz, r] of casters) {
    const pc = [cx - p[0], cy - p[1], cz - p[2]] as const;
    const t = pc[0] * l[0] + pc[1] * l[1] + pc[2] * l[2];
    if (t <= 0 || t >= dSun) continue;
    const d = Math.hypot(pc[0] - t * l[0], pc[1] - t * l[1], pc[2] - t * l[2]);
    const w = Math.max(1e-4, Math.min(r * ECLIPSE_PENUMBRA_MAX, (t * sunRadius) / dSun));
    lit *= smoothstep(r - w, r + w, d);
  }
  return lit;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Vertex shader additions: the fragment's world position. */
export const ECLIPSE_VERTEX_PARS = /* glsl */ `
varying vec3 vEclipseWorld;
`;
export const ECLIPSE_VERTEX = /* glsl */ `
vEclipseWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

/** Fragment shader additions: the uniforms and `eclipseLight`, the shader twin of the function. */
export const ECLIPSE_FRAGMENT_PARS = /* glsl */ `
#define ECLIPSE_MAX ${MAX_ECLIPSE_CASTERS}
uniform vec4 eclipseCasters[ ECLIPSE_MAX ];
uniform int eclipseCount;
uniform float eclipseSunRadius;
varying vec3 vEclipseWorld;
float eclipseLight( vec3 p ) {
  float dSun = length( p );
  if ( dSun < 1e-4 ) return 1.0;
  vec3 l = -p / dSun;
  float lit = 1.0;
  for ( int i = 0; i < ECLIPSE_MAX; i ++ ) {
    if ( i >= eclipseCount ) break;
    vec4 c = eclipseCasters[ i ];
    vec3 pc = c.xyz - p;
    float t = dot( pc, l );
    if ( t <= 0.0 || t >= dSun ) continue;
    float d = length( pc - t * l );
    float w = max( 1e-4, min( c.w * ${ECLIPSE_PENUMBRA_MAX.toFixed(4)}, t * eclipseSunRadius / dSun ) );
    lit *= smoothstep( c.w - w, c.w + w, d );
  }
  return lit;
}
`;

/** Applied after the lights: only the Sun's direct light is eclipsed (not ambient, not emissive). */
export const ECLIPSE_FRAGMENT = /* glsl */ `
float eclipseLit = eclipseLight( vEclipseWorld );
reflectedLight.directDiffuse *= eclipseLit;
reflectedLight.directSpecular *= eclipseLit;
`;

/** The shader chunks the patch anchors on (three's standard material). */
export const ECLIPSE_ANCHORS = {
  vertexPars: '#include <common>',
  vertex: '#include <project_vertex>',
  fragmentPars: '#include <common>',
  fragment: '#include <lights_fragment_end>',
} as const;

/**
 * Adds the eclipse to a standard material's shader source: returns the patched sources, or throws
 * when an anchor is missing (a three upgrade that renamed a chunk must fail loudly in tests, not
 * silently drop the shadows).
 */
export function patchEclipseShader(vertexShader: string, fragmentShader: string) {
  const insert = (src: string, anchor: string, add: string) => {
    if (!src.includes(anchor)) throw new Error(`eclipse: shader anchor ${anchor} not found`);
    return src.replace(anchor, `${anchor}\n${add}`);
  };
  return {
    vertexShader: insert(
      insert(vertexShader, ECLIPSE_ANCHORS.vertexPars, ECLIPSE_VERTEX_PARS),
      ECLIPSE_ANCHORS.vertex,
      ECLIPSE_VERTEX,
    ),
    fragmentShader: insert(
      insert(fragmentShader, ECLIPSE_ANCHORS.fragmentPars, ECLIPSE_FRAGMENT_PARS),
      ECLIPSE_ANCHORS.fragment,
      ECLIPSE_FRAGMENT,
    ),
  };
}
