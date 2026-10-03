import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../../state/store.js';
import { hoverAt, onHoverMove, type Point } from '../picking/store.js';
import { beaconCard } from './beacon-model.js';
import './beacons.css';

/**
 * The hover card of a question beacon (P4-05): "Permission: <text…>" or "Question: <text…>", the
 * agent asking, and "+n more on <body>" when several wait there; the click opens that question in
 * the inbox. One element over the canvas in the hover label's place (`pointer-events: none`),
 * positioned by the hover's position channel (`onHoverMove`, no React render per move), flipped
 * near the scene area's edges like the satellite card. Its content follows the store: a question
 * answered elsewhere changes the card (or removes it, with the beacon) at once.
 */
export const BeaconHoverCard = memo(function BeaconHoverCard({ bodyId }: { bodyId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const world = useAppStore((s) => s.world);
  const card = useMemo(() => beaconCard(world, bodyId), [world, bodyId]);

  useLayoutEffect(() => {
    const place = (at: Point) => {
      const el = ref.current;
      if (!el) return;
      const area = el.offsetParent as HTMLElement | null;
      const gap = 14;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = area ? at.x + gap + w > area.clientWidth : false;
      const up = area ? at.y + gap + h > area.clientHeight : false;
      const x = Math.max(0, left ? at.x - gap - w : at.x + gap);
      const y = Math.max(0, up ? at.y - gap - h : at.y + gap / 2);
      el.style.transform = `translate(${x}px, ${y}px)`;
    };
    place(hoverAt());
    return onHoverMove(place);
  }, [card]);

  if (!card) return null;
  return (
    <div
      ref={ref}
      className={`pick-hover beacon-card beacon-card-${card.kind}`}
      role="tooltip"
      data-body={bodyId}
    >
      <span className="beacon-card-head">
        <strong className="beacon-card-kind">{card.heading}:</strong> {card.text}
      </span>
      <span className="beacon-card-asker">{card.asker}</span>
      <span className="beacon-card-hint">
        {card.more > 0 ? `+${card.more} more on ${card.where} · ` : ''}click to open in the inbox
      </span>
    </div>
  );
});
