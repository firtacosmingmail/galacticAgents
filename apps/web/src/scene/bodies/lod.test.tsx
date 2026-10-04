// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Vector3 } from 'three';
import { QualityTier, type Body } from '@galactic/protocol';
import { getAnchor, onAnchorsChanged } from '../anchors.js';
import { useBodyAnchor } from '../anchor-binding.js';
import { QUALITY_TIERS, type LodConfig, type SceneQuality } from '../quality.js';
import { cappedFrameloop, frameDue, FRAME_CAP_SLACK_MS } from '../frame-cap.js';
import { MOON_LOOKS, PLANET_LOOKS } from './appearance.js';
import { buildRenderList, planetAnchor, type PlanetItem } from './layout.js';
import { distanceInRadii, selectLodLevel } from './lod.js';
import { paintAsync, paintBacklog, setPaintWorkerFactoryForTest } from './painter.js';
import { FakePaintWorker } from './paint-worker-fake.js';
import {
  extraOctaves,
  hasRelief,
  MATTE_ROUGHNESS,
  OCEAN_ROUGHNESS,
  paintSurface,
  paintSurfaceLayers,
} from './surface.js';
import { TextureCache, type Disposable } from './texture-cache.js';
import {
  buildSphereSet,
  disposeSphereSet,
  levelDetail,
  levelTexture,
  nearTextures,
  sphereFor,
  surfaceMapsBytes,
  surfaceMapsKey,
  useBodyMaps,
} from './textures.js';

const TIERS = QualityTier.options;
const ORDER = ['mobile', 'balanced', 'high'] as const;

afterEach(() => {
  cleanup();
  nearTextures.dropIdle();
});

/** The level a tier shows at `distance` body radii, coming from far away (no hysteresis memory). */
function levelAt(lod: LodConfig, distance: number) {
  return lod.levels[selectLodLevel(distance, lod.levels, lod.levels.length - 1, 0)]!;
}

