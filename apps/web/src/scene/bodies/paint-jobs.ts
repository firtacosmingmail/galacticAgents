import type { BodyLook } from './appearance.js';
import { extraOctaves, fbm, paintSurfaceLayers, type SurfaceLayers } from './surface.js';

/**
 * The paint jobs the worker runs (P3-06's surface maps, P6-02's detail level and clouds), as pure
 * functions of plain data: `runPaintJob` is what the worker (`bodies/paint-worker.ts`), the
 * main-thread fallback (`bodies/painter.ts`) and the tests' fake worker all call.
 */
export interface SurfacePaintRequest {
  kind?: 'surface';
  look: BodyLook;
  width: number;
  height: number;
  detail: boolean;
}

/** P6-02: the detail level of a body shown in detail. */
export interface DetailPaintRequest {
  kind: 'detail';
  look: BodyLook;
  width: number;
  height: number;
  normal: boolean;
  roughness: boolean;
  normalStrength: number;
  /** Box blur radius of the relief before the normals, texels. */
  reliefBlur?: number;
}

/** Earth's cloud look (P6-02; part of its detail look, `detail/visuals/looks.ts`). */
export interface CloudLook {
  /** Seed of the cloud pattern. */
  seed: number;
  /** Fraction of the sky covered, 0..1. */
  coverage: number;
  /** Opacity of a fully cloudy texel. */
  opacity: number;
  /** Extra turns of the clouds per turn of the surface (they drift slowly eastward). */
  drift: number;
  /** Height of the cloud shell above the surface, body radii. */
  altitude: number;
}

/** P6-02: Earth's clouds. */
export interface CloudPaintRequest {
  kind: 'clouds';
  clouds: CloudLook;
  width: number;
  height: number;
}

export type PaintRequest = SurfacePaintRequest | DetailPaintRequest | CloudPaintRequest;

/**
 * What a job paints: `color` (RGBA sRGB; for clouds RG coverage), `detail` (RG: height and
 * roughness — for a detail job only when it asked for roughness) and `normal` (RGBA tangent-space
 * normal map, detail jobs with `normal`).
 */
export interface PaintLayers extends SurfaceLayers {
  normal?: Uint8Array | null;
}

export function runPaintJob(job: PaintRequest): PaintLayers {
  switch (job.kind) {
    case 'detail':
      return paintDetailLevel(job);
    case 'clouds':
      return { color: paintClouds(job.clouds, job.width, job.height), detail: null };
    default:
      return paintSurfaceLayers(job.look, job.width, job.height, job.detail);
  }
}

/** The buffers of a job's result, to transfer back from the worker without a copy. */
export function transferablesOf(layers: PaintLayers): Transferable[] {
  const out: Transferable[] = [layers.color.buffer];
  if (layers.detail) out.push(layers.detail.buffer);
  if (layers.normal) out.push(layers.normal.buffer);
  return out;
}

/**
 * The detail level: the colour map at the detail size and, for relief surfaces, a normal map
 * derived from the same (unquantised) relief — Earth's relief is flat at sea, so its normals tilt
 * on land only — and Earth's roughness from the detail map's G channel.
 */
export function paintDetailLevel(job: DetailPaintRequest): PaintLayers {
  const heights = job.normal ? new Float32Array(job.width * job.height) : undefined;
  const layers = paintSurfaceLayers(job.look, job.width, job.height, job.roughness, heights);
  return {
    color: layers.color,
    detail: job.roughness ? layers.detail : null,
    normal: heights
      ? normalMapFromHeights(
          blurHeights(heights, job.width, job.height, job.reliefBlur ?? 0),
          job.width,
          job.height,
          job.normalStrength,
        )
      : null,
  };
}

/**
 * A tangent-space normal map (RGBA bytes, `n × 0.5 + 0.5`) from an equirectangular height field
 * (row 0 at the south pole, as the surface painter lays it out): central differences per radian of
 * arc — east-west spacing shrinks with cos(latitude), wrapping at the date line; north-south clamped
 * at the poles — times `strength`. +x is east (u), +y north (v): three's per-pixel tangent frame
 * (no tangent attribute) follows the uv derivatives, so no flip is needed.
 */
