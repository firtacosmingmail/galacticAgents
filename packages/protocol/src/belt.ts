import type { Id } from './primitives.js';

/**
 * The asteroid belt's deterministic generator (P2-02, moved here by P3-03): the server names and
 * places a new task asteroid with `asteroidSpec(n)`; the web client draws the decorative belt
 * from the same seed and orbit ranges, so both sides agree on where the belt is. Pure functions,
 * no Node or browser APIs.
 */

/** A small deterministic PRNG (mulberry32) in [0, 1): the same seed always gives the same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fixed seed of the belt: asteroid `n` is derived from it and `n` alone. */
export const BELT_SEED = 0x5eed_2026;

/**
 * The belt's extent: orbit radius in AU (between Mars and Jupiter; `innerAu + widthAu` =
 * `outerAu`) and the largest tilt of an orbit's plane, in radians, either way.
 */
export const BELT_ORBIT = {
  innerAu: 2.2,
  widthAu: 1.1,
  outerAu: 3.3,
  maxInclination: 0.15,
} as const;

/** A decorative orbit in the belt (TECHNOLOGY §2.1; corner case 26): AU, radians, radians. */
export interface BeltOrbit {
  radius: number;
  phase: number;
  inclination: number;
}

/** Three draws from `rand`, in this order: radius, phase, inclination (unrounded). */
export function drawBeltOrbit(rand: () => number): BeltOrbit {
  return {
    radius: BELT_ORBIT.innerAu + rand() * BELT_ORBIT.widthAu,
    phase: rand() * 2 * Math.PI,
    inclination: (rand() - 0.5) * (2 * BELT_ORBIT.maxInclination),
  };
}

const ONSETS = [
  '',
  'b',
  'c',
  'd',
  'f',
  'g',
  'k',
  'l',
  'm',
  'n',
  'p',
  'r',
  's',
  't',
  'v',
  'z',
  'th',
  'kr',
  'st',
];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'io'];
const CODAS = ['', '', 'n', 'r', 's', 'l', 'x'];

export interface AsteroidSpec {
  id: Id;
  name: string;
  meta: {
    number: number;
    seed: number;
    /** Decorative orbit in the belt, rounded to three decimals. */
    orbit: BeltOrbit;
  };
}

/** The seed of asteroid number `n`. */
export const asteroidSeed = (n: number): number => (BELT_SEED ^ Math.imul(n, 0x9e3779b1)) >>> 0;

/**
 * Asteroid number `n` of the belt: id, name ("(n) Name", after minor-planet designations) and
 * orbit, all a pure function of `n` — a replayed log or a second server builds the same belt.
 */
export function asteroidSpec(n: number): AsteroidSpec {
  const seed = asteroidSeed(n);
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const syllables = 2 + Math.floor(rand() * 2);
  let word = '';
  for (let i = 0; i < syllables; i++) word += pick(ONSETS) + pick(VOWELS);
  word += pick(CODAS);
  const name = `(${n}) ${word[0]!.toUpperCase()}${word.slice(1)}`;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const orbit = drawBeltOrbit(rand);
  return {
    id: `b-asteroid-${n}`,
    name,
    meta: {
      number: n,
      seed,
      orbit: {
        radius: round(orbit.radius),
        phase: round(orbit.phase),
        inclination: round(orbit.inclination),
      },
    },
  };
}
