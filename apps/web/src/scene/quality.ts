import type { QualityTier } from '@galactic/protocol';

/**
 * What a quality tier (SPEC decision 51, TECHNOLOGY §2.1) turns into for the renderer. One table,
 * so P3-06 (LOD and quality) extends it rather than scattering `tier === 'mobile'` checks.
 *
 * - `dprCap`: the highest device pixel ratio the canvas renders at (R3F `dpr={[1, cap]}`);
 * - `antialias`: MSAA — the composer's multisampling where there is a composer, else the
 *   context's (`contextAntialias`, P3-08; a context parameter, so a change recreates the canvas);
 * - `bloom`: the postprocessing bloom on emissive surfaces (the Sun); `null` = no composer at all.
 *   The threshold is 1.0 (linear luminance before tone mapping): only HDR emitters bloom, never
 *   the stars (capped at `STAR_MAX_BRIGHTNESS`, below it);
 * - `stars`: points in the star-field skybox;
 * - `beltRocks`: background rocks in the asteroid belt (P3-03): one instanced mesh, one draw call
 *   whatever the count; a lighter tier draws a prefix of the same deterministic belt;
 * - `shadows`: the shadow map and the Sun light's point shadow (P3-02): planets and the largest
 *   moons cast (each caster is drawn into all six cube faces every frame, so small moons do not:
 *   `bodies/layout.ts` `castsShadow`), every body and the rings receive (Saturn's shadow on its
 *   rings, eclipses of moons). `shadowMapSize` is that cube map's face size (only read when
 *   `shadows` is on; the light is recreated when it changes: three never resizes a cube map);
 * - `lod` (P3-06): the bodies' levels of detail, near → far, each holding while the camera is
 *   closer than `within` body radii (so they work in both scales), with `hysteresis` so a camera
 *   sitting on a boundary does not flicker: sphere segments, the procedural texture width (height
 *   = width / 2; the farthest level is painted at once, nearer ones lazily, off the main thread)
 *   and whether the bump/roughness `detail` map is painted (rocky and Earth-like surfaces).
 *   Sizing rule: a sphere at d radii spans ≈ H·dpr / (0.414·d) device pixels (45° vertical FOV),
 *   and about half the texture's width faces the camera, so a level's width should be ≥ twice
 *   that span at its far boundary. The camera frames a body at ≈ 8.5 of its anchor radii (P3-04),
 *   which must enter the near level (8.5 < within × (1 − hysteresis)) on every tier;
 * - `textureBudgetMB`: how many megabytes of near-level textures (CPU copy + GPU with mipmaps,
 *   estimated) may stay cached once nothing uses them; everything idle is dropped on a tier change;
 * - `ringSegments`, `orbitSegments`: tessellation of Saturn's and Uranus's rings and of the orbit
 *   lines;
 * - `labelHz` (P3-07): how many times a second the domain labels are re-projected at most (one pass
 *   for all of them; a label is rewritten only when it moved by more than half a pixel), on top of
 *   the frame cap;
 * - `maxFps`: a frame-rate cap while the decorative motion runs (`null` = the display's rate); the
 *   mobile tier renders every other frame of a 60 Hz display to save the phone's battery. The fps
 *   meter (`?fps=1`) lifts the cap so it measures the headroom.
 */
/** Linear luminance a pixel needs (before tone mapping) to bloom. */
export const BLOOM_THRESHOLD = 1.0;
/** The bloom's soft knee: full bloom from `BLOOM_THRESHOLD + BLOOM_SMOOTHING` up. */
export const BLOOM_SMOOTHING = 0.2;

/**
 * The Sun's emissive colour (sRGB) and intensity: its linear luminance (≈ 0.49 × 4 ≈ 1.95) sits
 * clearly above the bloom's full-strength point (1.2).
 */
export const SUN_EMISSIVE = { color: '#ffa630', intensity: 4 } as const;

export interface SceneQuality {
  tier: QualityTier;
  dprCap: number;
  antialias: boolean;
  bloom: { intensity: number; threshold: number; mipmapBlur: boolean } | null;
  stars: number;
  beltRocks: number;
  shadows: boolean;
  shadowMapSize: number;
  lod: LodConfig;
  textureBudgetMB: number;
  ringSegments: number;
  orbitSegments: { planet: number; moon: number };
  labelHz: number;
  maxFps: number | null;
}

/** One level of detail of the planets and moons (P3-06). */
export interface LodLevel {
  /** The level holds while the camera is closer than this many body radii (last: `Infinity`). */
  within: number;
  /** Sphere segments, `[around, pole to pole]`. */
  planetSegments: readonly [number, number];
  moonSegments: readonly [number, number];
  /** Surface texture width in texels (a power of two; the height is half of it). */
  planetTexture: number;
  moonTexture: number;
  /** A bump + roughness map painted from the same noise (rocky and Earth-like surfaces only). */
  detail: boolean;
}

