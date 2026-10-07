import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { useAppStore } from '../state/store.js';
import { summaryOf } from '../state/reduce.js';
import { REDUCED_MOTION_QUERY } from '../scene/motion.js';
import { useMediaQuery } from './use-media-query.js';

/**
 * The phone's navigation sheet (P8-15). Below the compact width (`COMPACT_TOP_BAR_QUERY`) the
 * panel's left navigation — the Harmonizer, the projects, the asteroids — leaves the stacked
 * layout and becomes an off-canvas sheet: hidden by default, it slides in from the left when the
 * top bar's "Agents" button is pressed or a finger swipes in from the screen's left edge, and
 * slides out again on a selection, a tap on the dimmed page beside it, Escape, its close button
 * or a swipe to the left. While open it is a modal dialog: the focus moves into it, Tab stays in
 * it, the rest of the page is `inert`, and on close the focus goes back to the "Agents" button.
 * Its open state is not remembered: every load starts with it hidden.
 */

export const NAV_SHEET_ID = 'pnl-nav-sheet';
export const NAV_SHEET_BUTTON_ID = 'pnl-nav-sheet-button';

/** How far from the screen's left edge a swipe may start to open the sheet, in CSS px. */
export const EDGE_ZONE = 24;
/** How far a finger must travel sideways for a swipe to open or close the sheet, in CSS px. */
export const SWIPE_DISTANCE = 48;

export interface NavSheetControl {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** The sheet's open state: plain component state (never persisted), closed on every load. */
export function useNavSheet(active: boolean): NavSheetControl {
  const [open, setOpenState] = useState(false);
  const setOpen = useCallback((next: boolean) => setOpenState(next), []);
  // Leaving the phone layout (a rotation, a wider window) drops the sheet; it comes back closed.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setOpenState(false);
  }
  const shown = active && open;
  return useMemo(() => ({ open: shown, setOpen }), [shown, setOpen]);
}

/** Whether a swipe has gone far enough, and sideways enough, to count (dx > 0: to the right). */
export function isSwipe(dx: number, dy: number, direction: 1 | -1): boolean {
  return dx * direction >= SWIPE_DISTANCE && Math.abs(dx) > 1.5 * Math.abs(dy);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The sheet's Tab stops, in order (not those in a closed disclosure, hidden or inert). */
function tabStops(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[hidden], [inert], details:not([open]) > :not(summary)'),
  );
}

/**
 * Makes everything outside `keep` inert (each sibling of it and of its ancestors up to the body),
 * as a modal dialog needs; returns the undo. Elements already inert stay so.
 */
function inertOutside(keep: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  for (let el: HTMLElement | null = keep; el && el !== document.body; el = el.parentElement) {
    const parent: HTMLElement | null = el.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === el || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute('inert') || sibling.tagName === 'SCRIPT') continue;
      sibling.setAttribute('inert', '');
      changed.push(sibling);
    }
  }
  return () => changed.forEach((el) => el.removeAttribute('inert'));
}

/**
 * The top bar's "Agents" button (compact bar only): opens the sheet. A dot says something in the
 * list waits for the user (the Harmonizer row's "N for you"); the words are in its name.
 */
export function NavSheetButton({ control }: { control: NavSheetControl }) {
  const waiting = useAppStore((s) => summaryOf(s.world).userQuestions);
  return (
    <button
      type="button"
      id={NAV_SHEET_BUTTON_ID}
      className="pnl-nav-button"
      aria-haspopup="dialog"
      aria-expanded={control.open}
      // Only while it is open: closed, the sheet is aria-hidden, and axe flags a reference to it.
      aria-controls={control.open ? NAV_SHEET_ID : undefined}
      title="Harmonizer, projects and asteroids"
      onClick={() => control.setOpen(!control.open)}
    >
      <span className="pnl-nav-button-icon" aria-hidden="true" />
      <span className="pnl-visually-hidden">
        Agents{waiting > 0 ? `, ${waiting} waiting for you` : ''}
      </span>
      {waiting > 0 && <span className="pnl-nav-button-dot" aria-hidden="true" />}
    </button>
  );
}

/**
 * Opens the sheet on a swipe from the screen's left edge (touch only: a mouse never swipes). Only
 * a touch that starts within `EDGE_ZONE` of the edge counts, so the scene's one-finger orbit keeps
 * the rest of the canvas; a touch that starts in the zone over the canvas is kept from the scene.
 * Touch events, not pointer events: the browser cancels a pointer when it starts to scroll, a
 * touch it does not.
 */
