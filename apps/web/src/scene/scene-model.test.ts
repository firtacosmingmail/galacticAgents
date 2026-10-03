// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { QualityTier } from '@galactic/protocol';
import { FPS_FLAG_KEY, FpsCounter, fpsMeterEnabled } from './fps.js';
import { DEFAULT_QUALITY_TIER, QUALITY_TIERS, sceneQuality } from './quality.js';
import { generateStarField, STAR_SHELL } from './starfield.js';
import { readSceneVisible, SCENE_VISIBLE_KEY, writeSceneVisible } from './visibility.js';

afterEach(() => localStorage.clear());

describe('quality tiers (P3-01)', () => {
  it('has one entry per protocol tier, keyed by its own name', () => {
    expect(Object.keys(QUALITY_TIERS).sort()).toEqual([...QualityTier.options].sort());
    for (const tier of QualityTier.options) expect(QUALITY_TIERS[tier].tier).toBe(tier);
  });

  it('gets lighter from high to balanced to mobile', () => {
    const { high, balanced, mobile } = QUALITY_TIERS;
    expect(high.dprCap).toBeGreaterThan(balanced.dprCap);
    expect(balanced.dprCap).toBeGreaterThan(mobile.dprCap);
    expect(high.stars).toBeGreaterThan(balanced.stars);
    expect(balanced.stars).toBeGreaterThan(mobile.stars);
    expect(high.bloom!.intensity).toBeGreaterThanOrEqual(balanced.bloom!.intensity);
  });

  it('turns the costly effects off on mobile', () => {
    expect(QUALITY_TIERS.mobile).toMatchObject({
      dprCap: 1,
      antialias: false,
      bloom: null,
      shadows: false,
    });
    expect(QUALITY_TIERS.high.shadows).toBe(true);
    expect(QUALITY_TIERS.balanced.shadows).toBe(false);
  });

  it('falls back to the server default when the settings say nothing', () => {
    expect(DEFAULT_QUALITY_TIER).toBe('high');
    expect(sceneQuality(undefined)).toBe(QUALITY_TIERS.high);
    expect(sceneQuality('mobile')).toBe(QUALITY_TIERS.mobile);
  });
});

describe('star field', () => {
  it('places the requested number of stars inside the shell', () => {
    const { positions, colors } = generateStarField(500, 7);
    expect(positions).toHaveLength(1500);
    expect(colors).toHaveLength(1500);
    for (let i = 0; i < 500; i++) {
      const r = Math.hypot(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
      expect(r).toBeGreaterThanOrEqual(STAR_SHELL.inner - 0.01);
      expect(r).toBeLessThanOrEqual(STAR_SHELL.outer + 0.01);
    }
    for (const c of colors) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('is the same sky on every load (seeded)', () => {
    expect(generateStarField(100, 3).positions).toEqual(generateStarField(100, 3).positions);
    expect(generateStarField(100, 3).positions).not.toEqual(generateStarField(100, 4).positions);
  });

  it('handles an empty sky', () => {
    expect(generateStarField(0).positions).toHaveLength(0);
  });
});

describe('fps meter', () => {
  it('reports frames per second once per window', () => {
    const counter = new FpsCounter(500);
    expect(counter.tick(0)).toBeUndefined();
    let sample;
    for (let i = 1; i <= 30; i++) sample = counter.tick(i * (500 / 30)) ?? sample;
    expect(sample?.fps).toBeCloseTo(60, 5);
    expect(sample?.frameMs).toBeCloseTo(16.67, 1);
  });

  it('is turned on by ?fps=1, remembered, and turned off by ?fps=0', () => {
    expect(fpsMeterEnabled('')).toBe(false);
    expect(fpsMeterEnabled('?fps=1')).toBe(true);
    expect(localStorage.getItem(FPS_FLAG_KEY)).toBe('1');
    expect(fpsMeterEnabled('')).toBe(true);
    expect(fpsMeterEnabled('?fps=0')).toBe(false);
    expect(fpsMeterEnabled('')).toBe(false);
  });
});

describe('scene visibility', () => {
  it('is shown by default and remembers a hide', () => {
    expect(readSceneVisible()).toBe(true);
    writeSceneVisible(false);
    expect(localStorage.getItem(SCENE_VISIBLE_KEY)).toBe('0');
    expect(readSceneVisible()).toBe(false);
    writeSceneVisible(true);
    expect(readSceneVisible()).toBe(true);
  });
});
