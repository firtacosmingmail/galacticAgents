import type { AgentRole, Id } from '@galactic/protocol';
import { hashId, seedFraction } from './machine.js';

/**
 * Satellite orbits around their body (P4-01). No three.js.
 *
 * Every orbit is a circle around the body's anchor, sized in the anchor's visual radius `R` (so it
 * works at both scales, decision 63, and for a planet, a moon or a task asteroid alike). The
 * satellites of one body take **slots**: the Waykeeper first, then the Stewards by agent id. A
 * slot fixes the orbit's shell (radius), inclination and node, so two satellites of one body never
 * share an orbit and stay at least `SHELL_STEP × R` apart (a Waykeeper and twelve Stewards reach 3.6 R); the agent id seeds the phase, so
 * the same world always draws the same picture. Angular speed is in radians per second of the
 * motion clock (`motionSeconds`), independent of the scale.
 *
 * Same conventions as the bodies (`scene/orbit.ts`): angle 0 on +x, counter-clockwise seen from
 * +y, inclination tilting the plane about its node line.
 */
export interface SatelliteOrbit {
  /** Orbit radius in body radii. */
  radius: number;
  /** Tilt of the orbit plane (radians) about the node line. */
  inclination: number;
  /** Direction of the node line in the xz plane (radians). */
  node: number;
  /** Angle at time 0 (radians). */
  phase: number;
  /** Radians per second. */
  speed: number;
}

/** Innermost shell, in body radii (clear of Saturn's rings' inner edge, ≈ 1.2). */
export const BASE_SHELL = 1.8;
/** Each further slot of a body orbits this much higher (body radii): no two share a radius. */
export const SHELL_STEP = 0.15;
/** Seconds per turn on the innermost shell: Waykeepers glide, Stewards bustle. */
export const PERIOD = { harmonizer: 40, waykeeper: 28, steward: 16 } as const;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Slot of each satellite within its body: Waykeeper (and HQ) first, then by agent id. */
export function orbitSlots(
  specs: readonly { agentId: Id; role: AgentRole; bodyId: Id }[],
): Map<Id, number> {
  const byBody = new Map<Id, { agentId: Id; role: AgentRole }[]>();
  for (const s of specs) {
    const list = byBody.get(s.bodyId) ?? [];
    list.push(s);
    byBody.set(s.bodyId, list);
  }
  const rank = (role: AgentRole) => (role === 'steward' ? 1 : 0);
  const slots = new Map<Id, number>();
  for (const list of byBody.values()) {
    list.sort((a, b) => rank(a.role) - rank(b.role) || (a.agentId < b.agentId ? -1 : 1));
    list.forEach((s, i) => slots.set(s.agentId, i));
  }
  return slots;
}

/** The orbit of slot `slot` for agent `agentId`. */
export function satelliteOrbit(agentId: Id, role: AgentRole, slot: number): SatelliteOrbit {
  const seed = hashId(agentId);
  const radius = BASE_SHELL + SHELL_STEP * slot;
  // Inclinations spread by the golden ratio over ≈ 8°–60°; the node turns by the golden angle.
  const inclination = 0.14 + 0.9 * ((slot * 0.6180339887 + 0.15) % 1);
  const node = slot * GOLDEN_ANGLE + 0.4 * seedFraction(seed, 1);
  const phase = 2 * Math.PI * seedFraction(seed, 2);
  const period = PERIOD[role] * Math.sqrt(radius / BASE_SHELL);
  return { radius, inclination, node, phase, speed: (2 * Math.PI) / period };
}

/** The orbit angle at time `t` (seconds); a still scene (reduced motion) passes `t = 0`. */
export function orbitAngle(orbit: SatelliteOrbit, t: number): number {
  return orbit.phase + orbit.speed * t;
}

/**
 * The offset from the body's centre at `angle`, at `radius` scene units, written into `out`
 * (no allocation: called per satellite per frame).
 */
export function orbitOffset(
  orbit: SatelliteOrbit,
  angle: number,
  radius: number,
  out: [number, number, number],
): [number, number, number] {
  // In the orbit plane: x along the node line, z across it (counter-clockwise from +y).
  const px = Math.cos(angle) * radius;
  const pz = -Math.sin(angle) * radius;
  // Tilt about the node line (x axis of the plane): z lifts toward +y.
  const ci = Math.cos(orbit.inclination);
  const si = Math.sin(orbit.inclination);
  const y = -pz * si;
  const z = pz * ci;
  // Turn the node line to `node` in the xz plane.
  const cn = Math.cos(orbit.node);
  const sn = Math.sin(orbit.node);
  out[0] = px * cn + z * sn;
  out[1] = y;
  out[2] = -px * sn + z * cn;
  return out;
}
