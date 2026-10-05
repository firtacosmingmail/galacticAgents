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
  return (
    <aside className="pwa-notices" aria-label="App notices">
      <div role="status">
        {update && (
          <div className="pwa-notice">
            <p>A new version of GalacticAgents is available.</p>
            <div className="pwa-actions">
              <button type="button" onClick={update}>
                Reload
              </button>
              <button type="button" className="pwa-secondary" onClick={dismissUpdate}>
                Later
              </button>
            </div>
          </div>
        )}
        {!update && install && (
          <div className="pwa-notice">
            <p>Install GalacticAgents on this device to open it from the Home Screen.</p>
            <div className="pwa-actions">
              <button type="button" onClick={() => void runInstall()}>
                Install
              </button>
              <button type="button" className="pwa-secondary" onClick={dismissInstall}>
                Not now
              </button>
            </div>
          </div>
        )}
        {!update && !install && iosHint && (
          <div className="pwa-notice">
            <p>
              To install GalacticAgents, tap <strong>Share</strong>, then{' '}
              <strong>Add to Home Screen</strong>.
            </p>
            <div className="pwa-actions">
              <button type="button" className="pwa-secondary" onClick={dismissInstall}>
                Got it
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
