/**
 * The development frame-rate meter (P3-01: "60 fps on the Mac at high"). `FpsCounter` is plain
 * arithmetic over frame timestamps so it is testable; the canvas feeds it from `useFrame`.
 */
export interface FpsSample {
  /** Frames per second over the last window. */
  fps: number;
  /** Mean frame time in milliseconds over the last window. */
  frameMs: number;
}

export class FpsCounter {
  private windowStart: number | undefined;
  private frames = 0;

  /** @param windowMs how often a sample is produced. */
  constructor(private readonly windowMs = 500) {}

  /** Records a frame at `now` (ms); returns a sample when a window closes. */
  tick(now: number): FpsSample | undefined {
    if (this.windowStart === undefined) {
      this.windowStart = now;
      return undefined;
    }
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed < this.windowMs) return undefined;
    const sample = { fps: (this.frames * 1000) / elapsed, frameMs: elapsed / this.frames };
    this.windowStart = now;
    this.frames = 0;
    return sample;
  }
}

export const FPS_FLAG_KEY = 'galactic.scene.fps';

/** The URL's choice taken at page load, for a browser without storage (private mode). */
let fromLoad: boolean | undefined;

/** The URL parameter that turns the meter on or off: `?show_fps=true` / `?show_fps=false`. */
export const FPS_PARAM = 'show_fps';

/** The URL's choice: `true` / `false` (also `1` / `0`, any case); undefined when absent or unknown. */
export function fpsParam(search: string): boolean | undefined {
  const value = new URLSearchParams(search).get(FPS_PARAM)?.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Whether the meter is on: `?show_fps=true` in the URL turns it on (and remembers it in this
 * browser), `?show_fps=false` turns it off; otherwise the remembered choice (or, without storage,
 * the choice taken at page load by `captureFpsFlag`); otherwise off.
 */
export function fpsMeterEnabled(search: string = globalThis.location?.search ?? ''): boolean {
  const flag = fpsParam(search);
  if (flag !== undefined) {
    try {
      if (flag) localStorage.setItem(FPS_FLAG_KEY, '1');
      else localStorage.removeItem(FPS_FLAG_KEY);
    } catch {
      // No storage (private mode): the URL still decides for this page.
    }
    return flag;
  }
  try {
    return localStorage.getItem(FPS_FLAG_KEY) === '1';
  } catch {
    return fromLoad ?? false;
  }
}

/**
 * Takes `?show_fps=` from the URL the page was loaded with (P3-11), before anything rewrites the URL:
 * the app calls it once at start-up. The scene mounts later (after the token, the settings, the
 * first-run gate, or a "Show scene" click), by which time a navigation may have dropped the query.
 */
export function captureFpsFlag(search: string = globalThis.location?.search ?? ''): void {
  if (fpsParam(search) === undefined) return;
  fromLoad = fpsMeterEnabled(search);
}
