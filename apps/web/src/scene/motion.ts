import { useSyncExternalStore } from 'react';

/**
 * The scene's decorative motion and the user's reduced-motion preference, shared by the scene's
 * parts (P3-02 bodies, P3-03 belt; the frame loop in `SolarScene`): planets go round the Sun,
 * moons round their planets, planets spin, the belt turns. All of it stops when the user asks the
 * system for reduced motion (`prefers-reduced-motion: reduce`): the bodies then sit still at their
 * starting angles (chosen so none hides behind the Sun) and the canvas renders on demand again.
 * No three.js here.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function mediaQuery(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    return undefined;
  }
}

/** Whether the user prefers reduced motion right now (no `matchMedia` → no preference). */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const mq = mediaQuery();
  if (!mq) return () => {};
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** The user's reduced-motion preference, live (a change in the system settings applies at once). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

/**
 * The decorative motion's clock, in seconds: wall time since the first frame that asked for it.
 * Not R3F's `clock.elapsedTime`, which restarts at 0 whenever the canvas's frame loop changes (a
 * tier switch to or from the capped mobile loop, the fps meter turned on or off) and would make
 * every planet jump back to its starting angle. Shared by every body, so the orbits stay in step;
 * it keeps running while the scene is hidden.
 */
let motionOrigin: number | undefined;

export function motionSeconds(now: number = performance.now()): number {
  motionOrigin ??= now;
  return (now - motionOrigin) / 1000;
}

/** Whether the decorative motion runs. */
export function motionEnabled(reducedMotion: boolean): boolean {
  return !reducedMotion;
}

/**
 * The canvas frame loop: continuous while something moves (the decorative motion, or the fps
 * meter that measures a real frame rate), on demand otherwise.
 */
export function sceneFrameloop(opts: { motion: boolean; fpsMeter: boolean }): 'always' | 'demand' {
  return opts.motion || opts.fpsMeter ? 'always' : 'demand';
}