describe('quality tier table (P3-06)', () => {
  it('defines every field for every tier', () => {
    for (const tier of TIERS) {
      const q = QUALITY_TIERS[tier];
      expect(q).not.toHaveProperty('shadowMapSize'); // P3-10: no shadow map any more
      expect(q.textureBudgetMB).toBeGreaterThan(0);
      expect(q.ringSegments).toBeGreaterThanOrEqual(32);
      expect(q.orbitSegments.planet).toBeGreaterThanOrEqual(q.orbitSegments.moon);
      expect(q.lod.hysteresis).toBeGreaterThan(0);
      expect(q.lod.hysteresis).toBeLessThan(0.5);
      expect(q.maxFps === null || q.maxFps >= 30).toBe(true);
    }
  });

  it('has nearest-first LOD levels, the last open-ended, getting lighter with distance', () => {
    for (const tier of TIERS) {
      const { levels } = QUALITY_TIERS[tier].lod;
      expect(levels.length).toBeGreaterThanOrEqual(2);
      expect(levels.at(-1)!.within).toBe(Infinity);
      for (let i = 1; i < levels.length; i++) {
        const near = levels[i - 1]!;
        const far = levels[i]!;
        expect(near.within).toBeLessThan(far.within);
        // Boundaries far enough apart that the hysteresis bands do not overlap.
        expect(near.within * (1 + QUALITY_TIERS[tier].lod.hysteresis)).toBeLessThan(
          far.within * (1 - QUALITY_TIERS[tier].lod.hysteresis),
        );
        for (const kind of ['planet', 'moon'] as const) {
          const seg = (l: typeof near) => (kind === 'planet' ? l.planetSegments : l.moonSegments);
          expect(seg(near)[0] * seg(near)[1]).toBeGreaterThanOrEqual(seg(far)[0] * seg(far)[1]);
          expect(levelTexture(near, kind).width).toBeGreaterThanOrEqual(
            levelTexture(far, kind).width,
          );
        }
        if (far.detail) expect(near.detail).toBe(true);
      }
      expect(levels.at(-1)!.detail).toBe(false); // the far map is painted at once: keep it small
      for (const l of levels) {
        for (const w of [l.planetTexture, l.moonTexture]) {
          expect(Math.log2(w) % 1).toBe(0); // power of two: mipmaps
          expect(w).toBeGreaterThanOrEqual(64);
        }
      }
    }
  });

  it('is monotonic: mobile lighter than balanced lighter than high, at every distance', () => {
    const scalar = (q: SceneQuality) => [
      q.dprCap,
      q.stars,
      q.beltRocks,
      q.textureBudgetMB,
      q.ringSegments,
      q.orbitSegments.planet,
      q.orbitSegments.moon,
      q.maxFps ?? Infinity,
      q.shadows ? 1 : 0,
      q.bloom ? 1 : 0,
      q.antialias ? 1 : 0,
    ];
    const distances = [1, 2, 5, 8.5, 10, 11, 12, 13, 14, 16, 20, 24, 30, 50, 100, 1000];
    for (let i = 1; i < ORDER.length; i++) {
      const lighter = QUALITY_TIERS[ORDER[i - 1]!];
      const heavier = QUALITY_TIERS[ORDER[i]!];
      scalar(lighter).forEach((v, k) => expect(v).toBeLessThanOrEqual(scalar(heavier)[k]!));
      expect(scalar(lighter)).not.toEqual(scalar(heavier));
      for (const d of distances) {
        const a = levelAt(lighter.lod, d);
        const b = levelAt(heavier.lod, d);
        expect(a.planetSegments[0] * a.planetSegments[1]).toBeLessThanOrEqual(
          b.planetSegments[0] * b.planetSegments[1],
        );
        expect(a.moonSegments[0] * a.moonSegments[1]).toBeLessThanOrEqual(
          b.moonSegments[0] * b.moonSegments[1],
        );
        expect(a.planetTexture).toBeLessThanOrEqual(b.planetTexture);
        expect(a.moonTexture).toBeLessThanOrEqual(b.moonTexture);
        expect(Number(a.detail)).toBeLessThanOrEqual(Number(b.detail));
      }
    }
  });

  it('defines the mobile tier for the phone: no shadows, no composer, small maps, capped at 30 fps', () => {
    const m = QUALITY_TIERS.mobile;
    expect(m).toMatchObject({
      dprCap: 1,
      antialias: false,
      bloom: null,
      shadows: false,
      maxFps: 30,
    });
    expect(m.lod.levels.every((l) => !l.detail && l.planetTexture <= 512)).toBe(true);
    expect(m.beltRocks).toBeLessThanOrEqual(1200);
  });

  it('gives a framed body (the camera at ≈ 8.5 radii, P3-04) the near level on every tier', () => {
    for (const tier of TIERS) {
      const { levels, hysteresis } = QUALITY_TIERS[tier].lod;
      // Coming in from far away, through the hysteresis band.
      expect(selectLodLevel(8.6, levels, levels.length - 1, hysteresis)).toBe(0);
    }
  });

  it('keeps the system view low-poly: at 40+ radii every tier shows its farthest level', () => {
    for (const tier of TIERS) {
      const { levels, hysteresis } = QUALITY_TIERS[tier].lod;
      expect(levelAt(QUALITY_TIERS[tier].lod, 40)).toBe(levels.at(-1));
      expect(selectLodLevel(40, levels, 0, hysteresis)).toBe(levels.length - 1);
    }
  });

  it('keeps the texture budget above one near map of the tier (it can always hold the focused body)', () => {
    for (const tier of TIERS) {
      const q = QUALITY_TIERS[tier];
      const near = q.lod.levels[0]!;
      expect(q.textureBudgetMB * 1024 * 1024).toBeGreaterThan(
        surfaceMapsBytes(near.planetTexture, near.detail),
      );
    }
  });
});

