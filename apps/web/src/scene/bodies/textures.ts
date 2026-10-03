import { useEffect, useMemo } from 'react';
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
} from 'three';
import type { BodyLook, RingLook } from './appearance.js';
import { paintRings, paintSurface, RING_TEXTURE_WIDTH } from './surface.js';

/**
 * Wraps the procedural pixels of `surface.ts` in three.js textures, painted once per look (keyed
 * by its content, not its identity) and disposed with the body that uses them.
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

export function surfaceKey(look: BodyLook): string {
  return `${look.style}|${look.seed}|${look.palette.join(',')}|${look.polarCaps ? 1 : 0}`;
}

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

export function useRingTexture(rings: RingLook): DataTexture {
  const texture = useMemo(() => {
    const t = dataTexture(paintRings(rings, RING_TEXTURE_WIDTH), RING_TEXTURE_WIDTH, 1);
    t.wrapS = ClampToEdgeWrapping;
    return t;
  }, [rings]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
