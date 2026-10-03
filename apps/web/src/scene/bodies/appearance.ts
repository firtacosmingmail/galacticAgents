/**
 * How each catalogue planet and moon looks (P3-02): a static table keyed by the body's name, as
 * seeded by migration 0005. The bodies themselves come from the world (the store); this table only
 * dresses them. A body with a name not in the table (a future catalogue entry) gets `DEFAULT_LOOK`.
 *
 * Surfaces are procedural (`surface.ts` paints them at runtime from `style` and `palette`): no
 * image assets. Earth alone also has real coastlines (`landMask`, P3-09): a small land/sea mask
 * generated from public-domain Natural Earth data (`earth-mask.ts`).
 *
 * Sizes: `radius` is the readable-layout ("fake scale") radius in scene units, hand-tuned so the
 * giants read as giants without swallowing their moons; `radiusKm` and `distanceKm` are the real
 * values, used by true scale.
 */
export type SurfaceStyle = 'rocky' | 'gas' | 'ice' | 'earth' | 'cloudy';

export interface RingLook {
  /** Inner and outer edge, in planet radii. */
  inner: number;
  outer: number;
  /** sRGB colours from the inner to the outer edge. */
  palette: readonly string[];
  /** Peak opacity (Saturn's are bright, Uranus's faint and dark). */
  opacity: number;
  /** Seed for the band pattern. */
  seed: number;
}

export interface BodyLook {
  style: SurfaceStyle;
  /** sRGB colours the surface painter mixes (dark to light, or band colours for gas giants). */
  palette: readonly string[];
  /** Readable-layout radius, scene units. */
  radius: number;
  /** Real mean radius, km (true scale). */
  radiusKm: number;
  /** Axial tilt (obliquity), degrees. Moons orbit in their planet's equatorial plane. */
  tiltDeg: number;
  /** Polar ice caps (Earth, Mars). */
  polarCaps?: boolean;
  /** Real coastlines from a land/sea mask instead of noise continents (Earth, P3-09). */
  landMask?: 'earth';
  rings?: RingLook;
  /** Moons: real mean distance from the planet, km (true scale). */
  distanceKm?: number;
  /** Seed for the surface pattern, so each body looks the same on every load. */
  seed: number;
}

export const PLANET_LOOKS: Readonly<Record<string, BodyLook>> = {
  Mercury: {
    style: 'rocky',
    palette: ['#5b5550', '#8f8780', '#b3aca4'],
    radius: 1.0,
    radiusKm: 2440,
    tiltDeg: 0.03,
    seed: 11,
  },
  Venus: {
    style: 'cloudy',
    palette: ['#b88a4a', '#d9b77a', '#efdcae'],
    radius: 1.6,
    radiusKm: 6052,
    tiltDeg: 177.4,
    seed: 12,
  },
  Earth: {
    style: 'earth',
    palette: ['#1d3f7a', '#2f6db0', '#4d7a3a', '#9a8a5a'],
    radius: 1.7,
    radiusKm: 6371,
    tiltDeg: 23.44,
    polarCaps: true,
    landMask: 'earth',
    seed: 13,
  },
  Mars: {
    style: 'rocky',
    palette: ['#7a3418', '#b5562b', '#d9884f'],
    radius: 1.2,
    radiusKm: 3390,
    tiltDeg: 25.19,
    polarCaps: true,
    seed: 14,
  },
  Jupiter: {
    style: 'gas',
    palette: ['#8c6a4f', '#c9a27c', '#efe1c6', '#b07a52', '#e3caa4'],
    radius: 4.5,
    radiusKm: 69911,
    tiltDeg: 3.13,
    seed: 15,
  },
  Saturn: {
    style: 'gas',
    palette: ['#a88a5c', '#d8c08e', '#efe0b8', '#c4a56f'],
    radius: 3.8,
    radiusKm: 58232,
    tiltDeg: 26.73,
    rings: {
      inner: 1.24,
      outer: 2.27,
      palette: ['#6f6450', '#cdbb94', '#e8dcbc', '#a89878'],
      opacity: 0.9,
      seed: 61,
    },
    seed: 16,
  },
  Uranus: {
    style: 'ice',
    palette: ['#7fb8c4', '#9fd3dc', '#c3e9ee'],
    radius: 2.6,
    radiusKm: 25362,
    tiltDeg: 97.77,
    rings: {
      inner: 1.64,
      outer: 2.0,
      palette: ['#4a5258', '#7b8790'],
      opacity: 0.45,
      seed: 71,
    },
    seed: 17,
  },
  Neptune: {
    style: 'ice',
    palette: ['#2a4fb0', '#3f6fd6', '#7aa0ec'],
    radius: 2.5,
    radiusKm: 24622,
    tiltDeg: 28.32,
    seed: 18,
  },
};