export function normalMapFromHeights(
  heights: Float32Array,
  width: number,
  height: number,
  strength: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const dLon = (Math.PI * 2) / width;
  const dLat = Math.PI / height;
  for (let j = 0; j < height; j++) {
    const lat = ((j + 0.5) / height) * Math.PI - Math.PI / 2;
    const ex = 2 * dLon * Math.max(0.02, Math.cos(lat));
    const up = Math.min(height - 1, j + 1);
    const down = Math.max(0, j - 1);
    const ey = (up - down) * dLat;
    for (let i = 0; i < width; i++) {
      const east = heights[j * width + ((i + 1) % width)]!;
      const west = heights[j * width + ((i - 1 + width) % width)]!;
      const north = heights[up * width + i]!;
      const south = heights[down * width + i]!;
      const nx = (-(east - west) / ex) * strength;
      const ny = (-(north - south) / ey) * strength;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      const k = (j * width + i) * 4;
      out[k] = Math.round((nx / len) * 127.5 + 127.5);
      out[k + 1] = Math.round((ny / len) * 127.5 + 127.5);
      out[k + 2] = Math.round((1 / len) * 127.5 + 127.5);
      out[k + 3] = 255;
    }
  }
  return out;
}

/**
 * A separable box blur of a height field (radius `r` texels; wrapping east-west, clamped at the
 * poles), in place; returns it. Two passes of each direction, close to a Gaussian.
 */
export function blurHeights(
  heights: Float32Array,
  width: number,
  height: number,
  r: number,
): Float32Array {
  if (r < 1) return heights;
  const tmp = new Float32Array(Math.max(width, height));
  const n = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < height; j++) {
      const row = j * width;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += heights[row + ((k + width) % width)]!;
      for (let i = 0; i < width; i++) {
        tmp[i] = sum / n;
        sum += heights[row + ((i + r + 1) % width)]! - heights[row + ((i - r + width) % width)]!;
      }
      heights.set(tmp.subarray(0, width), row);
    }
    for (let i = 0; i < width; i++) {
      const at = (j: number) => heights[Math.max(0, Math.min(height - 1, j)) * width + i]!;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += at(k);
      for (let j = 0; j < height; j++) {
        tmp[j] = sum / n;
        sum += at(j + r + 1) - at(j - r);
      }
      for (let j = 0; j < height; j++) heights[j * width + i] = tmp[j]!;
    }
  }
  return heights;
}

function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * How much cloudier a latitude is than average (|lat| in degrees): the equatorial convergence zone
 * and the mid-latitude storm tracks cloudy, the subtropical highs and the poles clearer.
 */
export function cloudClimate(absLatDeg: number): number {
  const g = (centre: number, width: number) => Math.exp(-(((absLatDeg - centre) / width) ** 2));
  return 0.14 * g(0, 7) - 0.16 * g(24, 9) + 0.12 * g(55, 12) - 0.08 * g(88, 10);
}

/**
 * Earth's clouds: `width` × `height` RG bytes (coverage × opacity in both channels; the material
 * reads it as an alpha map), equirectangular like the surface. Domain-warped fractal noise
 * (swirls), stretched along the latitude circles, thresholded by the coverage and the latitude's
 * climate. Seeded: the same sky on every load.
 */
export function paintClouds(clouds: CloudLook, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 2);
  const seed = clouds.seed * 6151;
  const extra = extraOctaves(width);
  const threshold = 1 - clouds.coverage;
  for (let j = 0; j < height; j++) {
    const lat = ((j + 0.5) / height) * Math.PI - Math.PI / 2;
    const cosLat = Math.cos(lat);
    const sy = Math.sin(lat);
    const climate = cloudClimate(Math.abs((lat * 180) / Math.PI));
    for (let i = 0; i < width; i++) {
      const lon = ((i + 0.5) / width) * Math.PI * 2;
      const sx = cosLat * Math.cos(lon);
      const sz = cosLat * Math.sin(lon);
      const wx = fbm(sx * 1.7, sy * 1.7, sz * 1.7, seed + 1, 3) - 0.5;
      const wy = fbm(sx * 1.7, sy * 1.7, sz * 1.7, seed + 2, 3) - 0.5;
      const wz = fbm(sx * 1.7, sy * 1.7, sz * 1.7, seed + 3, 3) - 0.5;
      const qx = sx * 2.6 + wx * 1.4;
      const qy = sy * 4.2 + wy * 1.4;
      const qz = sz * 2.6 + wz * 1.4;
      const n = fbm(qx, qy, qz, seed + 11, 5 + extra);
      const v = (n - 0.5) * 2.4 + 0.5 + climate;
      const a = smooth((v - threshold) / 0.32 + 0.35) * clouds.opacity;
      const byte = Math.round(Math.max(0, Math.min(1, a)) * 255);
      const k = (j * width + i) * 2;
      out[k] = byte;
      out[k + 1] = byte;
    }
  }
  return out;
}
