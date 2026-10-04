import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  RGFormat,
  SRGBColorSpace,
} from 'three';
import type { QualityTier } from '@galactic/protocol';
import type { BodyLook } from '../../bodies/appearance.js';
import { onPaintModeChange, paintAsync, paintsOffMainThread } from '../../bodies/painter.js';
import { TextureCache, type Disposable } from '../../bodies/texture-cache.js';
import { levelTexture, type BodyKind } from '../../bodies/textures.js';
import type { SceneQuality } from '../../quality.js';
import {
  cloudBytes,
  cloudKey,
  cloudSpec,
  detailMapsBytes,
  detailMapsKey,
  detailMapsSpec,
  detailTier,
  type DetailMapsSpec,
} from './budget.js';
import type { CloudLook, DetailLook } from './looks.js';
import type { PaintLayers } from '../../bodies/paint-jobs.js';

/**
 * The detail level's textures (P6-02): painted in the paint worker, cached by content and size in
 * `detailTextures` (reference-counted, idle ones kept within the tier's `budgetMB`, all idle ones
 * dropped on a tier change and when the canvas goes — `useDetailTextureBudget`), disposed with
 * their cache entry. Each texture frees its CPU copy once uploaded (`freeAfterUpload`): a 4096
 * map's pixels would otherwise sit in the JS heap next to the GPU copy for nothing.
 */
const MB = 1024 * 1024;

/**
 * Drops a texture's pixel array once three has uploaded it. Safe here: the texture is never
 * updated again, and when the canvas (its GL context) goes the cache drops every idle entry, so a
 * texture is never uploaded twice.
 */
export function freeAfterUpload(texture: DataTexture): void {
  texture.onUpdate = () => {
    (texture.image as { data: unknown }).data = null;
    texture.onUpdate = null;
  };
}

function texture(
  data: Uint8Array,
  width: number,
  height: number,
  format: typeof RGBAFormat | typeof RGFormat,
  srgb: boolean,
): DataTexture {
  const t = new DataTexture(data, width, height, format);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  freeAfterUpload(t);
  return t;
}

/** A body's detail level: colour, normal (relief surfaces), roughness (Earth). */
export class DetailMaps implements Disposable {
  constructor(
    readonly map: DataTexture,
    readonly normal: DataTexture | null,
    readonly roughness: DataTexture | null,
  ) {}

  static from(layers: PaintLayers, spec: DetailMapsSpec): DetailMaps {
    const { width, height } = spec;
    return new DetailMaps(
      texture(layers.color, width, height, RGBAFormat, true),
      layers.normal ? texture(layers.normal, width, height, RGBAFormat, false) : null,
      layers.detail ? texture(layers.detail, width, height, RGFormat, false) : null,
    );
  }

  dispose(): void {
    this.map.dispose();
    this.normal?.dispose();
    this.roughness?.dispose();
  }
}

/** Earth's clouds: one RG coverage texture, read as the alpha map. */
export class CloudMaps implements Disposable {
  constructor(readonly alpha: DataTexture) {}

  dispose(): void {
    this.alpha.dispose();
  }
}

/** The detail cache, shared by every detail view; its budget follows the tier. */
export const detailTextures = new TextureCache<Disposable>(128 * MB);

/** Sets the detail cache's budget from the tier; drops every idle entry on a tier change or unmount. */
export function useDetailTextureBudget(tier: QualityTier): void {
  useEffect(() => {
    detailTextures.setBudget(detailTier(tier).budgetMB * MB);
    return () => {
      // After the views' own cleanups have released their textures.
      queueMicrotask(() => detailTextures.dropIdle());
    };
  }, [tier]);
}

/**
 * Holds the cache entry `key` (painting it with `load` if new) and returns what to show: the entry
 * once ready, until then the previously shown one (still held), else `undefined` (the caller's
 * fallback). `key` null: nothing wanted (the fallback shows).
 */
export function useCachedPaint<T extends Disposable>(
  cache: TextureCache<Disposable>,
  key: string | null,
  bytes: number,
  load: (signal: AbortSignal) => Promise<T>,
): T | undefined {
  /** The entry on show, whose reference this hook holds (effects only). */
  const held = useRef<string | null>(null);
  /** The same, for the render: a state change re-renders when the entry arrives. */
  const [shownKey, setShownKey] = useState<string | null>(null);

  useEffect(() => {
    const show = (next: string | null) => {
      const old = held.current;
      held.current = next;
      // Every acquire is matched by one release, also when `next` is the same key (re-run).
      if (old !== null) cache.release(old);
      queueMicrotask(() => setShownKey(next));
    };
    if (key === null) {
      show(null);
      return;
    }
    let live = true;
    const handle = cache.acquire(key, bytes, load);
    if (handle.value !== undefined) show(key);
    else {
      void handle.promise.then((value) => {
        if (live && value) show(key);
      });
    }
    return () => {
      live = false;
      if (held.current !== key) cache.release(key);
    };
    // `key` captures the content and size of what `load` paints.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key]);

  useEffect(
    () => () => {
      if (held.current !== null) cache.release(held.current);
      held.current = null;
    },
    [cache],
  );

  if (key === null) return undefined;
  return (cache.peek(key) ?? (shownKey === null ? undefined : cache.peek(shownKey))) as
    T | undefined;
}

/** Whether near and detail maps are painted off the main thread now (live). */
export function useOffMainThread(): boolean {
  return useSyncExternalStore(onPaintModeChange, paintsOffMainThread, () => true);
}

/**
 * The detail level of the body shown in detail, once painted (`undefined` until then, or when the
 * tier gives it none: the caller shows the nearest LOD level meanwhile).
 */
export function useDetailMaps(
  look: BodyLook,
  kind: BodyKind,
  quality: SceneQuality,
  detail: DetailLook,
): DetailMaps | undefined {
  const offMainThread = useOffMainThread();
  const near = levelTexture(quality.lod.levels[0]!, kind).width;
  const spec = detailMapsSpec(detailTier(quality.tier), kind, look, detail, near, offMainThread);
  const key = spec ? detailMapsKey(look, spec) : null;
  return useCachedPaint(detailTextures, key, spec ? detailMapsBytes(spec) : 0, (signal) =>
    paintAsync(
      {
        kind: 'detail',
        look,
        width: spec!.width,
        height: spec!.height,
        normal: spec!.normal,
        roughness: spec!.roughness,
        normalStrength: spec!.normalStrength,
        reliefBlur: spec!.reliefBlur,
      },
      signal,
    ).then((layers) => DetailMaps.from(layers, spec!)),
  );
}

/** Earth's cloud texture at the tier's size, once painted. */
export function useCloudMaps(clouds: CloudLook, quality: SceneQuality): CloudMaps | undefined {
  const offMainThread = useOffMainThread();
  const { width, height } = cloudSpec(detailTier(quality.tier));
  // Without a worker, a small cloud map only (512 × 256 is ≈ 60 ms of noise).
  const w = offMainThread ? width : Math.min(width, 512);
  const h = offMainThread ? height : Math.min(height, 256);
  return useCachedPaint(detailTextures, cloudKey(clouds, w), cloudBytes(w), (signal) =>
    paintAsync({ kind: 'clouds', clouds, width: w, height: h }, signal).then(
      (layers) => new CloudMaps(texture(layers.color, w, h, RGFormat, false)),
    ),
  );
}
