import type { QualityTier } from '@galactic/protocol';

/**
 * What a quality tier (SPEC decision 51, TECHNOLOGY §2.1) turns into for the renderer. One table,
 * so P3-06 (LOD and quality) extends it rather than scattering `tier === 'mobile'` checks.
 *
 * - `dprCap`: the highest device pixel ratio the canvas renders at (R3F `dpr={[1, cap]}`);
 * - `antialias`: MSAA on the context (and the composer's multisampling) — a context parameter,
 *   so a change recreates the canvas;
 * - `bloom`: the postprocessing bloom on emissive surfaces (the Sun); `null` = no composer at all.
 *   The threshold is 1.0 (linear luminance before tone mapping): only HDR emitters bloom, never
 *   the stars (capped at `STAR_MAX_BRIGHTNESS`, below it);
 * - `stars`: points in the star-field skybox;
 * - `beltRocks`: background rocks in the asteroid belt (P3-03): one instanced mesh, one draw call
 *   whatever the count; a lighter tier draws a prefix of the same deterministic belt;
 * - `shadows`: the shadow map and the Sun light's point shadow (P3-02): planets and moons cast and
 *   receive, rings receive (Saturn's shadow on its rings, eclipses of moons).
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
}

export const QUALITY_TIERS: Readonly<Record<QualityTier, SceneQuality>> = {
  high: {
    tier: 'high',
    dprCap: 2,
    antialias: true,
    bloom: { intensity: 1.4, threshold: BLOOM_THRESHOLD, mipmapBlur: true },
    stars: 9000,
    beltRocks: 6000,
    shadows: true,
  },
  balanced: {
    tier: 'balanced',
    dprCap: 1.5,
    antialias: true,
    bloom: { intensity: 1.0, threshold: BLOOM_THRESHOLD, mipmapBlur: true },
    stars: 5000,
    beltRocks: 3500,
    shadows: false,
  },
  mobile: {
    tier: 'mobile',
    dprCap: 1,
    antialias: false,
    bloom: null,
    stars: 2000,
    beltRocks: 1200,
    shadows: false,
  },
};

/** The tier when the settings say nothing (no settings endpoint, or still loading): the server's default. */
export const DEFAULT_QUALITY_TIER: QualityTier = 'high';

export function sceneQuality(tier: QualityTier | undefined): SceneQuality {
  return QUALITY_TIERS[tier ?? DEFAULT_QUALITY_TIER];
}
