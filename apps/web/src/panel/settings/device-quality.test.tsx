// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  type QualityTier,
  type SettingsResponse,
} from '@galactic/protocol';
import type { Api } from '../../console/api.js';
import { useQualityTier } from '../../scene/SceneArea.js';
import { DEVICE_TIER_KEY } from '../../scene/device-tier.js';
import { COARSE_POINTER_QUERY } from '../../scene/device.js';
import { DeviceQuality } from './DeviceQuality.js';
import { SettingsProvider } from './SettingsData.js';

const settings = (qualityTier: QualityTier): SettingsResponse => ({
  settings: {
    projectsRoot: '/Users/me/GalacticProjects',
    defaultPermissionPolicy: structuredClone(DEFAULT_PERMISSION_POLICY),
    retentionDays: 7,
    caps: {
      maxConcurrentAgents: 4,
      maxStewardsPerWaykeeper: 3,
      maxSpawnsPerHour: 30,
      maxSpawnsPerHourPerBrain: 20,
      maxWallClockMs: 7_200_000,
      maxToolCalls: 500,
    },
    qualityTier,
    stewardsLoadUserSettings: true,
  },
  envOverrides: [],
  restartRequired: [],
});

function TierProbe() {
  return <output aria-label="scene tier">{useQualityTier() ?? 'default'}</output>;
}

async function renderPage(server: QualityTier) {
  const api = { settings: async () => settings(server) } as unknown as Api;
  render(
    <SettingsProvider api={api}>
      <DeviceQuality />
      <TierProbe />
    </SettingsProvider>,
  );
  await act(async () => {});
}

const region = () => screen.getByRole('region', { name: 'Rendering quality on this device' });
const sceneTier = () => screen.getByLabelText('scene tier').textContent;

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('rendering quality on this device (P7-03)', () => {
  it('follows the server tier on a desktop until this browser picks its own', async () => {
    await renderPage('balanced');
    const r = region();
    const auto = within(r).getByRole('radio', { name: /Automatic/ }) as HTMLInputElement;
    expect(auto.checked).toBe(true);
    expect(auto.closest('label')!.textContent).toContain('Balanced, the rendering quality above');
    expect(sceneTier()).toBe('balanced');

    fireEvent.click(within(r).getByRole('radio', { name: /^High/ }));
    expect(localStorage.getItem(DEVICE_TIER_KEY)).toBe('high');
    expect(sceneTier()).toBe('high'); // at once, no reload
    expect(within(r).getByRole('status').textContent).toBe('Saved in this browser.');

    fireEvent.click(auto);
    expect(localStorage.getItem(DEVICE_TIER_KEY)).toBeNull();
    expect(sceneTier()).toBe('balanced');
  });

  it('starts a phone at Mobile whatever the server holds; its own choice still wins', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === COARSE_POINTER_QUERY,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    await renderPage('high');
    const auto = within(region()).getByRole('radio', { name: /Automatic/ });
    expect(auto.closest('label')!.textContent).toContain('Mobile, because this looks like a phone');
    expect(sceneTier()).toBe('mobile');
    fireEvent.click(within(region()).getByRole('radio', { name: /^Balanced/ }));
    expect(sceneTier()).toBe('balanced');
  });

  it('remembers the choice across a reload', async () => {
    localStorage.setItem(DEVICE_TIER_KEY, 'mobile');
    await renderPage('high');
    expect(
      (within(region()).getByRole('radio', { name: /^Mobile/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(sceneTier()).toBe('mobile');
  });
});
