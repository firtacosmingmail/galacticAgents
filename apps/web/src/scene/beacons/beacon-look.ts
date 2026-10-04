import type { QuestionKind } from '@galactic/protocol';
import { PULSE } from '../satellites/look.js';

/**
 * How a beacon looks (P4-05), as numbers and pure functions. No three.js.
 *
 * A beacon is a billboard facing the camera, measured in **screen pixels** at its body's depth (the
 * renderer scales its group by world units per pixel), so it reads the same at the whole-system
 * view and up close, and on the phone:
 * - a thin amber **light pillar** rising from the top of the body (screen up, whatever the camera's
 *   angle — a world-vertical pillar would vanish in a top-down view);
 * - on top of it, the **glyph**: an amber diamond with a padlock for a permission, an amber disc
 *   with "?" for a clarification (one beacon per question, P4-13), and a "+n" badge on the last
 *   beacon of a full row (`MAX_BEACONS_PER_BODY`) for the questions past it;
 * - several beacons on one body stand side by side in a **row** centred above it, `spacingPx`
 *   apart (their click targets do not overlap), their pillars fanning out from the body's top;
 * - a **halo** ring around the glyph that pulses outwards, in step with the amber blink of a
 *   satellite waiting for the user (P4-02), steady under reduced motion. A beacon is a pillar and
 *   a glyph above the body, never another dot: the waiting satellite is the dot.
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
  glyphPx: 34,
  /** The pillar's width, in pixels (its texture fades to the sides). */
  pillarPx: 6,
  /** The glyph's centre never closer than this to the top of the viewport, in pixels. */
  topMarginPx: 22,
  /** The click / tap target's radius around the glyph's centre, in pixels (36 px across: a tap). */
  targetPx: 18,
  /**
   * The distance between the centres of two beacons side by side on one body, in pixels: more
   * than the glyph (34 px) and its click target (36 px across), so each is its own target.
   */
  spacingPx: 40,
  /**
   * One pulse of the halo, in seconds: the waiting satellites' blink (P4-02, `PULSE.blink`), on
   * the same motion clock and in phase (both peak at whole periods), so the scene has one
   * "waiting for you" rhythm, not two.
   */
  pulseSeconds: PULSE.blink,
} as const;

export interface BeaconLayout {
  /** The glyph's centre right of the body's centre, in pixels (screen right; 0 for one beacon). */
  glyphX: number;
  /** The glyph's centre above the body's centre, in pixels (screen up). */
  glyphY: number;
  /**
   * The pillar runs from the body's top, `pillarFrom` above the body's centre (on its vertical),
   * to `pillarTo` above it under the glyph (at `glyphX`): straight up for one beacon, fanning out
   * for a row. Empty (`pillarTo <= pillarFrom`): none.
   */
  pillarFrom: number;
  pillarTo: number;
}

/** A beacon's offset in its body's row, in pixels right of the body's centre (`slot` of `slots`). */
export function rowOffsetPx(slot: number, slots: number): number {
  return (slot - (Math.max(1, slots) - 1) / 2) * BEACON.spacingPx;
}

/**
 * Where the parts go, in pixels from the body's centre on screen: `radiusPx` is the body's radius
 * on screen, `bodyY` its centre's distance from the top of the viewport (CSS pixels), `slot` of
 * `slots` the beacon's place in its body's row. Written into `out` (the renderer passes one
 * scratch object: no allocation per frame).
 */
export function beaconLayout(
  radiusPx: number,
  bodyY: number,
  out: BeaconLayout = { glyphX: 0, glyphY: 0, pillarFrom: 0, pillarTo: 0 },
  slot = 0,
  slots = 1,
): BeaconLayout {
  let glyphY = radiusPx + BEACON.liftPx;
  // Close up the body fills the screen: keep the glyph inside the viewport's top edge.
  if (bodyY - glyphY < BEACON.topMarginPx) glyphY = Math.max(0, bodyY - BEACON.topMarginPx);
  const pillarTo = glyphY - BEACON.glyphPx / 2;
  out.glyphX = rowOffsetPx(slot, slots);
  out.glyphY = glyphY;
  out.pillarTo = pillarTo;
  out.pillarFrom = Math.min(radiusPx, pillarTo);
  return out;
}

