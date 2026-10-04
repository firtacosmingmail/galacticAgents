import { fbm, hash3, hexToRgb } from '../../bodies/surface.js';

/**
 * Per-body surface features (P6-02): what makes each planet and moon recognisably itself, painted
 * by the procedural surface painter (`bodies/surface.ts`) on top of its style at every texture
 * size — so the system view's Jupiter has its Great Red Spot too, and the detail view's bigger map
 * only adds resolution and relief (no feature pops in when it arrives). Pure data and arithmetic,
 * no three.js: it runs in the paint worker and in jsdom.
 *
 * - `bands`: a gas or ice giant's latitude bands — how many and how strong (Jupiter's bold,
 *   Saturn's pale and broad, Uranus's barely there);
 * - `storms`: ovals that swirl the bands around them and tint their inside (Jupiter's Great Red
 *   Spot, Neptune's Great Dark Spot);
 * - `maria`: dark (or bright) low-frequency plains, smooth and flat (the Moon's seas, Mars's dark
 *   regions, Iapetus's dark hemisphere);
 * - `craters`: bowls with raised rims, from cells on the sphere in up to three sizes (Mercury, the
 *   Moon, most moons); only sizes that span a couple of texels at the texture's width are painted;
 * - `lineae`: thin ridged cracks (Europa, Enceladus's stripes, Miranda, Triton);
 * - `chevrons`: Venus's V-shaped cloud deck.
 */
export interface Storm {
  /** Centre, degrees (longitude −180…180, as the Earth mask's). */
  lat: number;
  lon: number;
  /** Half-axes, degrees. */
  radiusLat: number;
  radiusLon: number;
  /** sRGB colour of the oval's core. */
  color: string;
  /** How far the bands are turned around it at its edge, radians. */
  swirl: number;
}

export interface SurfaceFeatures {
  bands?: { frequency: number; contrast: number };
  storms?: readonly Storm[];
  maria?: { color: string; coverage: number; scale: number };
  craters?: { density: number; depth: number; sizes: number };
  lineae?: { color: string; scale: number; width: number };
  chevrons?: number;
}

