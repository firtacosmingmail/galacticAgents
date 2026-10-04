import type { ComponentType } from 'react';
import type { SceneQuality } from '../quality.js';
import type { DetailBody } from './detail-body.js';
import type { DetailKind } from './mode.js';
import { Cutaway } from './cutaway/Cutaway.js';
import { acceptsCutaway } from './cutaway/target.js';

/**
 * The detail view's extension slots (P6-01), for the tasks that build on it:
 * - **P6-02 (visuals)** enriches the per-kind body components in `DetailScene.tsx`
 *   (`RockyPlanetDetail`, `GiantPlanetDetail`, `MoonDetail`, `AsteroidDetail`) — atmosphere,
 *   clouds, higher-resolution maps, the detail moons' layout;
 * - **P6-03 (cutaway)**, **P6-04 (project overlay)**, **P6-05 (Earth HQ)** add a part here: a
 *   component drawn inside the detail body's frame (origin at the body's centre, axes following
 *   its anchor — a moon's frame is tilted with its planet's equator, an asteroid's turns with the
 *   belt; one scene unit is one scene unit, so sizes come from `body.radius`).
 *
 * A part is mounted with the sub-scene and unmounted (its GPU objects disposed) when the view is
 * left. `mix()` is the cross-fade, read per frame: 0 at the system view, 1 fully in the detail
 * view (a part that should not pop fades its materials with it).
 */
export interface DetailPartProps {
  body: DetailBody;
  quality: SceneQuality;
  mix: () => number;
}

export interface DetailPart {
  /** A stable key: `'cutaway'`, `'project-overlay'`, `'earth-hq'`. */
  id: string;
  /** The sub-scenes it belongs to. */
  kinds: readonly DetailKind[];
  /** Only for these bodies (e.g. Earth's HQ), when given. */
  accepts?: (body: DetailBody) => boolean;
  Component: ComponentType<DetailPartProps>;
}

/** The parts, drawn in this order after the body. */
export const DETAIL_PARTS: readonly DetailPart[] = [
  // P6-03: the layers of the bodies with a known interior (`cutaway/layers.ts`).
  { id: 'cutaway', kinds: ['rocky', 'giant', 'moon'], accepts: acceptsCutaway, Component: Cutaway },
];

/** The parts a body's detail view mounts. */
export function partsFor(body: DetailBody, parts: readonly DetailPart[] = DETAIL_PARTS) {
  return parts.filter((p) => p.kinds.includes(body.kind) && (p.accepts?.(body) ?? true));
}
