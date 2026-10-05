import type { Id } from '@galactic/protocol';
import type { Vec3Tuple } from '../orbit.js';

/**
 * Placement overrides (P6-04): a view that shows an agent somewhere other than its orbit — the
 * detail view's project overlay puts a Steward down by its task, as a surface robot or an orbital
 * drone — tells the director where, and how far it has gone there. No three.js.
 *
 * The director (`director.ts`) applies an override after placing the satellite on its orbit, and
 * only while the satellite orbits (orbiting, scanning or an activity archetype; never while it
 * flies, lands or sits landed): its frame's `position` moves from the orbit to `position` by `k`
 * (0 → 1, eased by the caller), and from `k` ≥ `CLAIM_AT` the frame is `claimed` — the satellite
 * renderer then draws nothing for it (neither the satellite nor its beam) and the view draws its
 * own model at the frame's position. Everything that reads the frame — picking, the hover card and
 * ring, the activities (P4-03: gathering drones, transport shuttles, building robots around it) —
 * follows it there. Positions are in world units, written before `PLACE_SATELLITES` each frame.
 */
export interface PlacementOverride {
  /** Where the agent is shown (world units); rewritten in place by its owner. */
  position: Vec3Tuple;
  /** 0 → 1: how far from its orbit to `position`. */
  k: number;
  /**
   * The frame's span multiplier once claimed (the view's model is smaller than the satellite up
   * close: the activities and the pick target scale with the span). Default 1.
   */
  scale?: number;
}

/** From this `k` on, the frame is the view's own model's (the satellite is not drawn). */
export const CLAIM_AT = 0.5;

const overrides = new Map<Id, PlacementOverride>();

/** Shows an agent at an override (the same object is kept and read every frame). */
export function setPlacement(agentId: Id, override: PlacementOverride): void {
  overrides.set(agentId, override);
}

/** Gives an agent back to its orbit (only when `override` is the one set, if given). */
export function clearPlacement(agentId: Id, override?: PlacementOverride): void {
  if (override === undefined || overrides.get(agentId) === override) overrides.delete(agentId);
}

export function placementFor(agentId: Id): PlacementOverride | undefined {
  return overrides.get(agentId);
}

/** The agents with an override (tests). */
export function placedAgents(): Id[] {
  return [...overrides.keys()];
}
