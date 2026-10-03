import { useEffect, useRef, useState } from 'react';
import { useNotificationPrefs } from './prefs.js';
import { NotificationSettings } from './NotificationSettings.js';
import './notifications.css';

/**
 * The top bar's notifications control (P25-07): shows whether desktop notifications are on and
 * opens a small popover with the same settings the settings page mounts.
 */
export function NotificationsControl() {
  const [open, setOpen] = useState(false);
  const enabled = useNotificationPrefs((s) => s.enabled);
  const permission = useNotificationPrefs((s) => s.permission);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
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

  const state =
    permission === 'unsupported'
      ? 'unavailable'
      : permission === 'denied'
        ? 'blocked'
        : enabled && permission === 'granted'
          ? 'on'
          : 'off';

  return (
    <span className="ntf-control" ref={ref}>
      <button
        type="button"
        className="pnl-forget ntf-toggle"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        Notifications: {state}
      </button>
      {open && (
        <div className="ntf-popover" role="dialog" aria-label="notification settings">
          <NotificationSettings />
        </div>
      )}
    </span>
  );
}
