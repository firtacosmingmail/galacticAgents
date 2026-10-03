import type { QualityTier } from '@galactic/protocol';

/**
 * What a quality tier (SPEC decision 51, TECHNOLOGY §2.1) turns into for the renderer. One table,
 * so P3-06 (LOD and quality) extends it rather than scattering `tier === 'mobile'` checks.
 *
 * - `dprCap`: the highest device pixel ratio the canvas renders at (R3F `dpr={[1, cap]}`);
 * - `antialias`: MSAA on the context (and the composer's multisampling) — a context parameter,
 *   so a change recreates the canvas;
 * - `bloom`: the postprocessing bloom on emissive surfaces (the Sun); `null` = no composer at all;
 * - `stars`: points in the star-field skybox;
 * - `shadows`: the renderer's shadow map (nothing casts shadows yet; reserved for P3-02/P3-06).
 */
export interface SceneQuality {
  tier: QualityTier;
  dprCap: number;
  antialias: boolean;
  bloom: { intensity: number; threshold: number; mipmapBlur: boolean } | null;
  stars: number;
  shadows: boolean;
}

export const QUALITY_TIERS: Readonly<Record<QualityTier, SceneQuality>> = {
  high: {
    tier: 'high',
    dprCap: 2,
    antialias: true,
    bloom: { intensity: 1.4, threshold: 0.9, mipmapBlur: true },
    stars: 9000,
    shadows: true,
  },
  balanced: {
    tier: 'balanced',
    dprCap: 1.5,
    antialias: true,
    bloom: { intensity: 1.0, threshold: 0.9, mipmapBlur: true },
    stars: 5000,
    shadows: false,
  },
  mobile: {
    tier: 'mobile',
    dprCap: 1,
    antialias: false,
    bloom: null,
    stars: 2000,
    shadows: false,
  },
};

/** The tier when the settings say nothing (no settings endpoint, or still loading): the server's default. */
export const DEFAULT_QUALITY_TIER: QualityTier = 'high';

export function sceneQuality(tier: QualityTier | undefined): SceneQuality {
  return QUALITY_TIERS[tier ?? DEFAULT_QUALITY_TIER];
}
