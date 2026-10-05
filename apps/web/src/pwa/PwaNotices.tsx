import type { ReactNode } from 'react';
import { usePwa } from './register.js';
import './pwa.css';

/**
 * The installable app's notices (P7-01): "a new version is available — reload" after a deploy,
 * and, on phones and tablets, the offer to install the app (the browser's prompt, or on iOS how
 * to add it to the Home Screen). They sit above the page at the bottom of the screen, never take
 * the focus, and are announced politely (decision 81); each has its own way to be dismissed.
 */
export function PwaNotices() {
  const update = usePwa((s) => s.update);
  const install = usePwa((s) => s.install);
  const iosHint = usePwa((s) => s.iosHint);
  const { dismissUpdate, dismissInstall, runInstall } = usePwa.getState();
  // One notice at a time, the update first. Only the message is the live region (P7-01 review):
  // it stays in the page, empty, so a screen reader announces the text once, without the buttons.
  let message: ReactNode = null;
  let actions: ReactNode = null;
  if (update) {
    message = 'A new version of GalacticAgents is available.';
    actions = (
      <>
        <button type="button" onClick={update}>
          Reload
        </button>
        <button type="button" className="pwa-secondary" onClick={dismissUpdate}>
          Later
        </button>
      </>
    );
  } else if (install) {
    message = 'Install GalacticAgents on this device to open it from the Home Screen.';
    actions = (
      <>
        <button type="button" onClick={() => void runInstall()}>
          Install
        </button>
        <button type="button" className="pwa-secondary" onClick={dismissInstall}>
          Not now
        </button>
      </>
    );
  } else if (iosHint) {
    message = (
      <>
        To install GalacticAgents, tap <strong>Share</strong>, then{' '}
        <strong>Add to Home Screen</strong>.
      </>
    );
    actions = (
      <button type="button" className="pwa-secondary" onClick={dismissInstall}>
        Got it
      </button>
    );
  }
  return (
    <aside className="pwa-notices" aria-label="App notices">
      <div className={message ? 'pwa-notice' : 'pwa-notice-empty'}>
        <p role="status">{message}</p>
        {actions && <div className="pwa-actions">{actions}</div>}
      </div>
    </aside>
  );
}
