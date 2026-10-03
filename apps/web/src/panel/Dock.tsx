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
 *
 * While dragging, the height is written straight onto the dock element (`--pnl-dock-size` on the
 * handle's parent, and the handle's own `aria-valuenow`), not through React state: re-rendering
 * the panel on every pointer move made the drag stutter. The state is set once, when the drag
 * ends (and then matches what is on screen).
 */
export function DockHandle({
  size,
  onSize,
  container,
}: {
  size: number;
  onSize: (size: number) => void;
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
  /** Shows a height on screen without a render (the drag in progress). */
  const show = (el: HTMLElement, next: number) => {
    el.parentElement?.style.setProperty('--pnl-dock-size', `${next}%`);
    el.setAttribute('aria-valuenow', String(next));
    el.setAttribute('aria-valuetext', `${next}% of the height`);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const next = fromPointer(e.clientY);
    if (next !== undefined) show(e.currentTarget, clampDockSize(next));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released.
    }
    const final = clampDockSize(fromPointer(e.clientY) ?? size);
    // The state may already hold this value (dragged away and back): then React will not touch
    // the element, so it must show it already.
    show(e.currentTarget, final);
    onSize(final);
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
 * The "N new" badge of a minimised dock: the replies the agent wrote since it was minimised. The
 * chat stays mounted while minimised, so its live transcript keeps arriving in the store. Mounted
 * only while minimised and keyed by the agent, so the baseline is simply taken when it mounts
 * (minimising, or selecting another agent while minimised) — no state to reset during a render
 * or in an effect.
 */
export function UnreadReplies({ agentId }: { agentId: Id }) {
  const chunks = useAppStore((s) => s.transcripts[agentId]) ?? NO_CHUNKS;
  const [since] = useState(() =>
    chunks.reduce((max, c) => (isReply(c) && c.seq > max ? c.seq : max), 0),
  );
  const unread = chunks.filter((c) => isReply(c) && c.seq > since).length;
  if (unread === 0) return null;
  return (
    <span className="pnl-dock-unread" role="status" aria-label={`${unread} new replies`}>
      {unread} new
    </span>
  );
}
