import type { AgentRole, AgentState } from '@galactic/protocol';
import type { SatelliteSpec } from './satellite-model.js';
import type { SatelliteView } from './machine.js';
import { hashId, seedFraction } from './machine.js';

/**
 * How a satellite looks (P4-01, P4-02). One table, read every frame by both renderers (one mesh
 * pair per satellite, or the instanced path) and by the HQ station; the panel's legend draws the
 * same table in CSS. No three.js.
 *
 * - `size`: the satellite's span in its body's radii; `minPx`: the smallest it is drawn on screen,
 *   so a satellite stays visible at the system view (`maxSize` keeps that floor from making it
 *   larger than a few body radii around a tiny moon);
 * - the Waykeeper is the larger, warmer satellite; Stewards are smaller and cooler (SPEC §4.1:
 *   "smaller satellites doing work"); the Harmonizer's HQ station (P4-02, `hq/`) is the largest.
 *   The Waykeeper's warm white stays clear of the amber that only "waiting for you" uses.
 */
export const SATELLITE_LOOK: Readonly<
  Record<AgentRole, { color: string; size: number; minPx: number; maxSize: number }>
> = {
  harmonizer: { color: '#e8f0ff', size: 0.42, minPx: 7, maxSize: 1.4 },
  waykeeper: { color: '#ffe6b0', size: 0.16, minPx: 3, maxSize: 1 },
  steward: { color: '#a8dcff', size: 0.11, minPx: 2.2, maxSize: 0.8 },
};

/**
 * The pulse patterns (P4-02). Each is a brightness multiplier over time; every one has a reduced
 * motion variant that is still (`STATE_LOOK[state].still`). Colour is never the only cue: each
 * problem state also differs in pattern, size or motion (colour-blind safe).
 * - `breathe`: slow, soft (working: alive and busy), de-synchronised per agent;
 * - `blink`: a firm on/off every 1.6 s, the panel's and the labels' beacon rhythm, synchronised
 *   across satellites (waiting for you: the loudest thing in the scene);
 * - `stutter`: a double hiccup every 2.4 s (stalled: something is stuck);
 * - `flicker`: mostly dim with short random drop-outs (failed: a dying light);
 * - `steady`: no pulse (idle, paused, starting, and every ended state).
 */
export type Pulse = 'breathe' | 'blink' | 'stutter' | 'flicker' | 'steady';

export interface StateLook {
  /** The tint: a CSS colour, or `role` for the role's own colour (`SATELLITE_LOOK`). */
  color: string;
  pulse: Pulse;
  /** Base brightness (multiplies the tint; above ≈ 1.4 a bright tint blooms with a composer). */
  level: number;
  /** Brightness under reduced motion, where there is no pulse. */
  still: number;
  /** Size multiplier: a shape cue that survives reduced motion and colour blindness. */
  scale: number;
  /**
   * How fast it goes round its orbit, relative to its role's speed: 0 holds it still where it is
   * (paused), a fraction makes it drift (failed). Reduced motion stills every orbit anyway.
   */
  orbitRate: number;
  /** The legend's words. */
  label: string;
  /** The legend's one-line explanation. */
  hint: string;
}

/** The role's own colour in `STATE_LOOK`. */
export const ROLE_COLOR = 'role';

/** The amber of "blocked on you": the panel's beacon (`--pnl-beacon`) and the labels'. */
export const WAITING_AMBER = '#ffb547';

/**
 * Every agent state's look (P4-02; SPEC §4.4: "blocked on user" is the most prominent state
 * everywhere). Only live states and `failed` have a satellite today (`satellite-model.ts`);
 * `finished` is for P4-04's landed satellites; `stopped` / `interrupted` are listed so the table
 * is total.
 */
