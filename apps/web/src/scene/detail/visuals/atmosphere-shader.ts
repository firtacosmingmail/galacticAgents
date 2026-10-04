import type { AtmosphereLook } from './looks.js';
import { atmosphereScale } from './looks.js';

/**
 * The atmosphere shader (P6-02): the detail view's only hand-written shader. The plan allows two
 * (atmosphere and clouds); the clouds work as a standard material with an alpha map, which also
 * keeps the eclipse patch on them. One program for every body: only the uniforms differ.
 *
 * Drawn on a shell a little above the surface (`AtmosphereLook.thickness`), additively. The glow
 * is the length of the view ray inside the shell and outside the body, normalised to its maximum
 * (just past the limb) and raised to `power`: brightest as a thin ring at the limb, fading
 * smoothly to nothing at the shell's edge and to a faint veil over the disc — no hard rim. Only
 * the day side glows (the Sun is at the world origin), softly past the terminator. It casts and
 * receives no eclipse (a moon's shadow on a glow is not worth a second patch). It takes material
 * clipping planes (`clipping: true` and three's clipping chunks), so P6-03's cutaway cuts the
 * glow's wedge with the surface's instead of leaving a veil over the cut faces.
 */
export const ATMOSPHERE_VERTEX = /* glsl */ `
varying vec3 vShell;
varying vec3 vCamera;
varying vec3 vWorld;
varying vec3 vNormalWorld;
#include <clipping_planes_pars_vertex>
void main() {
  vShell = position;
  vCamera = ( inverse( modelMatrix ) * vec4( cameraPosition, 1.0 ) ).xyz;
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  vNormalWorld = normalize( mat3( modelMatrix ) * normal );
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

export const ATMOSPHERE_FRAGMENT = /* glsl */ `
uniform vec3 atmosphereColor;
uniform float atmosphereIntensity;
uniform float atmosphereInner;
uniform float atmospherePower;
uniform float atmosphereOpacity;
varying vec3 vShell;
varying vec3 vCamera;
varying vec3 vWorld;
varying vec3 vNormalWorld;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  vec3 dir = normalize( vShell - vCamera );
  float along = dot( vCamera, dir );
  float b2 = max( dot( vCamera, vCamera ) - along * along, 0.0 );
  float inner2 = atmosphereInner * atmosphereInner;
  float shell = sqrt( max( 1.0 - b2, 0.0 ) );
  float path = b2 < inner2 ? shell - sqrt( inner2 - b2 ) : 2.0 * shell;
  float glow = pow( clamp( path / ( 2.0 * sqrt( 1.0 - inner2 ) ), 0.0, 1.0 ), atmospherePower );
  float day = smoothstep( -0.25, 0.45, dot( normalize( vNormalWorld ), normalize( -vWorld ) ) );
  gl_FragColor = vec4( atmosphereColor, glow * day * atmosphereIntensity * atmosphereOpacity );
  #include <colorspace_fragment>
}
`;

/** The shader's uniform values for a look (colour as sRGB hex; the component converts it). */
export function atmosphereUniformValues(look: AtmosphereLook): {
  color: string;
  intensity: number;
  inner: number;
  power: number;
} {
  return {
    color: look.color,
    intensity: look.intensity,
    inner: 1 / atmosphereScale({ atmosphere: look, normalStrength: 0, roughness: 1 }),
    power: look.power,
  };
}

/**
 * The shader's glow mirrored in TypeScript (for the tests): the view ray from `camera` (object
 * space, shell radius 1) through the shell point `shell`, against an inner sphere of `inner`.
 */
export function atmosphereGlow(
  camera: readonly [number, number, number],
  shell: readonly [number, number, number],
  inner: number,
  power: number,
): number {
  const d = [shell[0] - camera[0], shell[1] - camera[1], shell[2] - camera[2]];
  const len = Math.hypot(d[0]!, d[1]!, d[2]!);
  const dir = d.map((x) => x / len);
  const along = camera[0] * dir[0]! + camera[1] * dir[1]! + camera[2] * dir[2]!;
  const b2 = Math.max(camera[0] ** 2 + camera[1] ** 2 + camera[2] ** 2 - along * along, 0);
  const inner2 = inner * inner;
  const shellHalf = Math.sqrt(Math.max(1 - b2, 0));
  const path = b2 < inner2 ? shellHalf - Math.sqrt(inner2 - b2) : 2 * shellHalf;
  return Math.min(1, Math.max(0, path / (2 * Math.sqrt(1 - inner2)))) ** power;
}
