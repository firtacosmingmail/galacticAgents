import type { Body } from '@galactic/protocol';
import { auToScene, PLANET_AU, TRUE_UNITS_PER_KM, type ScaleMode } from '../scale.js';
import { orbitPoint } from '../orbit.js';
import { MOON_LOOKS, moonLook, PLANET_LOOKS, planetLook, type BodyLook } from './appearance.js';

/**
 * The world → render list (P3-02), as plain data so it is testable without WebGL: which planets
 * and moons the scene draws, where (orbit radius, starting phase), how big, and how fast they go
 * round. Everything comes from the world's bodies (the catalogue of migration 0005 plus whatever
 * the server adds later); the appearance table only dresses them. Reserved bodies (Earth, the
 * Moon) are drawn like any other; the Sun is drawn by `SolarScene`, asteroids by the belt.
 */
export interface MoonItem {
  bodyId: string;
  name: string;
  parentId: string;
  reserved: boolean;
  /** Whether the appearance table knows this body (otherwise it wears the default look). */
  known: boolean;
  look: BodyLook;
  /** 1-based position among its planet's moons (by `meta.orbit`, then id). */
  rank: number;
  /** Orbit radius around the planet, in the planet's equatorial plane, scene units. */
  distance: number;
  radius: number;
  /** Angle at t = 0, radians. */
  phase: number;
  /** Seconds per decorative revolution. */
  period: number;
}

export interface PlanetItem {
  bodyId: string;
  name: string;
  reserved: boolean;
  known: boolean;
  look: BodyLook;
  /** The catalogue orbit (1 = Mercury), or the next free one for a body without a usable orbit. */
  orbit: number;
  au: number;
  /** Distance from the Sun, scene units. */
  distance: number;
  radius: number;
  /** Radius including the rings: what the camera frames. */
  outerRadius: number;
  phase: number;
  period: number;
  moons: MoonItem[];
}

/** Readable layout: a planet's first moon orbits this far outside the planet (or its rings). */
export const MOON_CLEARANCE = 1.6;
/** Readable layout: the gap between successive moon orbits. */
export const MOON_STEP = 1.4;
/** True scale: the smallest radius drawn, so Phobos is still something to click. */
export const MIN_TRUE_RADIUS = 0.02;

/** Seconds per revolution of the innermost planet; outer ones are slower (decorative only). */
export const PLANET_BASE_PERIOD = 100;
export const MOON_BASE_PERIOD = 24;
/** Seconds per planet spin (decorative). */
export const SPIN_PERIOD = 40;

/** The far side of the Sun from the default camera (on +z): orbit angle π/2 (see `scene/orbit.ts`). */
export const FAR_SIDE_ANGLE = Math.PI / 2;
/** How close (radians) to the far side a static planet may sit before it is nudged away. */
export const FAR_SIDE_MARGIN = (30 * Math.PI) / 180;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** A planet's semi-major axis in AU by orbit; orbits past Neptune continue every 10 AU. */
export function planetAu(orbit: number): number {
  const known = PLANET_AU[orbit - 1];
  if (known !== undefined) return known;
  const last = PLANET_AU[PLANET_AU.length - 1]!;
  return last + 10 * Math.max(1, orbit - PLANET_AU.length);
}

/** Orbit angle at time `t` seconds (`t` = 0 when motion is off: the static layout). */
export function orbitAngle(phase: number, period: number, t: number): number {
  return phase + (t / period) * Math.PI * 2;
}

function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  return ((a % twoPi) + twoPi) % twoPi;
}