describe('LOD level selection with hysteresis', () => {
  const levels = [{ within: 10 }, { within: 30 }, { within: Infinity }];
  const h = 0.15;

  it('picks the level whose band holds the distance', () => {
    expect(selectLodLevel(5, levels, 2, 0)).toBe(0);
    expect(selectLodLevel(20, levels, 2, 0)).toBe(1);
    expect(selectLodLevel(100, levels, 0, 0)).toBe(2);
  });

  it('needs to pass a boundary by the hysteresis before switching, both ways', () => {
    // Coming in from far: 9.9 is inside level 0's band, but not 15 % inside.
    expect(selectLodLevel(9.9, levels, 1, h)).toBe(1);
    expect(selectLodLevel(8.4, levels, 1, h)).toBe(0);
    // Going out from near: 11 is past the boundary but not 15 % past.
    expect(selectLodLevel(11, levels, 0, h)).toBe(0);
    expect(selectLodLevel(11.6, levels, 0, h)).toBe(1);
  });

  it('does not flicker for a camera hovering on a boundary', () => {
    let level = 2;
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const d = 30 + Math.sin(i) * 3; // ± 10 % around the 30-radii boundary
      level = selectLodLevel(d, levels, level, h);
      seen.add(level);
    }
    expect(seen).toEqual(new Set([2]));
  });

  it('jumps several levels at once (a flight straight in or out)', () => {
    expect(selectLodLevel(1, levels, 2, h)).toBe(0);
    expect(selectLodLevel(500, levels, 0, h)).toBe(2);
  });

  it('clamps an out-of-range current level (the table changed with the tier)', () => {
    expect(selectLodLevel(500, levels, 7, h)).toBe(2);
    expect(selectLodLevel(1, levels, -3, h)).toBe(0);
    expect(selectLodLevel(1, [{ within: Infinity }], 2, h)).toBe(0);
  });

  it('measures the camera distance in body radii from the world position', () => {
    const parent = new Group();
    parent.position.set(100, 0, 0);
    const body = new Object3D();
    body.position.set(0, 0, 10);
    parent.add(body);
    parent.updateMatrixWorld(true);
    const camera = new PerspectiveCamera();
    camera.position.set(100, 0, 50);
    expect(distanceInRadii(body, camera.position, 4, new Vector3())).toBeCloseTo(10);
  });
});

describe('procedural detail maps (P3-06)', () => {
  const small = 32;

  it('paints the same colours as the far painter, plus detail only for surfaces with relief', () => {
    for (const look of [PLANET_LOOKS['Mars']!, PLANET_LOOKS['Jupiter']!, MOON_LOOKS['Io']!]) {
      const layers = paintSurfaceLayers(look, small, small / 2, true);
      expect(layers.color).toEqual(paintSurface(look, small, small / 2));
      expect(layers.detail === null).toBe(!hasRelief(look));
      if (layers.detail) expect(layers.detail.length).toBe(small * (small / 2) * 2);
    }
    expect(paintSurfaceLayers(PLANET_LOOKS['Mars']!, small, small / 2, false).detail).toBeNull();
  });

  it('is deterministic and gives Earth glossy oceans and matte land', () => {
    const earth = PLANET_LOOKS['Earth']!;
    const a = paintSurfaceLayers(earth, 64, 32, true).detail!;
    expect(paintSurfaceLayers(earth, 64, 32, true).detail).toEqual(a);
    const roughness = new Set<number>();
    for (let i = 1; i < a.length; i += 2) roughness.add(a[i]!);
    expect(roughness.has(Math.round(OCEAN_ROUGHNESS * 255))).toBe(true);
    expect(roughness.has(Math.round(MATTE_ROUGHNESS * 255))).toBe(true);
  });

  it('adds faint octaves only to wide maps', () => {
    expect([128, 256, 511, 512, 1024, 2048, 4096].map(extraOctaves)).toEqual([0, 0, 0, 1, 2, 2, 2]);
  });

  it('asks for detail only where the level and the surface both want it', () => {
    const near = QUALITY_TIERS.high.lod.levels[0]!;
    expect(levelDetail(near, PLANET_LOOKS['Earth']!)).toBe(true);
    expect(levelDetail(near, PLANET_LOOKS['Saturn']!)).toBe(false);
    expect(levelDetail(QUALITY_TIERS.mobile.lod.levels[0]!, PLANET_LOOKS['Earth']!)).toBe(false);
  });
});

