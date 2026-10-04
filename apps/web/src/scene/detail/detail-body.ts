import type { Body } from '@galactic/protocol';
import { buildRenderList, type MoonItem, type PlanetItem } from '../bodies/layout.js';
import { TASK_ASTEROID_RADIUS, taskAsteroids, type TaskAsteroid } from '../belt/belt-model.js';
import type { ScaleMode } from '../scale.js';
import { framedRadius } from '../camera/flight.js';
import { detailKind, EXIT_RADII } from './mode.js';

/**
 * What a detail view shows (P6-01), as plain data (testable without WebGL): the body resolved from
 * the scene's world through the same layout the system view uses (`bodies/layout.ts`,
 * `belt/belt-model.ts`), so the sub-scene draws it — and a planet's moons — exactly where and as
 * big as the system's anchors say. `radius` is the anchor's visual radius (a ringed planet's
 * includes the rings), the unit of every distance in the detail view.
 */
export type DetailBody =
  | { kind: 'rocky' | 'giant'; bodyId: string; name: string; radius: number; planet: PlanetItem }
  | {
      kind: 'moon';
      bodyId: string;
      name: string;
      radius: number;
      moon: MoonItem;
      /** The planet it orbits (drawn by the system view, inside the backdrop). */
      parent: PlanetItem;
    }
  | { kind: 'asteroid'; bodyId: string; name: string; radius: number; asteroid: TaskAsteroid };

export function resolveDetailBody(
  bodies: Readonly<Record<string, Body>>,
  bodyId: string,
  mode: ScaleMode,
): DetailBody | undefined {
  const body = bodies[bodyId];
  const kind = detailKind(body);
  if (!body || !kind) return undefined;
  if (kind === 'asteroid') {
    const asteroid = taskAsteroids(bodies).find((a) => a.bodyId === bodyId);
    return asteroid
      ? { kind, bodyId, name: body.name, radius: TASK_ASTEROID_RADIUS, asteroid }
      : undefined;
  }
  const list = buildRenderList(bodies, mode);
  if (kind === 'moon') {
    const parent = list.find((p) => p.bodyId === body.parentId);
    const moon = parent?.moons.find((m) => m.bodyId === bodyId);
    return parent && moon
      ? { kind, bodyId, name: body.name, radius: moon.radius, moon, parent }
      : undefined;
  }
  const planet = list.find((p) => p.bodyId === bodyId);
  return planet ? { kind, bodyId, name: body.name, radius: planet.outerRadius, planet } : undefined;
}

/** The backdrop is at least this many framed radii (`framedRadius`) away from the body's centre. */
export const BACKDROP_MIN_RADII = 40;
/**
 * …and this much beyond the farthest body that belongs to the view (a planet's moons) as seen from
 * the farthest the camera may be while the view is on (`EXIT_RADII` off the centre).
 */
export const BACKDROP_MARGIN = 1.6;

/** How far a planet's own system reaches from its centre: its rings, its moons' orbits. */
export function planetReach(planet: PlanetItem): number {
  let reach = planet.outerRadius;
  for (const m of planet.moons) reach = Math.max(reach, m.distance + m.radius);
  return reach;
}

/**
 * The backdrop's radius about the body: far enough that the camera (within `EXIT_RADII` while the
 * view is on) and every body of the view's scope (`detailScope`: a planet's moons; a moon's planet
 * and siblings) are inside it, while the rest of the system is outside. Camera distances are in
 * framed radii, the camera's own unit (true scale's moons are smaller than `MIN_FRAMED_RADIUS`).
 */
export function backdropRadius(body: DetailBody): number {
  const reach =
    body.kind === 'asteroid'
      ? body.radius
      : body.kind === 'moon'
        ? body.moon.distance + planetReach(body.parent)
        : planetReach(body.planet);
  const r = framedRadius(body.radius);
  const camera = EXIT_RADII * r;
  return Math.max(r * BACKDROP_MIN_RADII, (reach + camera) * BACKDROP_MARGIN);
}