export const STATE_LOOK: Readonly<Record<AgentState, StateLook>> = {
  working: {
    color: ROLE_COLOR,
    pulse: 'breathe',
    level: 1,
    still: 1.1,
    scale: 1,
    orbitRate: 1,
    label: 'Working',
    hint: 'breathes, and scans its body now and then',
  },
  starting: {
    color: ROLE_COLOR,
    pulse: 'steady',
    level: 0.8,
    still: 0.8,
    scale: 1,
    orbitRate: 1,
    label: 'Starting',
    hint: 'steady, a little dim',
  },
  waiting_for_input: {
    color: WAITING_AMBER,
    pulse: 'blink',
    level: 1,
    still: 1.7,
    scale: 1.35,
    orbitRate: 1,
    label: 'Waiting for you',
    hint: 'amber, larger, blinking',
  },
  idle: {
    color: '#8e97ad',
    pulse: 'steady',
    level: 0.7,
    still: 0.7,
    scale: 1,
    orbitRate: 1,
    label: 'Idle',
    hint: 'grey, steady',
  },
  paused: {
    color: '#a58fff',
    pulse: 'steady',
    level: 0.85,
    still: 0.85,
    scale: 1,
    orbitRate: 0,
    label: 'Paused',
    hint: 'violet, holds still on its orbit',
  },
  stalled: {
    color: '#ff7a45',
    pulse: 'stutter',
    level: 1,
    still: 1,
    scale: 1,
    orbitRate: 1,
    label: 'Stalled',
    hint: 'orange, hiccups',
  },
  failed: {
    color: '#ff4d5a',
    pulse: 'flicker',
    level: 0.6,
    still: 0.5,
    scale: 0.8,
    orbitRate: 0.3,
    label: 'Failed',
    hint: 'red, smaller, flickers and drifts',
  },
  finished: {
    color: ROLE_COLOR,
    pulse: 'steady',
    level: 0.6,
    still: 0.6,
    scale: 1,
    orbitRate: 1,
    label: 'Finished',
    hint: 'dim, steady',
  },
  stopped: {
    color: '#6f7891',
    pulse: 'steady',
    level: 0.5,
    still: 0.5,
    scale: 1,
    orbitRate: 1,
    label: 'Stopped',
    hint: 'grey, dim',
  },
  interrupted: {
    color: '#6f7891',
    pulse: 'steady',
    level: 0.5,
    still: 0.5,
    scale: 1,
    orbitRate: 1,
    label: 'Interrupted',
    hint: 'grey, dim',
  },
};

/** The states the legend explains, loudest first (the ones a satellite shows today). */
export const LEGEND_STATES: readonly AgentState[] = [
  'waiting_for_input',
  'failed',
  'stalled',
  'working',
  'paused',
  'idle',
];

/** Pulse timings, seconds. */
export const PULSE = {
  breathe: 3.2,
  blink: 1.6,
  stutter: 2.4,
  /** One flicker cell: each cell is dark with probability `flickerDark`. */
  flickerCell: 0.12,
  flickerDark: 0.14,
} as const;

/**
 * The scanning beam: a cone from the satellite to its body's surface, additive, bright only at
 * the satellite. `color` is linear RGB; with bloom (`bloomGain`) its luminance passes the bloom
 * threshold (1.0, `quality.ts`) only at the apex, so the beam glows there; along its length the
 * brightness falls off steeply (`beamProfile`: `(1 − along)^falloff`), so where the beam crosses
 * the body it adds at most ≈ 0.15 luminance (`MAX_BODY_LUMINANCE`) — a linear fade washed bright
 * planets out into a pale spot (front faces only: an additive double-sided cone doubled it).
 * Without a composer (the mobile tier, `plainGain`) it is a soft translucent cone. `width` is the
 * footprint's radius in body radii; `sweep` the half-angle (radians) the beam swings across the
 * surface during a scan; `segments` the cone's rings along its length (the profile is sampled
 * there: one ring would interpolate it linearly again).
 */
export const BEAM = {
  color: [0.4, 0.95, 1.3] as const,
  bloomGain: 1.25,
  plainGain: 0.35,
  width: 0.22,
  sweep: 0.2,
  /** The base end's brightness relative to the apex (vertex colours). */
  baseFade: 0.02,
  /** The exponent of the falloff from the apex. */
  falloff: 3,
  segments: 12,
} as const;

/** The most luminance the beam adds over its body: from halfway down the beam to its footprint. */
export const MAX_BODY_LUMINANCE = 0.155;

/** The beam's brightness at `along` (0 at the apex, 1 at the footprint), relative to the apex. */
export function beamProfile(along: number): number {
  const a = Math.min(1, Math.max(0, along));
  return BEAM.baseFade + (1 - BEAM.baseFade) * (1 - a) ** BEAM.falloff;
}

