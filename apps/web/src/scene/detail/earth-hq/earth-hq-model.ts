import type { AgentState } from '@galactic/protocol';
import { HEADQUARTERS_BODY_ID } from '../../picking/body-action.js';
import { hqRingSpeed, hqThinking } from '../../satellites/hq/hq-model.js';
import { BASE_SHELL } from '../../satellites/orbits.js';
import { SATELLITE_LOOK } from '../../satellites/look.js';
import type { DetailBody } from '../detail-body.js';

/**
 * Earth as headquarters (P6-05; SPEC decisions 72, 82, 84), as data. No three.js.
 *
 * In Earth's detail view the Harmonizer's HQ station is drawn by a more detailed model (modules,
 * four solar arrays, a docking ring, a turning habitat ring, navigation lights, a "thinking" glow:
 * `earth-hq-mesh.ts`, `EarthHq.tsx`) in place of the system-scale one (`claimHqStation`). It sits
 * at the Harmonizer's satellite frame — the same pose, size and state colour as the system HQ
 * — so the frame's picking, hover card ("Harmonizer · …") and click (select the Harmonizer, open
 * its chat) are the system HQ's. With no Harmonizer running there is no frame: the station rests
 * dark at a fixed place in Earth's orbit (`restingPose`), its ring and lights still.
 */

/** The part's id in `DETAIL_PARTS`. */
export const EARTH_HQ_PART = 'earth-hq';

/** Only Earth's detail view has the station. */
export function isHeadquarters(body: Pick<DetailBody, 'bodyId'>): boolean {
  return body.bodyId === HEADQUARTERS_BODY_ID;
}

/**
 * What the station shows: no Harmonizer (`none`, also once it ended), thinking (a turn is
 * running), waiting for the user, idle, or halted (paused, stalled, failed).
 */
export type StationMood = 'none' | 'thinking' | 'waiting' | 'idle' | 'halted';

export function stationMood(state: AgentState | undefined): StationMood {
  if (state === undefined) return 'none';
  if (hqThinking(state)) return 'thinking';
  switch (state) {
    case 'waiting_for_input':
      return 'waiting';
    case 'idle':
      return 'idle';
    case 'paused':
    case 'stalled':
    case 'failed':
      return 'halted';
    default:
      return 'none'; // finished, stopped, interrupted: not running
  }
}

/** The navigation lights: blinking, lit steadily (reduced motion), or off. */
export type LightMode = 'blink' | 'steady' | 'off';

export interface StationLook {
  mood: StationMood;
  /** The habitat ring's spin (rad/s): fast thinking, slow idle, 0 halted, dark or reduced. */
  ringSpin: number;
  lights: LightMode;
  /** The "thinking" glow's strength (0 none … 1); it pulses unless `still`. */
  glow: number;
  /** No Harmonizer: the station is drawn in `STATION.dark`, unlit. */
  dark: boolean;
  /** Reduced motion: nothing spins, blinks or pulses. */
  still: boolean;
}

export const STATION = {
  /** The hull's colour with no Harmonizer (dark grey-blue, steady). */
  dark: '#3b4354',
  darkBrightness: 0.55,
  /** Navigation lights: port red and starboard green blink slowly together… */
  navPeriod: 1.6,
  navDuty: 0.5,
  navOff: 0.18,
  /** …and a white strobe on the top module flashes twice every `strobePeriod`. */
  strobePeriod: 2.4,
  strobeFlash: 0.08,
  /** The thinking glow's breath, seconds, and its level range. */
  glowPeriod: 1.8,
  glowMin: 0.35,
  glowMax: 1,
  /** The steady glow under reduced motion (still brighter than none: thinking still reads). */
  glowStill: 0.6,
} as const;

/** The station's look for the Harmonizer's state (`undefined`: none running). */
export function stationLook(state: AgentState | undefined, reducedMotion: boolean): StationLook {
  const mood = stationMood(state);
  const dark = mood === 'none';
  const lights: LightMode =
    dark || state === 'failed' ? 'off' : reducedMotion || state === 'paused' ? 'steady' : 'blink';
  return {
    mood,
    ringSpin: dark || !state ? 0 : hqRingSpeed(state, reducedMotion),
    lights,
    glow: mood === 'thinking' ? 1 : 0,
    dark,
    still: reducedMotion,
  };
}

const frac = (x: number): number => x - Math.floor(x);

/** The red and green lights' level at time `t` (motion seconds). */
export function navLevel(look: StationLook, t: number): number {
  if (look.lights === 'off') return 0;
  if (look.lights === 'steady') return 1;
  return frac(t / STATION.navPeriod) < STATION.navDuty ? 1 : STATION.navOff;
}

/** The white strobe's level at time `t`: two short flashes per period. */
export function strobeLevel(look: StationLook, t: number): number {
  if (look.lights === 'off') return 0;
  if (look.lights === 'steady') return 0.6;
  const x = frac(t / STATION.strobePeriod);
  const flash = STATION.strobeFlash;
  return x < flash || (x >= 2 * flash && x < 3 * flash) ? 1.6 : 0;
}

/** The thinking glow's level at time `t` (0 when not thinking; steady under reduced motion). */
export function glowLevel(look: StationLook, t: number): number {
  if (look.glow <= 0) return 0;
  if (look.still) return STATION.glowStill * look.glow;
  const x = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / STATION.glowPeriod);
  return (STATION.glowMin + (STATION.glowMax - STATION.glowMin) * x) * look.glow;
}

/**
 * Where the dark station rests with no Harmonizer, in Earth's frame (body radii scaled by the
 * anchor's `radius`): on the innermost satellite shell, a little above the equator, at the
 * Harmonizer's size. Its −y faces Earth's centre.
 */
export function restingPose(radius: number): {
  position: [number, number, number];
  size: number;
} {
  const r = BASE_SHELL * radius;
  const lift = 0.2;
  return {
    position: [r * Math.cos(lift), r * Math.sin(lift), 0],
    size: SATELLITE_LOOK.harmonizer.size * radius,
  };
}
