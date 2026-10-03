import { useState, type ReactNode } from 'react';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER } from '../../state/selection.js';
import { FirstRunWizard } from './FirstRunWizard.js';
import { useSettingsData } from './SettingsData.js';

/**
 * Shows the first-run wizard instead of the panel (P25-08) when — and only when — the server
 * says the setup was never done (`setupCompletedAt` absent). While the settings load, or when the
 * server cannot say (no settings endpoint, a failed read), the panel shows: the wizard is an
 * offer the server makes, never a wall in front of a working panel.
 */
export function FirstRunGate({ children }: { children: ReactNode }) {
  const data = useSettingsData();
  const navigate = useAppStore((s) => s.navigate);
  // Set when the setup is finished, or when the user goes on although the marker could not be
  // saved (a refusal shown in the wizard): this page life then shows the panel.
  const [passed, setPassed] = useState(false);
  const firstRun = data.status === 'ready' && !data.response?.setupCompletedAt && !passed;
  if (!firstRun) return <>{children}</>;
  return (
    <FirstRunWizard
      onDone={() => {
        setPassed(true);
        navigate({ route: 'panel', selection: HARMONIZER });
      }}
    />
  );
}
