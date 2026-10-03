import {
  asteroidSpec,
  BELT_ORBIT,
  BELT_SEED,
  drawBeltOrbit,
  mulberry32,
  type BeltOrbit,
  type Body,
  type Id,
} from '@galactic/protocol';
import { orbitPoint } from '../orbit.js';
import { auToScene, type ScaleMode } from '../scale.js';

/**
 * The asteroid belt as plain data (P3-03; no three.js here, so it is testable without WebGL).
 *
 * - The **background belt** is client-only decoration: `count` rocks drawn from one PRNG stream
 *   seeded from the shared `BELT_SEED`, each with an orbit from the shared `drawBeltOrbit` (so it
 *   covers exactly the band the server places task asteroids in), a size, a squash and a tint.
 *   Every rock takes the same number of draws, so a lighter tier's belt is a prefix of a heavier
 *   one's: switching tiers thins the belt, it never reshuffles it.
 * - **Task asteroids** are the world's `asteroid` bodies that host something; they are drawn
 *   individually at their `meta.orbit` (the server's `asteroidSpec`).
 *
 * Placement: an orbit (`radius` AU, `phase`, `inclination`) is a point at `auToScene(radius)` from
 * the Sun, at azimuth `phase` (the scene's one convention, `scene/orbit.ts`: counter-clockwise
 * seen from above, like the planets) and `inclination` above or below the ecliptic. Decorative
 * (corner case 26), and the distance from the Sun is exactly the scaled radius.
 */

/** The background rocks' own stream: the belt seed, offset so it never replays asteroid `n`. */
export const BACKGROUND_BELT_SEED = (BELT_SEED ^ 0xb0c4_5eed) >>> 0;

/** Background rock size range (scene units, before the per-axis squash). */
export const ROCK_SIZE = { min: 0.1, max: 0.55 } as const;
/** A task asteroid's visual radius in scene units: several times the largest background rock. */
export const TASK_ASTEROID_RADIUS = 1.1;
/** The belt's decorative spin, radians per second (a full turn in about 26 minutes). */
export const BELT_ANGULAR_SPEED = 0.004;

/** Floats per rock in `BackgroundBelt.data`. */
export const ROCK_STRIDE = 12;
/**
 * Per rock: [radiusAu, phase, inclination, size, squashX, squashY, squashZ, rotX, rotY, rotZ,
 * tint, brightness] — `tint` in [0, 1] from grey to warm brown, `brightness` in [0.35, 0.8].
 */
export interface BackgroundBelt {
  count: number;
  data: Float32Array;
}

export function generateBelt(count: number, seed: number = BACKGROUND_BELT_SEED): BackgroundBelt {
  const n = Math.max(0, Math.floor(count));
  const rand = mulberry32(seed);
  const data = new Float32Array(n * ROCK_STRIDE);
  for (let i = 0; i < n; i++) {
    const o = i * ROCK_STRIDE;
    const orbit = drawBeltOrbit(rand);
    data[o] = orbit.radius;
    data[o + 1] = orbit.phase;
    data[o + 2] = orbit.inclination;
    // Mostly small rocks, a few big ones.
    data[o + 3] = ROCK_SIZE.min + (ROCK_SIZE.max - ROCK_SIZE.min) * rand() ** 3;
    data[o + 4] = 0.6 + rand() * 0.6;
    data[o + 5] = 0.6 + rand() * 0.6;
    data[o + 6] = 0.6 + rand() * 0.6;
    data[o + 7] = rand() * 2 * Math.PI;
    data[o + 8] = rand() * 2 * Math.PI;
    data[o + 9] = rand() * 2 * Math.PI;
    data[o + 10] = rand();
    data[o + 11] = 0.35 + rand() * 0.45;
  }
  return { count: n, data };
}

/** Where an orbit puts a body, in scene units (the Sun at the origin, y up). */
export function orbitPosition(
  orbit: BeltOrbit,
  mode: ScaleMode,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  return orbitPoint(auToScene(orbit.radius, mode), orbit.phase, orbit.inclination, out);
}

/** The belt's extent in scene units at a scale: the radii of its inner and outer edges. */
export function beltBounds(mode: ScaleMode): { inner: number; outer: number } {
  return { inner: auToScene(BELT_ORBIT.innerAu, mode), outer: auToScene(BELT_ORBIT.outerAu, mode) };
}