function moon(
  palette: readonly string[],
  radius: number,
  radiusKm: number,
  distanceKm: number,
  seed: number,
  style: SurfaceStyle = 'rocky',
): BodyLook {
  return { style, palette, radius, radiusKm, distanceKm, tiltDeg: 0, seed };
}

const GREY = ['#5d5d5d', '#8c8c8c', '#b8b8b8'] as const;
const ICY = ['#9aa3ab', '#c9d0d6', '#eef2f5'] as const;

export const MOON_LOOKS: Readonly<Record<string, BodyLook>> = {
  Moon: moon(GREY, 0.45, 1737, 384_400, 101),
  Phobos: moon(['#4d4239', '#6f6256', '#8a7c6e'], 0.2, 11, 9_376, 102),
  Deimos: moon(['#5a4f44', '#7d6f61', '#998b7c'], 0.16, 6, 23_460, 103),
  Io: moon(['#b5892a', '#e0c34a', '#f4e98a'], 0.45, 1822, 421_700, 104),
  Europa: moon(['#9c8a73', '#d6c9b1', '#f1eadb'], 0.4, 1561, 671_034, 105),
  Ganymede: moon(['#5f574c', '#8f8476', '#bdb3a4'], 0.6, 2634, 1_070_412, 106),
  Callisto: moon(['#3f3a33', '#5f574c', '#887e70'], 0.55, 2410, 1_882_709, 107),
  Mimas: moon(ICY, 0.22, 198, 185_539, 108),
  Enceladus: moon(['#c9d6de', '#e6eef2', '#ffffff'], 0.25, 252, 237_948, 109),
  Tethys: moon(ICY, 0.32, 531, 294_619, 110),
  Dione: moon(ICY, 0.33, 561, 377_396, 111),
  Rhea: moon(ICY, 0.4, 764, 527_108, 112),
  Titan: moon(['#9a6b2c', '#c8913f', '#e0b45e'], 0.6, 2575, 1_221_870, 113, 'cloudy'),
  Iapetus: moon(['#2e2a26', '#8f8a82', '#e6e2da'], 0.38, 735, 3_560_820, 114),
  Miranda: moon(GREY, 0.2, 236, 129_390, 115),
  Ariel: moon(ICY, 0.3, 579, 191_020, 116),
  Umbriel: moon(['#45423f', '#5f5b57', '#7a7570'], 0.3, 585, 266_000, 117),
  Titania: moon(['#7d746c', '#a49a90', '#c6bcb2'], 0.38, 789, 435_910, 118),
  Oberon: moon(['#6a6058', '#8f857b', '#b0a69c'], 0.36, 761, 583_520, 119),
  Proteus: moon(['#3f3f3f', '#5a5a5a', '#787878'], 0.24, 210, 117_647, 120),
  Triton: moon(['#a99c95', '#d2c4bd', '#f0e6e0'], 0.45, 1353, 354_759, 121),
  Nereid: moon(GREY, 0.2, 170, 5_513_818, 122),
};

/** The look of a body whose name the table does not know: a plain grey rock. */
export const DEFAULT_LOOK: BodyLook = {
  style: 'rocky',
  palette: GREY,
  radius: 1.0,
  radiusKm: 2000,
  tiltDeg: 0,
  seed: 7,
};

export const DEFAULT_MOON_LOOK: BodyLook = { ...DEFAULT_LOOK, radius: 0.3, radiusKm: 500 };

export function planetLook(name: string): BodyLook {
  return PLANET_LOOKS[name] ?? DEFAULT_LOOK;
}

export function moonLook(name: string): BodyLook {
  return MOON_LOOKS[name] ?? DEFAULT_MOON_LOOK;
}