/** The halo's largest radius, in pixels (the pulse's peak scale times the glyph's half size). */
export const HALO_MAX_PX = (BEACON.glyphPx / 2) * 2;

/**
 * Whether a beacon's glyph (with its halo at its widest) is on screen: `ndcX`/`ndcY` are its body
 * centre's normalised device coordinates, `glyphY` the glyph's lift above it in pixels (screen
 * up), `glyphX` its offset in its body's row (screen right), `width`/`height` the viewport in CSS
 * pixels. The pillar runs from the body up to the glyph, and the glyph is held inside the top edge
 * while the body is on screen, so a glyph off screen means the whole beacon is (nearly: a row's
 * slanted pillar may still cross a corner): it is not drawn (three draw calls saved) nor clickable.
 */
export function glyphInView(
  ndcX: number,
  ndcY: number,
  glyphY: number,
  width: number,
  height: number,
  glyphX = 0,
): boolean {
  const x = ((ndcX + 1) / 2) * width + glyphX;
  const y = ((1 - ndcY) / 2) * height - glyphY;
  const r = HALO_MAX_PX;
  return x + r >= 0 && x - r <= width && y + r >= 0 && y - r <= height;
}

export interface BeaconPulse {
  /** The halo's radius as a multiple of the glyph's half size. */
  haloScale: number;
  haloOpacity: number;
  pillarOpacity: number;
}

/** The steady look (reduced motion): a visible halo, a full pillar, no change over time. */
export const STEADY_PULSE: Readonly<BeaconPulse> = {
  haloScale: 1.35,
  haloOpacity: 0.45,
  pillarOpacity: 0.8,
};

/**
 * The pulse at time `t` (seconds, the shared motion clock): the halo grows from the glyph's edge
 * outwards (to `HALO_MAX_PX`) and fades, the pillar breathes a little. Under reduced motion:
 * `STEADY_PULSE`. Written into `out` otherwise (the renderer's scratch object).
 */
export function beaconPulse(
  t: number,
  reducedMotion: boolean,
  out: BeaconPulse = { haloScale: 0, haloOpacity: 0, pillarOpacity: 0 },
): Readonly<BeaconPulse> {
  if (reducedMotion) return STEADY_PULSE;
  const phase = (((t / BEACON.pulseSeconds) % 1) + 1) % 1;
  out.haloScale = 1.1 + 0.9 * phase;
  out.haloOpacity = 0.7 * (1 - phase) * (1 - phase);
  out.pillarOpacity = 0.65 + 0.25 * Math.cos(phase * 2 * Math.PI);
  return out;
}

/** What a glyph shows: its shape and symbol by kind, and the "+n" badge of a full row's last. */
export interface GlyphSpec {
  kind: QuestionKind;
  shape: 'diamond' | 'disc';
  symbol: 'lock' | '?';
  /** `undefined` for no questions past it; "+1" … "+99". */
  badge: string | undefined;
}

/** `more`: the questions on the body without a beacon of their own (`BeaconSpec.more`). */
export function glyphSpec(kind: QuestionKind, more = 0): GlyphSpec {
  return {
    kind,
    shape: kind === 'permission' ? 'diamond' : 'disc',
    symbol: kind === 'permission' ? 'lock' : '?',
    badge: more <= 0 ? undefined : `+${Math.min(more, 99)}`,
  };
}

/** A glyph texture's cache key (one texture per kind and badge). */
export const glyphKey = (g: GlyphSpec): string => `${g.kind}:${g.badge ?? ''}`;
