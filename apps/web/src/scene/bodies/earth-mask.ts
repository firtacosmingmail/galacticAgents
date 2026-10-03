import { EARTH_MASK_HEIGHT, EARTH_MASK_RUNS, EARTH_MASK_WIDTH } from './earth-mask-data.js';

/**
 * Earth's real land/sea mask (P3-09), from public-domain Natural Earth land polygons rasterised by
 * `apps/web/scripts/earth-mask.mjs` into `earth-mask-data.ts`. Decoded once, on the first Earth
 * paint (in the worker or on the main thread), into a small pyramid of land fractions: level 0 is
 * the 1024 × 512 mask itself (0 or 1 per texel), each further level halves it by averaging, so a
 * small texture samples a matching level (no aliasing at the far level) and a coarse level gives a
 * smooth "near a coast" field (shallow seas).
 *
 * Geography: column 0 starts at 180°W, row 0 at 90°N; `sampleLand` takes degrees.
 */

/** Bumped whenever the mask data or its sampling changes: part of Earth's texture cache key. */
export const EARTH_MASK_VERSION = 1;

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

export interface MaskLevel {
  width: number;
  height: number;
  /** Land fraction per texel, 0..1. */
  data: Float32Array;
}

/** Decodes run lengths (sea first, alternating; base-64 varints) into 0/1 bytes. */
export function decodeMask(runs: string, width: number, height: number): Uint8Array {
  const lookup = new Int8Array(128).fill(-1);
  for (let k = 0; k < ALPHABET.length; k++) lookup[ALPHABET.charCodeAt(k)] = k;
  const out = new Uint8Array(width * height);
  let pos = 0;
  let value = 0;
  let n = 0;
  let shift = 1;
  for (let c = 0; c < runs.length; c++) {
    const d = lookup[runs.charCodeAt(c)] ?? -1;
    if (d < 0) throw new Error(`Bad character in the Earth mask at ${c}`);
    n += (d & 31) * shift;
    if (d & 32) {
      shift *= 32;
      continue;
    }
    if (pos + n > out.length) throw new Error('The Earth mask overflows its size');
    if (value) out.fill(1, pos, pos + n);
    pos += n;
    value ^= 1;
    n = 0;
    shift = 1;
  }
  if (pos !== out.length) throw new Error(`The Earth mask has ${pos} of ${out.length} texels`);
  return out;
}

function halve(level: MaskLevel): MaskLevel {
  const width = level.width / 2;
  const height = level.height / 2;
  const data = new Float32Array(width * height);
  const src = level.data;
  const w = level.width;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const a = 2 * j * w + 2 * i;
      data[j * width + i] = (src[a]! + src[a + 1]! + src[a + w]! + src[a + w + 1]!) / 4;
    }
  }
  return { width, height, data };
}

let pyramid: MaskLevel[] | undefined;

/** The decoded mask pyramid (level 0 = full size), built on first use. */
export function earthMask(): readonly MaskLevel[] {
  if (pyramid) return pyramid;
  const bits = decodeMask(EARTH_MASK_RUNS, EARTH_MASK_WIDTH, EARTH_MASK_HEIGHT);
  const levels: MaskLevel[] = [
    { width: EARTH_MASK_WIDTH, height: EARTH_MASK_HEIGHT, data: Float32Array.from(bits) },
  ];
  while (levels.length < 6) levels.push(halve(levels[levels.length - 1]!));
  pyramid = levels;
  return levels;
}

/** The pyramid level whose texel size matches a texture `width` texels wide. */
export function maskLevelFor(width: number): number {
  const levels = earthMask();
  const k = Math.round(Math.log2(EARTH_MASK_WIDTH / Math.max(1, width)));
  return Math.max(0, Math.min(levels.length - 1, k));
}

/**
 * The land fraction at `latDeg` (−90..90, north positive), `lonDeg` (−180..180, east positive),
 * bilinear between texel centres (wrapping in longitude, clamped at the poles), from pyramid
 * level `level`.
 */
export function sampleLand(latDeg: number, lonDeg: number, level = 0): number {
  const m = earthMask()[level]!;
  const { width, height, data } = m;
  const x = ((lonDeg + 180) / 360) * width - 0.5;
  const y = Math.min(height - 1, Math.max(0, ((90 - latDeg) / 180) * height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i0 = ((x0 % width) + width) % width;
  const i1 = (i0 + 1) % width;
  const j1 = Math.min(height - 1, y0 + 1);
  const r0 = y0 * width;
  const r1 = j1 * width;
  const top = data[r0 + i0]! + (data[r0 + i1]! - data[r0 + i0]!) * fx;
  const bottom = data[r1 + i0]! + (data[r1 + i1]! - data[r1 + i0]!) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Geographic coordinates of a texel of an equirectangular body texture as three's `SphereGeometry`
 * reads it (P3-09): u = 0 at 180°W growing eastward (so the prime meridian, u = 0.5, faces the
 * sphere's local +X and the map is not mirrored), v = 0 at the south pole (row 0 of a
 * `DataTexture`).
 */
export function uvToLatLon(u: number, v: number): { lat: number; lon: number } {
  return { lat: v * 180 - 90, lon: u * 360 - 180 };
}