export function useEdgeSwipe(control: NavSheetControl, active: boolean): void {
  const { open, setOpen } = control;
  useEffect(() => {
    if (!active || open) return;
    let start: { id: number; x: number; y: number } | undefined;
    const onPointerDown = (e: PointerEvent) => {
      // Keep an edge touch from starting an orbit: the sheet's swipe owns it.
      if (e.pointerType !== 'touch' || e.clientX > EDGE_ZONE) return;
      if ((e.target as Element | null)?.closest?.('canvas')) e.stopPropagation();
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches.length === 1 ? e.touches[0] : undefined;
      start =
        t && t.clientX <= EDGE_ZONE ? { id: t.identifier, x: t.clientX, y: t.clientY } : undefined;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = Array.from(e.touches).find((x) => x.identifier === start!.id);
      if (!t || e.touches.length > 1) {
        start = undefined;
        return;
      }
      if (isSwipe(t.clientX - start.x, t.clientY - start.y, 1)) {
        start = undefined;
        setOpen(true);
      }
    };
    const onEnd = () => {
      start = undefined;
    };
    document.addEventListener('pointerdown', onPointerDown, { capture: true });
    document.addEventListener('touchstart', onStart, { capture: true, passive: true });
    document.addEventListener('touchmove', onMove, { capture: true, passive: true });
    document.addEventListener('touchend', onEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', onEnd, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      document.removeEventListener('touchstart', onStart, { capture: true });
      document.removeEventListener('touchmove', onMove, { capture: true });
      document.removeEventListener('touchend', onEnd, { capture: true });
      document.removeEventListener('touchcancel', onEnd, { capture: true });
    };
  }, [active, open, setOpen]);
}

/**
 * The sheet itself: a scrim over the page and the panel sliding in from the left, holding the
 * navigation. Always mounted on a phone (the navigation keeps its open rows and its scroll
 * position), hidden, `inert` and `aria-hidden` while closed.
 */
export function NavSheet({ control, children }: { control: NavSheetControl; children: ReactNode }) {
  const { open, setOpen } = control;
  const still = useMediaQuery(REDUCED_MOTION_QUERY);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);

  // Open: the rest of the page goes inert, the focus moves in (the selected row, else the first
  // row); closed again, the page comes back and the focus returns to the "Agents" button.
  useEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!open || !root || !panel) return;
    const opener = document.activeElement as HTMLElement | null;
    const first =
      panel.querySelector<HTMLElement>('nav [aria-current="page"]') ??
      panel.querySelector<HTMLElement>('nav a[href]') ??
      tabStops(panel)[0];
    first?.focus();
    // A row still `visibility: hidden` for an instant (a transition the stylesheet missed) drops
    // the focus: once more on the next frame.
    const retry =
      first && document.activeElement !== first && typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => first.focus())
        : undefined;
    const undo = inertOutside(root);
    return () => {
      if (retry !== undefined) cancelAnimationFrame(retry);
      undo();
      const button = document.getElementById(NAV_SHEET_BUTTON_ID);
      const target = button ?? (opener?.isConnected ? opener : null);
      // Only if the focus was in the sheet (or lost): a tap elsewhere keeps its own focus.
      const active = document.activeElement;
      if (!active || active === document.body || root.contains(active)) target?.focus();
    };
  }, [open]);

  // Escape closes, after anything inside that takes it first (a row's actions, a confirmation).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // The focus stays in the sheet: where `inert` is missing (old browsers, jsdom) a focus that
  // lands outside comes back.
  useEffect(() => {
    if (!open) return;
    const onFocusIn = (e: FocusEvent) => {
      const panel = panelRef.current;
      const target = e.target as Node | null;
      if (!panel || !target || panel.contains(target)) return;
      tabStops(panel)[0]?.focus();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [open]);

  // Any navigation (a row, the brand, back) closes the sheet.
  const route = useAppStore((s) => s.route);
  const selection = useAppStore((s) => s.selection);
  const location = `${route}|${JSON.stringify(selection)}`;
  const lastLocation = useRef(location);
  useEffect(() => {
    if (lastLocation.current === location) return;
    lastLocation.current = location;
    setOpen(false);
  }, [location, setOpen]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const stops = tabStops(e.currentTarget);
    if (stops.length === 0) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // A selection closes the sheet, even of the row already selected (no navigation then).
  const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest('a[href]');
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    close();
  };

  // A swipe to the left, on the sheet or the scrim, closes it.
  const swipe = useRef<{ id: number; x: number; y: number } | undefined>(undefined);
  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    const t = e.touches.length === 1 ? e.touches[0] : undefined;
    swipe.current = t ? { id: t.identifier, x: t.clientX, y: t.clientY } : undefined;
  };
  const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s) return;
    const t = Array.from(e.touches).find((x) => x.identifier === s.id);
    if (!t || e.touches.length > 1) {
      swipe.current = undefined;
      return;
    }
    if (isSwipe(t.clientX - s.x, t.clientY - s.y, -1)) {
      swipe.current = undefined;
      close();
    }
  };
  const onTouchEnd = () => {
    swipe.current = undefined;
  };

  const className = ['pnl-nav-sheet', open ? 'is-open' : 'is-closed', still && 'is-still']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      ref={rootRef}
      className={className}
      inert={!open}
      {...(open ? {} : { 'aria-hidden': true })}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className="pnl-nav-scrim" aria-hidden="true" onClick={close} />
      <div
        ref={panelRef}
        id={NAV_SHEET_ID}
        className="pnl-nav-sheet-panel"
        role="dialog"
        aria-modal={open ? 'true' : undefined}
        aria-label="Agents"
        onKeyDown={onKeyDown}
        onClick={onClick}
      >
        <div className="pnl-nav-sheet-head">
          <h2 className="pnl-eyebrow">Agents</h2>
          <button
            type="button"
            className="pnl-nav-sheet-close"
            aria-label="Close the agents list"
            title="Close"
            onClick={close}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
