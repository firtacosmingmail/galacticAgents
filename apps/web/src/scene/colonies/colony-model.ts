import type { Body, Id } from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { hashId, seedFraction } from '../satellites/machine.js';

/**
 * The colonised mark as data (P4-04; SPEC §4.1 "completed work shows the satellite landing and
 * the body marked colonised", decision 4). No three.js, no React: `Colonies.tsx` draws it.
 *
 * - **Which bodies:** a body whose **host** is completed — a planet or moon hosting a `completed`
 *   project, an asteroid hosting a `completed` standalone task. It is the body's own work that
 *   colonises it, not the tasks living on it: a project task that completes lands its Steward on
 *   the project's body (the satellite list, `hasLanded`) but the body is marked only once the
 *   user closes the project (decision 11) — a planet with ten finished tasks and one running is
 *   still a project in progress, and its label says so.
 * - **How long:** while the host is `completed`, i.e. during retention (decision 4). Archiving
 *   frees the body (`body.freed` clears its host), a reopen makes the work `approved` again, a
 *   move leaves only a "moved to …" marker (no host): each removes the mark at the next render.
 * - **What:** a few clusters of small warm lights on the surface ("settlements"), the same for
 *   the same body (seeded by its id): cheap (one `Points` draw per colonised body, no texture,
 *   no shader of its own), still under reduced motion, and quiet beside the satellites, the labels
 *   and the beacons.
 */
export interface ColonySpec {
  bodyId: Id;
  /** What completed there: a project (planet or moon) or a standalone task (asteroid). */
  host: 'project' | 'task';
  /** Seeds the lights' places (from the body id). */
  seed: number;
}

export type ColonyWorld = Pick<WorldState, 'bodies' | 'projects' | 'tasks'>;

/** The look of a colony (`Colonies.tsx`). */
export const COLONY = {
  /** Settlement clusters per body, and lights per cluster. */
  clusters: 5,
  perCluster: 4,
  /** A cluster's spread on the surface (radians) and the band its centres keep to (± latitude). */
  spread: 0.13,
  latitude: 0.9,
  /** Warm white, not the amber of "blocked on you" (decision 72) nor a state colour. */
  color: '#ffe6b8',
  opacity: 0.85,
  /** Pixels (not attenuated: a colony reads at the system view and up close alike). */
  sizePx: 2.5,
  /** Lights sit this far out, in body radii: just above the surface; a lumpy asteroid needs more. */
  lift: 1.012,
  asteroidLift: 1.18,
} as const;

/** Whether a body is colonised: its host (project or standalone task) is `completed`. */
export function isColonised(world: ColonyWorld, body: Body): boolean {
  const host = body.host;
  if (!host) return false;
  const state = host.kind === 'project' ? world.projects[host.id]?.state : world.tasks[host.id]?.state;
  return state === 'completed';
}

/** The colonised bodies, by body id. */
export function colonyList(world: ColonyWorld): ColonySpec[] {
  const out: ColonySpec[] = [];
  for (const id of Object.keys(world.bodies).sort()) {
    const body = world.bodies[id];
    if (!body?.host || !isColonised(world, body)) continue;
    out.push({ bodyId: id, host: body.host.kind, seed: hashId(id) });
  }
  return out;
}

/** Two lists draw the same thing (the list is rebuilt on every world change). */
export function sameColonies(a: readonly ColonySpec[], b: readonly ColonySpec[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.bodyId === b[i]?.bodyId && c.host === b[i]?.host)
  );
}

/**
 * The lights of a colony, as unit vectors from the body's centre (x, y, z per light): `clusters`
 * centres spread round the body (golden-angle longitudes, seeded latitudes within ±`latitude`),
 * each with `perCluster` lights jittered within `spread`. Deterministic per seed.
 */
export function colonyLights(seed: number): Float32Array {
  const n = COLONY.clusters * COLONY.perCluster;
  const out = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  let k = 0;
  for (let c = 0; c < COLONY.clusters; c++) {
    const lon0 = 2 * Math.PI * seedFraction(seed, 1) + c * golden * 2.2;
    const lat0 = (2 * seedFraction(seed, 10 + c) - 1) * COLONY.latitude;
    for (let i = 0; i < COLONY.perCluster; i++) {
      const salt = 100 + c * 16 + i * 2;
      const lat = lat0 + (2 * seedFraction(seed, salt) - 1) * COLONY.spread;
      const lon = lon0 + ((2 * seedFraction(seed, salt + 1) - 1) * COLONY.spread) / Math.cos(lat0);
      out[k++] = Math.cos(lat) * Math.cos(lon);
      out[k++] = Math.sin(lat);
      out[k++] = -Math.cos(lat) * Math.sin(lon);
    }
  }
  return out;
}
