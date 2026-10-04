import type { AgentState, Id } from '@galactic/protocol';
import type { SatelliteFrame } from '../director.js';

/**
 * The Harmonizer's HQ station (P4-02; SPEC §4.1, TECHNOLOGY §2.1 "a satellite/HQ presence on
 * their body"), as data. No three.js.
 *
 * The station is the Harmonizer's satellite: the same list entry (`satelliteList(world, {
 * harmonizer: true })`, on `b-earth`), the same actor, director frame, registry entry, state look
 * (`look.ts`) and picking — hovering it shows its card, clicking it selects the Harmonizer. Only
 * its model differs (`hq-mesh.ts`, drawn by `HqStation.tsx` outside the satellites' instancing):
 * a hub with solar wings and a habitat ring that **turns slowly while the Harmonizer is idle and
 * fast while it thinks** (`working`), on top of the state's colour and pulse. Under reduced
 * motion the ring stands still; thinking still reads by brightness (the state's `still` level).
 */
export const HQ = {
  /** The ring's spin, radians per second. */
  ringSpin: { thinking: 1.6, idle: 0.22 },
} as const;

/** Whether the Harmonizer is thinking (a turn is running). */
export function hqThinking(state: AgentState): boolean {
  return state === 'working' || state === 'starting';
}

/** The ring's spin for a state; 0 under reduced motion, or once the agent ended. */
export function hqRingSpeed(state: AgentState, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  if (hqThinking(state)) return HQ.ringSpin.thinking;
  return state === 'failed' || state === 'paused' ? 0 : HQ.ringSpin.idle;
}

/** The HQ station's frame among the director's frames (the Harmonizer's), if drawn. */
export function hqFrame(frames: readonly SatelliteFrame[]): SatelliteFrame | undefined {
  for (const f of frames) if (f.role === 'harmonizer') return f;
  return undefined;
}

/**
 * The ring's angle, integrated over the motion clock so a speed change never makes it jump.
 * `advance(now, speed)` returns the angle at `now`.
 */
export class RingSpin {
  angle = 0;
  private at: number | undefined;
  advance(now: number, speed: number): number {
    if (this.at !== undefined) this.angle = (this.angle + (now - this.at) * speed) % (2 * Math.PI);
    this.at = now;
    return this.angle;
  }
}

/** The agent ids the ordinary satellite renderers draw: every published one but the HQ's. */
export function ordinarySatellites(
  ids: readonly Id[],
  roleOf: (id: Id) => string | undefined,
): { hq: Id | undefined; others: Id[] } {
  let hq: Id | undefined;
  const others: Id[] = [];
  for (const id of ids) {
    if (hq === undefined && roleOf(id) === 'harmonizer') hq = id;
    else others.push(id);
  }
  return { hq, others };
}

/**
 * P6-05: a more detailed station may take over drawing the HQ (Earth's detail view,
 * `detail/earth-hq/`). While claimed, `writeHq` hides the system station's core and ring (never
 * both stations at once), but the Harmonizer's frame stays published, so picking, the hover card
 * and the beam (still drawn by `writeHq`) are unchanged. `claimHqStation()` returns the release;
 * claims count (a StrictMode remount claims twice and releases once before claiming again).
 */
let claims = 0;
export function claimHqStation(): () => void {
  claims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims--;
  };
}

/** Whether a detail station draws the HQ now (`claimHqStation`). */
export function hqClaimed(): boolean {
  return claims > 0;
}
