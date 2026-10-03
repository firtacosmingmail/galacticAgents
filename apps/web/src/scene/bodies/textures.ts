import { useEffect, useMemo, useReducer } from 'react';
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  RGFormat,
  SphereGeometry,
  SRGBColorSpace,
} from 'three';
import type { LodConfig, LodLevel } from '../quality.js';
import type { BodyLook, RingLook } from './appearance.js';
import { paintAsync } from './painter.js';
import {
  hasRelief,
  paintRings,
  paintSurface,
  RING_TEXTURE_WIDTH,
  type SurfaceLayers,
} from './surface.js';
import { TextureCache } from './texture-cache.js';

/**
 * Wraps the procedural pixels of `surface.ts` in three.js textures (P3-02, P3-06).
 *
 * - The farthest level's map is painted at once, per body (`useSurfaceTexture`), so the first
 *   frame is textured; it is disposed with the body or when the tier changes its size.
 * - Nearer levels (bigger maps, plus the bump/roughness detail map) are painted lazily off the
 *   main thread (`painter.ts`) when a body reaches that level, and live in `nearTextures`, a cache
 *   keyed by content and size (`surfaceMapsKey`), shared by bodies that look alike, kept idle
 *   within the tier's budget and dropped on a tier change (`useNearTextureBudget`). Until the near
 *   maps are ready the body keeps its far map.
 * - Sphere geometries are unit spheres per level and kind, shared by every body (scaled by the
 *   mesh) and disposed when the tier changes (`useSphereGeometries`).
 */
