import type { RingLook } from './appearance.js';
import { fbm, hexToRgb } from './surface.js';

/**
 * Ring systems from a measured profile (P6-02): the bands a ring system is made of, in planet
 * radii, with the gaps between them left empty — Saturn's faint C ring, bright B ring, the Cassini
 * division, the A ring with the Encke gap; Uranus's narrow dark ringlets out to the ε ring. Fine
 * ringlets come from 1D noise on top. The same profile paints the system view's 256-texel strip
 * (`paintRings`) and the detail view's wider one (`ringTextureWidth`), so the rings keep their
 * structure across the swap and only gain sharpness. No three.js.
 */
export interface RingBand {
  /** Inner and outer edge, planet radii. */
  from: number;
  to: number;
  /** Peak opacity (times the ring look's `opacity`). */
  opacity: number;
  /** Where the band's colour sits on the ring palette, 0..1. */
  tone: number;
}

/** Saturn's main rings (radii from the planet's centre in Saturn radii, rounded). */
export const SATURN_RING_BANDS: readonly RingBand[] = [
  { from: 1.239, to: 1.527, opacity: 0.22, tone: 0.1 }, // C ring
  { from: 1.527, to: 1.64, opacity: 0.75, tone: 0.45 }, // B ring, inner
  { from: 1.64, to: 1.951, opacity: 1, tone: 0.6 }, // B ring
  { from: 1.951, to: 2.025, opacity: 0.06, tone: 0.2 }, // Cassini division (nearly empty)
  { from: 2.025, to: 2.214, opacity: 0.72, tone: 0.8 }, // A ring
  { from: 2.222, to: 2.267, opacity: 0.6, tone: 0.85 }, // A ring beyond the Encke gap
];

/** Uranus's rings: 6, 5, 4, α, β, η, γ, δ and the bright ε (Uranus radii; drawn wider than real). */
export const URANUS_RING_BANDS: readonly RingBand[] = [
  { from: 1.636, to: 1.641, opacity: 0.5, tone: 0.3 },
  { from: 1.65, to: 1.655, opacity: 0.5, tone: 0.3 },
  { from: 1.664, to: 1.669, opacity: 0.55, tone: 0.3 },
  { from: 1.746, to: 1.754, opacity: 0.75, tone: 0.5 },
  { from: 1.783, to: 1.791, opacity: 0.75, tone: 0.5 },
  { from: 1.844, to: 1.848, opacity: 0.4, tone: 0.4 },
  { from: 1.86, to: 1.866, opacity: 0.7, tone: 0.5 },
  { from: 1.886, to: 1.893, opacity: 0.7, tone: 0.5 },
  { from: 1.982, to: 1.998, opacity: 1, tone: 0.9 }, // ε
];

function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * A ring system's opacity (0..1, before the look's `opacity` and the ringlet noise) at `r` planet
 * radii, each band's edges softened over `soft` radii.
 */
export function ringBandOpacity(bands: readonly RingBand[], r: number, soft: number): number {
  let a = 0;
  for (const b of bands) {
    const inside = smooth((r - b.from) / soft + 0.5) * smooth((b.to - r) / soft + 0.5);
    if (inside > 0) a = Math.max(a, b.opacity * inside);
  }
  return a;
}

/** The colour position of the band at `r` (the nearest band's tone). */
function ringTone(bands: readonly RingBand[], r: number): number {
  let best = bands[0]?.tone ?? 0.5;
  let dist = Infinity;
  for (const b of bands) {
    const d = r < b.from ? b.from - r : r > b.to ? r - b.to : 0;
    if (d < dist) {
      dist = d;
      best = b.tone;
    }
  }
  return best;
}

/**
 * Paints a ring system with `bands`: `width` RGBA texels from the inner edge (0) to the outer
 * (width − 1), opacity from the profile with fine ringlets, colour from the palette by tone.
 */
export function paintRingProfile(rings: RingLook, width: number): Uint8Array {
  const bands = rings.bands ?? [];
  const data = new Uint8Array(width * 4);
  const palette = rings.palette.map(hexToRgb);
  const seed = rings.seed * 104729;
  const span = rings.outer - rings.inner;
  // At least a texel and a half, so narrow ringlets survive at 256 texels.
  const soft = Math.max(0.002, (span / width) * 1.5);
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    const r = rings.inner + t * span;
    const n = fbm(t * 160, 0.5, 0.5, seed, 4);
    const ringlets = 0.7 + 0.6 * n;
    const alpha = rings.opacity * ringBandOpacity(bands, r, soft) * ringlets;
    const x = Math.min(1, Math.max(0, ringTone(bands, r) * 0.8 + n * 0.2)) * (palette.length - 1);
    const k0 = Math.min(palette.length - 2, Math.floor(x));
    const f = x - k0;
    const a = palette[Math.max(0, k0)]!;
    const b = palette[Math.max(0, k0) + 1] ?? a;
    const k = i * 4;
    data[k] = a[0] + (b[0] - a[0]) * f;
    data[k + 1] = a[1] + (b[1] - a[1]) * f;
    data[k + 2] = a[2] + (b[2] - a[2]) * f;
    data[k + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  }
  return data;
}
