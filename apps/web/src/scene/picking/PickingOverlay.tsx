import { useEffect, useLayoutEffect, useRef } from 'react';
import { useCameraStore } from '../camera/store.js';
import { SatelliteHoverCard } from './SatelliteHoverCard.js';
import {
  activateBody,
  activateSatellite,
  hoverAt,
  onHoverMove,
  usePickingStore,
  type Point,
  type Popover,
} from './store.js';
import './picking.css';

/**
 * Picking's DOM over the canvas (P3-05): one hover label (the name of the body under the pointer,
 * "+n" when others are there too) and the popover — a body's info (what it is, when a click
 * selects nothing) or the "what's here" list (corner case 24). One element each, whatever the
 * number of bodies. Escape (handled by the scene area), a click elsewhere in the scene or the
 * close button closes the popover; closing it, or choosing from the list, gives the keyboard focus
 * back to the scene area (as Escape does), not to the page.
 *
 * Over a satellite (P4-08) the hover label is its agent's card instead (`SatelliteHoverCard`), and
 * the "what's here" list names the satellites under the pointer (by their agent) before the
 * bodies; choosing one selects that agent.
 *
 * A body's info card opens at the click and, once the camera lands on that body, moves to the
 * scene's centre where the body now is (the same place `Enter` opens it).
 *
 * The overlay re-renders only when *what* is hovered changes: the label and the card follow the
 * hover's position (`onHoverMove`) by writing their own `transform`.
 */
export function PickingOverlay() {
  const hover = usePickingStore((s) => s.hover);
  const popover = usePickingStore((s) => s.popover);
  return (
    <>
      {hover?.kind === 'satellite' && !popover && (
        <SatelliteHoverCard
          agentId={hover.agentId}
          mode={hover.mode}
          bodyId={hover.satelliteBodyId}
          others={hover.others}
        />
      )}
      {hover && hover.kind !== 'satellite' && !popover && (
        <BodyHoverLabel name={hover.name} others={hover.others} />
      )}
      {popover && <PickPopover popover={popover} />}
    </>
  );
}

/** The body's name at the pointer, "+n" when others are there too; follows `hoverAt`. */
function BodyHoverLabel({ name, others }: { name: string; others: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = (at: Readonly<Point>) => {
      if (ref.current) ref.current.style.transform = `translate(${at.x + 14}px, ${at.y + 10}px)`;
    };
    place(hoverAt());
    return onHoverMove(place);
  }, []);
  return (
    <div ref={ref} className="pick-hover" role="tooltip">
      {name}
      {others > 0 && <span className="pick-hover-more"> +{others}</span>}
    </div>
  );
}

/** The scene area the popover sits in (the positioned parent of the overlay). */
function sceneArea(el: HTMLElement | null): HTMLElement | null {
  return el?.closest<HTMLElement>('.pnl-scene') ?? (el?.offsetParent as HTMLElement | null) ?? null;
}

export function PickPopover({ popover }: { popover: Popover }) {
  const ref = useRef<HTMLDivElement>(null);
  /** Runs `action` (which may unmount the popover), then puts the focus back on the scene area. */
  const thenFocusScene = (action: () => void) => {
    const area = sceneArea(ref.current);
    action();
    area?.focus({ preventScroll: true });
  };
  const close = () => thenFocusScene(() => usePickingStore.getState().closePopover());
  // An info card follows its body to the centre when the camera's flight there ends.
  useEffect(() => {
    if (popover.kind !== 'info') return;
    const bodyId = popover.action.bodyId;
    let wasFlying = useCameraStore.getState().flying;
    return useCameraStore.subscribe((camera) => {
      const landed = wasFlying && !camera.flying && camera.focusedId === bodyId;
      wasFlying = camera.flying;
      const area = sceneArea(ref.current);
      if (!landed || !area) return;
      if (usePickingStore.getState().popover !== popover) return;
      usePickingStore.setState({
        popover: { ...popover, x: area.clientWidth / 2, y: area.clientHeight / 2 },
      });
    });
  }, [popover]);
  // The list takes the focus so the keyboard can choose; the info leaves it on the scene.
  useEffect(() => {
    if (popover.kind === 'here')
      ref.current
        ?.querySelector<HTMLButtonElement>('.pick-list button')
        ?.focus({ preventScroll: true });
  }, [popover]);
  // Kept inside the scene area: flipped to the pointer's left / above it near the edges.
  useLayoutEffect(() => {
    const el = ref.current;
    const area = el?.offsetParent as HTMLElement | null | undefined;
    if (!el || !area) return;
    const gap = 8;
    const left = popover.x + gap + el.offsetWidth > area.clientWidth;
    const up = popover.y + gap + el.offsetHeight > area.clientHeight;
    el.style.left = `${Math.max(0, left ? popover.x - gap - el.offsetWidth : popover.x + gap)}px`;
    el.style.top = `${Math.max(0, up ? popover.y - gap - el.offsetHeight : popover.y + gap)}px`;
  }, [popover]);
  const at = { x: popover.x, y: popover.y };
  return (
    <div
      ref={ref}
      className="pick-popover"
      role="dialog"
      aria-label={popover.kind === 'here' ? "what's here" : popover.action.name}
      style={{ left: popover.x + 8, top: popover.y + 8 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" className="pick-close" aria-label="close" onClick={close}>
        ×
      </button>
      {popover.kind === 'info' ? (
        <>
          <strong className="pick-title">{popover.action.name}</strong>
          <p className="pick-detail">{popover.action.detail}</p>
        </>
      ) : (
        <>
          <strong className="pick-title">What's here</strong>
          <ul className="pick-list">
            {popover.satellites.map((s) => (
              <li key={`satellite:${s.agentId}`}>
                <button
                  type="button"
                  className="pick-list-satellite"
                  onClick={() => thenFocusScene(() => void activateSatellite(s.agentId))}
                >
                  {s.name}
                </button>
              </li>
            ))}
            {popover.bodies.map((b) => (
              <li key={b.bodyId}>
                <button
                  type="button"
                  onClick={() => thenFocusScene(() => void activateBody(b.bodyId, at))}
                >
                  {b.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