export interface LodConfig {
  /** Nearest first; the last one is open-ended (`within: Infinity`). */
  levels: readonly LodLevel[];
  /** Fraction of a boundary the camera must pass beyond before the level changes. */
  hysteresis: number;
}

/** The hysteresis every tier uses: 15 % either side of a boundary. */
export const LOD_HYSTERESIS = 0.15;

export const QUALITY_TIERS: Readonly<Record<QualityTier, SceneQuality>> = {
  high: {
    tier: 'high',
    dprCap: 2,
    antialias: true,
    bloom: { intensity: 1.4, threshold: BLOOM_THRESHOLD, mipmapBlur: true },
    stars: 9000,
    beltRocks: 6000,
    shadows: true,
    shadowMapSize: 1024,
    lod: {
      levels: [
        {
          within: 16,
          planetSegments: [128, 96],
          moonSegments: [64, 48],
          planetTexture: 2048,
          moonTexture: 1024,
          detail: true,
        },
        {
          within: 32,
          planetSegments: [64, 48],
          moonSegments: [32, 24],
          planetTexture: 1024,
          moonTexture: 512,
          detail: false,
        },
        {
          within: Infinity,
          planetSegments: [48, 32],
          moonSegments: [24, 16],
          planetTexture: 256,
          moonTexture: 128,
          detail: false,
        },
      ],
      hysteresis: LOD_HYSTERESIS,
    },
    textureBudgetMB: 96,
    ringSegments: 128,
    orbitSegments: { planet: 192, moon: 96 },
    labelHz: 30,
    maxFps: null,
  },
  balanced: {
    tier: 'balanced',
    dprCap: 1.5,
    antialias: true,
    bloom: { intensity: 1.0, threshold: BLOOM_THRESHOLD, mipmapBlur: true },
    stars: 5000,
    beltRocks: 3500,
    shadows: false,
    shadowMapSize: 512,
    lod: {
      levels: [
        {
          within: 12,
          planetSegments: [96, 64],
          moonSegments: [48, 32],
          planetTexture: 1024,
          moonTexture: 512,
          detail: true,
        },
        {
          within: 24,
          planetSegments: [48, 32],
          moonSegments: [24, 16],
          planetTexture: 512,
          moonTexture: 256,
          detail: false,
        },
        {
          within: Infinity,
          planetSegments: [32, 24],
          moonSegments: [16, 12],
          planetTexture: 256,
          moonTexture: 128,
          detail: false,
        },
      ],
      hysteresis: LOD_HYSTERESIS,
    },
    textureBudgetMB: 32,
    ringSegments: 96,
    orbitSegments: { planet: 128, moon: 64 },
    labelHz: 30,
    maxFps: null,
  },
  mobile: {
    tier: 'mobile',
    dprCap: 1,
    antialias: false,
    bloom: null,
    stars: 2000,
    beltRocks: 1200,
    shadows: false,
    shadowMapSize: 256,
    lod: {
      levels: [
        {
          within: 12,
          planetSegments: [48, 32],
          moonSegments: [24, 16],
          planetTexture: 512,
          moonTexture: 256,
          detail: false,
        },
        {
          within: Infinity,
          planetSegments: [24, 16],
          moonSegments: [12, 8],
          planetTexture: 256,
          moonTexture: 128,
          detail: false,
        },
      ],
      hysteresis: LOD_HYSTERESIS,
    },
    textureBudgetMB: 8,
    ringSegments: 64,
    orbitSegments: { planet: 96, moon: 48 },
    labelHz: 15,
    maxFps: 30,
  },
};

/** The tier when the settings say nothing (no settings endpoint, or still loading): the server's default. */
export const DEFAULT_QUALITY_TIER: QualityTier = 'high';

export function sceneQuality(tier: QualityTier | undefined): SceneQuality {
  return QUALITY_TIERS[tier ?? DEFAULT_QUALITY_TIER];
}

/**
 * Whether the WebGL context itself is multisampled (P3-08). With a composer (bloom), the scene is
 * drawn into the composer's own multisampled target (`multisampling` 4) and only a full-screen
 * quad reaches the canvas, so a multisampled canvas would add a full-resolution MSAA buffer and its
 * resolve every frame for nothing (measured: ≈ 40 → ≈ 60 fps at high under load). The context
 * gets MSAA only on a tier that wants it and draws the scene straight to the canvas.
 */
export function contextAntialias(quality: Pick<SceneQuality, 'antialias' | 'bloom'>): boolean {
  return quality.antialias && quality.bloom === null;
}
