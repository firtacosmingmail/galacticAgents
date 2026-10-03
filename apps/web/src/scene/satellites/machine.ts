import type { AgentState } from '@galactic/protocol';

/**
 * The satellite actor's state machine (P4-01; TECHNOLOGY §2.1, SPEC §3.4, §4.1, decisions 4, 9).
 * Pure: no three.js, no React, no clock of its own. `advance(actor, input, now)` folds what the
 * status store says about the agent (`SatelliteInput`) into the actor at time `now` (seconds of
 * the scene's motion clock, `motionSeconds`) and returns the next actor (the same object when
 * nothing changed). `sampleActor(actor, now)` turns it into what the renderer draws.
 *
 * Every timed step is stored as absolute times (when it started, how long it lasts), never as
 * per-frame progress, so a flight started while the camera looks elsewhere — or while the frame
 * loop is capped, on demand, or not running at all — has completed by the next frame that asks
 * (corner case 26). A flight runs to completion: inputs that arrive mid-flight (landing, an
 * activity) wait for the arrival; only a new destination retargets it.
 *
 * Who drives which input:
 * - `bodyId`: the body the agent works on (P4-01, from the world; a move changes it → `flying`);
 * - `state`: `StatusRecord.state` (P4-01: a `working` agent scans its body periodically; P4-02
 *   maps every state to a colour and pulse in `look.ts`);
 * - `archetype`: the Steward activity archetype (P4-03 derives it from `current_activity`);
 * - `landed`: the work completed (P4-04: the satellite lands and the body is colonised).
 */
export const SATELLITE_MODES = [
  'orbiting',
  'scanning',
  'gathering',
  'transporting',
  'building',
  'flying',
  'landing',
  'landed',
] as const;
export type SatelliteMode = (typeof SATELLITE_MODES)[number];

/** The Steward activity archetypes (P4-03, SPEC §4.1). */
export type ActivityArchetype = 'gathering' | 'transporting' | 'building';
export const ARCHETYPES: readonly ActivityArchetype[] = ['gathering', 'transporting', 'building'];

/** What the world says about one satellite's agent; the machine's only input. */
export interface SatelliteInput {
  /** The body the agent works on: a Waykeeper's project's body, a Steward's task's body. */
  bodyId: string;
  /** `StatusRecord.state`. */
  state: AgentState;
  /** P4-03: the activity archetype derived from `current_activity`; `undefined` = none. */
  archetype?: ActivityArchetype | undefined;
  /** P4-04: the work completed — land on the body (and stay landed while it holds). */
  landed?: boolean | undefined;
}

/** The last mode change: the renderer blends from `from` into the current mode over `duration`. */
export interface ModeTween {
  from: SatelliteMode;
  start: number;
  duration: number;
}

/** A flight between bodies (`body.moved`, SPEC §3.4). */
export interface Flight {
  fromBodyId: string;
  toBodyId: string;
  start: number;
  duration: number;
}

export interface SatelliteActor {
  agentId: string;
  mode: SatelliteMode;
  /** The body the satellite belongs to; during a flight, the destination. */
  bodyId: string;
  tween: ModeTween;
  flight?: Flight | undefined;
  /** Scanning: when the current scan started and ends. */
  scan?: { start: number; end: number } | undefined;
  /** When an orbiting, working satellite next scans its body. */
  nextScanAt: number;
  /** Scans so far (varies the interval between them deterministically). */
  scans: number;
  /** From the agent id (`hashId`): de-synchronises the satellites' scans. */
  seed: number;
}

export interface MachineOptions {
  /** `prefers-reduced-motion`: no scans, and every tween, flight and landing is instant. */
  reducedMotion?: boolean | undefined;
}

/** Durations in seconds. */
export const TIMING = {
  /** Blend between two modes (beam fade, archetype in/out, take-off). */
  modeTween: 0.6,
  /** A flight between two bodies; long enough to follow, short enough to finish soon. */
  flight: 3,
  /** Descent from the orbit to the surface. */
  landing: 1.6,
  /** One scan of the body. */
  scan: 2.4,
  /** Time between scans, `[min, max)`; each interval is picked from the seed and the scan count. */
  scanEvery: [5, 10] as const,
  /** The beam's fade in and out at either end of a scan. */
  beamFade: 0.35,
} as const;

