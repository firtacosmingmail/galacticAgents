// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUALITY_TIERS, type LodConfig, type LodLevel } from '../quality.js';
import { MOON_LOOKS, PLANET_LOOKS } from './appearance.js';
import {
  paintAsync,
  paintBacklog,
  paintsOffMainThread,
  setPaintWorkerFactoryForTest,
} from './painter.js';
import { FakePaintWorker } from './paint-worker-fake.js';
import { nearMapsSpec, nearTextures, useBodyMaps } from './textures.js';

const mars = PLANET_LOOKS['Mars']!;
const io = MOON_LOOKS['Io']!;

/** A small three-level table (128 + detail / 64 / far 32) so the paints stay fast. */
const level = (within: number, planetTexture: number, detail: boolean): LodLevel => ({
  within,
  planetSegments: [8, 6],
  moonSegments: [8, 6],
  planetTexture,
  moonTexture: planetTexture / 2,
  detail,
});
const SMALL: LodConfig = {
  levels: [level(4, 128, true), level(16, 64, false), level(Infinity, 32, false)],
  hysteresis: 0.15,
};

afterEach(() => {
  cleanup();
  nearTextures.dropIdle();
  setPaintWorkerFactoryForTest(undefined);
  FakePaintWorker.made = [];
});

async function settle(): Promise<void> {
  await act(async () => {
    await vi.waitFor(() => expect(nearTextures.stats().pending).toBe(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('nearMapsSpec (what a level paints)', () => {
  it("is the level's own size and detail with a worker", () => {
    const high = QUALITY_TIERS.high.lod;
    expect(nearMapsSpec(high, 0, 'planet', mars, true)).toEqual({
      width: 2048,
      height: 1024,
      detail: true,
    });
    expect(nearMapsSpec(high, 0, 'planet', PLANET_LOOKS['Saturn']!, true).detail).toBe(false);
  });

  it('without a worker: capped at the middle level, never a detail map', () => {
    const high = QUALITY_TIERS.high.lod;
    expect(nearMapsSpec(high, 0, 'planet', mars, false)).toEqual({
      width: 1024,
      height: 512,
      detail: false,
    });
    expect(nearMapsSpec(high, 0, 'moon', io, false)).toMatchObject({ width: 512, detail: false });
    expect(nearMapsSpec(high, 1, 'planet', mars, false)).toMatchObject({ width: 1024 });
    expect(nearMapsSpec(high, 2, 'planet', mars, false)).toMatchObject({ width: 256 });
    // Two levels (mobile): the near level is the middle one; it keeps its size.
    const mobile = QUALITY_TIERS.mobile.lod;
    expect(nearMapsSpec(mobile, 0, 'planet', mars, false)).toMatchObject({ width: 512 });
  });
});

describe('useBodyMaps across level changes', () => {
  it('keeps the maps it shows until the next level is painted, then lets them go', async () => {
    setPaintWorkerFactoryForTest(FakePaintWorker.factory());
    const { result, rerender, unmount } = renderHook(
      ({ lvl }: { lvl: number }) => useBodyMaps(mars, 'planet', SMALL, lvl),
      { initialProps: { lvl: 2 } },
    );
    expect(result.current.map.image.width).toBe(32);
    rerender({ lvl: 1 });
    await settle();
    expect(result.current.map.image.width).toBe(64);
    expect(nearTextures.stats()).toMatchObject({ entries: 1, idle: 0 });

    // Closer: the 64 map stays on show (not the far 32) while the 128 one is painted…
    rerender({ lvl: 0 });
    expect(result.current.map.image.width).toBe(64);
    expect(nearTextures.stats()).toMatchObject({ pending: 1, idle: 0 });
    await settle();
    // …then the 128 one, with its detail; the 64 one is released (idle in the cache).
    expect(result.current.map.image.width).toBe(128);
    expect(result.current.detail).not.toBeNull();
    expect(nearTextures.stats()).toMatchObject({ entries: 2, idle: 1 });

    // Back out: the cached 64 map shows at once.
    rerender({ lvl: 1 });
    expect(result.current.map.image.width).toBe(64);
    await settle();
    expect(nearTextures.stats()).toMatchObject({ entries: 2, idle: 1 });

    // Leaving a level before its maps arrive abandons that paint and keeps what is shown.
    nearTextures.dropIdle();
    rerender({ lvl: 0 });
    rerender({ lvl: 1 });
    expect(result.current.map.image.width).toBe(64);
    expect(nearTextures.stats()).toMatchObject({ entries: 1, pending: 0 });

    // The far level shows the far map at once and releases the near one.
    rerender({ lvl: 2 });
    expect(result.current.map.image.width).toBe(32);
    expect(nearTextures.stats()).toMatchObject({ entries: 1, idle: 1 });
    unmount();
  }, 20_000);

  it('releases what it holds when the body goes', async () => {
    setPaintWorkerFactoryForTest(FakePaintWorker.factory());
    const { rerender, unmount } = renderHook(
      ({ lvl }: { lvl: number }) => useBodyMaps(mars, 'planet', SMALL, lvl),
      { initialProps: { lvl: 1 } },
    );
    await settle();
    rerender({ lvl: 0 }); // a paint pending while the 64 map is held
    unmount();
    expect(nearTextures.stats()).toMatchObject({ entries: 1, idle: 1, pending: 0 });
  }, 20_000);
});

describe('painting without a worker', () => {
  it('caps the near maps (no detail) when there is no worker at all', async () => {
    setPaintWorkerFactoryForTest(null);
    expect(paintsOffMainThread()).toBe(false);
    const { result } = renderHook(() => useBodyMaps(mars, 'planet', SMALL, 0));
    await settle();
    expect(result.current.map.image.width).toBe(64);
    expect(result.current.detail).toBeNull();
  }, 20_000);

  it('falls back to capped maps when the worker fails to load', async () => {
    setPaintWorkerFactoryForTest(FakePaintWorker.factory('fail'));
    expect(paintsOffMainThread()).toBe(true);
    const { result } = renderHook(() => useBodyMaps(mars, 'planet', SMALL, 0));
    expect(FakePaintWorker.made).toHaveLength(1);
    await act(async () => {
      await vi.waitFor(() => expect(paintsOffMainThread()).toBe(false));
    });
    await settle();
    // The 128 + detail job was sent to the worker and failed; the body asked again, lighter.
    expect(FakePaintWorker.made[0]!.jobs.map((j) => [j.width, 'detail' in j && j.detail])).toEqual([
      [128, true],
    ]);
    expect(result.current.map.image.width).toBe(64);
    expect(result.current.detail).toBeNull();
  }, 20_000);
});

describe('cancelling the running paint', () => {
  it('terminates the worker and starts the next job on a fresh one', async () => {
    setPaintWorkerFactoryForTest(FakePaintWorker.factory('hold'));
    const abort = new AbortController();
    const stale = paintAsync({ look: mars, width: 64, height: 32, detail: true }, abort.signal);
    const next = paintAsync({ look: io, width: 32, height: 16, detail: false });
    const first = FakePaintWorker.made[0]!;
    expect(first.jobs).toHaveLength(1);
    expect(paintBacklog()).toBe(2);

    abort.abort();
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.terminated).toBe(true);
    const second = FakePaintWorker.made[1]!;
    expect(second.jobs.map((j) => j.width)).toEqual([32]);
    second.reply();
    await expect(next).resolves.toMatchObject({ detail: null });
    expect(paintBacklog()).toBe(0);
    // A late answer from the terminated worker is ignored.
    first.terminated = false;
    first.reply();
    expect(paintBacklog()).toBe(0);
  });
});
