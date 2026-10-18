import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { PHONE_VIEW_ID, type FullPhoneView } from './phone-view.js';

const TITLES: Record<FullPhoneView, { title: string; close: string; button: string }> = {
  inbox: { title: 'Inbox', close: 'Close the inbox', button: '.pnl-phone-inbox' },
  agents: { title: 'Managed agents', close: 'Close managed agents', button: '.pnl-phone-agents' },
};

/**
 * A full-screen view on a phone (P8-18, SPEC decision 140): the inbox or the managed agents over
 * the chat, under the top bar. The chat stays mounted beneath it (`inert`), so its scroll position
 * and the composer's draft survive. Opening moves the focus to the title; ✕, Escape or Back close
 * it, and the focus goes back to the top bar's button when it was in here.
 */
export function PhoneFullView({
  view,
  onClose,
  children,
}: {
  view: FullPhoneView;
  onClose: () => void;
  children: ReactNode;
}) {
  const { title, close, button } = TITLES[view];
  const ref = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    titleRef.current?.focus();
  }, [view]);
  useLayoutEffect(() => {
    const root = ref.current;
    return () => {
      // Before the view leaves the page: a focus inside it would fall to the body.
      const active = document.activeElement;
      if (root && (root.contains(active) || active === document.body || active === null)) {
        document.querySelector<HTMLElement>(button)?.focus();
      }
    };
  }, [button]);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    onClose();
  };
  return (
    <section
      ref={ref}
      id={PHONE_VIEW_ID}
      // Modal in effect: the chat under it is inert until it closes.
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={`pnl-phone-view pnl-phone-view-${view}`}
      onKeyDown={onKeyDown}
    >
      <div className="pnl-phone-view-head">
        <h2 className="pnl-phone-view-title" id={titleId} tabIndex={-1} ref={titleRef}>
          {title}
        </h2>
        <button
          type="button"
          className="pnl-phone-view-close"
          aria-label={close}
          title={close}
          onClick={onClose}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <div className="pnl-phone-view-body">{children}</div>
    </section>
  );
}
