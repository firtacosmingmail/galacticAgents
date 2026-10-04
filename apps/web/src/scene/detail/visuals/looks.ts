import { MOON_LOOKS, PLANET_LOOKS } from '../../bodies/appearance.js';

/**
 * How each catalogue body looks **in its detail view** (P6-02), on top of its surface look
 * (`bodies/appearance.ts`, which now also carries the features every view paints): its atmosphere
 * glow, Earth's clouds, how strongly the detail level's normal map tilts the light, and the
 * surface's roughness where no roughness map varies it. Keyed by name like the surface looks; a
 * body the table does not know gets `DEFAULT_DETAIL_LOOK` (no atmosphere, matte rock).
 */
export interface AtmosphereLook {
  /** sRGB colour of the glow. */
  color: string;
  /** Peak brightness at the limb (1 ≈ Earth's). */
  intensity: number;
  /** Shell thickness above the surface, in body radii. */
  thickness: number;
  /** Falloff exponent of the glow across the shell (higher: hugs the limb). */
  power: number;
}

export interface CloudLook {
  /** Seed of the cloud pattern. */
  seed: number;
  /** Fraction of the sky covered, 0..1. */
  coverage: number;
  /** Opacity of a fully cloudy texel. */
  opacity: number;
  /** Extra turns of the clouds per turn of the surface (they drift slowly eastward). */
  drift: number;
  /** Height of the cloud shell above the surface, body radii. */
  altitude: number;
}

export interface DetailLook {
  atmosphere?: AtmosphereLook;
  clouds?: CloudLook;
  /** Slope of the normal map per unit of relief per radian (0: no normal map, e.g. a giant). */
  normalStrength: number;
  /** Roughness where no map varies it (icy moons are a little glossier than rock). */
  roughness: number;
  /**
   * Blur of the relief before the normals are derived, in texels of a 4096 map (scaled with the
   * width): Earth's coasts follow a coarser land mask, whose steps would otherwise be embossed.
   */
  reliefBlur?: number;
}

export const DEFAULT_DETAIL_LOOK: DetailLook = { normalStrength: 0.045, roughness: 0.95 };

const ROCK: DetailLook = DEFAULT_DETAIL_LOOK;
const ICE: DetailLook = { normalStrength: 0.035, roughness: 0.7 };

export const DETAIL_LOOKS: Readonly<Record<string, DetailLook>> = {
  Mercury: { normalStrength: 0.05, roughness: 0.95 },
  Venus: {
    atmosphere: { color: '#f3d58e', intensity: 1.1, thickness: 0.06, power: 1.3 },
    normalStrength: 0,
    roughness: 0.9,
  },
  Earth: {
    atmosphere: { color: '#5aa2ff', intensity: 1, thickness: 0.035, power: 1.6 },
    clouds: { seed: 31, coverage: 0.5, opacity: 0.95, drift: 0.04, altitude: 0.01 },
    normalStrength: 0.02,
    roughness: 0.95,
    reliefBlur: 4,
  },
  Mars: {
    atmosphere: { color: '#eaa08a', intensity: 0.45, thickness: 0.025, power: 2 },
    normalStrength: 0.05,
    roughness: 0.95,
  },
  Jupiter: {
    atmosphere: { color: '#ead6b4', intensity: 0.35, thickness: 0.02, power: 2.4 },
    normalStrength: 0,
    roughness: 0.95,
  },
  Saturn: {
    atmosphere: { color: '#eee0b6', intensity: 0.3, thickness: 0.02, power: 2.4 },
    normalStrength: 0,
    roughness: 0.95,
  },
  Uranus: {
    atmosphere: { color: '#a6eaf2', intensity: 0.5, thickness: 0.03, power: 2 },
    normalStrength: 0,
    roughness: 0.9,
  },
  Neptune: {
    atmosphere: { color: '#6e9cff', intensity: 0.5, thickness: 0.03, power: 2 },
    normalStrength: 0,
    roughness: 0.9,
  },
  Moon: ROCK,
  Phobos: ROCK,
  Deimos: ROCK,
  Io: { normalStrength: 0.03, roughness: 0.9 },
  Europa: ICE,
  Ganymede: ROCK,
  Callisto: ROCK,
  Mimas: ICE,
  Enceladus: { normalStrength: 0.03, roughness: 0.6 },
  Tethys: ICE,
  Dione: ICE,
  Rhea: ICE,
  Titan: {
    atmosphere: { color: '#e0a650', intensity: 1, thickness: 0.08, power: 1.2 },
    normalStrength: 0,
    roughness: 0.95,
  },
  Iapetus: ROCK,
  Miranda: ICE,
  Ariel: ICE,
  Umbriel: ROCK,
  Titania: ICE,
  Oberon: ROCK,
  Proteus: ROCK,
  Triton: ICE,
  Nereid: ROCK,
};

