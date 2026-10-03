/**
 * The star-field skybox as plain data (no three.js here, so it is testable without WebGL): `count`
 * points spread uniformly over a spherical shell around the origin, with a slight colour spread
 * (blue-white to warm) and brightness spread. Seeded, so the sky is the same on every load.
 */
export interface StarField {
  /** xyz per star. */
  positions: Float32Array;
  /** Linear rgb per star, in [0, 1]. */
  colors: Float32Array;
}

export const STAR_SHELL = { inner: 1200, outer: 2400 } as const;

/**
 * The brightest a star channel gets (linear). Kept below the bloom threshold (1.0, `quality.ts`)
 * so the stars never bloom: only the Sun does.
 */
export const STAR_MAX_BRIGHTNESS = 0.85;
const STAR_MIN_BRIGHTNESS = 0.25;

/** mulberry32: a tiny deterministic PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Star tints, cool to warm (linear rgb). */
const TINTS: readonly [number, number, number][] = [
  [0.75, 0.82, 1.0],
  [0.9, 0.93, 1.0],
  [1.0, 1.0, 1.0],
  [1.0, 0.95, 0.85],
  [1.0, 0.85, 0.7],
];

export function generateStarField(count: number, seed = 1): StarField {
  const n = Math.max(0, Math.floor(count));
  const random = mulberry32(seed);
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const { inner, outer } = STAR_SHELL;
  for (let i = 0; i < n; i++) {
    // Uniform direction on the sphere.
    const z = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    const radius = inner + (outer - inner) * random();
    positions[i * 3] = r * Math.cos(phi) * radius;
    positions[i * 3 + 1] = z * radius;
    positions[i * 3 + 2] = r * Math.sin(phi) * radius;
    // Most stars are dim; a few are bright.
    const brightness =
      STAR_MIN_BRIGHTNESS + (STAR_MAX_BRIGHTNESS - STAR_MIN_BRIGHTNESS) * random() ** 3;
    const tint = TINTS[Math.floor(random() * TINTS.length)] ?? TINTS[2]!;
    colors[i * 3] = tint[0] * brightness;
    colors[i * 3 + 1] = tint[1] * brightness;
    colors[i * 3 + 2] = tint[2] * brightness;
  }
  return { positions, colors };
}
