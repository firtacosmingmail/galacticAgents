import { describe, expect, it } from 'vitest';
import {
  BEACON,
  beaconLayout,
  beaconPulse,
  glyphInView,
  glyphKey,
  glyphSpec,
  HALO_MAX_PX,
  STEADY_PULSE,
} from './beacon-look.js';
import { drawGlyph, drawPillar } from './glyph-draw.js';
import { PULSE, pulseAt } from '../satellites/look.js';
import { beaconUnder, type BeaconFrame } from './registry.js';

describe('beaconLayout', () => {
  it('lifts the glyph above the body (clear of its label), the pillar up to the glyph', () => {
    const l = beaconLayout(3, 300);
    expect(l.glyphY).toBe(3 + BEACON.liftPx);
    expect(l.pillarFrom).toBe(3);
    expect(l.pillarTo).toBe(3 + BEACON.liftPx - BEACON.glyphPx / 2);
  });

  it('keeps the glyph inside the top of the viewport when the body is big on screen', () => {
    // Body centre 200 px below the top, radius 400 px: the glyph slides down over the body.
    const l = beaconLayout(400, 200);
    expect(200 - l.glyphY).toBe(BEACON.topMarginPx);
    expect(l.pillarTo).toBeLessThan(l.pillarFrom + 1); // no pillar inside the body
    // A body whose centre is above the viewport: the glyph stays on it, never below it.
    expect(beaconLayout(400, -50).glyphY).toBe(0);
  });
});

describe('beaconPulse', () => {
  it('pulses on the motion clock: the halo grows and fades', () => {
    const start = beaconPulse(0, false);
    const later = beaconPulse(BEACON.pulseSeconds * 0.5, false);
    expect(later.haloScale).toBeGreaterThan(start.haloScale);
    expect(later.haloOpacity).toBeLessThan(start.haloOpacity);
    const again = beaconPulse(BEACON.pulseSeconds * 3, false);
    expect(again.haloScale).toBeCloseTo(start.haloScale, 9);
    expect(again.haloOpacity).toBeCloseTo(start.haloOpacity, 9);
    expect(beaconPulse(-0.4, false).haloOpacity).toBeGreaterThanOrEqual(0);
  });

  it("is in step with a waiting satellite's blink: same period, both peak together", () => {
    expect(BEACON.pulseSeconds).toBe(PULSE.blink);
    for (const t of [0, PULSE.blink, PULSE.blink * 7]) {
      expect(beaconPulse(t, false).pillarOpacity).toBeCloseTo(0.9, 9);
      expect(beaconPulse(t, false).haloOpacity).toBeCloseTo(0.7, 9);
      expect(pulseAt('blink', t)).toBeCloseTo(1.9, 9);
    }
    // Half a period later both are at their low.
    const half = PULSE.blink / 2;
    expect(beaconPulse(half, false).pillarOpacity).toBeCloseTo(0.4, 9);
    expect(pulseAt('blink', half)).toBeCloseTo(0.4, 9);
  });

  it('is steady under reduced motion, whatever the time', () => {
    expect(beaconPulse(0, true)).toEqual(STEADY_PULSE);
    expect(beaconPulse(0.7, true)).toEqual(STEADY_PULSE);
    expect(STEADY_PULSE.haloOpacity).toBeGreaterThan(0);
    expect(STEADY_PULSE.pillarOpacity).toBeGreaterThan(0);
  });
});

describe('glyphSpec', () => {
  it('a padlock diamond for a permission, a "?" disc for a clarification, a badge for several', () => {
    expect(glyphSpec('permission', 1)).toEqual({
      kind: 'permission',
      shape: 'diamond',
      symbol: 'lock',
      badge: undefined,
    });
    expect(glyphSpec('clarification', 2)).toMatchObject({ shape: 'disc', symbol: '?', badge: '2' });
    expect(glyphSpec('clarification', 12).badge).toBe('9+');
    expect(glyphKey(glyphSpec('permission', 3))).toBe('permission:3');
    expect(glyphKey(glyphSpec('permission', 1))).not.toBe(glyphKey(glyphSpec('clarification', 1)));
  });
});

/** A 2D context that records what is drawn. */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineJoin: 'miter' as CanvasLineJoin,
    font: '',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    beginPath: () => calls.push('beginPath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    closePath: () => calls.push('closePath'),
    arc: () => calls.push('arc'),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    fillRect: () => calls.push('fillRect'),
    fillText: (t: string) => calls.push(`text:${t}`),
    clearRect: () => calls.push('clearRect'),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
  };
  return { ctx: ctx as unknown as Parameters<typeof drawGlyph>[0], calls };
}

