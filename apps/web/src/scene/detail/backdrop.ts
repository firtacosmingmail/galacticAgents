import { generateStarField, STAR_SHELL, type StarField } from '../starfield.js';

/**
 * The detail view's backdrop as plain data (P6-01; no three.js, testable): a dark sphere about the
 * body (`backdropRadius`) that fades in over the rest of the solar system, the sky's stars drawn on
 * its inside, and the Sun in its real direction.
 *
 * **Stars.** The same stars as the system's sky (`generateStarField`, same seed and count, centred
 * on the camera), so nothing in the sky moves or changes across the cross-fade: only the shell is
 * smaller, inside the backdrop. Drawn additively at the fade's opacity over the system's sky (which
 * the backdrop dims by the same amount), a star keeps its brightness all the way through.
 */

/** The backdrop stars' shell, as fractions of the backdrop's radius, about the camera. */
export const BACKDROP_STAR_SHELL = { inner: 0.78, outer: 0.86 } as const;
/** How far out the Sun sits on the backdrop, as a fraction of its radius, from the body. */
export const BACKDROP_SUN_AT = 0.7;

/**
 * The sky's stars on a shell of radius `inner`–`outer` (fractions; the points object is scaled by
 * the backdrop's radius): the same directions, colours and order as `generateStarField(count)`.
 */
export function backdropStars(
  count: number,
  shell: { inner: number; outer: number } = BACKDROP_STAR_SHELL,
): StarField {
  const sky = generateStarField(count);
  const positions = new Float32Array(sky.positions.length);
  const span = STAR_SHELL.outer - STAR_SHELL.inner;
  for (let i = 0; i < positions.length; i += 3) {
    const x = sky.positions[i]!;
    const y = sky.positions[i + 1]!;
    const z = sky.positions[i + 2]!;
    const r = Math.hypot(x, y, z) || 1;
    const t = Math.min(1, Math.max(0, (r - STAR_SHELL.inner) / span));
    const k = (shell.inner + (shell.outer - shell.inner) * t) / r;
    positions[i] = x * k;
    positions[i + 1] = y * k;
    positions[i + 2] = z * k;
  }
  return { positions, colors: sky.colors };
}

/**
 * Where the Sun goes on the backdrop for a body at `body` (the Sun is at the origin): its
 * direction from the body, `BACKDROP_SUN_AT` of the backdrop's radius out, and a scale that keeps
 * the size it has on screen in the system view (`sunRadius` seen from the body's distance).
 * `undefined` for a body at the Sun's centre. Written into `out` (no allocation per frame).
 */
export function backdropSun(
  body: readonly [number, number, number],
  backdrop: number,
  sunRadius: number,
  out: BackdropSun = { position: [0, 0, 0], radius: 0 },
): BackdropSun | undefined {
  const d = Math.hypot(body[0], body[1], body[2]);
  if (d < 1e-9) return undefined;
  const at = backdrop * BACKDROP_SUN_AT;
  out.position[0] = (-body[0] / d) * at;
  out.position[1] = (-body[1] / d) * at;
  out.position[2] = (-body[2] / d) * at;
  out.radius = sunRadius * (at / d);
  return out;
}

/** The backdrop Sun's place (`backdropSun`; per-frame callers pass a scratch `out`). */
export interface BackdropSun {
  position: [number, number, number];
  radius: number;
}
