import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Mesh, ShaderLib, type WebGLProgramParametersWithUniforms } from 'three';
import type { Body } from '@galactic/protocol';
import { orbitPoint } from '../orbit.js';
import { QUALITY_TIERS } from '../quality.js';
import { auToScene, PLANET_AU } from '../scale.js';
import { buildRenderList, type PlanetItem } from './layout.js';
import {
  ECLIPSE_PENUMBRA_MAX,
  eclipseCasters,
  eclipseLight,
  eclipseReceivers,
  MAX_ECLIPSE_CASTERS,
  patchEclipseShader,
  ringsId,
} from './eclipse.js';
import { EclipseSystem, useEclipse } from './eclipse-binding.js';

/** The seeded catalogue, read from the migration itself (as in `bodies-model.test.ts`). */
function seededCatalogue(): Body[] {
  const sql = readFileSync(
    resolve(import.meta.dirname, '../../../../server/src/db/migrations/0005_body_catalogue.sql'),
    'utf8',
  );
  const row =
    /\('(b-[a-z]+)', '(star|planet|moon)', (NULL|'b-[a-z]+'), '([A-Za-z]+)', '(\{[^']*\})'\)/g;
  return [...sql.matchAll(row)].map(([, id, kind, parent, name, meta]) => ({
    id: id!,
    kind: kind as Body['kind'],
    ...(parent !== 'NULL' ? { parentId: parent!.slice(1, -1) } : {}),
    name: name!,
    meta: JSON.parse(meta!) as Record<string, unknown>,
  }));
}

const LIST = buildRenderList(seededCatalogue(), 'fake');
const SUN_RADIUS = 6;
const planet = (name: string): PlanetItem => LIST.find((p) => p.name === name)!;
const names = (ids: { bodyId: string }[]) =>
  ids.map((c) => LIST.flatMap((p) => [p, ...p.moons]).find((b) => b.bodyId === c.bodyId)!.name);

describe('the root cause (P3-10): a point light magnifies an inner planet over an outer one', () => {
  it('in the readable layout, Mercury, Venus and Earth throw shadows wider than Jupiter or Saturn', () => {
    // Shadow radius at the receiver from a point light at the Sun: r × d_receiver / d_caster.
    const at = (name: string) => auToScene(PLANET_AU[planet(name).orbit - 1]!, 'fake');
    for (const caster of ['Mercury', 'Venus', 'Earth']) {
      for (const receiver of ['Jupiter', 'Saturn']) {
        const shadow = (planet(caster).radius * at(receiver)) / at(caster);
        expect(shadow).toBeGreaterThan(planet(receiver).radius);
      }
    }
  });

  it('so Venus, lined up with the Sun and Jupiter, would black out the whole lit disc', () => {
    const venus = planet('Venus');
    const jupiter = planet('Jupiter');
    const v = orbitPoint(venus.distance, 0);
    const j = orbitPoint(jupiter.distance, 0);
    // Points across Jupiter's disc as seen from the Sun (its lit hemisphere's silhouette).
    for (const off of [-0.9, -0.5, 0, 0.5, 0.9]) {
      for (const up of [-0.9, 0, 0.9]) {
        if (Math.hypot(off, up) > 0.95) continue;
        const p = [j[0] - jupiter.radius * 0.3, up * jupiter.radius, off * jupiter.radius] as const;
        expect(eclipseLight(p, [[v[0], v[1], v[2], venus.radius]], SUN_RADIUS)).toBe(0);
      }
    }
  });
});