describe('glyph sprites (drawn at runtime)', () => {
  it('a permission draws a diamond and a padlock, no "?"', () => {
    const { ctx, calls } = recorder();
    drawGlyph(ctx, glyphSpec('permission', 1));
    expect(calls.filter((c) => c === 'lineTo')).toHaveLength(3);
    expect(calls).toContain('fillRect'); // the padlock's body
    expect(calls.some((c) => c.startsWith('text:'))).toBe(false);
  });

  it('a clarification draws "?" on a disc, and the count badge when several', () => {
    const { ctx, calls } = recorder();
    drawGlyph(ctx, glyphSpec('clarification', 3));
    expect(calls).toContain('text:?');
    expect(calls).toContain('text:3');
    expect(calls).not.toContain('lineTo');
  });

  it('the pillar fills every column', () => {
    const { ctx, calls } = recorder();
    drawPillar(ctx, 8, 32);
    expect(calls.filter((c) => c === 'fillRect')).toHaveLength(8);
  });
});

describe('beaconUnder (picking a beacon)', () => {
  // The camera at z 10 looking down -z; 72 px per world unit at depth 10 (perPx = 1/72).
  const ray = (x: number, y: number) => {
    const len = Math.hypot(x, y, -10);
    return {
      origin: [0, 0, 10] as [number, number, number],
      direction: [x / len, y / len, -10 / len] as [number, number, number],
    };
  };
  const frame = (bodyId: string, x: number, y: number, visible = true): BeaconFrame => ({
    bodyId,
    visible,
    center: [x, y, 0],
    perPx: 1 / 72,
  });

  it('hits within the target radius, nearest the pointer first', () => {
    const frames = [frame('b-a', 0, 0), frame('b-b', 0.2, 0)];
    expect(beaconUnder(ray(0, 0), frames)).toBe('b-a');
    expect(beaconUnder(ray(0.18, 0), frames)).toBe('b-b');
    // 18 px = 0.25 units: inside; 0.4 units = 29 px: outside.
    expect(beaconUnder(ray(0, 0.24), [frame('b-a', 0, 0)])).toBe('b-a');
    expect(beaconUnder(ray(0, 0.4), [frame('b-a', 0, 0)])).toBeUndefined();
  });

  it('skips hidden beacons and those behind the camera', () => {
    expect(beaconUnder(ray(0, 0), [frame('b-a', 0, 0, false)])).toBeUndefined();
    const behind: BeaconFrame = { bodyId: 'b-z', visible: true, center: [0, 0, 20], perPx: 1 };
    expect(beaconUnder(ray(0, 0), [behind])).toBeUndefined();
  });
});

describe('glyphInView (off-screen beacons are not drawn)', () => {
  const [w, h] = [800, 600];
  it('is true for a glyph on screen, and for one whose halo still reaches in', () => {
    expect(glyphInView(0, 0, 80, w, h)).toBe(true);
    // The body just right of the edge: its glyph's halo still pokes in.
    const justOut = 1 + ((HALO_MAX_PX - 1) / w) * 2;
    expect(glyphInView(justOut, 0, 80, w, h)).toBe(true);
  });

  it('is false once the glyph and its widest halo are past any edge', () => {
    const past = 1 + ((HALO_MAX_PX + 1) / w) * 2;
    expect(glyphInView(past, 0, 80, w, h)).toBe(false);
    expect(glyphInView(-past, 0, 80, w, h)).toBe(false);
    // Above the top: the glyph is lifted 80 px over a body already at the top edge.
    expect(glyphInView(0, 1, 80, w, h)).toBe(false);
    // Below the bottom: the body far below, its glyph too.
    expect(glyphInView(0, -1.5, 80, w, h)).toBe(false);
    // A body just below the bottom edge whose glyph is lifted into view is drawn.
    expect(glyphInView(0, -1.05, 80, w, h)).toBe(true);
  });
});

describe('no allocation per frame', () => {
  it('beaconLayout and beaconPulse write into the scratch object they are given', () => {
    const layout = { glyphY: 0, pillarFrom: 0, pillarTo: 0 };
    expect(beaconLayout(3, 300, layout)).toBe(layout);
    expect(layout.glyphY).toBe(3 + BEACON.liftPx);
    const pulse = { haloScale: 0, haloOpacity: 0, pillarOpacity: 0 };
    expect(beaconPulse(0.3, false, pulse)).toBe(pulse);
    expect(pulse.haloScale).toBeGreaterThan(1);
    expect(beaconPulse(0.3, true, pulse)).toBe(STEADY_PULSE);
  });
});
