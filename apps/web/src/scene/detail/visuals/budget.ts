import type { QualityTier } from '@galactic/protocol';
import type { BodyLook } from '../../bodies/appearance.js';
import { hasRelief } from '../../bodies/surface.js';
import { surfaceKey, type BodyKind } from '../../bodies/textures.js';
import type { CloudLook, DetailLook } from './looks.js';

/**
 * The detail level's sizes per quality tier (P6-02), as plain data: the body shown in a detail view
 * gets a level beyond the LOD table's nearest — a bigger colour map, a normal map derived from the
 * same relief instead of the bump map, and Earth's roughness map — plus the cloud and ring
 * textures. Only the shown body: the moons orbiting a planet keep their nearest LOD level (Saturn
 * with six moons at 2048 + normals would be ~250 MB).
 *
 * Memory: a detail texture's CPU copy is freed once it is on the GPU (`detail-textures.ts`), so a
 * level costs its GPU size, mipmaps included (× 4/3): high Earth 4096 × 2048 × (4 colour + 4 normal
 * + 2 roughness) bytes ≈ 112 MB; balanced 2048 Earth ≈ 28 MB; mobile 1024 colour only ≈ 2.8 MB.
 * Idle levels (the view left) stay cached within `budgetMB` (high fits one rocky planet, so
 * flying back is instant) and all go when the tier changes or the canvas goes.
 */
export interface DetailTier {
  /** Colour (and normal) map width of a planet shown in detail (height = width / 2). */
  planetTexture: number;
  /** …of a moon shown in detail. */
  moonTexture: number;
  /** Whether relief surfaces get a normal map (else they keep the nearest level's bump, if any). */
  normalMaps: boolean;
  /** Earth's cloud texture width. */
  cloudTexture: number;
  /** The rings' radial texture width. */
  ringTexture: number;
  /** Ring tessellation in the detail view. */
  ringSegments: number;
  /** Idle detail textures kept, megabytes (GPU). */
  budgetMB: number;
}

export const DETAIL_TIERS: Readonly<Record<QualityTier, DetailTier>> = {
  high: {
    planetTexture: 4096,
    moonTexture: 2048,
    normalMaps: true,
    cloudTexture: 2048,
    ringTexture: 2048,
    ringSegments: 256,
    budgetMB: 128,
  },
  balanced: {
    planetTexture: 2048,
    moonTexture: 1024,
    normalMaps: true,
    cloudTexture: 1024,
    ringTexture: 1024,
    ringSegments: 160,
    budgetMB: 32,
  },
  mobile: {
    planetTexture: 1024,
    moonTexture: 512,
    normalMaps: false,
    cloudTexture: 512,
    ringTexture: 512,
    ringSegments: 96,
    budgetMB: 8,
  },
};

export function detailTier(tier: QualityTier): DetailTier {
  return DETAIL_TIERS[tier];
}

export interface DetailMapsSpec {
  width: number;
  height: number;
  /** A normal map from the relief (rocky and Earth-like surfaces with a `normalStrength`). */
  normal: boolean;
  /** Earth's roughness map (glossy oceans, matte land, the ice in between). */
  roughness: boolean;
  normalStrength: number;
  /** Box blur radius of the relief before the normals, texels (0: none). */
  reliefBlur: number;
}

/** Whether a surface's roughness varies enough to need a map: Earth's oceans are glossy. */
export function variesRoughness(look: BodyLook): boolean {
  return look.style === 'earth';
}

/**
 * The detail level a body shown in detail asks for, or `null` when it would add nothing over the
 * nearest LOD level (`nearWidth`) or cannot be painted off the main thread (without a worker a
 * 4096 map would freeze the page for seconds: the body keeps its nearest level then).
 */
export function detailMapsSpec(
  tier: DetailTier,
  kind: BodyKind,
  look: BodyLook,
  detail: DetailLook,
  nearWidth: number,
  offMainThread: boolean,
): DetailMapsSpec | null {
  if (!offMainThread) return null;
  const width = kind === 'planet' ? tier.planetTexture : tier.moonTexture;
  const normal = tier.normalMaps && hasRelief(look) && detail.normalStrength > 0;
  if (width <= nearWidth && !normal) return null;
  return {
    width,
    height: width / 2,
    normal,
    roughness: normal && variesRoughness(look),
    normalStrength: detail.normalStrength,
    reliefBlur: normal ? Math.round(((detail.reliefBlur ?? 0) * width) / 4096) : 0,
  };
}

/** The detail cache's key for a body's level: its surface content (features included), size, maps. */
export function detailMapsKey(look: BodyLook, spec: DetailMapsSpec): string {
  const maps = `${spec.normal ? `+n${spec.normalStrength}b${spec.reliefBlur}` : ''}${spec.roughness ? '+r' : ''}`;
  return `detail|${surfaceKey(look)}@${spec.width}${maps}`;
}

const GPU_MIPS = 4 / 3;

/** A detail level's GPU bytes with mipmaps: RGBA colour, RGBA normal, RG roughness. */
export function detailMapsBytes(spec: DetailMapsSpec): number {
  const texels = spec.width * spec.height;
  const perTexel = 4 + (spec.normal ? 4 : 0) + (spec.roughness ? 2 : 0);
  return Math.round(texels * perTexel * GPU_MIPS);
}

/** Earth's cloud texture at a tier: width × width / 2, RG (coverage in both channels). */
export function cloudSpec(tier: DetailTier): { width: number; height: number } {
  return { width: tier.cloudTexture, height: tier.cloudTexture / 2 };
}

export function cloudKey(clouds: CloudLook, width: number): string {
  return `clouds|${clouds.seed}|${clouds.coverage}@${width}`;
}

export function cloudBytes(width: number): number {
  return Math.round(width * (width / 2) * 2 * GPU_MIPS);
}

/**
 * The rings' texture width in the detail view (never below the system's 256). The strip is 1D and
 * small (2048 × 4 bytes): painted on the main thread, owned by the rings, not cached.
 */
export function ringTextureWidth(tier: DetailTier, systemWidth: number): number {
  return Math.max(tier.ringTexture, systemWidth);
}

/** The detail tier's total budget for one view (shown body + clouds), in bytes, for the notes. */
export function viewBytes(spec: DetailMapsSpec | null, clouds: { width: number } | null): number {
  return (spec ? detailMapsBytes(spec) : 0) + (clouds ? cloudBytes(clouds.width) : 0);
}