describe('casting rules (P3-10)', () => {
  it("a system's casters are its planet and its largest moons, biggest first", () => {
    expect(names(eclipseCasters(planet('Jupiter')))).toEqual([
      'Jupiter',
      'Ganymede',
      'Callisto',
      'Io',
      'Europa',
    ]);
    expect(names(eclipseCasters(planet('Saturn')))).toEqual(['Saturn', 'Titan']);
    expect(names(eclipseCasters(planet('Earth')))).toEqual(['Earth', 'Moon']);
    expect(names(eclipseCasters(planet('Mars')))).toEqual(['Mars']); // Phobos, Deimos: too small
    expect(names(eclipseCasters(planet('Neptune')))).toEqual(['Neptune', 'Triton']);
  });

  it('every planet, moon and ring system receives, from its own system only, never itself', () => {
    for (const p of LIST) {
      const own = new Set([p.bodyId, ...p.moons.map((m) => m.bodyId)]);
      const receivers = eclipseReceivers(p);
      expect(receivers.map((r) => r.id)).toEqual([
        p.bodyId,
        ...p.moons.map((m) => m.bodyId),
        ...(p.look.rings ? [ringsId(p.bodyId)] : []),
      ]);
      for (const r of receivers) {
        expect(r.casters.length).toBeLessThanOrEqual(MAX_ECLIPSE_CASTERS);
        for (const c of r.casters) {
          expect(own.has(c.bodyId)).toBe(true);
          expect(c.bodyId).not.toBe(r.id);
        }
      }
    }
  });

  it('a planet never eclipses another planet', () => {
    const planets = new Set(LIST.map((p) => p.bodyId));
    for (const p of LIST) {
      for (const r of eclipseReceivers(p)) {
        const otherPlanets = r.casters.filter(
          (c) => planets.has(c.bodyId) && c.bodyId !== p.bodyId,
        );
        expect(otherPlanets).toEqual([]);
      }
    }
  });

  it('Saturn shades its rings (and Titan does too); the rings cast on nothing', () => {
    const saturn = planet('Saturn');
    const rings = eclipseReceivers(saturn).find((r) => r.id === ringsId(saturn.bodyId))!;
    expect(names(rings.casters)).toEqual(['Saturn', 'Titan']);
    const casterIds = LIST.flatMap((p) => eclipseCasters(p).map((c) => c.bodyId));
    expect(casterIds.some((id) => id.endsWith(':rings'))).toBe(false);
  });

  it("a moon is eclipsed by its planet; the planet takes its moons' spots", () => {
    const jupiter = planet('Jupiter');
    const io = jupiter.moons.find((m) => m.name === 'Io')!;
    const receivers = eclipseReceivers(jupiter);
    expect(names(receivers.find((r) => r.id === io.bodyId)!.casters)).toEqual([
      'Jupiter',
      'Ganymede',
      'Callisto',
      'Europa',
    ]);
    expect(names(receivers.find((r) => r.id === jupiter.bodyId)!.casters)).toEqual([
      'Ganymede',
      'Callisto',
      'Io',
      'Europa',
    ]);
  });

  it('caps the casters at the shader array size, keeping the largest', () => {
    const big = planet('Saturn');
    const many: PlanetItem = {
      ...big,
      moons: Array.from({ length: 9 }, (_, i) => ({
        ...big.moons[0]!,
        bodyId: `b-m${i}`,
        radius: 0.1 + i * 0.05,
        castShadow: true,
      })),
    };
    const casters = eclipseCasters(many);
    expect(casters).toHaveLength(MAX_ECLIPSE_CASTERS);
    expect(casters[0]!.bodyId).toBe(big.bodyId);
    expect(casters.slice(1).map((c) => c.bodyId)).toEqual(['b-m8', 'b-m7', 'b-m6', 'b-m5', 'b-m4']);
  });

  it('only the high tier shades (the other tiers keep their budget)', () => {
    expect(QUALITY_TIERS.high.shadows).toBe(true);
    expect(QUALITY_TIERS.balanced.shadows).toBe(false);
    expect(QUALITY_TIERS.mobile.shadows).toBe(false);
  });
});

describe('eclipseLight (the shader maths, mirrored)', () => {
  // Jupiter on +x at 90, Io between it and the Sun, 6.55 closer.
  const jupiterX = 90;
  const io = [jupiterX - 6.55, 0, 0, 0.45] as const;
  const onJupiter = (z: number) => [jupiterX - Math.sqrt(4.5 ** 2 - z * z), 0, z] as const;

  it("is dark under the moon, lit outside its shadow: a spot the moon's size, not magnified", () => {
    expect(eclipseLight(onJupiter(0), [io], SUN_RADIUS)).toBe(0);
    const w = io[3] * ECLIPSE_PENUMBRA_MAX;
    // Within the system the rays from the Sun are nearly parallel: ×(90 / 83.45) ≈ 1.08 wider.
    const k = jupiterX / io[0];
    expect(eclipseLight(onJupiter((io[3] - w) * 0.99), [io], SUN_RADIUS)).toBe(0);
    expect(eclipseLight(onJupiter((io[3] + w) * k * 1.01), [io], SUN_RADIUS)).toBe(1);
    const edge = eclipseLight(onJupiter(io[3]), [io], SUN_RADIUS);
    expect(edge).toBeGreaterThan(0.3);
    expect(edge).toBeLessThan(0.7);
  });

  it('a caster behind the point, or past the Sun, casts nothing', () => {
    const behind = [jupiterX + 6, 0, 0, 0.45] as const;
    expect(eclipseLight(onJupiter(0), [behind], SUN_RADIUS)).toBe(1);
    const pastSun = [-10, 0, 0, 3] as const;
    expect(eclipseLight([5, 0, 0], [pastSun], SUN_RADIUS)).toBe(1);
  });

  it('multiplies overlapping casters and stays in [0, 1]', () => {
    const a = [jupiterX - 6, 0, 0.45, 0.45] as const;
    const b = [jupiterX - 8, 0, -0.45, 0.45] as const;
    for (const z of [-1, -0.45, 0, 0.45, 1, 2]) {
      const both = eclipseLight(onJupiter(z), [a, b], SUN_RADIUS);
      const product =
        eclipseLight(onJupiter(z), [a], SUN_RADIUS) * eclipseLight(onJupiter(z), [b], SUN_RADIUS);
      expect(both).toBeCloseTo(product, 10);
      expect(both).toBeGreaterThanOrEqual(0);
      expect(both).toBeLessThanOrEqual(1);
    }
  });

  it("Saturn's shadow reaches its rings behind it", () => {
    const s = planet('Saturn');
    const ringR = s.radius * ((s.look.rings!.inner + s.look.rings!.outer) / 2);
    // Ring point straight behind Saturn (away from the Sun), slightly below the ring plane's
    // centre line so the shadow cylinder covers it: dark. The same radius sideways: lit.
    expect(eclipseLight([125 + ringR, 0.5, 0], [[125, 0, 0, s.radius]], SUN_RADIUS)).toBe(0);
    expect(eclipseLight([125, 0, ringR], [[125, 0, 0, s.radius]], SUN_RADIUS)).toBe(1);
  });
});

