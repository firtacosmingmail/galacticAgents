/**
 * What kind of device and connection the panel runs on (P7-03), for two per-device defaults:
 * the scene's quality tier (`device-tier.ts`: phones start at `mobile`) and whether the scene is
 * shown at all (`visibility.ts`: list mode on a small screen or a slow connection). Only defaults:
 * the user's own choice, remembered in the browser, always wins. No three.js, no React.
 *
 * Everything is read through `DeviceProbe`, so tests describe a phone without a browser; the live
 * probe reads `matchMedia`, the window's size and `navigator.connection` (Network Information API:
 * Chrome and Android only — Safari has none, so an iPhone is never "slow" by this test).
 */
export interface DeviceProbe {
  /** `matchMedia(query).matches`; false without `matchMedia`. */
  matches: (query: string) => boolean;
  /** The viewport's CSS size. */
  viewport: { width: number; height: number };
  /** `navigator.connection`, when the browser has it. */
  connection?: { saveData?: boolean; effectiveType?: string } | undefined;
}

/** The primary pointer is a finger (phones, tablets); a mouse or a trackpad is `fine`. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/**
 * A phone: a coarse pointer and a viewport whose short side is at most this many CSS pixels
 * (every phone in portrait or landscape; a tablet's short side is 744 px and up, so a tablet keeps
 * the server's tier).
 */
export const PHONE_MAX_SHORT_SIDE_PX = 600;

/**
 * A small screen for list mode: as narrow as the compact top bar (decision 67, 760 px), where the
 * scene gets 40 % of the height of a stacked panel.
 */
export const SMALL_SCREEN_QUERY = '(max-width: 760px)';

/** `effectiveType`s slow enough that the scene's chunk and textures should wait for a tap. */
export const SLOW_EFFECTIVE_TYPES: readonly string[] = ['slow-2g', '2g', '3g'];

export function liveProbe(): DeviceProbe {
  const w = typeof window === 'undefined' ? undefined : window;
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    matches: (query) => {
      if (!w || typeof w.matchMedia !== 'function') return false;
      try {
        return w.matchMedia(query).matches;
      } catch {
        return false;
      }
    },
    viewport: { width: w?.innerWidth ?? 1024, height: w?.innerHeight ?? 768 },
    connection: (nav as { connection?: DeviceProbe['connection'] } | undefined)?.connection,
  };
}

/** A phone: a finger for a pointer and a phone-sized viewport (either orientation). */
export function isPhone(probe: DeviceProbe = liveProbe()): boolean {
  const short = Math.min(probe.viewport.width, probe.viewport.height);
  return probe.matches(COARSE_POINTER_QUERY) && short > 0 && short <= PHONE_MAX_SHORT_SIDE_PX;
}

/** A screen too small for the scene beside the panel (any pointer: a narrow desktop window too). */
export function isSmallScreen(probe: DeviceProbe = liveProbe()): boolean {
  return probe.matches(SMALL_SCREEN_QUERY);
}

/** Data saver on, or a connection the browser rates 3G or slower. Unknown → not slow. */
export function isSlowConnection(probe: DeviceProbe = liveProbe()): boolean {
  const c = probe.connection;
  if (!c) return false;
  if (c.saveData === true) return true;
  return c.effectiveType !== undefined && SLOW_EFFECTIVE_TYPES.includes(c.effectiveType);
}

/** Why the scene starts hidden on this device, or `undefined` when it starts shown. */
export type ListModeReason = 'small-screen' | 'slow-connection';

export function listModeReason(probe: DeviceProbe = liveProbe()): ListModeReason | undefined {
  if (isSlowConnection(probe)) return 'slow-connection';
  if (isSmallScreen(probe)) return 'small-screen';
  return undefined;
}
