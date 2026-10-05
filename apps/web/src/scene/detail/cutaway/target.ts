import type { Mesh, Object3D } from 'three';
import type { DetailBody } from '../detail-body.js';
import { cutawayLayers, type Layer } from './layers.js';

/**
 * Which detail bodies get the cutaway and what of them is cut (P6-03), kept apart from the
 * component (`Cutaway.tsx`) so that file exports only components (React fast refresh).
 */

/** The detail body's layers and its sphere (radius, tilt), or undefined without layer data. */
export function cutawayTarget(
  body: DetailBody,
): { layers: readonly Layer[]; radius: number; tiltDeg: number } | undefined {
  if (body.kind === 'asteroid') return undefined;
  if (body.kind === 'moon') {
    const layers = cutawayLayers({ kind: 'moon', name: body.moon.name });
    return layers ? { layers, radius: body.moon.radius, tiltDeg: 0 } : undefined;
  }
  const layers = cutawayLayers({ kind: 'planet', name: body.planet.name });
  return layers
    ? { layers, radius: body.planet.radius, tiltDeg: body.planet.look.tiltDeg }
    : undefined;
}

/** Whether the part mounts for a body (`DETAIL_PARTS`' `accepts`). */
export function acceptsCutaway(body: DetailBody): boolean {
  return cutawayTarget(body) !== undefined;
}

/** Whether a mesh of the body is cut (see `Cutaway.tsx`'s header). */
export function isCutMesh(o: Object3D): o is Mesh {
  const mesh = o as Mesh;
  if (!mesh.isMesh) return false;
  if (o.userData.cutaway === false) return false;
  return o.userData.cutaway === true || mesh.geometry.type === 'SphereGeometry';
}