describe('asynchronous painting', () => {
  it('paints off the caller (no worker in jsdom: after a macrotask) with the same pixels', async () => {
    const look = MOON_LOOKS['Io']!;
    const pending = paintAsync({ look, width: 32, height: 16, detail: true });
    expect(paintBacklog()).toBe(1);
    const layers = await pending;
    expect(layers).toEqual(paintSurfaceLayers(look, 32, 16, true));
    expect(paintBacklog()).toBe(0);
  });

  it('drops a queued job whose body no longer wants it', async () => {
    const look = MOON_LOOKS['Io']!;
    const first = paintAsync({ look, width: 16, height: 8, detail: false });
    const abort = new AbortController();
    const second = paintAsync({ look, width: 16, height: 8, detail: false }, abort.signal);
    abort.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await expect(first).resolves.toBeDefined();
  });

  it('runs small jobs (near levels, clouds) before queued detail levels, never preempting the running one', async () => {
    setPaintWorkerFactoryForTest(FakePaintWorker.factory('hold'));
    try {
      const look = MOON_LOOKS['Io']!;
      const detail = (width: number) =>
        ({
          kind: 'detail',
          look,
          width,
          height: width / 2,
          normal: false,
          roughness: false,
          normalStrength: 0,
        }) as const;
      const order: string[] = [];
      const track = (name: string, p: Promise<unknown>) => p.then(() => order.push(name));
      const done = [
        track('detail-a', paintAsync(detail(16))), // starts at once (the worker was idle)
        track('detail-b', paintAsync(detail(16))),
        track('near', paintAsync({ look, width: 8, height: 4, detail: false })),
        track(
          'clouds',
          paintAsync({
            kind: 'clouds',
            clouds: { seed: 1, coverage: 0.5, opacity: 1, drift: 0, altitude: 0.01 },
            width: 8,
            height: 4,
          }),
        ),
      ];
      const worker = FakePaintWorker.made[0]!;
      for (let i = 0; i < 4; i++) {
        worker.reply();
        await Promise.resolve();
      }
      await Promise.all(done);
      expect(worker.jobs.map((j) => j.kind ?? 'surface')).toEqual([
        'detail',
        'surface',
        'clouds',
        'detail',
      ]);
      expect(order).toEqual(['detail-a', 'near', 'clouds', 'detail-b']);
    } finally {
      setPaintWorkerFactoryForTest(undefined);
      FakePaintWorker.made = [];
    }
  });
});

class Fake implements Disposable {
  disposed = 0;
  constructor(readonly name: string) {}
  dispose() {
    this.disposed++;
  }
}

