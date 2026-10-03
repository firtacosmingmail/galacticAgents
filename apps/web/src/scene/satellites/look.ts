import type { AgentRole } from '@galactic/protocol';
import type { SatelliteSpec } from './satellite-model.js';
import type { SatelliteView } from './machine.js';

/**
 * How a satellite looks (P4-01). One table, so P4-02 (colour and pulse per agent state) replaces
 * `satelliteTint` / `satelliteBrightness` here rather than touching the renderer: both renderers (one
 * mesh pair per satellite, or the instanced path) read them every frame. No three.js.
 *
 * - `size`: the satellite's span in its body's radii; `minPx`: the smallest it is drawn on screen,
 *   so a satellite stays visible at the system view (`maxSize` keeps that floor from making it
 *   larger than a few body radii around a tiny moon);
 * - the Waykeeper is the larger, warmer satellite; Stewards are smaller and cooler (SPEC §4.1:
 *   "smaller satellites doing work"); the Harmonizer's HQ station (P4-02) is the largest.
 */
export const SATELLITE_LOOK: Readonly<
  Record<AgentRole, { color: string; size: number; minPx: number; maxSize: number }>
> = {
  harmonizer: { color: '#e8f0ff', size: 0.2, minPx: 3.5, maxSize: 1.2 },
  waykeeper: { color: '#ffd27a', size: 0.16, minPx: 3, maxSize: 1 },
  steward: { color: '#a8dcff', size: 0.11, minPx: 2.2, maxSize: 0.8 },
};

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

/** A satellite's colour (P4-02 maps the agent's state here). */
export function satelliteTint(spec: Pick<SatelliteSpec, 'role' | 'state'>): string {
  return SATELLITE_LOOK[spec.role].color;
}

/**
 * A multiplier on the tint, per frame (P4-02's pulse goes here). Satellites are unlit
 * (`MeshBasicMaterial`, shaded by the geometry's vertex colours) so their colour reads the same on
 * a body's night side; above about 1.4 a bright tint starts to bloom on tiers with a composer.
 */
export function satelliteBrightness(
  _spec: Pick<SatelliteSpec, 'role' | 'state'>,
  _view: SatelliteView,
  _now: number,
): number {
  return 1;
}
