import { BEACON_COLOR, BEACON_INK, type GlyphSpec } from './beacon-look.js';

/**
 * The beacon's sprites, drawn at runtime on a 2D canvas (no image assets). No three.js: the
 * renderer wraps the canvases in textures.
 *
 * - The glyph (`drawGlyph`, square): an amber diamond with a dark padlock (permission) or an amber
 *   disc with a dark "?" (clarification), a dark rim so it reads over a bright planet, and a count
 *   badge in the top-right corner (dark disc, amber rim and figure) when several questions wait.
 * - The pillar (`drawPillar`, tall and thin): amber light, soft at the sides, brightest at the top
 *   (under the glyph) and fading towards the body.
 */
export const GLYPH_TEXTURE_PX = 128;
export const PILLAR_TEXTURE = { width: 16, height: 128 } as const;

type Ctx = Pick<
  CanvasRenderingContext2D,
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'arc'
  | 'fill'
  | 'stroke'
  | 'fillRect'
  | 'fillText'
  | 'clearRect'
  | 'createLinearGradient'
  | 'save'
  | 'restore'
> & {
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  strokeStyle: CanvasRenderingContext2D['strokeStyle'];
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

export function drawGlyph(ctx: Ctx, spec: GlyphSpec, size = GLYPH_TEXTURE_PX): void {
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  // The badge sits in the corner: the shape keeps to the middle 78 %.
  const r = size * 0.39;
  ctx.save();
  ctx.beginPath();
  if (spec.shape === 'diamond') {
    ctx.moveTo(c, c - r);
    ctx.lineTo(c + r, c);
    ctx.lineTo(c, c + r);
    ctx.lineTo(c - r, c);
    ctx.closePath();
  } else {
    ctx.arc(c, c, r * 0.86, 0, Math.PI * 2);
  }
  ctx.fillStyle = BEACON_COLOR;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.035;
  ctx.strokeStyle = BEACON_INK;
  ctx.stroke();

  ctx.fillStyle = BEACON_INK;
  ctx.strokeStyle = BEACON_INK;
  if (spec.symbol === 'lock') {
    // Shackle: an arch over the body.
    const w = size * 0.2;
    const h = size * 0.15;
    const top = c - size * 0.02;
    ctx.beginPath();
    ctx.lineWidth = size * 0.045;
    ctx.arc(c, top, w * 0.32, Math.PI, 0);
    ctx.stroke();
    ctx.fillRect(c - w / 2, top, w, h);
  } else {
    ctx.font = `bold ${Math.round(size * 0.42)}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', c, c + size * 0.03);
  }

  if (spec.badge) {
    const br = size * 0.21;
    const bx = size - br - size * 0.02;
    const by = br + size * 0.02;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = BEACON_INK;
    ctx.fill();
    ctx.lineWidth = size * 0.03;
    ctx.strokeStyle = BEACON_COLOR;
    ctx.stroke();
    ctx.fillStyle = BEACON_COLOR;
    const chars = spec.badge.length;
    ctx.font = `bold ${Math.round(size * (chars > 1 ? 0.2 : 0.27))}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.badge, bx, by + size * 0.01);
  }
  ctx.restore();
}

export function drawPillar(
  ctx: Ctx,
  width: number = PILLAR_TEXTURE.width,
  height: number = PILLAR_TEXTURE.height,
): void {
  ctx.clearRect(0, 0, width, height);
  // Columns: a soft core, fading to nothing at the sides; rows: brightest at the top.
  for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width - 0.5;
    const across = Math.exp(-(u * u) / 0.03);
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, `rgba(255, 196, 110, ${across})`);
    g.addColorStop(1, `rgba(255, 181, 71, ${0.15 * across})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 1, height);
  }
}