describe('near texture cache', () => {
  const load = (name: string) => () => Promise.resolve(new Fake(name));

  it('keys maps by look content, size and detail', () => {
    const mars = PLANET_LOOKS['Mars']!;
    expect(surfaceMapsKey(mars, 1024, true)).toBe(surfaceMapsKey({ ...mars }, 1024, true));
    const keys = new Set([
      surfaceMapsKey(mars, 1024, true),
      surfaceMapsKey(mars, 1024, false),
      surfaceMapsKey(mars, 2048, true),
      surfaceMapsKey({ ...mars, seed: 99 }, 1024, true),
      surfaceMapsKey({ ...mars, palette: ['#000000'] }, 1024, true),
      surfaceMapsKey(PLANET_LOOKS['Earth']!, 1024, true),
    ]);
    expect(keys.size).toBe(6);
    expect(surfaceMapsBytes(1024, false)).toBe(Math.round(1024 * 512 * 4 * (7 / 3)));
    expect(surfaceMapsBytes(1024, true)).toBe(Math.round(1024 * 512 * 6 * (7 / 3)));
  });

  it('shares an entry between users, keeps it idle after the last release, disposes it on dropIdle', async () => {
    const cache = new TextureCache<Fake>(1000);
    const loader = vi.fn(load('a'));
    const first = cache.acquire('a', 100, loader);
    const second = cache.acquire('a', 100, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    const value = (await first.promise)!;
    expect(await second.promise).toBe(value);
    expect(cache.peek('a')).toBe(value);
    cache.release('a');
    cache.release('a');
    expect(cache.stats()).toEqual({ entries: 1, pending: 0, idle: 1, bytes: 100 });
    expect(value.disposed).toBe(0);
    // Re-acquiring an idle entry reuses it (no repaint).
    expect(cache.acquire('a', 100, loader).value).toBe(value);
    expect(loader).toHaveBeenCalledTimes(1);
    cache.release('a');
    cache.dropIdle();
    expect(value.disposed).toBe(1);
    expect(cache.stats().entries).toBe(0);
  });

  it('evicts idle entries least recently used first beyond the budget, never one in use', async () => {
    const cache = new TextureCache<Fake>(250);
    const values: Fake[] = [];
    for (const k of ['a', 'b', 'c']) values.push((await cache.acquire(k, 100, load(k)).promise)!);
    // 300 bytes in use, over the budget, but nothing is idle: nothing goes.
    expect(values.every((v) => v.disposed === 0)).toBe(true);
    cache.release('b');
    cache.release('a');
    // Idle: b (older), a. One must go to get under 250: b.
    expect(values[1]!.disposed).toBe(1);
    expect(values[0]!.disposed).toBe(0);
    cache.setBudget(100);
    expect(values[0]!.disposed).toBe(1);
    expect(values[2]!.disposed).toBe(0);
    expect(cache.stats()).toEqual({ entries: 1, pending: 0, idle: 0, bytes: 100 });
  });

  it('aborts a pending load nobody wants and disposes what a late load made', async () => {
    const cache = new TextureCache<Fake>(1000);
    let finish: (f: Fake) => void = () => {};
    let signal: AbortSignal | undefined;
    const handle = cache.acquire(
      'slow',
      100,
      (s) =>
        new Promise<Fake>((resolve) => {
          signal = s;
          finish = resolve;
        }),
    );
    cache.release('slow');
    expect(signal!.aborted).toBe(true);
    expect(cache.stats().entries).toBe(0);
    const late = new Fake('late');
    finish(late);
    expect(await handle.promise).toBeUndefined();
    expect(late.disposed).toBe(1);
  });

  it('forgets a failed load', async () => {
    const cache = new TextureCache<Fake>(1000);
    const h = cache.acquire('bad', 100, () => Promise.reject(new Error('no')));
    expect(await h.promise).toBeUndefined();
    expect(cache.stats().entries).toBe(0);
  });
});

describe('body maps per level, and a tier change', () => {
  const mars = PLANET_LOOKS['Mars']!;
  // A paint worker (jsdom has none; without one the near maps would be capped).
  beforeEach(() => setPaintWorkerFactoryForTest(FakePaintWorker.factory()));
  afterEach(() => setPaintWorkerFactoryForTest(undefined));

  it('shows the far map at once, the near maps once painted, and frees them on a tier change', async () => {
    const high = QUALITY_TIERS.high.lod;
    const { result, rerender, unmount } = renderHook(
      ({ lod, level }: { lod: LodConfig; level: number }) =>
        useBodyMaps(mars, 'planet', lod, level),
      { initialProps: { lod: high, level: high.levels.length - 1 } },
    );
    const far = result.current.map;
    expect(far.image.width).toBe(high.levels.at(-1)!.planetTexture);
    expect(result.current.detail).toBeNull();

    rerender({ lod: high, level: 0 });
    // Still the far map while the near one is painted…
    expect(result.current.map).toBe(far);
    await act(async () => {
      await vi.waitFor(() => expect(nearTextures.stats().pending).toBe(0), { timeout: 20_000 });
    });
    // …then the near one, with its detail map (Mars is rocky).
    expect(result.current.map.image.width).toBe(high.levels[0]!.planetTexture);
    expect(result.current.detail).not.toBeNull();
    const near = { map: result.current.map, detail: result.current.detail! };
    const disposed = { map: vi.fn(), detail: vi.fn() };
    near.map.addEventListener('dispose', disposed.map);
    near.detail.addEventListener('dispose', disposed.detail);
    const farDisposed = vi.fn();
    far.addEventListener('dispose', farDisposed);

    // Switch to mobile: the far map has the same size there, so it is kept (no repaint); the near
    // map is released and, once the tier's cleanup runs, dropped.
    const mobile = QUALITY_TIERS.mobile.lod;
    rerender({ lod: mobile, level: mobile.levels.length - 1 });
    expect(result.current.map).toBe(far);
    expect(farDisposed).not.toHaveBeenCalled();
    expect(nearTextures.stats()).toMatchObject({ idle: 1 });
    nearTextures.dropIdle();
    expect(disposed.map).toHaveBeenCalledTimes(1);
    expect(disposed.detail).toHaveBeenCalledTimes(1);
    expect(nearTextures.stats().entries).toBe(0);

    // A far map of another size replaces (and disposes) the old one; unmounting disposes the last.
    const smaller: LodConfig = {
      ...mobile,
      levels: [mobile.levels[0]!, { ...mobile.levels[1]!, planetTexture: 128 }],
    };
    rerender({ lod: smaller, level: 1 });
    expect(result.current.map.image.width).toBe(128);
    expect(farDisposed).toHaveBeenCalledTimes(1);
    const last = vi.fn();
    result.current.map.addEventListener('dispose', last);
    unmount();
    expect(last).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('shares unit sphere geometries per level and disposes them all', () => {
    const set = buildSphereSet(QUALITY_TIERS.balanced.lod);
    expect(set.planet).toHaveLength(QUALITY_TIERS.balanced.lod.levels.length);
    expect(set.planet[0]!.parameters).toMatchObject({ radius: 1, widthSegments: 96 });
    expect(sphereFor(set, 'moon', 99)).toBe(set.moon.at(-1));
    const spy = vi.fn();
    [...set.planet, ...set.moon].forEach((g) => g.addEventListener('dispose', spy));
    disposeSphereSet(set);
    expect(spy).toHaveBeenCalledTimes(set.planet.length + set.moon.length);
  });
});

describe('anchors across LOD switches and tier changes', () => {
  const bodies: Body[] = [
    { id: 'b-jupiter', kind: 'planet', name: 'Jupiter', meta: { orbit: 5 } },
    { id: 'b-io', kind: 'moon', parentId: 'b-jupiter', name: 'Io', meta: { orbit: 1 } },
  ];
  const jupiter: PlanetItem = buildRenderList(bodies, 'fake')[0]!;

  /**
   * Mirrors `Planet`: the anchor group bound with `planetAnchor(item)`, the sphere mesh inside it
   * taking the level's shared geometry. Only the mesh's geometry follows the level.
   */
  function Probe({ quality, level }: { quality: SceneQuality; level: number }) {
    const anchor = useRef<Group>(new Group());
    const mesh = useRef<Mesh>(new Mesh(undefined, new MeshStandardMaterial()));
    useBodyAnchor(anchor, planetAnchor(jupiter));
    const set = useRef<Map<SceneQuality, ReturnType<typeof buildSphereSet>>>(new Map());
    useLayoutEffect(() => {
      if (!set.current.has(quality)) set.current.set(quality, buildSphereSet(quality.lod));
      const m = mesh.current;
      if (m.parent !== anchor.current) anchor.current.add(m);
      m.geometry = sphereFor(set.current.get(quality)!, 'planet', level);
      m.scale.setScalar(jupiter.radius);
    });
    return null;
  }

  it('keeps the same anchor object and radius, with no re-registration', () => {
    const { rerender } = render(<Probe quality={QUALITY_TIERS.high} level={2} />);
    const anchor = getAnchor('b-jupiter')!;
    const object = anchor.object;
    const mesh = object.children[0] as Mesh;
    const changes = vi.fn();
    const off = onAnchorsChanged(changes);
    const geometries = new Set();
    const steps: [SceneQuality, number][] = [
      [QUALITY_TIERS.high, 0],
      [QUALITY_TIERS.high, 1],
      [QUALITY_TIERS.mobile, 1],
      [QUALITY_TIERS.mobile, 0],
      [QUALITY_TIERS.balanced, 2],
    ];
    for (const [quality, level] of steps) {
      rerender(<Probe quality={quality} level={level} />);
      const now = getAnchor('b-jupiter')!;
      expect(now).toBe(anchor);
      expect(now.object).toBe(object);
      expect(now.radius).toBe(jupiter.outerRadius);
      expect(object.children).toEqual([mesh]);
      geometries.add(mesh.geometry);
    }
    expect(geometries.size).toBe(steps.length);
    expect(changes).not.toHaveBeenCalled();
    off();
  });
});

describe('frame-rate cap', () => {
  it('asks for a frame every other 60 Hz tick at 30 fps despite timer jitter', () => {
    let last: number | undefined;
    let frames = 0;
    for (let i = 0; i < 120; i++) {
      const now = i * (1000 / 60) + (i % 3) * 0.7;
      if (frameDue(now, last, 30)) {
        last = now;
        frames++;
      }
    }
    expect(frames).toBe(60);
    expect(FRAME_CAP_SLACK_MS).toBeLessThan(1000 / 60);
  });

  it('applies only while the loop would run continuously, and never to the fps meter', () => {
    expect(cappedFrameloop('always', 30, false)).toEqual({ frameloop: 'never', capFps: 30 });
    expect(cappedFrameloop('always', 30, true)).toEqual({ frameloop: 'always', capFps: null });
    expect(cappedFrameloop('demand', 30, false)).toEqual({ frameloop: 'demand', capFps: null });
    expect(cappedFrameloop('always', null, false)).toEqual({ frameloop: 'always', capFps: null });
  });
});
