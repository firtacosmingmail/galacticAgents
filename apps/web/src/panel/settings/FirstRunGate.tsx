import { useState, type ReactNode } from 'react';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER } from '../../state/selection.js';
import { FirstRunWizard } from './FirstRunWizard.js';
import { useSettingsData } from './SettingsData.js';

/**
 * Shows the first-run wizard instead of the panel (P25-08) when — and only when — the server
 * says the setup was never done (`setupCompletedAt` absent) and this client may finish it.
 *
 * - While the settings load, the gated area stays empty (no flash of the panel before the
 *   wizard).
 * - When the server cannot say (no settings endpoint, a failed read), the panel shows: the wizard
 *   is an offer the server makes, never a wall in front of a working panel.
 * - A client that may not stamp the marker (`writable: 'limited'`: remote, or of unknown origin,
 *   decision 51) gets the panel with a dismissible note to finish the setup on the computer
 *   running Mission Control, rather than a wizard it could never close.
 */
export function FirstRunGate({ children }: { children: ReactNode }) {
  const data = useSettingsData();
  const navigate = useAppStore((s) => s.navigate);
  // Set when the setup is finished, or when the user goes on although the marker could not be
  // saved (a refusal shown in the wizard): this page life then shows the panel.
  const [passed, setPassed] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState(false);
  if (data.status === 'loading') return null;
  const notDone = data.status === 'ready' && !data.response?.setupCompletedAt && !passed;
  // Absent (an older server): treated as 'all', as before the field existed.
  const limited = data.response?.writable === 'limited';
  if (notDone && !limited) {
    return (
      <FirstRunWizard
        onDone={() => {
          setPassed(true);
          navigate({ route: 'panel', selection: HARMONIZER });
        }}
      />
    );
  }
  return (
    <>
      {notDone && limited && !noteDismissed && (
        <div className="set-gate-note" role="note" aria-label="setup not finished">
          <span>Setup is not finished — finish it on the computer running Mission Control.</span>
          <button type="button" className="set-secondary" onClick={() => setNoteDismissed(true)}>
            Dismiss
          </button>
        </div>
      )}
      {children}
    </>
  );
}