function dataTexture(data: Uint8Array, width: number, height: number): DataTexture {
  const t = new DataTexture(data, width, height, RGBAFormat);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** The detail map: RG bytes, linear (no colour space): R = height (bump), G = roughness. */
function detailTexture(data: Uint8Array, width: number, height: number): DataTexture {
  const t = new DataTexture(data, width, height, RGFormat);
  t.wrapS = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  // RG8 rows are 2 × width bytes: a multiple of the default 4-byte unpack alignment.
  t.needsUpdate = true;
  return t;
}

export function surfaceKey(look: BodyLook): string {
  return `${look.style}|${look.seed}|${look.palette.join(',')}|${look.polarCaps ? 1 : 0}`;
}

export type BodyKind = 'planet' | 'moon';

/** A level's texture size for a kind (height = width / 2). */
export function levelTexture(level: LodLevel, kind: BodyKind): { width: number; height: number } {
  const width = kind === 'planet' ? level.planetTexture : level.moonTexture;
  return { width, height: width / 2 };
}

/** Whether a level paints a detail map for this surface. */
export function levelDetail(level: LodLevel, look: BodyLook): boolean {
  return level.detail && hasRelief(look);
}

/** The near-texture cache key: the look's content, the size, and whether a detail map is in it. */
export function surfaceMapsKey(look: BodyLook, width: number, detail: boolean): string {
  return `${surfaceKey(look)}@${width}${detail ? '+detail' : ''}`;
}

/**
 * Estimated memory of a level's maps: the CPU copy a `DataTexture` keeps plus the GPU copy with
 * its mipmaps (× 4/3): RGBA colour, RG detail.
 */
export function surfaceMapsBytes(width: number, detail: boolean): number {
  const texels = width * (width / 2);
  return Math.round(texels * (4 + (detail ? 2 : 0)) * (1 + 4 / 3));
}

export class SurfaceMaps {
  constructor(
    readonly map: DataTexture,
    readonly detail: DataTexture | null,
  ) {}

  static from(layers: SurfaceLayers, width: number, height: number): SurfaceMaps {
    return new SurfaceMaps(
      dataTexture(layers.color, width, height),
      layers.detail ? detailTexture(layers.detail, width, height) : null,
    );
  }

  dispose(): void {
    this.map.dispose();
    this.detail?.dispose();
  }
}

const MB = 1024 * 1024;

/** The near-level texture cache, shared by every body; its budget follows the tier. */
export const nearTextures = new TextureCache<SurfaceMaps>(96 * MB);

/** Sets the cache's budget from the tier and drops every idle near map when the tier changes or the scene goes. */
export function useNearTextureBudget(budgetMB: number, tier: string): void {
  useEffect(() => {
    nearTextures.setBudget(budgetMB * MB);
  }, [budgetMB]);
  useEffect(
    () => () => {
      // After the bodies' own cleanups have released their maps (React may run a parent's
      // cleanup before its children's when the whole tree goes).
      queueMicrotask(() => nearTextures.dropIdle());
    },
    [tier],
  );
}

/** The far map of a body: painted at once, owned by this body. */
export function useSurfaceTexture(
  look: BodyLook,
  size: { width: number; height: number },
): DataTexture {
  const key = surfaceKey(look);
  const { width, height } = size;
  const texture = useMemo(
    () => dataTexture(paintSurface(look, width, height), width, height),
    // The look is captured by content (`key`): a new object with the same content reuses the texture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, width, height],
  );
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/**
 * The maps a body shows at LOD `levelIndex`: the far map until the level's own maps (bigger, maybe
 * with detail) are painted, then those. A level whose map is no bigger than the far one and paints
 * no detail just uses the far map.
 */
export function useBodyMaps(
  look: BodyLook,
  kind: BodyKind,
  lod: LodConfig,
  levelIndex: number,
): { map: DataTexture; detail: DataTexture | null } {
  const far = lod.levels[lod.levels.length - 1]!;
  const farMap = useSurfaceTexture(look, levelTexture(far, kind));
  const level = lod.levels[Math.min(levelIndex, lod.levels.length - 1)]!;
  const { width, height } = levelTexture(level, kind);
  const detail = levelDetail(level, look);
  const near = width > levelTexture(far, kind).width || detail;
  const key = near ? surfaceMapsKey(look, width, detail) : null;
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (key === null) return;
    let live = true;
    const handle = nearTextures.acquire(key, surfaceMapsBytes(width, detail), (signal) =>
      paintAsync({ look, width, height, detail }, signal).then((layers) =>
        SurfaceMaps.from(layers, width, height),
      ),
    );
    if (handle.value === undefined) {
      void handle.promise.then((value) => {
        if (live && value) rerender();
      });
    }
    return () => {
      live = false;
      nearTextures.release(key);
    };
    // `key` captures the look's content and the size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const maps = key === null ? undefined : nearTextures.peek(key);
  return maps ? { map: maps.map, detail: maps.detail } : { map: farMap, detail: null };
}

export function useRingTexture(rings: RingLook): DataTexture {
  const texture = useMemo(() => {
    const t = dataTexture(paintRings(rings, RING_TEXTURE_WIDTH), RING_TEXTURE_WIDTH, 1);
    t.wrapS = ClampToEdgeWrapping;
    return t;
  }, [rings]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/** Unit spheres, one per LOD level and kind, shared by all bodies; disposed when the tier changes. */
export interface SphereSet {
  planet: SphereGeometry[];
  moon: SphereGeometry[];
}

export function buildSphereSet(lod: LodConfig): SphereSet {
  return {
    planet: lod.levels.map((l) => new SphereGeometry(1, l.planetSegments[0], l.planetSegments[1])),
    moon: lod.levels.map((l) => new SphereGeometry(1, l.moonSegments[0], l.moonSegments[1])),
  };
}

/** The shared sphere for a kind at a level (clamped to the set's levels). */
export function sphereFor(set: SphereSet, kind: BodyKind, level: number): SphereGeometry {
  const list = set[kind];
  return list[Math.max(0, Math.min(level, list.length - 1))]!;
}

export function disposeSphereSet(set: SphereSet): void {
  for (const g of [...set.planet, ...set.moon]) g.dispose();
}

export function useSphereGeometries(lod: LodConfig): SphereSet {
  const set = useMemo(() => buildSphereSet(lod), [lod]);
  useEffect(() => () => disposeSphereSet(set), [set]);
  return set;
}
