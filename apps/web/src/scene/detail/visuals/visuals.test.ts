import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOON_LOOKS, PLANET_LOOKS } from '../../bodies/appearance.js';
import { hexToRgb, paintRings, paintSurface } from '../../bodies/surface.js';
import { QUALITY_TIERS } from '../../quality.js';
import { levelTexture } from '../../bodies/textures.js';
import { atmosphereGlow, atmosphereUniformValues } from './atmosphere-shader.js';
import {
  cloudBytes,
  cloudKey,
  cloudSpec,
  DETAIL_TIERS,
  detailMapsBytes,
  detailMapsKey,
  detailMapsSpec,
  ringTextureWidth,
  viewBytes,
} from './budget.js';
import { applyFeatures, bandLatitude, craterScales, type SurfaceFeatures } from '../../bodies/features.js';
import {
  atmosphereScale,
  catalogueLookNames,
  cloudScale,
  cloudTurn,
  DEFAULT_DETAIL_LOOK,
  DETAIL_LOOKS,
  detailLook,
  PLANETSHINE_MAX,
  planetshineColor,
  planetshineStrength,
} from './looks.js';
import {
  blurHeights,
  cloudClimate,
  normalMapFromHeights,
  paintClouds,
  runPaintJob,
} from '../../bodies/paint-jobs.js';
import { ringBandOpacity, SATURN_RING_BANDS, URANUS_RING_BANDS } from '../../bodies/rings.js';

