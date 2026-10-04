import { CanvasTexture, SRGBColorSpace } from 'three';

/**
 * The Sun's soft glow: a radial gradient drawn at runtime (no image asset), for the system's Sun
 * sprite on tiers without bloom (`SolarScene`) and the detail view's backdrop Sun (`detail/`).
 * The caller owns (and disposes) the texture.
 */
export function sunGlowTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255, 200, 120, 1)');
    g.addColorStop(0.25, 'rgba(255, 150, 50, 0.55)');
    g.addColorStop(0.6, 'rgba(255, 110, 20, 0.12)');
    g.addColorStop(1, 'rgba(255, 90, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}
