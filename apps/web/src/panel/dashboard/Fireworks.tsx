import { useEffect } from 'react';

/** How long the burst lasts, in milliseconds. */
export const FIREWORKS_MS = 1500;

const BURSTS = [
  { x: '22%', y: '38%', delay: '0s' },
  { x: '70%', y: '30%', delay: '0.25s' },
  { x: '48%', y: '62%', delay: '0.5s' },
];
const SPARKS = 10;

/**
 * A short burst over a very good panel (P15-06): pure CSS, no canvas and no dependency, ignoring
 * the pointer. It is decoration (`aria-hidden`); the live region beside it says "very good" for
 * screen readers. It calls `onDone` when it ends.
 */
export function Fireworks({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, FIREWORKS_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <>
      <span className="dash-fireworks" aria-hidden="true">
        {BURSTS.flatMap((b, bi) =>
          Array.from({ length: SPARKS }, (_, i) => {
            const angle = (360 / SPARKS) * i;
            return (
              <span
                key={`${bi}-${i}`}
                className="dash-spark"
                style={
                  {
                    left: b.x,
                    top: b.y,
                    animationDelay: b.delay,
                    '--angle': `${angle}deg`,
                    '--hue': `${(bi * 70 + i * 12) % 360}`,
                  } as React.CSSProperties
                }
              />
            );
          }),
        )}
      </span>
      <span className="pnl-visually-hidden" role="status">
        very good
      </span>
    </>
  );
}
