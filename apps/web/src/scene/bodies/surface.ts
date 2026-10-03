import type { BodyLook, RingLook } from './appearance.js';

/**
 * Procedural surfaces (P3-02): equirectangular RGBA pixels painted from a body's look, as plain
 * data (no canvas, no three.js) so it is testable in jsdom; `textures.ts` wraps the result in a
 * `DataTexture`. Noise is sampled on the unit sphere (3D value noise), so the map wraps seamlessly
 * at the date line and does not pinch at the poles. Seeded: a body looks the same on every load.
 */

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A small integer hash → [0, 1). */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 3D value noise in [0, 1). */
export function valueNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

/** Fractal noise (octaves of value noise), in [0, 1). */
export function fbm(x: number, y: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, z * freq, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Samples a palette (sRGB bytes) at t ∈ [0, 1], linearly between stops. */
function samplePalette(palette: readonly [number, number, number][], t: number): number[] {
  const x = Math.min(1, Math.max(0, t)) * (palette.length - 1);
  const i = Math.min(palette.length - 2, Math.floor(x));
  const f = x - i;
  const a = palette[i] ?? palette[0]!;
  const b = palette[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Stretches noise (which clusters around 0.5) to fill [0, 1]. */
function contrast(n: number, k = 2.2): number {
  return Math.min(1, Math.max(0, (n - 0.5) * k + 0.5));
}

/**
 * Paints a body's surface: `width` × `height` RGBA bytes, equirectangular (u = longitude,
 * v = latitude): row 0 is the south pole, as three's `SphereGeometry` (v = 0 at the bottom) reads a
 * `DataTexture` (no flip).
 */
export function paintSurface(look: BodyLook, width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  const palette = look.palette.map(hexToRgb);
  const seed = look.seed * 7919;
  for (let j = 0; j < height; j++) {
    const lat = ((j + 0.5) / height) * Math.PI - Math.PI / 2;
    const cosLat = Math.cos(lat);
    const sy = Math.sin(lat);
    for (let i = 0; i < width; i++) {
      const lon = ((i + 0.5) / width) * Math.PI * 2;
      const sx = cosLat * Math.cos(lon);
      const sz = cosLat * Math.sin(lon);
      let rgb: number[];
      switch (look.style) {
        case 'gas': {
          // Latitude bands, wobbled by noise; a few strong stripes and fine streaks.
          const turb = fbm(sx * 3, sy * 3, sz * 3, seed) - 0.5;
          const band = Math.sin((sy + turb * 0.12) * 18) * 0.5 + 0.5;
          const fine = fbm(sx * 1.5, sy * 24, sz * 1.5, seed + 77, 3);
          rgb = samplePalette(palette, band * 0.75 + fine * 0.25);
          break;
        }
        case 'ice': {
          const turb = fbm(sx * 2, sy * 2, sz * 2, seed) - 0.5;
          const band = Math.sin((sy + turb * 0.08) * 9) * 0.5 + 0.5;
          rgb = samplePalette(palette, 0.35 + band * 0.4 + turb * 0.3);
          break;
        }
        case 'cloudy': {
          const n = fbm(sx * 2.5 + sy, sy * 4, sz * 2.5, seed, 5);
          rgb = samplePalette(palette, contrast(n, 1.8));
          break;
        }
        case 'earth': {
          // palette: deep ocean, shallow ocean, land, dry land.
          const n = fbm(sx * 2.2, sy * 2.2, sz * 2.2, seed, 5);
          const [deep, shallow, land, dry] = [palette[0]!, palette[1]!, palette[2]!, palette[3]!];
          if (n < 0.5) {
            const t = Math.max(0, (n - 0.35) / 0.15);
            rgb = samplePalette([deep, shallow], t);
          } else {
            const d = fbm(sx * 5, sy * 5, sz * 5, seed + 5, 3);
            rgb = samplePalette([land, dry], contrast(d, 2.5));
          }
          break;
        }
        case 'rocky':
        default: {
          const n = fbm(sx * 3, sy * 3, sz * 3, seed, 5);
          const speck = valueNoise(sx * 40, sy * 40, sz * 40, seed + 31);
          rgb = samplePalette(palette, contrast(n) * 0.85 + speck * 0.15);
          break;
        }
      }
      if (look.polarCaps) {
        // Caps above ≈ 75° latitude, with a ragged edge blended over a few degrees.
        const edge = 0.965 + (fbm(sx * 8, sy * 8, sz * 8, seed + 9, 3) - 0.5) * 0.04;
        const ice = Math.min(1, Math.max(0, (Math.abs(sy) - edge) / 0.012 + 0.5));
        if (ice > 0) rgb = rgb.map((c, n) => c + ([236, 241, 246][n]! - c) * ice);
      }
      const k = (j * width + i) * 4;
      data[k] = rgb[0]!;
      data[k + 1] = rgb[1]!;
      data[k + 2] = rgb[2]!;
      data[k + 3] = 255;
    }
  }
  return data;
}

/**
 * Paints a ring system's radial profile: `width` RGBA texels from the inner edge (0) to the outer
 * (width - 1), with ringlets and gaps from 1D noise (Saturn gets a Cassini-like gap at ≈ 60 %).
 */
export function paintRings(rings: RingLook, width: number): Uint8Array {
  const data = new Uint8Array(width * 4);
  const palette = rings.palette.map(hexToRgb);
  const seed = rings.seed * 104729;
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    const n = fbm(t * 24, 0.5, 0.5, seed, 4);
    const edge = Math.min(1, t / 0.06, (1 - t) / 0.04);
    const gap = palette.length > 2 && t > 0.57 && t < 0.63 ? 0.08 : 1;
    const alpha = rings.opacity * edge * gap * (0.35 + 0.65 * contrast(n, 2.4));
    const rgb = samplePalette(palette, t * 0.7 + n * 0.3);
    const k = i * 4;
    data[k] = rgb[0]!;
    data[k + 1] = rgb[1]!;
    data[k + 2] = rgb[2]!;
    data[k + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  }
  return data;
}

/** Texture sizes (power of two, so mipmaps work): planets get more texels than moons. */
export const PLANET_TEXTURE = { width: 256, height: 128 } as const;
export const MOON_TEXTURE = { width: 128, height: 64 } as const;
export const RING_TEXTURE_WIDTH = 256;
