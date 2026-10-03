import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../../state/store.js';
import { StatePill } from '../../console/hierarchy/shared.js';
import type { SatelliteMode } from '../satellites/machine.js';
import { satelliteCard } from './satellite-card.js';
import { usePickingStore, type Point } from './store.js';

/**
 * The hover card of a satellite (P4-08): the agent's name, its state pill (the panel's words and
 * colours), a one-line title of what it is doing and where it is (`satelliteCard`). It takes the
 * hover label's place — still one element over the canvas, `pointer-events: none`.
 *
 * Content and position update separately: the content re-renders from the app store (a state or
 * activity change shows at once while hovering) and when the satellite's mode or the "+n" count
 * changes; the position follows the satellite every frame through a store subscription that writes
 * the element's `transform` directly (no React render per frame), placed right of and below the
 * satellite and flipped to its left / above it near the scene area's edges.
 */
export const SatelliteHoverCard = memo(function SatelliteHoverCard({
  agentId,
  mode,
  bodyId,
  others,
}: {
  agentId: string;
  mode: SatelliteMode;
  bodyId: string;
  others: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const world = useAppStore((s) => s.world);
  const { name, state, activity, where } = useMemo(
    () => satelliteCard(world, agentId, bodyId ? { bodyId, mode } : undefined),
    [world, agentId, bodyId, mode],
  );

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
    const current = usePickingStore.getState().hover;
    if (current?.kind === 'satellite') place(current);
    return usePickingStore.subscribe((s) => {
      if (s.hover?.kind === 'satellite' && s.hover.agentId === agentId) place(s.hover);
    });
  }, [agentId, name, activity, where, others]);

  return (
    <div ref={ref} className="pick-hover pick-sat" role="tooltip" data-agent={agentId}>
      <span className="pick-sat-head">
        <StatePill state={state} />
        <strong className="pick-sat-name">{name}</strong>
      </span>
      <span className="pick-sat-activity">{activity}</span>
      {(where || others > 0) && (
        <span className="pick-sat-where">
          {where}
          {others > 0 && <span className="pick-hover-more"> +{others}</span>}
        </span>
      )}
    </div>
  );
});