/** Angular distance between two angles, in [0, π]. */
export function angleBetween(a: number, b: number): number {
  const d = wrapAngle(a - b);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/**
 * Moves a starting angle out of the cone behind the Sun (seen from the default camera), so the
 * static layout (reduced motion) never parks a planet where the Sun hides it (corner case 26).
 */
export function safePhase(angle: number): number {
  const a = wrapAngle(angle);
  if (angleBetween(a, FAR_SIDE_ANGLE) >= FAR_SIDE_MARGIN) return a;
  const side = wrapAngle(a - FAR_SIDE_ANGLE) < Math.PI ? 1 : -1;
  return wrapAngle(FAR_SIDE_ANGLE + side * FAR_SIDE_MARGIN);
}

function orbitOf(body: Body): number | undefined {
  const orbit = body.meta?.['orbit'];
  return typeof orbit === 'number' && Number.isInteger(orbit) && orbit > 0 ? orbit : undefined;
}

function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function dress(name: string, id: string, table: (name: string) => BodyLook, known: boolean) {
  const look = table(name);
  return known ? look : { ...look, seed: hashSeed(id) };
}

function byOrbitThenId(a: Body, b: Body): number {
  const oa = orbitOf(a) ?? Number.MAX_SAFE_INTEGER;
  const ob = orbitOf(b) ?? Number.MAX_SAFE_INTEGER;
  return oa - ob || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function sizeOf(look: BodyLook, mode: ScaleMode): number {
  return mode === 'true'
    ? Math.max(MIN_TRUE_RADIUS, look.radiusKm * TRUE_UNITS_PER_KM)
    : look.radius;
}

/** A planet's radius including its rings. */
export function outerRadiusOf(look: BodyLook, radius: number): number {
  return radius * (look.rings ? look.rings.outer : 1);
}

/** The orbit radius of a moon around its planet. */
export function moonDistance(
  look: BodyLook,
  moonRadius: number,
  rank: number,
  planetOuter: number,
  mode: ScaleMode,
): number {
  const fake = planetOuter + MOON_CLEARANCE + moonRadius + (rank - 1) * MOON_STEP;
  if (mode === 'fake') return fake;
  const real = (look.distanceKm ?? 0) * TRUE_UNITS_PER_KM;
  return Math.max(real, planetOuter * 1.25 + moonRadius);
}

/**
 * The planets (with their moons) to draw, in orbit order. Planets without a usable `meta.orbit`
 * (or with one already taken) get the next orbits past the last; moons whose parent is not a
 * drawn planet are left out (there is nowhere to put them).
 */
export function buildRenderList(
  bodies: Readonly<Record<string, Body>> | readonly Body[],
  mode: ScaleMode,
): PlanetItem[] {
  const all = Array.isArray(bodies) ? bodies : Object.values(bodies);
  const planets = all.filter((b) => b.kind === 'planet').sort(byOrbitThenId);
  const moonsByParent = new Map<string, Body[]>();
  for (const b of all) {
    if (b.kind !== 'moon' || !b.parentId) continue;
    const list = moonsByParent.get(b.parentId) ?? [];
    list.push(b);
    moonsByParent.set(b.parentId, list);
  }

  const used = new Set<number>();
  let next = Math.max(0, ...planets.map((p) => orbitOf(p) ?? 0)) + 1;
  return planets.map((p) => {
    let orbit = orbitOf(p);
    if (orbit === undefined || used.has(orbit)) orbit = next++;
    used.add(orbit);
    const known = Object.hasOwn(PLANET_LOOKS, p.name);
    const look = dress(p.name, p.id, planetLook, known);
    const radius = sizeOf(look, mode);
    const outerRadius = outerRadiusOf(look, radius);
    const au = planetAu(orbit);
    const moons = (moonsByParent.get(p.id) ?? []).sort(byOrbitThenId).map((m, i): MoonItem => {
      const mKnown = Object.hasOwn(MOON_LOOKS, m.name);
      const mLook = dress(m.name, m.id, moonLook, mKnown);
      const mRadius = sizeOf(mLook, mode);
      const rank = i + 1;
      return {
        bodyId: m.id,
        name: m.name,
        parentId: p.id,
        reserved: m.meta?.['reserved'] === true,
        known: mKnown,
        look: mLook,
        rank,
        distance: moonDistance(mLook, mRadius, rank, outerRadius, mode),
        radius: mRadius,
        phase: wrapAngle(rank * 2.1 + (mLook.seed % 7)),
        period: MOON_BASE_PERIOD * Math.pow(rank, 1.1),
      };
    });
    return {
      bodyId: p.id,
      name: p.name,
      reserved: p.meta?.['reserved'] === true,
      known,
      look,
      orbit,
      au,
      distance: auToScene(au, mode),
      radius,
      outerRadius,
      phase: safePhase(orbit * GOLDEN_ANGLE + 0.6),
      period: PLANET_BASE_PERIOD * Math.pow(orbit, 1.2),
      moons,
    };
  });
}

/** The anchors the bodies register (`anchors.ts`): one per drawn planet and moon. */
export interface AnchorSpec {
  bodyId: string;
  radius: number;
  kind: 'planet' | 'moon';
}

export function anchorSpecs(list: readonly PlanetItem[]): AnchorSpec[] {
  return list.flatMap((p) => [
    { bodyId: p.bodyId, radius: p.outerRadius, kind: 'planet' as const },
    ...p.moons.map((m) => ({ bodyId: m.bodyId, radius: m.radius, kind: 'moon' as const })),
  ]);
}

/** Circle points (x, 0, z) for an orbit line, closed by `LineLoop`. */
export function circlePoints(radius: number, segments: number): Float32Array {
  const out = new Float32Array(segments * 3);
  const p = orbitPoint(0, 0);
  for (let i = 0; i < segments; i++) {
    orbitPoint(radius, (i / segments) * Math.PI * 2, 0, p);
    out[i * 3] = p[0];
    out[i * 3 + 2] = p[2];
  }
  return out;
}
