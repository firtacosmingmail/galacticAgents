import { useEffect, useMemo, useState } from 'react';
import { ArchetypeHold, type HoldInput } from '../archetype.js';

/** Wall-clock seconds (the hold is about what the user sees, not the decorative motion clock). */
export const wallSeconds = (): number => performance.now() / 1000;

/**
 * The satellite list with each Steward's archetype held (P4-03, `ArchetypeHold`): no flicker, a
 * run of edits escalated to building. A switch that becomes due while the world stays the same
 * (the confirm, dwell and release delays) re-renders at that moment through a timer, so it also
 * lands under the on-demand frame loop (reduced motion).
 */
export function useHeldArchetypes<T extends HoldInput>(
  list: readonly T[],
  clock: () => number = wallSeconds,
): T[] {
  const [hold] = useState(() => new ArchetypeHold());
  const [tick, setTick] = useState(0);
  const held = useMemo(() => {
    void tick; // a due switch re-applies the same list
    return hold.apply(list, clock());
  }, [hold, list, tick, clock]);
  useEffect(() => {
    const due = hold.nextDue();
    if (due === undefined) return;
    const wait = Math.max(0, (due - clock()) * 1000) + 5;
    const timer = setTimeout(() => setTick((t) => t + 1), wait);
    return () => clearTimeout(timer);
  }, [hold, held, clock]);
  return held;
}
