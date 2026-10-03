import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

/**
 * The frame-rate cap (P3-06, the tier's `maxFps`): while the decorative motion runs, a capped
 * tier switches the canvas to `demand` and this component asks for a frame at most `fps` times a
 * second (every other frame of a 60 Hz display at 30), which roughly halves the GPU work and the
 * battery drain on the phone. Camera flights, resizes and prop changes still ask for their own
 * frames. The orbits follow the clock, so the motion keeps its speed at any rate.
 */

/** Slack so a 60 Hz display's 16.7 ms ticks land on 30 fps rather than 20 (timer jitter). */
export const FRAME_CAP_SLACK_MS = 4;

/** Whether a frame is due at `now` (ms) when the last one was asked for at `last`. */
export function frameDue(now: number, last: number | undefined, fps: number): boolean {
  if (last === undefined) return true;
  return now - last >= 1000 / fps - FRAME_CAP_SLACK_MS;
}

/** The canvas loop under a cap: `demand` while capped (this component drives it), otherwise as asked. */
export function cappedFrameloop(
  loop: 'always' | 'demand',
  maxFps: number | null,
  fpsMeter: boolean,
): { frameloop: 'always' | 'demand'; capFps: number | null } {
  if (loop !== 'always' || maxFps === null || fpsMeter) return { frameloop: loop, capFps: null };
  return { frameloop: 'demand', capFps: maxFps };
}

export function FrameCap({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let last: number | undefined;
    let handle = 0;
    const tick = (now: number) => {
      if (frameDue(now, last, fps)) {
        last = now;
        invalidate();
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [fps, invalidate]);
  return null;
}
