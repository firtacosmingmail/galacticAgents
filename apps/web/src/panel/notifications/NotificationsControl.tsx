import { useEffect, useId, useRef, useState } from 'react';
import { useNotificationPrefs } from './prefs.js';
import { shellPostsNotifications } from '../../desktop-shell.js';
import { NotificationSettings } from './NotificationSettings.js';
import './notifications.css';

/**
 * The state the top bar shows: "on", "off", "blocked", "unavailable", or "by the app" inside the
 * desktop shell (P8-06), which posts them itself.
 */
export function useNotificationState(): 'on' | 'off' | 'blocked' | 'unavailable' | 'by the app' {
  const enabled = useNotificationPrefs((s) => s.enabled);
  const permission = useNotificationPrefs((s) => s.permission);
  if (shellPostsNotifications()) return 'by the app';
  return permission === 'unsupported'
    ? 'unavailable'
    : permission === 'denied'
      ? 'blocked'
      : enabled && permission === 'granted'
        ? 'on'
        : 'off';
}

/**
 * The top bar's notifications control (P25-07): shows whether desktop notifications are on and
 * opens a small popover with the same settings the settings page mounts.
 */
export function NotificationsControl() {
  const [open, setOpen] = useState(false);
  const state = useNotificationState();
  const ref = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  // P5-04: opening moves the focus into the popover; Escape closes it and gives the focus back to
  // the button (a click outside leaves the focus where the user put it).
  useEffect(() => {
    if (!open) return;
    const popover = ref.current?.querySelector<HTMLElement>('.ntf-popover');
    if (!popover) return;
    // Its first control that can take the focus (one in a disabled fieldset cannot), else itself.
    const controls = popover.querySelectorAll<HTMLElement>('button, input, select');
    for (const el of [...controls, popover]) {
      el.focus();
      if (document.activeElement === el) return;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inside = ref.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (inside) toggle.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <span className="ntf-control" ref={ref}>
      <button
        ref={toggle}
        type="button"
        className="pnl-forget ntf-toggle"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        Notifications: {state}
      </button>
      {open && (
        <div
          className="ntf-popover"
          role="dialog"
          aria-label="notification settings"
          tabIndex={-1}
          data-escape-layer=""
        >
          <NotificationSettings />
        </div>
      )}
    </span>
  );
}

/**
 * The same control inside the compact top bar's menu (P3-12): a disclosure that unfolds the
 * settings in place instead of a popover, which has no room to float on a phone.
 */
export function NotificationsDisclosure() {
  const [open, setOpen] = useState(false);
  const state = useNotificationState();
  const id = useId();
  return (
    <div className="ntf-disclosure">
      <button
        type="button"
        className="ntf-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        Notifications: {state}
      </button>
      <div id={id} className="ntf-inline" hidden={!open}>
        {open && <NotificationSettings heading={false} />}
      </div>
    </div>
  );
}
