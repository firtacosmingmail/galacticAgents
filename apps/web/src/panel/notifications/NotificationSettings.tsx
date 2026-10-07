import { useEffect, useState } from 'react';
import { KIND_LABELS, useNotificationPrefs } from './prefs.js';
import { showNotification } from './notifier.js';
import { shellPostsNotifications } from '../../desktop-shell.js';
import './notifications.css';

/**
 * Desktop notification settings (P25-07): the opt-in, the browser's answer, and one switch per
 * kind. Self-contained (its state is the browser's own, in `localStorage`), so the settings page
 * (P25-08) and the top bar's popover mount the same component. The permission prompt is opened
 * only by the "Enable" button's click, never on load.
 */
export function NotificationSettings({ heading = true }: { heading?: boolean }) {
  const enabled = useNotificationPrefs((s) => s.enabled);
  const permission = useNotificationPrefs((s) => s.permission);
  const kinds = useNotificationPrefs((s) => s.kinds);
  const enable = useNotificationPrefs((s) => s.enable);
  const disable = useNotificationPrefs((s) => s.disable);
  const setKind = useNotificationPrefs((s) => s.setKind);
  const refreshPermission = useNotificationPrefs((s) => s.refreshPermission);
  const [asking, setAsking] = useState(false);

  // The user may have changed the site permission in the browser since the page loaded.
  useEffect(() => refreshPermission(), [refreshPermission]);

  const on = enabled && permission === 'granted';

  if (shellPostsNotifications()) {
    // Inside the desktop shell (P8-06): the menu bar app posts them, never the page.
    return (
      <section className="ntf-settings" aria-label="desktop notifications">
        {heading && <h3 className="ntf-heading">Desktop notifications</h3>}
        <p className="ntf-status">
          The GalacticAgents app posts these notifications: permission requests, questions for you,
          and finished or failed projects. Turn them off in the system’s notification settings.
        </p>
      </section>
    );
  }

  let status;
  if (permission === 'unsupported') {
    status = <p className="ntf-status">This browser cannot show desktop notifications.</p>;
  } else if (permission === 'denied') {
    status = (
      <p className="ntf-status ntf-status-blocked">
        Notifications are blocked for this site. Allow them in the browser’s site settings, then
        reload the page.
      </p>
    );
  } else if (on) {
    status = (
      <p className="ntf-status">
        On in this browser.{' '}
        <button type="button" className="secondary ntf-button" onClick={disable}>
          Turn off
        </button>{' '}
        <button
          type="button"
          className="secondary ntf-button"
          onClick={() =>
            showNotification({
              id: 'galactic:test',
              title: 'GalacticAgents',
              body: 'Desktop notifications work.',
            })
          }
        >
          Send a test
        </button>
      </p>
    );
  } else {
    status = (
      <p className="ntf-status">
        <button
          type="button"
          className="ntf-button"
          disabled={asking}
          onClick={() => {
            setAsking(true);
            void enable().finally(() => setAsking(false));
          }}
        >
          Enable desktop notifications
        </button>
      </p>
    );
  }

  return (
    <section className="ntf-settings" aria-label="desktop notifications">
      {heading && <h3 className="ntf-heading">Desktop notifications</h3>}
      {status}
      <fieldset className="ntf-kinds" disabled={permission === 'unsupported'}>
        <legend>Notify me when</legend>
        {KIND_LABELS.map(({ kind, label }) => (
          <label key={kind} className="ntf-kind">
            <input
              type="checkbox"
              name={kind}
              checked={kinds[kind]}
              onChange={(e) => setKind(kind, e.target.checked)}
            />{' '}
            {label}
          </label>
        ))}
      </fieldset>
      <p className="ntf-note">Kept in this browser only: each device chooses its own.</p>
    </section>
  );
}
