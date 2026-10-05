import { useSyncExternalStore } from 'react';
import { QualityTier } from '@galactic/protocol';
import { isPhone, liveProbe, type DeviceProbe } from './device.js';

/**
 * The quality tier per device (P7-03; SPEC decision 93, answering §8's 2026-10-03 question): the
 * server's `qualityTier` (decision 51) is the default for every device; a phone starts at
 * `mobile` instead; and the user may pick a tier for this browser alone in the settings page,
 * which wins over both and is remembered here, in `localStorage` — like the scene's visibility
 * (decision 62), a device preference.
 */
export const DEVICE_TIER_KEY = 'galactic.scene.tier';

/** This browser's own tier, or `undefined` (follow the automatic choice). */
export function readDeviceTier(): QualityTier | undefined {
  try {
    const parsed = QualityTier.safeParse(localStorage.getItem(DEVICE_TIER_KEY));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return memory;
  }
}

/** Without storage (private mode) the choice lasts for this page only. */
let memory: QualityTier | undefined;
const listeners = new Set<() => void>();

export function writeDeviceTier(tier: QualityTier | undefined): void {
  memory = tier;
  try {
    if (tier) localStorage.setItem(DEVICE_TIER_KEY, tier);
    else localStorage.removeItem(DEVICE_TIER_KEY);
  } catch {
    // No storage: `memory` holds it.
  }
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab of this browser changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === DEVICE_TIER_KEY || e.key === null) onChange();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** This browser's own tier, live (the settings page and the scene stay in step). */
export function useDeviceTier(): QualityTier | undefined {
  return useSyncExternalStore(subscribe, readDeviceTier, () => undefined);
}

/**
 * The tier when this browser has no choice of its own: `mobile` on a phone, else the server's
 * (`undefined` while the settings are loading or unavailable: the renderer's default).
 */
export function automaticTier(
  serverTier: QualityTier | undefined,
  probe: DeviceProbe = liveProbe(),
): QualityTier | undefined {
  return isPhone(probe) ? 'mobile' : serverTier;
}

/** The tier the scene draws at: this browser's choice, else the automatic one. */
export function effectiveTier(
  serverTier: QualityTier | undefined,
  deviceTier: QualityTier | undefined,
  probe: DeviceProbe = liveProbe(),
): QualityTier | undefined {
  return deviceTier ?? automaticTier(serverTier, probe);
}