const DEG = Math.PI / 180;

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The band frequency and contrast of a giant (defaults: the P3-02 painter's). */
export function bandsOf(
  features: SurfaceFeatures | undefined,
  fallbackFrequency: number,
): { frequency: number; contrast: number } {
  return features?.bands ?? { frequency: fallbackFrequency, contrast: 1 };
}

/** Where a texel sits relative to a storm: normalised elliptic distance and offsets in degrees. */
function stormOffset(storm: Storm, latDeg: number, lonDeg: number) {
  let dLon = lonDeg - storm.lon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  const dLat = latDeg - storm.lat;
  const d = Math.sqrt((dLat / storm.radiusLat) ** 2 + (dLon / storm.radiusLon) ** 2);
  return { d, dLat, dLon };
}

/** A storm's reach (in its own radii) over which it swirls the bands. */
export const STORM_REACH = 2;

/**
 * The latitude (radians) a giant's bands are sampled at: the texel's own, turned about each storm
 * within `STORM_REACH` of it (most where it is closest), so the bands wrap round the oval.
 */
export function bandLatitude(
  features: SurfaceFeatures | undefined,
  lat: number,
  lon: number,
): number {
  const storms = features?.storms;
  if (!storms) return lat;
  const latDeg = lat / DEG;
  const lonDeg = lon / DEG - 180;
  let out = latDeg;
  for (const s of storms) {
    const { d, dLat, dLon } = stormOffset(s, latDeg, lonDeg);
    if (d >= STORM_REACH) continue;
    const a = s.swirl * smooth(1 - d / STORM_REACH);
    // Turn the offset (in units of the oval's axes, so the swirl follows its shape).
    const x = dLon / s.radiusLon;
    const y = dLat / s.radiusLat;
    const ry = x * Math.sin(a) + y * Math.cos(a);
    out = s.lat + ry * s.radiusLat;
  }
  return out * DEG;
}

/** A texel being painted: its sRGB colour (mutable) and relief (0..1). */
export interface FeatureTexel {
  rgb: number[];
  relief: number;
}

/** Where on the sphere, and at which texture width (for the crater sizes). */
export interface FeatureSample {
  lat: number;
  lon: number;
  sx: number;
  sy: number;
  sz: number;
  seed: number;
  width: number;
}

/** Crater cell scales (cells per unit of sphere radius), large to small. */
export const CRATER_SCALES = [5, 12, 28] as const;
/** The largest crater radius, in cells (≤ 0.5 / 1.3 so a rim never leaves the 2³ cells searched). */
const CRATER_MAX = 0.38;

/**
 * The crater sizes worth painting at a texture width: those whose typical radius spans at least
 * ~1.5 texels (smaller ones would only add speckle and cost time), at most `sizes`.
 */
export function craterScales(width: number, sizes: number): number[] {
  const texel = (Math.PI * 2) / width;
  return CRATER_SCALES.slice(0, sizes).filter((s) => 0.25 / s / texel >= 1.5);
}

/**
 * Adds the crater relief and tint at point `p` (unit sphere): cells of `scale` per radius, each
 * holding one crater with probability `density`. Returns [relief delta, brightness factor].
 */
function craterAt(
  sx: number,
  sy: number,
  sz: number,
  scale: number,
  density: number,
  seed: number,
  out: [number, number],
): void {
  const px = sx * scale;
  const py = sy * scale;
  const pz = sz * scale;
  const bx = Math.floor(px - 0.5);
  const by = Math.floor(py - 0.5);
  const bz = Math.floor(pz - 0.5);
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) {
        const cx = bx + dx;
        const cy = by + dy;
        const cz = bz + dz;
        if (hash3(cx, cy, cz, seed) >= density) continue;
        const ox = cx + hash3(cx, cy, cz, seed + 1);
        const oy = cy + hash3(cx, cy, cz, seed + 2);
        const oz = cz + hash3(cx, cy, cz, seed + 3);
        const u = hash3(cx, cy, cz, seed + 4);
        // Many small, few large.
        const r = CRATER_MAX * (0.35 + 0.65 * u * u);
        const dist = Math.sqrt((px - ox) ** 2 + (py - oy) ** 2 + (pz - oz) ** 2);
        const d = dist / r;
        if (d >= 1.3) continue;
        if (d < 1) {
          // The bowl: floor below the plain, rising to the rim.
          out[0] += (d * d - 0.7) * 0.5;
          out[1] *= 0.86 + 0.14 * d;
        } else {
          const t = (1.3 - d) / 0.3;
          out[0] += 0.15 * t * t; // the rim
          out[1] *= 1 + 0.08 * t;
        }
      }
}

const scratch: [number, number] = [0, 0];
const featureRgb = new Map<string, [number, number, number]>();

function rgbOf(hex: string): [number, number, number] {
  let c = featureRgb.get(hex);
  if (!c) featureRgb.set(hex, (c = hexToRgb(hex)));
  return c;
}

function mix(rgb: number[], to: readonly number[], t: number): void {
  rgb[0] = rgb[0]! + (to[0]! - rgb[0]!) * t;
  rgb[1] = rgb[1]! + (to[1]! - rgb[1]!) * t;
  rgb[2] = rgb[2]! + (to[2]! - rgb[2]!) * t;
}

/**
 * Paints a body's features onto one texel (after its style, before the polar caps): storms' cores,
 * maria, craters (fewer on the maria), lineae, Venus's chevrons. Deterministic in the seed.
 */
