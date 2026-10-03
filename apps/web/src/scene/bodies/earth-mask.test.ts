import { describe, expect, it } from 'vitest';
import { SphereGeometry, Vector3 } from 'three';
import { QUALITY_TIERS } from '../quality.js';
import { DEFAULT_LOOK, MOON_LOOKS, PLANET_LOOKS, type BodyLook } from './appearance.js';
import {
  decodeMask,
  EARTH_MASK_VERSION,
  earthMask,
  maskLevelFor,
  sampleLand,
  uvToLatLon,
} from './earth-mask.js';
import { EARTH_MASK_HEIGHT, EARTH_MASK_WIDTH } from './earth-mask-data.js';
import { paintAsync } from './painter.js';
import { MATTE_ROUGHNESS, OCEAN_ROUGHNESS, paintSurface, paintSurfaceLayers } from './surface.js';
import { surfaceKey, surfaceMapsKey } from './textures.js';

/** [name, lat, lon] — places far enough from any coast that every texture size agrees. */
const LAND: [string, number, number][] = [
  ['Congo basin', 0, 20],
  ['Kansas', 40, -100],
  ['Australian outback', -25, 135],
  ['Germany', 50, 10],
  ['Amazon', -8, -60],
  ['Siberia', 62, 100],
  ['Sahara', 22, 10],
  ['India', 22, 78],
];
const SEA: [string, number, number][] = [
  ['mid-Atlantic', 0, -30],
  ['central Pacific', 0, -160],
  ['Indian Ocean', -20, 80],
  ['North Pacific', 40, -150],
  ['South Atlantic', -40, -15],
];
const ICE: [string, number, number][] = [
  ['Antarctica', -80, 0],
  ['Greenland', 72, -40],
];

describe('the Earth mask (P3-09)', () => {
  it('decodes to its full size with a plausible share of land', () => {
    const [full] = earthMask();
    expect(full!.width).toBe(EARTH_MASK_WIDTH);
    expect(full!.height).toBe(EARTH_MASK_HEIGHT);
    expect(full!.data.length).toBe(EARTH_MASK_WIDTH * EARTH_MASK_HEIGHT);
    let land = 0;
    for (const v of full!.data) {
      expect(v === 0 || v === 1).toBe(true);
      land += v;
    }
    // ≈ 29 % of the globe is land; the equirectangular grid over-counts the polar regions.
    expect(land / full!.data.length).toBeGreaterThan(0.28);
    expect(land / full!.data.length).toBeLessThan(0.38);
  });

  it('builds a pyramid of averaged levels', () => {
    const levels = earthMask();
    expect(levels.map((l) => l.width)).toEqual([1024, 512, 256, 128, 64, 32]);
    const mean = (d: Float32Array) => d.reduce((s, v) => s + v, 0) / d.length;
    for (const l of levels) expect(mean(l.data)).toBeCloseTo(mean(levels[0]!.data), 5);
    expect([2048, 1024, 512, 256, 128, 8].map(maskLevelFor)).toEqual([0, 0, 1, 2, 3, 5]);
  });

  it.each(LAND)('has land at %s', (_name, lat, lon) => {
    expect(sampleLand(lat, lon)).toBe(1);
  });
  it.each(SEA)('has sea at %s', (_name, lat, lon) => {
    expect(sampleLand(lat, lon)).toBe(0);
  });
  it.each(ICE)('has land under the ice at %s', (_name, lat, lon) => {
    expect(sampleLand(lat, lon)).toBe(1);
  });

  it('is not mirrored: Africa lies east of the Atlantic, the Americas west', () => {
    expect(sampleLand(10, -10)).toBe(1); // West Africa
    expect(sampleLand(10, 10)).toBe(1); // Nigeria / Chad
    expect(sampleLand(10, -45)).toBe(0); // Atlantic
    expect(sampleLand(10, -70)).toBe(1); // Venezuela
    expect(sampleLand(-10, 10)).toBe(0); // Gulf of Guinea, south of the bulge
  });

  it('wraps in longitude and clamps at the poles', () => {
    expect(sampleLand(-87, 180)).toBeCloseTo(sampleLand(-87, -180), 6);
    expect(sampleLand(-87, 179.9)).toBe(1); // Antarctica, beyond the Ross Ice Shelf
    expect(sampleLand(0, 179.9)).toBe(0); // the Pacific
    expect(sampleLand(90, 0)).toBe(0); // the North Pole is sea
    expect(sampleLand(-90, 0)).toBe(1);
  });

  it('decodes run lengths and rejects corrupt data', () => {
    // 3 sea, 2 land, 3 sea: '3', '2', '3'; 40 = 8 + 1·32 → '8' with the "more" bit, then '1'.
    expect([...decodeMask('323', 4, 2)]).toEqual([0, 0, 0, 1, 1, 0, 0, 0]);
    expect(decodeMask('0e1', 40, 1).every((v) => v === 1)).toBe(true);
    expect(() => decodeMask('32', 4, 2)).toThrow(/texels/);
    expect(() => decodeMask('9', 4, 2)).toThrow(/overflows/);
    expect(() => decodeMask('3!3', 4, 2)).toThrow(/Bad character/);
  });
});

