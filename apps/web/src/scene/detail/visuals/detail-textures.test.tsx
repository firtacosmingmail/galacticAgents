// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTexture } from 'three';
import { MOON_LOOKS } from '../../bodies/appearance.js';
import { setPaintWorkerFactoryForTest } from '../../bodies/painter.js';
import { FakePaintWorker } from '../../bodies/paint-worker-fake.js';
import { TextureCache, type Disposable } from '../../bodies/texture-cache.js';
import { QUALITY_TIERS } from '../../quality.js';
import {
  DetailMaps,
  detailTextures,
  freeAfterUpload,
  useCachedPaint,
  useCloudMaps,
  useDetailMaps,
  useDetailTextureBudget,
} from './detail-textures.js';
import { DETAIL_LOOKS } from './looks.js';

afterEach(() => {
  cleanup();
  detailTextures.dropIdle();
  setPaintWorkerFactoryForTest(undefined);
  FakePaintWorker.made = [];
});

class Thing implements Disposable {
  disposed = false;
  constructor(readonly name: string) {}
  dispose(): void {
    this.disposed = true;
  }
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });

describe('detail textures: memory', () => {
  it('frees the pixel array once three has uploaded the texture', () => {
    const t = new DataTexture(new Uint8Array(16), 2, 2);
    freeAfterUpload(t);
    expect(t.image.data).not.toBeNull();
    t.onUpdate!(t);
    expect(t.image.data).toBeNull();
    expect(t.onUpdate).toBeNull();
  });

  it('disposes every map of a detail level', () => {
    const maps = new DetailMaps(
      new DataTexture(new Uint8Array(16), 2, 2),
      new DataTexture(new Uint8Array(16), 2, 2),
      new DataTexture(new Uint8Array(8), 2, 2),
    );
    const spies = [maps.map, maps.normal!, maps.roughness!].map((t) => vi.spyOn(t, 'dispose'));
    maps.dispose();
    for (const s of spies) expect(s).toHaveBeenCalledOnce();
  });
});

describe('useCachedPaint (cache keys and disposal)', () => {
  it('shows the entry once painted, keeps the old one until the new is ready, releases on unmount', async () => {
    const cache = new TextureCache<Disposable>(0);
    const made: Thing[] = [];
    let resolveB: (() => void) | undefined;
    const load = (name: string) => () =>
      new Promise<Thing>((resolve) => {
        const thing = new Thing(name);
        made.push(thing);
        if (name === 'b') resolveB = () => resolve(thing);
        else setTimeout(() => resolve(thing), 0);
      });
    const { result, rerender, unmount } = renderHook(
      ({ k }: { k: string | null }) => useCachedPaint(cache, k, 10, load(k ?? '')),
      { initialProps: { k: 'a' as string | null } },
    );
    expect(result.current).toBeUndefined();
    await flush();
    expect((result.current as Thing | undefined)?.name).toBe('a');
    rerender({ k: 'b' });
    await flush();
    // b still painting: a is still shown (and held).
    expect((result.current as Thing | undefined)?.name).toBe('a');
    resolveB!();
    await flush();
    expect((result.current as Thing | undefined)?.name).toBe('b');
    // a was released; with a zero budget the idle entry is disposed at once.
    expect(made[0]!.disposed).toBe(true);
    expect(made[1]!.disposed).toBe(false);
    rerender({ k: null });
    await flush();
    expect(result.current).toBeUndefined();
    unmount();
    expect(made[1]!.disposed).toBe(true);
    expect(cache.stats().entries).toBe(0);
  });

  it('keeps idle levels within the tier budget and drops them all on a tier change', async () => {
    const thing = new Thing('x');
    void detailTextures.acquire('test-idle', 1024, () => Promise.resolve(thing));
    await flush();
    detailTextures.release('test-idle');
    const { rerender } = renderHook(({ tier }) => useDetailTextureBudget(tier), {
      initialProps: { tier: 'high' as 'high' | 'mobile' },
    });
    expect(detailTextures.stats().idle).toBe(1);
    rerender({ tier: 'mobile' });
    await flush();
    expect(thing.disposed).toBe(true);
    expect(detailTextures.stats().entries).toBe(0);
  });
});

describe('useDetailMaps / useCloudMaps', () => {
  const moon = MOON_LOOKS['Moon']!;
  const mobile = QUALITY_TIERS.mobile;

  it("paints the shown moon's detail level in the worker at the tier's size, cached and disposed", async () => {
    setPaintWorkerFactoryForTest(FakePaintWorker.factory('paint'));
    const { result, unmount } = renderHook(() =>
      useDetailMaps(moon, 'moon', mobile, DETAIL_LOOKS['Moon']!),
    );
    await act(async () => {
      await vi.waitFor(() => expect(detailTextures.stats().pending).toBe(0), { timeout: 10_000 });
    });
    await flush();
    const maps = result.current!;
    expect(maps.map.image.width).toBe(512);
    expect(maps.normal).toBeNull(); // mobile: no normal maps
    expect(FakePaintWorker.made[0]!.jobs[0]).toMatchObject({ kind: 'detail', width: 512 });
    const dispose = vi.spyOn(maps.map, 'dispose');
    unmount();
    expect(detailTextures.stats().idle).toBe(1);
    detailTextures.dropIdle();
    expect(dispose).toHaveBeenCalledOnce();
  }, 20_000);

  it('asks for nothing without a paint worker (the nearest level stays)', async () => {
    setPaintWorkerFactoryForTest(null);
    const { result } = renderHook(() => useDetailMaps(moon, 'moon', mobile, DETAIL_LOOKS['Moon']!));
    await flush();
    expect(result.current).toBeUndefined();
    expect(detailTextures.stats().entries).toBe(0);
  });

  it("paints Earth's clouds at the tier's (mobile: small) size", async () => {
    setPaintWorkerFactoryForTest(FakePaintWorker.factory('paint'));
    const { result } = renderHook(() => useCloudMaps(DETAIL_LOOKS['Earth']!.clouds!, mobile));
    await act(async () => {
      await vi.waitFor(() => expect(detailTextures.stats().pending).toBe(0), { timeout: 10_000 });
    });
    await flush();
    expect(result.current!.alpha.image.width).toBe(512);
    expect(FakePaintWorker.made[0]!.jobs[0]).toMatchObject({ kind: 'clouds', width: 512 });
  }, 20_000);
});
