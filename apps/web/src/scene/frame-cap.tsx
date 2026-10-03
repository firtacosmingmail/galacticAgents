import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

/**
 * The frame-rate cap (P3-06, the tier's `maxFps`): while the decorative motion runs, a capped
 * tier switches the canvas's loop to `never` and this component renders a frame at most `fps`
 * times a second (every other frame of a 60 Hz display at 30), which roughly halves the GPU work
 * and the battery drain on the phone. Under `never` R3F ignores `invalidate()`, so a camera that
 * follows a body (and invalidates every frame) is capped too; flights and resizes simply show on
 * the next capped frame. R3F's clock is driven from here (seconds since the cap started: R3F
 * restarts it at 0 on any loop change); the orbits do not use it but `motionSeconds()`, a clock of
 * their own, so they keep their speed at any rate and their place across loop switches.
 */

/** Slack so a 60 Hz display's 16.7 ms ticks land on 30 fps rather than 20 (timer jitter). */
export const FRAME_CAP_SLACK_MS = 4;

/** Whether a frame is due at `now` (ms) when the last one was drawn at `last`. */
export function frameDue(now: number, last: number | undefined, fps: number): boolean {
  if (last === undefined) return true;
  return now - last >= 1000 / fps - FRAME_CAP_SLACK_MS;
}

/** The canvas loop under a cap: `never` while capped (`FrameCap` drives it), otherwise as asked. */
export function cappedFrameloop(
  loop: 'always' | 'demand',
  maxFps: number | null,
  fpsMeter: boolean,
): { frameloop: 'always' | 'demand' | 'never'; capFps: number | null } {
  if (loop !== 'always' || maxFps === null || fpsMeter) return { frameloop: loop, capFps: null };
  return { frameloop: 'never', capFps: maxFps };
}

export function FrameCap({ fps }: { fps: number }) {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    let start: number | undefined;
    let last: number | undefined;
    let handle = 0;
    const tick = (now: number) => {
      start ??= now;
      if (frameDue(now, last, fps)) {
        last = now;
        advance((now - start) / 1000, true);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [fps, advance]);
  return null;
}