export function applyFeatures(
  features: SurfaceFeatures | undefined,
  at: FeatureSample,
  texel: FeatureTexel,
): void {
  if (!features) return;
  const { sx, sy, sz, seed } = at;
  const rgb = texel.rgb;

  if (features.storms) {
    const latDeg = at.lat / DEG;
    const lonDeg = at.lon / DEG - 180;
    for (const s of features.storms) {
      const { d } = stormOffset(s, latDeg, lonDeg);
      if (d >= 1) continue;
      const swirlNoise = fbm(sx * 30, sy * 30, sz * 30, seed + 211, 3);
      const core = smooth(clamp01((1 - d) / 0.45)) * (0.75 + 0.5 * (swirlNoise - 0.5));
      mix(rgb, rgbOf(s.color), clamp01(core));
      // A pale collar round the oval.
      const collar = Math.exp(-(((d - 0.92) / 0.08) ** 2)) * 0.25;
      mix(rgb, [245, 232, 210], collar);
    }
  }

  if (features.chevrons) {
    // Venus: streaks that bend away from the equator, V shapes opening westward.
    const turb = fbm(sx * 4, sy * 4, sz * 4, seed + 307, 3) - 0.5;
    const v = Math.sin(at.lon * 3 + Math.abs(sy) * 7 + turb * 5) * 0.5 + 0.5;
    const k = features.chevrons * (0.6 + 0.4 * Math.cos(at.lat));
    const shade = 1 + (v - 0.5) * 0.35 * k;
    rgb[0] = rgb[0]! * shade;
    rgb[1] = rgb[1]! * shade;
    rgb[2] = rgb[2]! * shade;
  }

  let maria = 0;
  if (features.maria) {
    const m = features.maria;
    const n = fbm(sx * m.scale, sy * m.scale, sz * m.scale, seed + 401, 4);
    const threshold = 1 - m.coverage;
    // fbm clusters about 0.5: stretch it before thresholding.
    const t = clamp01((n - 0.5) * 2.4 + 0.5);
    maria = smooth(clamp01((t - threshold) / 0.12 + 0.5));
    if (maria > 0) {
      const fine = fbm(sx * 18, sy * 18, sz * 18, seed + 409, 3);
      const c = rgbOf(m.color);
      const k = 0.85 + 0.3 * fine;
      mix(rgb, [c[0] * k, c[1] * k, c[2] * k], maria * 0.9);
      texel.relief = texel.relief + (0.3 + texel.relief * 0.25 - texel.relief) * maria;
    }
  }

  if (features.craters) {
    const c = features.craters;
    scratch[0] = 0;
    scratch[1] = 1;
    const scales = craterScales(at.width, c.sizes);
    for (let i = 0; i < scales.length; i++) {
      craterAt(sx, sy, sz, scales[i]!, c.density, seed + 503 + i * 17, scratch);
    }
    if (scratch[0] !== 0 || scratch[1] !== 1) {
      const fewer = 1 - maria * 0.7;
      texel.relief += scratch[0] * c.depth * fewer;
      const b = 1 + (scratch[1] - 1) * fewer;
      rgb[0] = rgb[0]! * b;
      rgb[1] = rgb[1]! * b;
      rgb[2] = rgb[2]! * b;
    }
  }

  if (features.lineae) {
    const l = features.lineae;
    const ridge = (n: number) => 1 - Math.abs(n * 2 - 1);
    const a = ridge(fbm(sx * l.scale, sy * l.scale, sz * l.scale, seed + 601, 4));
    const b = ridge(fbm(sx * l.scale * 2.3, sy * l.scale * 2.3, sz * l.scale * 2.3, seed + 613, 3));
    const edge = 1 - l.width;
    const line = Math.max(
      smooth(clamp01((a - edge) / l.width)),
      smooth(clamp01((b - edge) / l.width)) * 0.6,
    );
    if (line > 0) {
      mix(rgb, rgbOf(l.color), line * 0.8);
      texel.relief += line * 0.08;
    }
  }

  // Brightening (chevrons, rims, collars) may pass 255: a Uint8Array would wrap it, not clamp.
  for (let c = 0; c < 3; c++) rgb[c] = Math.min(255, Math.max(0, rgb[c]!));
}

/** A stable text form of a body's features, for texture cache keys. */
export function featuresKey(features: SurfaceFeatures | undefined): string {
  return features ? JSON.stringify(features) : '';
}