describe('the shader patch', () => {
  it("anchors on three's standard material chunks and adds the eclipse once", () => {
    const { vertexShader, fragmentShader } = patchEclipseShader(
      ShaderLib.standard.vertexShader,
      ShaderLib.standard.fragmentShader,
    );
    expect(vertexShader.match(/vEclipseWorld = /g)).toHaveLength(1);
    expect(fragmentShader.match(/float eclipseLight\(/g)).toHaveLength(1);
    expect(fragmentShader.match(/reflectedLight\.directDiffuse \*= eclipseLit/g)).toHaveLength(1);
    expect(fragmentShader).toContain(`#define ECLIPSE_MAX ${MAX_ECLIPSE_CASTERS}`);
    // After the lights, so only the Sun's direct light is dimmed.
    expect(fragmentShader.indexOf('eclipseLit')).toBeGreaterThan(
      fragmentShader.indexOf('#include <lights_fragment_end>'),
    );
  });

  it('fails loudly when three renames a chunk', () => {
    expect(() => patchEclipseShader('void main() {}', ShaderLib.standard.fragmentShader)).toThrow(
      /anchor/,
    );
  });
});

describe('useEclipse (the binding)', () => {
  const jupiter = planet('Jupiter');
  const receivers = new Map(eclipseReceivers(jupiter).map((r) => [r.id, r]));

  function setup(enabled: boolean) {
    const system = new EclipseSystem();
    const meshes = new Map(
      eclipseCasters(jupiter).map((c, i) => {
        const m = new Mesh();
        m.position.set(90 + i, i * 0.5, -i);
        m.updateMatrixWorld();
        system.register(c.bodyId, m);
        return [c.bodyId, m] as const;
      }),
    );
    const hook = renderHook(
      ({ on }) => useEclipse(system, receivers.get(jupiter.bodyId), on, SUN_RADIUS),
      { initialProps: { on: enabled } },
    );
    return { system, meshes, hook };
  }

  it("writes its casters' world positions and radii before each draw", () => {
    const { hook } = setup(true);
    const b = hook.result.current;
    b.onBeforeRender();
    const casters = receivers.get(jupiter.bodyId)!.casters;
    expect(b.uniforms.eclipseCount.value).toBe(casters.length);
    expect(b.uniforms.eclipseSunRadius.value).toBe(SUN_RADIUS);
    const first = b.uniforms.eclipseCasters.value[0]!;
    const i = eclipseCasters(jupiter).findIndex((c) => c.bodyId === casters[0]!.bodyId);
    expect([first.x, first.y, first.z, first.w]).toEqual([90 + i, i * 0.5, -i, casters[0]!.radius]);
  });

  it('writes nothing when the tier has no shadows, and keeps the same uniforms when it changes', () => {
    const { hook } = setup(false);
    const before = hook.result.current;
    before.onBeforeRender();
    expect(before.uniforms.eclipseCount.value).toBe(0);
    hook.rerender({ on: true });
    expect(hook.result.current).toBe(before);
    before.onBeforeRender();
    expect(before.uniforms.eclipseCount.value).toBe(4);
  });

  it('skips a caster whose mesh is gone', () => {
    const { system, meshes, hook } = setup(true);
    const ganymede = jupiter.moons.find((m) => m.name === 'Ganymede')!;
    const unregister = system.register(ganymede.bodyId, meshes.get(ganymede.bodyId)!);
    unregister();
    hook.result.current.onBeforeRender();
    expect(hook.result.current.uniforms.eclipseCount.value).toBe(3);
  });

  it('patches the material and hands it the uniforms; every receiver shares one program', () => {
    const { hook } = setup(true);
    const b = hook.result.current;
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
    } as unknown as WebGLProgramParametersWithUniforms;
    b.onBeforeCompile(shader);
    expect(shader.uniforms['eclipseCasters']).toBe(b.uniforms.eclipseCasters);
    expect(shader.fragmentShader).toContain('eclipseLight');
    const other = setup(true).hook.result.current;
    expect(other.customProgramCacheKey()).toBe(b.customProgramCacheKey());
  });

  it('leaves the shader unpatched, instead of throwing in the frame loop, if an anchor is gone', () => {
    const { hook } = setup(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const renamed = ShaderLib.standard.fragmentShader.replaceAll('lights_fragment_end', 'renamed');
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: renamed,
    } as unknown as WebGLProgramParametersWithUniforms;
    expect(() => hook.result.current.onBeforeCompile(shader)).not.toThrow();
    expect(shader.fragmentShader).toBe(renamed);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