export function detailLook(name: string): DetailLook {
  return DETAIL_LOOKS[name] ?? DEFAULT_DETAIL_LOOK;
}

/** Every body name the surface tables know (for the tests: the detail table must cover them). */
export function catalogueLookNames(): string[] {
  return [...Object.keys(PLANET_LOOKS), ...Object.keys(MOON_LOOKS)];
}

/**
 * The atmosphere shell's radius, in body radii (the mesh is scaled by it): the shell sits just
 * above the clouds, if any, so the clouds are inside the glow.
 */
export function atmosphereScale(look: DetailLook): number {
  return 1 + (look.atmosphere?.thickness ?? 0);
}

/** The cloud shell's radius, in body radii. */
export function cloudScale(clouds: CloudLook): number {
  return 1 + clouds.altitude;
}

/**
 * The clouds' turn (radians) at `seconds` on the motion clock for a surface turning once per
 * `spinPeriod` seconds: the surface's turn plus the drift. Reduced motion (`motion` false) holds
 * them still at 0, like the surface.
 */
export function cloudTurn(
  clouds: CloudLook,
  seconds: number,
  spinPeriod: number,
  motion: boolean,
): number {
  if (!motion) return 0;
  return (seconds / spinPeriod) * Math.PI * 2 * (1 + clouds.drift);
}

/**
 * Planetshine (P6-02, the moons' lighting in a detail view): a moon's night side faintly lit by
 * its planet's day side. The planet's colour is its palette's mean (sRGB hex); the strength
 * follows how much of the planet's lit hemisphere faces the moon — `(1 + cos θ) / 2`, θ the angle
 * at the planet between the Sun (at the world origin) and the moon — and the planet's apparent size
 * from the moon, `(R / d)²`, capped at `PLANETSHINE_MAX`. Applied as the moon material's emissive,
 * which is not eclipsed: in the planet's shadow the moon sees the planet's night side (θ ≈ 180°,
 * strength ≈ 0), so it goes dark as it should.
 */
export const PLANETSHINE_MAX = 0.12;
const PLANETSHINE_GAIN = 0.6;

export function planetshineColor(palette: readonly string[]): string {
  const sum: [number, number, number] = [0, 0, 0];
  for (const hex of palette) {
    const n = parseInt(hex.replace('#', ''), 16);
    sum[0] += (n >> 16) & 255;
    sum[1] += (n >> 8) & 255;
    sum[2] += n & 255;
  }
  const k = Math.max(1, palette.length);
  return `#${sum
    .map((c) =>
      Math.round(c / k)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function planetshineStrength(
  planet: readonly [number, number, number],
  moon: readonly [number, number, number],
  planetRadius: number,
): number {
  const toSun = [-planet[0], -planet[1], -planet[2]] as const;
  const toMoon = [moon[0] - planet[0], moon[1] - planet[1], moon[2] - planet[2]] as const;
  const ls = Math.hypot(...toSun);
  const lm = Math.hypot(...toMoon);
  if (ls < 1e-6 || lm < 1e-6) return 0;
  const cos = (toSun[0] * toMoon[0] + toSun[1] * toMoon[1] + toSun[2] * toMoon[2]) / (ls * lm);
  const lit = (1 + cos) / 2;
  return Math.min(PLANETSHINE_MAX, PLANETSHINE_GAIN * lit * (planetRadius / lm) ** 2);
}
