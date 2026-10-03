import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { Id, TranscriptChunk } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { clampDockSize, DOCK_MAX, DOCK_MIN, DOCK_STEP } from './dock-state.js';

/**
 * The docked conversation's pieces (P4-10): the drag handle that sets its height, and the
 * "new replies while minimised" count its bar shows.
 */

/** The dock's body, for the minimise button's `aria-controls`. */
export const DOCK_BODY_ID = 'pnl-dock-body';

/**
 * The handle on the dock's top edge: drag it, or focus it and use the arrow keys (Page Up / Page
 * Down for bigger steps, Home / End for the smallest and the largest), to set the dock's height as
 * a share of `container` (the centre column; the whole stacked layout on narrow screens), clamped
 * to DOCK_MIN–DOCK_MAX. A drag is saved when it ends.
 */
export function DockHandle({
  size,
  onSize,
  container,
}: {
  size: number;
  onSize: (size: number, persist?: boolean) => void;
  container: RefObject<HTMLElement | null>;
}) {
  const dragging = useRef(false);
  const fromPointer = (y: number): number | undefined => {
    const box = container.current?.getBoundingClientRect();
    if (!box || box.height <= 0) return undefined;
    return ((box.bottom - y) / box.height) * 100;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Not an active pointer (a synthetic event): the drag still works while over the handle.
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const next = fromPointer(e.clientY);
    if (next !== undefined) onSize(next, false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released.
    }
    onSize(fromPointer(e.clientY) ?? size, true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === 'ArrowUp'
        ? size + DOCK_STEP
        : e.key === 'ArrowDown'
          ? size - DOCK_STEP
          : e.key === 'PageUp'
            ? size + 2 * DOCK_STEP
            : e.key === 'PageDown'
              ? size - 2 * DOCK_STEP
              : e.key === 'Home'
                ? DOCK_MIN
                : e.key === 'End'
                  ? DOCK_MAX
                  : undefined;
    if (next === undefined) return;
    e.preventDefault();
    onSize(clampDockSize(next));
  };
  return (
    <div
      className="pnl-dock-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the conversation"
      aria-valuemin={DOCK_MIN}
      aria-valuemax={DOCK_MAX}
      aria-valuenow={size}
      aria-valuetext={`${size}% of the height`}
      title="Drag to resize (or focus and use the arrow keys)"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}

const NO_CHUNKS: TranscriptChunk[] = [];
const isReply = (c: TranscriptChunk) => c.kind === 'text' && c.text.trim() !== '';

/**
 * How many replies the agent wrote since the dock was minimised (0 while it is open). The chat
 * stays mounted while minimised, so its live transcript keeps arriving in the store.
 */
export function useUnreadReplies(agentId: Id | undefined, minimised: boolean): number {
  const chunks = useAppStore((s) => (agentId ? s.transcripts[agentId] : undefined)) ?? NO_CHUNKS;
  const last = chunks.reduce((max, c) => (isReply(c) && c.seq > max ? c.seq : max), 0);
  const key = minimised ? (agentId ?? '') : undefined;
  const [base, setBase] = useState({ key, seq: last });
  if (base.key !== key) {
    // Minimised (or another agent selected while minimised): count from here.
    setBase({ key, seq: last });
    return 0;
  }
  if (!minimised) return 0;
  return chunks.filter((c) => isReply(c) && c.seq > base.seq).length;
}