/** The positions of the background rocks at a scale: xyz per rock. */
export function rockPositions(belt: BackgroundBelt, mode: ScaleMode): Float32Array {
  const out = new Float32Array(belt.count * 3);
  const p: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < belt.count; i++) {
    const o = i * ROCK_STRIDE;
    orbitPosition(
      { radius: belt.data[o]!, phase: belt.data[o + 1]!, inclination: belt.data[o + 2]! },
      mode,
      p,
    );
    out.set(p, i * 3);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Task asteroids
// ---------------------------------------------------------------------------

export interface TaskAsteroid {
  /** The domain `Body.id`: the anchor's key. */
  bodyId: Id;
  name: string;
  /** What the asteroid hosts (a standalone task; SPEC §3.1). */
  hostId: Id;
  orbit: BeltOrbit;
  /** Drives the rock's shape, so each task asteroid keeps its own look. */
  seed: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** FNV-1a: a stable 32-bit hash for a body without catalogue data. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const clampRadius = (au: number) => Math.min(BELT_ORBIT.outerAu, Math.max(BELT_ORBIT.innerAu, au));

/**
 * An asteroid's orbit: its `meta.orbit` (the catalogue's); else the catalogue orbit of its
 * `meta.number`; else one drawn from a hash of its id — so an asteroid without catalogue data
 * still sits in the belt, always at the same place, and the camera can reach it.
 */
export function asteroidOrbit(body: Body): { orbit: BeltOrbit; seed: number } {
  const meta = body.meta ?? {};
  const seed = isNum(meta['seed']) ? meta['seed'] >>> 0 : hash(body.id);
  const o = meta['orbit'] as Partial<BeltOrbit> | undefined;
  if (o && isNum(o.radius) && isNum(o.phase) && isNum(o.inclination)) {
    return {
      orbit: { radius: clampRadius(o.radius), phase: o.phase, inclination: o.inclination },
      seed,
    };
  }
  if (isNum(meta['number'])) {
    const spec = asteroidSpec(meta['number']);
    return { orbit: spec.meta.orbit, seed: spec.meta.seed };
  }
  return { orbit: drawBeltOrbit(mulberry32(seed)), seed };
}

/**
 * The asteroids drawn individually: the `asteroid` bodies that host work. A freed asteroid (no
 * host), or one whose work moved away (only a "moved to" marker), is not drawn on its own; it
 * is just part of the background. Sorted by id, so the order is stable.
 */
export function taskAsteroids(bodies: Readonly<Record<Id, Body>>): TaskAsteroid[] {
  const out: TaskAsteroid[] = [];
  for (const body of Object.values(bodies)) {
    if (body.kind !== 'asteroid' || !body.host) continue;
    const { orbit, seed } = asteroidOrbit(body);
    out.push({ bodyId: body.id, name: body.name, hostId: body.host.id, orbit, seed });
  }
  return out.sort((a, b) => (a.bodyId < b.bodyId ? -1 : a.bodyId > b.bodyId ? 1 : 0));
}

/** A task asteroid's per-axis squash from its seed, in [0.75, 1.15]. */
export function asteroidSquash(seed: number): [number, number, number] {
  const rand = mulberry32(seed ^ 0x51ed);
  return [0.75 + rand() * 0.4, 0.75 + rand() * 0.4, 0.75 + rand() * 0.4];
}

/** How far the belt turns in a frame: none with reduced motion; long gaps (a hidden tab) capped. */
export function beltSpin(delta: number, reducedMotion: boolean): number {
  if (reducedMotion || !(delta > 0)) return 0;
  return Math.min(delta, 0.1) * BELT_ANGULAR_SPEED;
}

/** The name of a body's pick target mesh (P3-05 raycasts these). */
export const PICK_TARGET_NAME = 'pick-target';

/**
 * What a task asteroid's group and pick target carry in `userData`: P3-05 maps a raycast hit back
 * to the body (and through it to the task, SPEC §4.1).
 */
export interface BodyPickData {
  bodyId: Id;
  kind: 'asteroid';
  hostId: Id;
}

export const pickData = (a: TaskAsteroid): BodyPickData => ({
  bodyId: a.bodyId,
  kind: 'asteroid',
  hostId: a.hostId,
});