/**
 * The transition table: which modes each mode may go to. `advance` only ever takes these edges
 * (a test walks it), so a later task adding a trigger cannot invent a jump the renderer does not
 * know how to blend. A flight goes nowhere but its arrival (`orbiting`) or a new destination.
 */
export const TRANSITIONS: Readonly<Record<SatelliteMode, readonly SatelliteMode[]>> = {
  orbiting: ['scanning', 'gathering', 'transporting', 'building', 'flying', 'landing'],
  scanning: ['orbiting', 'gathering', 'transporting', 'building', 'flying', 'landing'],
  gathering: ['orbiting', 'transporting', 'building', 'flying', 'landing'],
  transporting: ['orbiting', 'gathering', 'building', 'flying', 'landing'],
  building: ['orbiting', 'gathering', 'transporting', 'flying', 'landing'],
  flying: ['orbiting', 'flying'],
  landing: ['landed', 'orbiting', 'flying'],
  landed: ['orbiting', 'flying'],
};

export function canTransition(from: SatelliteMode, to: SatelliteMode): boolean {
  return TRANSITIONS[from].includes(to);
}

/** FNV-1a over the id: a stable 32-bit seed per agent. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic number in [0, 1) from a seed and a salt. */
export function seedFraction(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The pause before scan number `n`. */
export function scanInterval(seed: number, n: number): number {
  const [min, max] = TIMING.scanEvery;
  return min + (max - min) * seedFraction(seed, n);
}

/** A new actor, orbiting its body; its first scan comes after a seeded part of an interval. */
export function createActor(agentId: string, input: SatelliteInput, now: number): SatelliteActor {
  const seed = hashId(agentId);
  return {
    agentId,
    mode: input.landed ? 'landed' : 'orbiting',
    bodyId: input.bodyId,
    tween: { from: 'orbiting', start: now, duration: 0 },
    nextScanAt: now + 1 + scanInterval(seed, 0) * seedFraction(seed, 99),
    scans: 0,
    seed,
  };
}

const isArchetype = (mode: SatelliteMode): mode is ActivityArchetype =>
  (ARCHETYPES as readonly SatelliteMode[]).includes(mode);

function enter(
  actor: SatelliteActor,
  mode: SatelliteMode,
  at: number,
  duration: number,
  extra: Partial<SatelliteActor> = {},
): SatelliteActor {
  return { ...actor, ...extra, mode, tween: { from: actor.mode, start: at, duration } };
}

/** One transition at most; `advance` repeats it until the actor settles. */
function step(
  actor: SatelliteActor,
  input: SatelliteInput,
  now: number,
  reduced: boolean,
): SatelliteActor {
  const tween = reduced ? 0 : TIMING.modeTween;

  // 1. A flight runs to its end; only a new destination changes it.
  if (actor.mode === 'flying' && actor.flight) {
    const flight = actor.flight;
    if (input.bodyId !== flight.toBodyId) {
      return enter(actor, 'flying', now, 0, {
        bodyId: input.bodyId,
        flight: {
          fromBodyId: flight.toBodyId,
          toBodyId: input.bodyId,
          start: now,
          duration: reduced ? 0 : TIMING.flight,
        },
      });
    }
    const arrival = flight.start + flight.duration;
    if (now < arrival) return actor;
    // Arrived at `arrival`, not at `now`: an arrival seen late is already settled in.
    return enter(actor, 'orbiting', arrival, 0, {
      bodyId: flight.toBodyId,
      flight: undefined,
      nextScanAt: arrival + scanInterval(actor.seed, actor.scans),
    });
  }

  // 2. The work moved to another body: fly there (from wherever the satellite is).
  if (input.bodyId !== actor.bodyId) {
    return enter(actor, 'flying', now, 0, {
      bodyId: input.bodyId,
      scan: undefined,
      flight: {
        fromBodyId: actor.bodyId,
        toBodyId: input.bodyId,
        start: now,
        duration: reduced ? 0 : TIMING.flight,
      },
    });
  }

  // 3. Completion: land, then stay landed; a reopened task takes off again.
  if (input.landed) {
    if (actor.mode === 'landed') return actor;
    if (actor.mode === 'landing') {
      const down = actor.tween.start + actor.tween.duration;
      return now >= down ? enter(actor, 'landed', down, 0) : actor;
    }
    return enter(actor, 'landing', now, reduced ? 0 : TIMING.landing, { scan: undefined });
  }
  if (actor.mode === 'landing' || actor.mode === 'landed') {
    return enter(actor, 'orbiting', now, tween, {
      nextScanAt: now + scanInterval(actor.seed, actor.scans),
    });
  }

  // 4. An activity archetype (P4-03) while the agent works.
  const working = input.state === 'working';
  if (working && input.archetype) {
    return actor.mode === input.archetype
      ? actor
      : enter(actor, input.archetype, now, tween, { scan: undefined });
  }
  if (isArchetype(actor.mode)) {
    return enter(actor, 'orbiting', now, tween, {
      nextScanAt: now + scanInterval(actor.seed, actor.scans),
    });
  }

  // 5. The periodic scan of a working agent's body.
  if (actor.mode === 'scanning') {
    const end = actor.scan?.end ?? now;
    if (working && !reduced && now < end) return actor;
    const at = Math.min(now, end);
    return enter(actor, 'orbiting', at, tween, {
      scan: undefined,
      nextScanAt: at + scanInterval(actor.seed, actor.scans),
    });
  }
  if (actor.mode === 'orbiting' && working && !reduced && now >= actor.nextScanAt) {
    return enter(actor, 'scanning', now, tween, {
      scan: { start: now, end: now + TIMING.scan },
      scans: actor.scans + 1,
    });
  }
  return actor;
}

/**
 * Folds `input` into `actor` at `now`; returns the same object when nothing changed. Several
 * transitions can be due at once (a flight that ended long ago, then a landing): they are taken in
 * order, each at the time it became due.
 */
export function advance(
  actor: SatelliteActor,
  input: SatelliteInput,
  now: number,
  options: MachineOptions = {},
): SatelliteActor {
  const reduced = options.reducedMotion === true;
  let current = actor;
  for (let i = 0; i < 8; i++) {
    const next = step(current, input, now, reduced);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Smooth start and end. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

const progress = (now: number, start: number, duration: number): number =>
  duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - start) / duration));