/** Relative luminance (Rec. 709) of a linear RGB colour. */
export function luminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

type LookSpec = Pick<SatelliteSpec, 'role' | 'state'> & { agentId?: string };

/** A satellite's colour (CSS): its state's, or its role's while the state uses the role colour. */
export function satelliteTint(spec: Pick<SatelliteSpec, 'role' | 'state'>): string {
  const color = STATE_LOOK[spec.state].color;
  return color === ROLE_COLOR ? SATELLITE_LOOK[spec.role].color : color;
}

/** The size multiplier of a satellite's state (waiting larger, failed smaller). */
export function satelliteScale(spec: Pick<SatelliteSpec, 'state'>): number {
  return STATE_LOOK[spec.state].scale;
}

/** How fast its orbit turns relative to its role's speed (paused 0, failed drifts). */
export function satelliteOrbitRate(spec: Pick<SatelliteSpec, 'state'>): number {
  return STATE_LOOK[spec.state].orbitRate;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const frac = (x: number): number => x - Math.floor(x);

/** A pulse's multiplier at time `t` (seconds), for an agent seeded `seed`. Pure. */
export function pulseAt(pulse: Pulse, t: number, seed = 0): number {
  switch (pulse) {
    case 'breathe': {
      const phase = seedFraction(seed, 7);
      const x = 0.5 - 0.5 * Math.cos(2 * Math.PI * (t / PULSE.breathe + phase));
      return 0.82 + 0.38 * x; // 0.82 → 1.2
    }
    case 'blink': {
      // Synchronised (no seed): every waiting satellite blinks together, like one alarm.
      const s = 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / PULSE.blink);
      return 0.4 + 1.5 * smoothstep(0.3, 0.7, s); // 0.4 ↔ 1.9: a firm on/off, blooming when on
    }
    case 'stutter': {
      const p = frac(t / PULSE.stutter + seedFraction(seed, 8));
      const dip = (p > 0.02 && p < 0.08) || (p > 0.14 && p < 0.2);
      return dip ? 0.3 : 1;
    }
    case 'flicker': {
      const cell = Math.floor(t / PULSE.flickerCell);
      return seedFraction(seed, 1000 + cell) < PULSE.flickerDark ? 0.25 : 1;
    }
    case 'steady':
      return 1;
  }
}

/**
 * A multiplier on the tint, per frame: the state's level times its pulse (P4-02); under reduced
 * motion the state's still level, no pulse. Satellites are unlit (`MeshBasicMaterial`, shaded by
 * the geometry's vertex colours) so their colour reads the same on a body's night side.
 */
export function satelliteBrightness(
  spec: LookSpec,
  _view: SatelliteView | undefined,
  now: number,
  reducedMotion = false,
): number {
  const look = STATE_LOOK[spec.state];
  if (reducedMotion) return look.still;
  return look.level * pulseAt(look.pulse, now, spec.agentId ? hashId(spec.agentId) : 0);
}

const LINEAR_CACHE = new Map<string, readonly [number, number, number]>();

/** A `#rrggbb` colour in linear RGB (three-free; matches three's sRGB → linear conversion). */
export function linearRgb(hex: string): readonly [number, number, number] {
  let rgb = LINEAR_CACHE.get(hex);
  if (rgb) return rgb;
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  rgb = [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)] as const;
  LINEAR_CACHE.set(hex, rgb);
  return rgb;
}

/**
 * The beam's colour (linear RGB, before the bloom gain): cyan while the agent works — the only
 * time it scans — and its state's colour, at the cyan's luminance, while a beam cut short by a
 * state change fades out (it turns amber as the agent starts waiting, for instance).
 */
export function beamTint(
  spec: Pick<SatelliteSpec, 'role' | 'state'>,
): readonly [number, number, number] {
  if (spec.state === 'working' || spec.state === 'starting') return BEAM.color;
  const tint = satelliteTint(spec);
  const key = `beam:${tint}`;
  let out = LINEAR_CACHE.get(key);
  if (!out) {
    const rgb = linearRgb(tint);
    const k = luminance(BEAM.color) / Math.max(1e-6, luminance(rgb));
    out = [rgb[0] * k, rgb[1] * k, rgb[2] * k] as const;
    LINEAR_CACHE.set(key, out);
  }
  return out;
}
