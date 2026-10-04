import type { BodyLook, RingLook } from './appearance.js';
import { maskLevelFor, sampleLand } from './earth-mask.js';
import {
  applyFeatures,
  bandLatitude,
  bandsOf,
  type FeatureTexel,
} from '../detail/visuals/features.js';
import { paintRingProfile } from '../detail/visuals/rings.js';

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
export function hash3(x: number, y: number, z: number, seed: number): number {
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

/** Whether a surface has relief worth a bump map (P3-06): rocky bodies and Earth-like ones. */
export function hasRelief(look: BodyLook): boolean {
  return look.style === 'rocky' || look.style === 'earth';
}

/**
 * Extra noise octaves for a texture wider than the 256-texel base (one per doubling, at most
 * two): a near-level texture gains fine relief instead of just smoother blur. The added octaves
 * are faint (1/32 and 1/64 of the first), so a level switch does not shift the pattern.
 */
export function extraOctaves(width: number): number {
  return Math.max(0, Math.min(2, Math.floor(Math.log2(width / 256))));
}

/** Earth's colours (sRGB) for the masked surface (P3-09). */
const EARTH = {
  deep: [11, 34, 78],
  ocean: [20, 56, 112],
  shallow: [38, 104, 156],
  rainforest: [36, 78, 30],
  forest: [54, 96, 40],
  grass: [104, 128, 58],
  savanna: [128, 128, 70],
  boreal: [38, 70, 40],
  tundra: [100, 102, 76],
  sand: [214, 184, 128],
  rock: [170, 140, 100],
  ice: [238, 243, 248],
} satisfies Record<string, [number, number, number]>;

/** Land colour by |latitude| in degrees (equator → poles), before deserts and ice. */
const LATITUDE_BIOMES: readonly [number, readonly [number, number, number]][] = [
  [0, EARTH.rainforest],
  [10, EARTH.rainforest],
  [18, EARTH.savanna],
  [26, EARTH.grass],
  [40, EARTH.forest],
  [52, EARTH.boreal],
  [62, EARTH.boreal],
  [70, EARTH.tundra],
  [90, EARTH.tundra],
];

/**
 * The great dry regions, as soft ellipses: [lat, lon, lat radius, lon radius, strength] in
 * degrees. Deserts sit in the subtropical bands, but not all along them (Florida, southern China
 * and Brazil are green): a pure latitude rule would paint them sand.
 */
const ARID: readonly (readonly [number, number, number, number, number])[] = [
  [22, 10, 10, 32, 1], // Sahara
  [23, 47, 9, 12, 1], // Arabia
  [30, 60, 6, 11, 0.85], // Iran, Afghanistan, Pakistan
  [26, 71, 4, 4, 0.7], // Thar
  [42, 61, 5, 9, 0.75], // Karakum, Kyzylkum
  [41, 94, 5, 17, 0.85], // Taklamakan, Gobi
  [-25, 132, 10, 16, 0.95], // Australian outback
  [-24, 19, 6, 6, 0.75], // Kalahari, Namib
  [-21, -70, 9, 3, 0.8], // Atacama
  [-44, -68, 6, 4, 0.55], // Patagonia
  [32, -112, 7, 8, 0.8], // North American deserts
  [7, 46, 5, 5, 0.6], // Horn of Africa
];

/**
 * How dry the land is at a place, 0..1: the strongest of the arid regions, each fading out over its
 * outer part, its edge pushed in and out by noise (`warp()`, about ±0.5, asked for only near a
 * region) so no region reads as an ellipse.
 */
function aridity(latDeg: number, lonDeg: number, warp: () => number): number {
  let a = 0;
  let w: number | undefined;
  for (const [la, lo, rl, rn, k] of ARID) {
    let dl = Math.abs(lonDeg - lo);
    if (dl > 180) dl = 360 - dl;
    const r = Math.sqrt(((latDeg - la) / rl) ** 2 + (dl / rn) ** 2);
    if (r > 1.6) continue;
    w ??= warp();
    const d = r + w;
    if (d < 1) a = Math.max(a, k * smooth(Math.min(1, (1 - d) / 0.45)));
  }
  return a;
}

/** A colour being mixed (sRGB bytes as floats); scratch space, so a texel allocates nothing. */
type Rgb = [number, number, number];

/** `out` ← `a` + (`b` − `a`) · `t` (`out` may be `a` or `b`). */
function mixInto(out: Rgb, a: readonly number[], b: readonly number[], t: number): Rgb {
  out[0] = a[0]! + (b[0]! - a[0]!) * t;
  out[1] = a[1]! + (b[1]! - a[1]!) * t;
  out[2] = a[2]! + (b[2]! - a[2]!) * t;
  return out;
}

function biomeInto(out: Rgb, absLat: number): Rgb {
  for (let k = 1; k < LATITUDE_BIOMES.length; k++) {
    const [l1, c1] = LATITUDE_BIOMES[k]!;
    if (absLat <= l1) {
      const [l0, c0] = LATITUDE_BIOMES[k - 1]!;
      return mixInto(out, c0, c1, (absLat - l0) / (l1 - l0));
    }
  }
  return mixInto(out, EARTH.tundra, EARTH.tundra, 0);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** One texel of Earth's surface, as `earthTexel` leaves it. */
interface EarthTexel {
  rgb: Rgb;
  relief: number;
  rough: number;
}

const ground: Rgb = [0, 0, 0];
const desert: Rgb = [0, 0, 0];

/**
 * One texel of Earth's masked surface (P3-09), written into `out`: land or sea from the real mask
 * (bilinear, at the pyramid level matching the texture's size, with a noisy threshold so coasts
 * are not pixel stairs), latitude biomes and the great deserts on land, ice on Antarctica,
 * Greenland and the high Arctic, shallow seas along the coasts, the seeded noise on top for
 * texture. `lat` and `lon` are the painter's radians (lon 0..2π from u = 0, i.e. from 180°W).
 */
function earthTexel(
  out: EarthTexel,
  lat: number,
  lon: number,
  sx: number,
  sy: number,
  sz: number,
  seed: number,
  extra: number,
  maskLevel: number,
): void {
  const latDeg = (lat * 180) / Math.PI;
  const lonDeg = (lon * 180) / Math.PI - 180;
  const land = sampleLand(latDeg, lonDeg, maskLevel);
  // Land fraction → land weight `a`, through a threshold wobbled by noise along the coasts only
  // (open sea and inland texels skip the noise: they are 0 or 1 whatever the threshold).
  let a: number;
  if (land > 0.02 && land < 0.98) {
    const threshold = 0.5 + (fbm(sx * 22, sy * 22, sz * 22, seed + 3, 3 + extra) - 0.5) * 0.4;
    a = smooth(clamp01((land - threshold) / 0.24 + 0.5));
  } else a = land < 0.5 ? 0 : 1;

  // Sea: deep far out, shallow along the coasts (a coarse level of the mask).
  const n = fbm(sx * 2.2, sy * 2.2, sz * 2.2, seed, 5 + extra);
  const rgb = out.rgb;
  if (a < 1) {
    const near = sampleLand(latDeg, lonDeg, Math.max(maskLevel, 2));
    mixInto(rgb, EARTH.deep, EARTH.ocean, clamp01(near * 2.5 + (n - 0.5) * 0.6));
    mixInto(rgb, rgb, EARTH.shallow, clamp01(near * 2 - 0.1) * 0.55);
  }
  out.relief = 0.3;
  out.rough = OCEAN_ROUGHNESS;
  if (a <= 0) return;

  const d = fbm(sx * 5, sy * 5, sz * 5, seed + 5, 3 + extra);
  biomeInto(ground, Math.max(0, Math.abs(latDeg) + (d - 0.5) * 12 + (n - 0.5) * 8));
  const dry = aridity(latDeg, lonDeg, () => {
    const w = fbm(sx * 9, sy * 9, sz * 9, seed + 17, 3 + extra) - 0.5;
    return w * 1.6 + (d - 0.5) * 0.6;
  });
  if (dry > 0) {
    mixInto(desert, EARTH.sand, EARTH.rock, contrast(n, 2));
    mixInto(ground, ground, desert, dry);
  }
  // Texture: brighter and darker patches.
  const shade = 0.86 + d * 0.28;
  ground[0] *= shade;
  ground[1] *= shade;
  ground[2] *= shade;
  // Ice sheets: Antarctica, Greenland, the high Arctic islands.
  const iceEdge = latDeg < 0 ? -62 + (d - 0.5) * 6 : 72 + (d - 0.5) * 6;
  const polar = latDeg < 0 ? latDeg < iceEdge : latDeg > iceEdge;
  // Greenland: east of a line along Baffin Bay and the Davis Strait (Baffin Island stays brown).
  const greenland = latDeg > 59 && lonDeg < -10 && lonDeg > -48 - (latDeg - 60) * 1.3;
  const ice = polar ? 1 : greenland ? smooth(clamp01((latDeg - 59) / 2)) : 0;
  if (ice > 0) mixInto(ground, ground, EARTH.ice, ice);
  if (a >= 1) {
    rgb[0] = ground[0];
    rgb[1] = ground[1];
    rgb[2] = ground[2];
  } else mixInto(rgb, rgb, ground, a);
  const landRelief = clamp01((0.45 + (n - 0.5) * 1.1 + (d - 0.5) * 0.4) * (1 - ice * 0.5));
  out.relief = 0.3 + (landRelief - 0.3) * a;
  const landRough = MATTE_ROUGHNESS + (0.7 - MATTE_ROUGHNESS) * ice;
  out.rough =
    a >= 1 && ice === 0 ? MATTE_ROUGHNESS : OCEAN_ROUGHNESS + (landRough - OCEAN_ROUGHNESS) * a;
}

/** A painted surface: the colour map and, when asked for, the detail map. */
export interface SurfaceLayers {
  /** `width` × `height` RGBA bytes (sRGB). */
  color: Uint8Array;
  /**
   * `width` × `height` RG bytes (linear) or `null`: R = height (the bump map reads `.r`), G =
   * roughness (the roughness map reads `.g`; Earth's oceans are glossy, everything else matte).
   */
  detail: Uint8Array | null;
}

/** Roughness of a matte surface and of Earth's oceans, as painted into the detail map. */
export const MATTE_ROUGHNESS = 0.95;
export const OCEAN_ROUGHNESS = 0.4;

/**
 * Paints a body's surface: `width` × `height` RGBA bytes, equirectangular (u = longitude,
 * v = latitude): row 0 is the south pole, as three's `SphereGeometry` (v = 0 at the bottom) reads a
 * `DataTexture` (no flip).
 */
export function paintSurface(look: BodyLook, width: number, height: number): Uint8Array {
  return paintSurfaceLayers(look, width, height, false).color;
}

/**
 * Paints the colour map and, with `withDetail` (and a surface with relief, `hasRelief`), the
 * detail map from the same noise in the same pass (P3-06): the bumps sit exactly under the colours.
 * Pure data, so it runs in a worker (`paint-worker.ts`) and in jsdom alike. P6-02: the body's
 * `features` are painted on top of its style (`detail/visuals/features.ts`), and `heights`, when
 * given (`width` × `height` floats), receives the unquantised relief the detail level derives its
 * normal map from.
 */
export function paintSurfaceLayers(
  look: BodyLook,
  width: number,
  height: number,
  withDetail: boolean,
  heights?: Float32Array,
): SurfaceLayers {
  const data = new Uint8Array(width * height * 4);
  const detail = withDetail && hasRelief(look) ? new Uint8Array(width * height * 2) : null;
  const palette = look.palette.map(hexToRgb);
  const seed = look.seed * 7919;
  const extra = extraOctaves(width);
  const matte = Math.round(MATTE_ROUGHNESS * 255);
  const maskLevel = look.landMask === 'earth' ? maskLevelFor(width) : 0;
  const texel: EarthTexel = { rgb: [0, 0, 0], relief: 0, rough: 0 };
  const features = look.features;
  const feature: FeatureTexel = { rgb: [0, 0, 0], relief: 0 };
  const at = { lat: 0, lon: 0, sx: 0, sy: 0, sz: 0, seed, width };
  for (let j = 0; j < height; j++) {
    const lat = ((j + 0.5) / height) * Math.PI - Math.PI / 2;
    const cosLat = Math.cos(lat);
    const sy = Math.sin(lat);
    for (let i = 0; i < width; i++) {
      const lon = ((i + 0.5) / width) * Math.PI * 2;
      const sx = cosLat * Math.cos(lon);
      const sz = cosLat * Math.sin(lon);
      let rgb: number[];
      // Relief (0..1) and roughness (0..1) for the detail map; only rocky and Earth set relief.
      let relief = 0.5;
      let rough = MATTE_ROUGHNESS;
      switch (look.style) {
        case 'gas': {
          // Latitude bands, wobbled by noise; a few strong stripes and fine streaks.
          // P6-02: per-planet band frequency and contrast, bands swirled round storms.
          const bands = bandsOf(features, 18);
          const by = features?.storms ? Math.sin(bandLatitude(features, lat, lon)) : sy;
          const turb = fbm(sx * 3, sy * 3, sz * 3, seed) - 0.5;
          const band = Math.sin((by + turb * 0.12) * bands.frequency) * 0.5 + 0.5;
          const fine = fbm(sx * 1.5, by * 24, sz * 1.5, seed + 77, 3);
          rgb = samplePalette(palette, 0.5 + (band * 0.75 + fine * 0.25 - 0.5) * bands.contrast);
          break;
        }
        case 'ice': {
          const bands = bandsOf(features, 9);
          const by = features?.storms ? Math.sin(bandLatitude(features, lat, lon)) : sy;
          const turb = fbm(sx * 2, sy * 2, sz * 2, seed) - 0.5;
          const band = Math.sin((by + turb * 0.08) * bands.frequency) * 0.5 + 0.5;
          rgb = samplePalette(palette, 0.35 + band * 0.4 * bands.contrast + turb * 0.3);
          break;
        }
        case 'cloudy': {
          const n = fbm(sx * 2.5 + sy, sy * 4, sz * 2.5, seed, 5);
          rgb = samplePalette(palette, contrast(n, 1.8));
          break;
        }
        case 'earth': {
          if (look.landMask === 'earth') {
            earthTexel(texel, lat, lon, sx, sy, sz, seed, extra, maskLevel);
            rgb = texel.rgb;
            relief = texel.relief;
            rough = texel.rough;
            break;
          }
          // Noise continents (an Earth-like body without a mask).
          // palette: deep ocean, shallow ocean, land, dry land.
          const n = fbm(sx * 2.2, sy * 2.2, sz * 2.2, seed, 5 + extra);
          const [deep, shallow, land, dry] = [palette[0]!, palette[1]!, palette[2]!, palette[3]!];
          if (n < 0.5) {
            const t = Math.max(0, (n - 0.35) / 0.15);
            rgb = samplePalette([deep, shallow], t);
            // The sea is flat and glossy.
            relief = 0.3;
            rough = OCEAN_ROUGHNESS;
          } else {
            const d = fbm(sx * 5, sy * 5, sz * 5, seed + 5, 3 + extra);
            rgb = samplePalette([land, dry], contrast(d, 2.5));
            relief = 0.3 + (n - 0.5) * 1.4 + (d - 0.5) * 0.3;
          }
          break;
        }
        case 'rocky':
        default: {
          const n = fbm(sx * 3, sy * 3, sz * 3, seed, 5 + extra);
          const speck = valueNoise(sx * 40, sy * 40, sz * 40, seed + 31);
          const t = contrast(n) * 0.85 + speck * 0.15;
          rgb = samplePalette(palette, t);
          relief = t;
          break;
        }
      }
      if (features) {
        feature.rgb = rgb;
        feature.relief = relief;
        at.lat = lat;
        at.lon = lon;
        at.sx = sx;
        at.sy = sy;
        at.sz = sz;
        applyFeatures(features, at, feature);
        rgb = feature.rgb;
        relief = feature.relief;
      }
      if (look.polarCaps) {
        // Caps above ≈ 75° latitude, with a ragged edge blended over a few degrees.
        const edge = 0.965 + (fbm(sx * 8, sy * 8, sz * 8, seed + 9, 3) - 0.5) * 0.04;
        const ice = Math.min(1, Math.max(0, (Math.abs(sy) - edge) / 0.012 + 0.5));
        if (ice > 0) {
          rgb = rgb.map((c, n) => c + ([236, 241, 246][n]! - c) * ice);
          rough = rough + (0.7 - rough) * ice;
        }
      }
      const k = (j * width + i) * 4;
      data[k] = rgb[0]!;
      data[k + 1] = rgb[1]!;
      data[k + 2] = rgb[2]!;
      data[k + 3] = 255;
      if (heights) heights[j * width + i] = relief;
      if (detail) {
        const d = (j * width + i) * 2;
        detail[d] = Math.round(Math.min(1, Math.max(0, relief)) * 255);
        detail[d + 1] = rough === MATTE_ROUGHNESS ? matte : Math.round(rough * 255);
      }
    }
  }
  return { color: data, detail };
}

/**
 * Paints a ring system's radial profile: `width` RGBA texels from the inner edge (0) to the outer
 * (width - 1), with ringlets and gaps from 1D noise (Saturn gets a Cassini-like gap at ≈ 60 %).
 */
export function paintRings(rings: RingLook, width: number): Uint8Array {
  // P6-02: a ring system with a measured profile (Saturn's C/B/A rings and Cassini division,
  // Uranus's narrow ringlets) is painted from it.
  if (rings.bands) return paintRingProfile(rings, width);
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

/**
 * The rings' radial texture width. Body texture sizes are per LOD level in the tier table
 * (`quality.ts`, powers of two so mipmaps work; planets get more texels than moons).
 */
export const RING_TEXTURE_WIDTH = 256;