describe("Earth's orientation on three's sphere", () => {
  it('maps u to longitude from 180°W eastward and v to latitude from the south pole', () => {
    expect(uvToLatLon(0.5, 0.5)).toEqual({ lat: 0, lon: 0 });
    expect(uvToLatLon(0, 0)).toEqual({ lat: -90, lon: -180 });
    expect(uvToLatLon(0.75, 1)).toEqual({ lat: 90, lon: 90 });
  });

  it('puts the prime meridian on +X, 90°E on −Z and north on +Y: east is to the right, seen from outside with north up', () => {
    const g = new SphereGeometry(1, 64, 32);
    const uv = g.getAttribute('uv');
    const pos = g.getAttribute('position');
    const at = (u: number, v: number) => {
      for (let k = 0; k < uv.count; k++) {
        if (Math.abs(uv.getX(k) - u) < 1e-6 && Math.abs(uv.getY(k) - v) < 1e-6) {
          return new Vector3(pos.getX(k), pos.getY(k), pos.getZ(k));
        }
      }
      throw new Error(`no vertex at ${u}, ${v}`);
    };
    const greenwich = at(0.5, 0.5);
    const east = at(0.75, 0.5);
    expect(greenwich.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-6);
    expect(east.distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-6);
    expect(at(0.5, 0.75).y).toBeCloseTo(Math.SQRT1_2); // 45°N is up
    // Looking at Greenwich from outside (along −X) with north (+Y) up, the right hand points
    // along forward × up; 90°E must be there for the map not to be mirrored.
    const right = new Vector3(-1, 0, 0).cross(new Vector3(0, 1, 0));
    expect(right.distanceTo(east)).toBeLessThan(1e-6);
    g.dispose();
  });
});

const earth = PLANET_LOOKS['Earth']!;

/** The texel of an equirectangular texture (row 0 = south) at a place. */
function texelAt(width: number, lat: number, lon: number): number {
  const height = width / 2;
  const i = Math.min(width - 1, Math.floor(((lon + 180) / 360) * width));
  const j = Math.min(height - 1, Math.floor(((lat + 90) / 180) * height));
  return j * width + i;
}

function rgbAt(color: Uint8Array, width: number, lat: number, lon: number): number[] {
  const k = texelAt(width, lat, lon) * 4;
  return [color[k]!, color[k + 1]!, color[k + 2]!];
}

const isSea = ([r, g, b]: number[]) => b! > r! + 30 && b! > g! + 10;
const isLand = ([r, g, b]: number[]) => b! < g! && b! < r! + 10;
const isIce = ([r, g, b]: number[]) => Math.min(r!, g!, b!) > 200;

function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619);
  return (h >>> 0).toString(16);
}