/** What the renderer needs from an actor at `now`. */
export interface SatelliteView {
  mode: SatelliteMode;
  /** The previous mode and how far (eased, 0 → 1) the blend into `mode` has gone. */
  from: SatelliteMode;
  blend: number;
  /** While flying: the eased progress of the flight (0 at the old body, 1 at the new one). */
  flight: number | undefined;
  /** The scanning beam's strength, 0 → 1 (fades at either end of a scan). */
  beam: number;
  /** While landing / landed: the eased progress of the descent (1 = on the surface). */
  landing: number;
}

export function sampleActor(actor: SatelliteActor, now: number): SatelliteView {
  const blend = easeInOut(progress(now, actor.tween.start, actor.tween.duration));
  let beam = 0;
  if (actor.mode === 'scanning' && actor.scan) {
    const fade = TIMING.beamFade;
    beam = Math.min(
      progress(now, actor.scan.start, fade),
      progress(actor.scan.end, now, fade), // 1 until `fade` before the end, then down to 0
    );
  }
  const flight =
    actor.mode === 'flying' && actor.flight
      ? easeInOut(progress(now, actor.flight.start, actor.flight.duration))
      : undefined;
  const landing = actor.mode === 'landed' ? 1 : actor.mode === 'landing' ? blend : 0;
  return { mode: actor.mode, from: actor.tween.from, blend, flight, beam, landing };
}