/** The catalogue's body names, from the migration that seeds it (as `bodies-model.test.ts`). */
function catalogueNames(): { planets: string[]; moons: string[] } {
  const sql = readFileSync(
    resolve(import.meta.dirname, '../../../../../server/src/db/migrations/0005_body_catalogue.sql'),
    'utf8',
  );
  const row = /\('(b-[a-z]+)', '(star|planet|moon)', (NULL|'b-[a-z]+'), '([A-Za-z]+)', '\{/g;
  const planets: string[] = [];
  const moons: string[] = [];
  for (const m of sql.matchAll(row)) {
    if (m[2] === 'planet') planets.push(m[4]!);
    if (m[2] === 'moon') moons.push(m[4]!);
  }
  return { planets, moons };
}

const { planets, moons } = catalogueNames();
const rgb = (hex: string) => hexToRgb(hex);

describe('per-body look tables', () => {
  it('cover every catalogue planet and moon (detail looks and surface features)', () => {
    expect(planets).toHaveLength(8);
    expect(moons).toHaveLength(22);
    for (const name of [...planets, ...moons]) {
      expect(DETAIL_LOOKS[name], name).toBeDefined();
      const look = PLANET_LOOKS[name] ?? MOON_LOOKS[name]!;
      // Earth is dressed by its land mask, Titan by its haze; everything else has features.
      if (name !== 'Earth' && name !== 'Titan') expect(look.features, name).toBeDefined();
    }
    expect(Object.keys(DETAIL_LOOKS).sort()).toEqual(catalogueLookNames().sort());
    expect(detailLook('Planet X')).toBe(DEFAULT_DETAIL_LOOK);
  });

  it('gives each planet what makes it recognisable', () => {
    const f = (name: string) => PLANET_LOOKS[name]!.features!;
    expect(f('Jupiter').storms?.[0]).toMatchObject({ lat: -22 }); // the Great Red Spot
    expect(f('Saturn').bands!.contrast).toBeLessThan(f('Jupiter').bands!.contrast); // pale bands
    expect(f('Uranus').bands!.contrast).toBeLessThan(0.5); // barely banded
    expect(f('Mars').maria).toBeDefined();
    expect(PLANET_LOOKS['Mars']!.polarCaps).toBe(true);
    expect(f('Mercury').craters).toBeDefined();
    expect(MOON_LOOKS['Moon']!.features!.craters).toBeDefined();
    expect(MOON_LOOKS['Moon']!.features!.maria).toBeDefined();
    expect(f('Venus').chevrons).toBeGreaterThan(0);
    expect(PLANET_LOOKS['Saturn']!.rings!.bands).toBe(SATURN_RING_BANDS);
    expect(PLANET_LOOKS['Uranus']!.rings!.bands).toBe(URANUS_RING_BANDS);
    // Only the rocky bodies tilt the light with a normal map; the giants and Venus's deck do not.
    for (const name of ['Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Venus', 'Titan'])
      expect(DETAIL_LOOKS[name]!.normalStrength).toBe(0);
    for (const name of ['Mercury', 'Earth', 'Mars', 'Moon'])
      expect(DETAIL_LOOKS[name]!.normalStrength).toBeGreaterThan(0);
  });

  it('paints the Great Red Spot red, in every texture size', () => {
    for (const width of [64, 256]) {
      const px = paintSurface(PLANET_LOOKS['Jupiter']!, width, width / 2);
      // lat −22°, lon 40° (lon 0..360 from 180°W): u = (40 + 180) / 360, v = (90 − 22) / 180.
      const i = Math.floor(((40 + 180) / 360) * width);
      const j = Math.floor(((90 - 22) / 180) * (width / 2));
      const k = (j * width + i) * 4;
      expect(px[k]! - px[k + 2]!, `width ${width}`).toBeGreaterThan(70);
    }
  });

  it('swirls the bands round a storm only within its reach', () => {
    const f = PLANET_LOOKS['Jupiter']!.features;
    const deg = Math.PI / 180;
    const far = 60 * deg;
    expect(bandLatitude(f, far, 300 * deg)).toBe(far);
    const near = bandLatitude(f, -20 * deg, (40 + 180 + 5) * deg);
    expect(near).not.toBeCloseTo(-20 * deg, 4);
  });

  it('paints craters only at sizes worth a couple of texels', () => {
    expect(craterScales(64, 3)).toEqual([]);
    expect(craterScales(256, 3)).toEqual([5]);
    expect(craterScales(4096, 3)).toEqual([5, 12, 28]);
    expect(craterScales(4096, 1)).toEqual([5]);
  });

  it('never wraps a brightened colour past 255', () => {
    const features: SurfaceFeatures = { chevrons: 2, craters: { density: 1, depth: 1, sizes: 3 } };
    for (let n = 0; n < 200; n++) {
      const lat = ((n % 20) / 20 - 0.5) * Math.PI;
      const lon = (n / 200) * Math.PI * 2;
      const texel = { rgb: [252, 250, 248], relief: 0.5 };
      applyFeatures(
        features,
        {
          lat,
          lon,
          sx: Math.cos(lat) * Math.cos(lon),
          sy: Math.sin(lat),
          sz: Math.cos(lat) * Math.sin(lon),
          seed: 7,
          width: 4096,
        },
        texel,
      );
      for (const c of texel.rgb) expect(c).toBeLessThanOrEqual(255);
    }
  });
});

describe('detail texture budget per tier', () => {
  const earth = PLANET_LOOKS['Earth']!;
  const near = (tier: keyof typeof QUALITY_TIERS, kind: 'planet' | 'moon') =>
    levelTexture(QUALITY_TIERS[tier].lod.levels[0]!, kind).width;

  it('high: Earth and Mars at 4096 with normals (Earth also roughness), giants colour only', () => {
    const spec = detailMapsSpec(
      DETAIL_TIERS.high,
      'planet',
      earth,
      DETAIL_LOOKS['Earth']!,
      2048,
      true,
    )!;
    expect(spec).toMatchObject({ width: 4096, height: 2048, normal: true, roughness: true });
    const mars = detailMapsSpec(
      DETAIL_TIERS.high,
      'planet',
      PLANET_LOOKS['Mars']!,
      DETAIL_LOOKS['Mars']!,
      2048,
      true,
    )!;
    expect(mars).toMatchObject({ width: 4096, normal: true, roughness: false });
    const jupiter = detailMapsSpec(
      DETAIL_TIERS.high,
      'planet',
      PLANET_LOOKS['Jupiter']!,
      DETAIL_LOOKS['Jupiter']!,
      2048,
      true,
    )!;
    expect(jupiter).toMatchObject({ width: 4096, normal: false, roughness: false });
  });

  it('every tier gives the shown body more than its nearest LOD level', () => {
    for (const tier of ['high', 'balanced', 'mobile'] as const) {
      for (const name of [...planets, ...moons]) {
        const kind = PLANET_LOOKS[name] ? 'planet' : 'moon';
        const look = PLANET_LOOKS[name] ?? MOON_LOOKS[name]!;
        const spec = detailMapsSpec(
          DETAIL_TIERS[tier],
          kind,
          look,
          DETAIL_LOOKS[name]!,
          near(tier, kind),
          true,
        );
        expect(spec, `${tier} ${name}`).not.toBeNull();
        expect(spec!.width).toBeGreaterThan(near(tier, kind));
        if (tier === 'mobile') expect(spec!.normal).toBe(false);
      }
    }
  });

  it("fits the largest view (Earth with its clouds) in each tier's budget", () => {
    for (const tier of ['high', 'balanced', 'mobile'] as const) {
      const t = DETAIL_TIERS[tier];
      const spec = detailMapsSpec(
        t,
        'planet',
        earth,
        DETAIL_LOOKS['Earth']!,
        near(tier, 'planet'),
        true,
      );
      expect(viewBytes(spec, cloudSpec(t)), tier).toBeLessThanOrEqual(t.budgetMB * 1024 * 1024);
    }
    const MB = 1024 * 1024;
    const high = detailMapsSpec(
      DETAIL_TIERS.high,
      'planet',
      earth,
      DETAIL_LOOKS['Earth']!,
      2048,
      true,
    )!;
    expect(detailMapsBytes(high) / MB).toBeCloseTo((4096 * 2048 * 10 * (4 / 3)) / MB, 3); // ≈ 112 MB
    expect(cloudBytes(2048) / MB).toBeCloseTo((2048 * 1024 * 2 * (4 / 3)) / MB, 3);
  });

  it('mobile drops the clouds’ and rings’ resolution; the rings never go below the system’s', () => {
    expect(cloudSpec(DETAIL_TIERS.mobile).width).toBeLessThan(cloudSpec(DETAIL_TIERS.high).width);
    expect(DETAIL_TIERS.mobile.planetTexture).toBeLessThan(DETAIL_TIERS.balanced.planetTexture);
    expect(DETAIL_TIERS.balanced.planetTexture).toBeLessThan(DETAIL_TIERS.high.planetTexture);
    expect(ringTextureWidth(DETAIL_TIERS.mobile, 256)).toBe(512);
    expect(ringTextureWidth({ ...DETAIL_TIERS.mobile, ringTexture: 128 }, 256)).toBe(256);
  });

  it('asks for no detail level without a paint worker (a 4096 paint would freeze the page)', () => {
    expect(
      detailMapsSpec(DETAIL_TIERS.high, 'planet', earth, DETAIL_LOOKS['Earth']!, 2048, false),
    ).toBeNull();
  });

  it('keys the cache by content, size and maps', () => {
    const t = DETAIL_TIERS.high;
    const spec = detailMapsSpec(t, 'planet', earth, DETAIL_LOOKS['Earth']!, 2048, true)!;
    const balanced = detailMapsSpec(
      DETAIL_TIERS.balanced,
      'planet',
      earth,
      DETAIL_LOOKS['Earth']!,
      1024,
      true,
    )!;
    expect(detailMapsKey(earth, spec)).not.toEqual(detailMapsKey(earth, balanced));
    expect(detailMapsKey(earth, spec)).toContain('mask:earth');
    expect(detailMapsKey(earth, { ...spec, normal: false, roughness: false })).not.toEqual(
      detailMapsKey(earth, spec),
    );
    const mars = PLANET_LOOKS['Mars']!;
    const marsSpec = detailMapsSpec(t, 'planet', mars, DETAIL_LOOKS['Mars']!, 2048, true)!;
    expect(detailMapsKey(mars, marsSpec)).not.toEqual(
      detailMapsKey({ ...mars, features: undefined } as never, marsSpec),
    );
    const clouds = DETAIL_LOOKS['Earth']!.clouds!;
    expect(cloudKey(clouds, 2048)).not.toEqual(cloudKey(clouds, 512));
  });
});

describe('detail paint jobs', () => {
  it('derives a flat normal map from flat relief and tilts it on a slope', () => {
    const flat = normalMapFromHeights(new Float32Array(16 * 8).fill(0.5), 16, 8, 1);
    for (let k = 0; k < flat.length; k += 4) {
      expect([flat[k], flat[k + 1], flat[k + 2]]).toEqual([128, 128, 255]);
    }
    // Rising eastward: the normal leans west (x < 0.5).
    const ramp = new Float32Array(16 * 8);
    for (let j = 0; j < 8; j++)
      for (let i = 0; i < 16; i++) ramp[j * 16 + i] = Math.sin((i / 16) * Math.PI * 2);
    const n = normalMapFromHeights(ramp, 16, 8, 0.2);
    const k = (4 * 16 + 0) * 4; // at i = 0 the ramp rises
    expect(n[k]!).toBeLessThan(128);
  });

  it('blurs relief without changing a flat field', () => {
    const flat = new Float32Array(32 * 16).fill(0.3);
    expect(Array.from(blurHeights(flat, 32, 16, 2)).every((v) => Math.abs(v - 0.3) < 1e-6)).toBe(
      true,
    );
    const spike = new Float32Array(32 * 16);
    spike[8 * 32 + 8] = 1;
    blurHeights(spike, 32, 16, 1);
    expect(spike[8 * 32 + 8]!).toBeLessThan(1);
    expect(spike[8 * 32 + 9]!).toBeGreaterThan(0);
  });

  it('paints Earth with normals and roughness, a giant without normals', () => {
    const earth = runPaintJob({
      kind: 'detail',
      look: PLANET_LOOKS['Earth']!,
      width: 64,
      height: 32,
      normal: true,
      roughness: true,
      normalStrength: 0.02,
      reliefBlur: 1,
    });
    expect(earth.color).toHaveLength(64 * 32 * 4);
    expect(earth.normal).toHaveLength(64 * 32 * 4);
    expect(earth.detail).toHaveLength(64 * 32 * 2);
    const jupiter = runPaintJob({
      kind: 'detail',
      look: PLANET_LOOKS['Jupiter']!,
      width: 64,
      height: 32,
      normal: false,
      roughness: false,
      normalStrength: 0,
    });
    expect(jupiter.normal).toBeNull();
    expect(jupiter.detail).toBeNull();
    // The detail level's colour is the same painter's: identical to the surface map at that size.
    expect(jupiter.color).toEqual(paintSurface(PLANET_LOOKS['Jupiter']!, 64, 32));
  });

  it('paints clouds deterministically, within the coverage, cloudier in the storm tracks', () => {
    const clouds = DETAIL_LOOKS['Earth']!.clouds!;
    const a = paintClouds(clouds, 128, 64);
    expect(paintClouds(clouds, 128, 64)).toEqual(a);
    let covered = 0;
    for (let k = 0; k < a.length; k += 2) {
      expect(a[k]).toBe(a[k + 1]);
      covered += a[k]! / 255;
    }
    const mean = covered / (a.length / 2);
    expect(mean).toBeGreaterThan(0.2);
    expect(mean).toBeLessThan(0.8);
    expect(cloudClimate(55)).toBeGreaterThan(cloudClimate(24));
    expect(cloudClimate(0)).toBeGreaterThan(cloudClimate(24));
    const job = runPaintJob({ kind: 'clouds', clouds, width: 32, height: 16 });
    expect(job.color).toEqual(paintClouds(clouds, 32, 16));
  });
});

describe('rings from their measured profile', () => {
  it('has the Cassini division nearly empty between the bright B and A rings', () => {
    const soft = 0.002;
    expect(ringBandOpacity(SATURN_RING_BANDS, 1.8, soft)).toBe(1);
    expect(ringBandOpacity(SATURN_RING_BANDS, 1.99, soft)).toBeLessThan(0.1);
    expect(ringBandOpacity(SATURN_RING_BANDS, 2.1, soft)).toBeGreaterThan(0.6);
    expect(ringBandOpacity(SATURN_RING_BANDS, 2.218, soft)).toBeLessThan(0.1); // Encke gap
    expect(ringBandOpacity(URANUS_RING_BANDS, 1.99, soft)).toBe(1); // ε
    expect(ringBandOpacity(URANUS_RING_BANDS, 1.95, soft)).toBe(0);
  });

  it('paints the same structure at the system’s and the detail view’s widths', () => {
    const rings = PLANET_LOOKS['Saturn']!.rings!;
    const alphaAt = (px: Uint8Array, width: number, r: number) => {
      const i = Math.round(((r - rings.inner) / (rings.outer - rings.inner)) * (width - 1));
      return px[i * 4 + 3]!;
    };
    for (const width of [256, 2048]) {
      const px = paintRings(rings, width);
      expect(alphaAt(px, width, 1.99)).toBeLessThan(alphaAt(px, width, 1.8) / 4);
    }
  });
});

describe('atmosphere and clouds parameters', () => {
  const color = (name: string) => rgb(DETAIL_LOOKS[name]!.atmosphere!.color);

  it('colours each atmosphere as itself, the giants faint', () => {
    const [er, eg, eb] = color('Earth');
    expect(eb).toBeGreaterThan(er);
    expect(eb).toBeGreaterThan(eg);
    const [vr, , vb] = color('Venus');
    expect(vr).toBeGreaterThan(vb); // yellowish
    const [mr, mg, mb] = color('Mars');
    expect(mr).toBeGreaterThan(mg);
    expect(mr).toBeGreaterThan(mb); // pinkish
    const earth = DETAIL_LOOKS['Earth']!.atmosphere!;
    for (const name of ['Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Mars'])
      expect(DETAIL_LOOKS[name]!.atmosphere!.intensity).toBeLessThan(earth.intensity);
    expect(DETAIL_LOOKS['Mercury']!.atmosphere).toBeUndefined();
    expect(DETAIL_LOOKS['Moon']!.atmosphere).toBeUndefined();
    expect(DETAIL_LOOKS['Titan']!.atmosphere).toBeDefined();
  });

  it('keeps Earth’s clouds inside its glow', () => {
    const earth = DETAIL_LOOKS['Earth']!;
    expect(cloudScale(earth.clouds!)).toBeGreaterThan(1);
    expect(atmosphereScale(earth)).toBeGreaterThan(cloudScale(earth.clouds!));
    expect(atmosphereUniformValues(earth.atmosphere!).inner).toBeCloseTo(
      1 / atmosphereScale(earth),
      6,
    );
  });

  it('glows brightest just past the limb, faintly over the disc, nothing beyond the shell', () => {
    const inner = 1 / 1.035;
    const camera = [0, 0, 1000] as const; // far: nearly parallel rays
    const at = (b: number) => {
      // The shell point seen at impact parameter b (front side).
      const z = Math.sqrt(Math.max(0, 1 - b * b));
      return atmosphereGlow(camera, [b, 0, z], inner, 1.6);
    };
    expect(at(0)).toBeLessThan(0.05);
    expect(at(inner + 0.001)).toBeGreaterThan(0.9);
    expect(at(0.9999)).toBeLessThan(0.2);
  });

  it('holds the clouds still under reduced motion, drifting slowly otherwise', () => {
    const clouds = DETAIL_LOOKS['Earth']!.clouds!;
    expect(cloudTurn(clouds, 100, 60, false)).toBe(0);
    const surface = (100 / 60) * Math.PI * 2;
    const turn = cloudTurn(clouds, 100, 60, true);
    expect(turn).toBeGreaterThan(surface);
    expect(turn).toBeLessThan(surface * 1.1);
  });
});

describe('planetshine on the moons', () => {
  it('is strongest between the planet and the Sun, nothing in the planet’s shadow, capped', () => {
    const planet = [100, 0, 0] as const;
    const between = planetshineStrength(planet, [97, 0, 0], 0.5);
    const behind = planetshineStrength(planet, [103, 0, 0], 0.5);
    const side = planetshineStrength(planet, [100, 3, 0], 0.5);
    expect(behind).toBeCloseTo(0, 6);
    expect(between).toBeGreaterThan(side);
    expect(side).toBeGreaterThan(behind);
    expect(planetshineStrength(planet, [99.9, 0, 0], 4)).toBe(PLANETSHINE_MAX);
    expect(planetshineColor(['#000000', '#ffffff'])).toBe('#808080');
  });
});