describe("Earth's painted surface (P3-09)", () => {
  // Every size a tier can ask for: far (256), mobile near (512), mid (1024); 2048 is the same
  // code at mask level 0, covered by 1024 (also level 0) to keep the suite fast.
  const sizes = [
    ...new Set(
      Object.values(QUALITY_TIERS).flatMap((t) => t.lod.levels.map((l) => l.planetTexture)),
    ),
  ]
    .filter((w) => w <= 1024)
    .sort((a, b) => a - b);

  it('covers the far, mobile and mid sizes', () => {
    expect(sizes).toEqual([256, 512, 1024]);
  });

  it.each(sizes)('paints land, sea and ice where they are at %i texels', (width) => {
    const { color } = paintSurfaceLayers(earth, width, width / 2, false);
    for (const [name, lat, lon] of LAND) {
      expect([name, isLand(rgbAt(color, width, lat, lon))]).toEqual([name, true]);
    }
    for (const [name, lat, lon] of SEA) {
      expect([name, isSea(rgbAt(color, width, lat, lon))]).toEqual([name, true]);
    }
    for (const [name, lat, lon] of ICE) {
      expect([name, isIce(rgbAt(color, width, lat, lon))]).toEqual([name, true]);
    }
    expect(rgbAt(color, width, 22, 10)[0]).toBeGreaterThan(180); // the Sahara is sand
  });

  it('makes the oceans glossy and the land matte in the detail map, with relief only on land', () => {
    const width = 512;
    const { detail } = paintSurfaceLayers(earth, width, width / 2, true);
    const at = (lat: number, lon: number) => texelAt(width, lat, lon) * 2;
    for (const [, lat, lon] of SEA) {
      expect(detail![at(lat, lon) + 1]).toBe(Math.round(OCEAN_ROUGHNESS * 255));
      expect(detail![at(lat, lon)]).toBe(Math.round(0.3 * 255));
    }
    for (const [, lat, lon] of LAND) {
      expect(detail![at(lat, lon) + 1]).toBe(Math.round(MATTE_ROUGHNESS * 255));
    }
  });

  it('is deterministic, and the main-thread fallback paints the same pixels', async () => {
    const a = paintSurfaceLayers(earth, 256, 128, true);
    expect(paintSurfaceLayers(earth, 256, 128, true)).toEqual(a);
    expect(paintSurface(earth, 256, 128)).toEqual(a.color);
    expect(await paintAsync({ look: earth, width: 256, height: 128, detail: true })).toEqual(a);
  });

  it('keys its textures by the mask version', () => {
    expect(surfaceKey(earth)).toContain(`mask:earth@${EARTH_MASK_VERSION}`);
    const { landMask: _, ...noMask } = earth;
    expect(surfaceKey(noMask)).not.toEqual(surfaceKey(earth));
    expect(surfaceMapsKey(earth, 2048, true)).toContain(`@${EARTH_MASK_VERSION}@2048+detail`);
    expect(surfaceKey(PLANET_LOOKS['Mars']!)).not.toContain('mask');
  });

  it('leaves every other body exactly as it was painted before the mask', () => {
    // Hashes of the 64 × 32 colour (and detail) maps, recorded before P3-09 changed the painter.
    const before: Record<string, string> = {
      Mercury: '81cc8a2/2e44b77a',
      Venus: '437fcb37',
      Mars: 'ecb79179/1fd940f',
      Jupiter: 'c624c1b4',
      Saturn: '510d0f4b',
      Uranus: '59bacdaf',
      Neptune: '7dd71887',
      Moon: 'd025c833/247d908f',
      Phobos: '85562fe3/2e8d773c',
      Deimos: 'badefb7/a0a016ea',
      Io: 'c45adc60/e419f0bf',
      Europa: '84f3256b/2e5e2315',
      Ganymede: '2f7c7cc2/47b041',
      Callisto: 'd7326027/57e2f3d3',
      Mimas: 'ac50bd8e/9ad95f47',
      Enceladus: '4f012622/70c87db',
      Tethys: '4d62a30c/20318b0e',
      Dione: 'ba959ec3/77ced829',
      Rhea: '42cca85a/e333f33a',
      Titan: 'd44ed73a',
      Iapetus: '254dbb3a/53d6e2d',
      Miranda: 'cd409f4/cb500fb1',
      Ariel: '91a980f7/138510bc',
      Umbriel: '3e492e60/d8432a43',
      Titania: '930ca079/bd7db4b4',
      Oberon: 'd77f6ef2/5ed3eded',
      Proteus: '4c084df8/da38581e',
      Triton: '65c22db9/455b9278',
      Nereid: 'ad6205bc/99ded01f',
      DEFAULT: '195f3a50/82ef0211',
    };
    const looks: Record<string, BodyLook> = {
      ...PLANET_LOOKS,
      ...MOON_LOOKS,
      DEFAULT: DEFAULT_LOOK,
    };
    const now: Record<string, string> = {};
    for (const [name, look] of Object.entries(looks)) {
      if (name === 'Earth') continue;
      const l = paintSurfaceLayers(look, 64, 32, true);
      now[name] = fnv(l.color) + (l.detail ? `/${fnv(l.detail)}` : '');
    }
    expect(now).toEqual(before);
  });
});
