import type { QuestionKind } from '@galactic/protocol';

/**
 * How a beacon looks (P4-05), as numbers and pure functions. No three.js.
 *
 * A beacon is a billboard facing the camera, measured in **screen pixels** at its body's depth (the
 * renderer scales its group by world units per pixel), so it reads the same at the whole-system
 * view and up close, and on the phone:
 * - a thin amber **light pillar** rising from the top of the body (screen up, whatever the camera's
 *   angle — a world-vertical pillar would vanish in a top-down view);
 * - on top of it, the **glyph**: an amber diamond with a padlock for a permission, an amber disc
 *   with "?" for a clarification, and a count badge when several questions wait on that body;
 * - a **halo** ring around the glyph that pulses outwards (steady under reduced motion).
 * The glyph sits `LIFT_PX` above the body's top, clear of the body's label (which sits right
 * above the body, P3-07), and is kept inside the top of the viewport when the body is big on
 * screen (close up), sliding down over the body rather than leaving the view.
 *
 * Colour: the panel's amber "blocked on you" (`#ffb547`, SPEC §4.4 — nothing else in the scene
 * uses it but the "blocked on you" label pill).
 */
export const BEACON_COLOR = '#ffb547';
/** The glyph's dark ink (the panel's `--pnl-beacon-ink`). */
export const BEACON_INK = '#1d1300';

export const BEACON = {
  /** The glyph's centre above the body's top edge, in pixels. */
  liftPx: 64,
  /** The glyph's drawn size (its texture's quad), in pixels. */
  glyphPx: 30,
  /** The pillar's width, in pixels (its texture fades to the sides). */
  pillarPx: 6,
  /** The glyph's centre never closer than this to the top of the viewport, in pixels. */
  topMarginPx: 22,
  /** The click / tap target's radius around the glyph's centre, in pixels (36 px across: a tap). */
  targetPx: 18,
  /** One pulse of the halo, in seconds. */
  pulseSeconds: 1.6,
} as const;

export interface BeaconLayout {
  /** The glyph's centre above the body's centre, in pixels (screen up). */
  glyphY: number;
  /** The pillar runs from `pillarFrom` to `pillarTo` above the body's centre (empty: none). */
  pillarFrom: number;
  pillarTo: number;
}

/**
 * Where the parts go, in pixels above the body's centre on screen: `radiusPx` is the body's radius
 * on screen, `bodyY` its centre's distance from the top of the viewport (CSS pixels).
 */
export function beaconLayout(radiusPx: number, bodyY: number): BeaconLayout {
  let glyphY = radiusPx + BEACON.liftPx;
  // Close up the body fills the screen: keep the glyph inside the viewport's top edge.
  if (bodyY - glyphY < BEACON.topMarginPx) glyphY = Math.max(0, bodyY - BEACON.topMarginPx);
  const pillarTo = glyphY - BEACON.glyphPx / 2;
  const pillarFrom = Math.min(radiusPx, pillarTo);
  return { glyphY, pillarFrom, pillarTo };
}

export interface BeaconPulse {
  /** The halo's radius as a multiple of the glyph's half size. */
  haloScale: number;
  haloOpacity: number;
  pillarOpacity: number;
}

/** The steady look (reduced motion): a visible halo, a full pillar, no change over time. */
export const STEADY_PULSE: BeaconPulse = { haloScale: 1.35, haloOpacity: 0.45, pillarOpacity: 0.8 };

/**
 * The pulse at time `t` (seconds, the shared motion clock): the halo grows from the glyph's edge
 * outwards and fades, the pillar breathes a little. Under reduced motion: `STEADY_PULSE`.
 */
export function beaconPulse(t: number, reducedMotion: boolean): BeaconPulse {
  if (reducedMotion) return STEADY_PULSE;
  const phase = (((t / BEACON.pulseSeconds) % 1) + 1) % 1;
  return {
    haloScale: 1.1 + 0.9 * phase,
    haloOpacity: 0.7 * (1 - phase) * (1 - phase),
    pillarOpacity: 0.65 + 0.25 * Math.cos(phase * 2 * Math.PI),
  };
}

/** What a glyph shows: its shape and symbol by kind, and the badge's text when several wait. */
export interface GlyphSpec {
  kind: QuestionKind;
  shape: 'diamond' | 'disc';
  symbol: 'lock' | '?';
  /** `undefined` for one question; "2" … "9", then "9+". */
  badge: string | undefined;
}

export function glyphSpec(kind: QuestionKind, count: number): GlyphSpec {
  return {
    kind,
    shape: kind === 'permission' ? 'diamond' : 'disc',
    symbol: kind === 'permission' ? 'lock' : '?',
    badge: count <= 1 ? undefined : count > 9 ? '9+' : String(count),
  };
}

/** A glyph texture's cache key (one texture per kind and badge). */
export const glyphKey = (g: GlyphSpec): string => `${g.kind}:${g.badge ?? ''}`;
