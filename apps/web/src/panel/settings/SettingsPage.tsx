import { useEffect } from 'react';
import { useAppStore } from '../../state/store.js';
import { revealAccessSection } from '../phone/PhoneIndicator.js';
import { NavLink } from '../Navigation.js';
import { NotificationSettings } from '../notifications/NotificationSettings.js';
import { PushSettings } from '../../pwa/PushSettings.js';
import { AccessToken } from './AccessToken.js';
import { Backups } from './Backups.js';
import { DeviceQuality } from './DeviceQuality.js';
import { IDE } from './IdeSetting.js';
import { PreflightCheck } from './PreflightCheck.js';
import { useSettingsData } from './SettingsData.js';
import {
  LATER_SECTIONS,
  SaveButton,
  SECTIONS,
  SectionFrame,
  TRANSCRIPT_RETENTION,
  useSection,
  type AnySectionSpec,
} from './sections.js';
import './settings.css';

/**
 * The settings page (P25-08; SPEC §4.6, decision 51) at `/settings`: the runtime check, every
 * setting with its own Save, the notification toggles, and the access token. The first-run
 * wizard walks the same editors.
 */
export function SettingsPage({ token }: { token: string }) {
  const data = useSettingsData();
  const selection = useAppStore((s) => s.selection);
  // `/settings#access` (the desktop app's "Show the Phone QR Code", P9-16): Access in view.
  useEffect(() => {
    const go = () => {
      if (window.location.hash === '#access') revealAccessSection();
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, []);
  return (
    <main className="set-page" aria-label="settings">
      <div className="set-page-head">
        <h1 className="pnl-title">Settings</h1>
        <NavLink to={{ route: 'panel', selection }} className="pnl-back">
          ← Back to the panel
        </NavLink>
      </div>

      <PreflightCheck />

      {data.status === 'loading' && <p className="set-muted">Loading the settings…</p>}
      {data.status === 'unavailable' && (
        <p className="set-note" role="note">
          This Mission Control has no settings endpoint; update it to edit the settings here.
        </p>
      )}
      {data.status === 'error' && (
        <p className="set-error" role="alert">
          Could not read the settings: {data.error}{' '}
          <button type="button" className="set-secondary" onClick={data.reload}>
            Try again
          </button>
        </p>
      )}
      {data.status === 'ready' &&
        SECTIONS.map((spec) => <PageSection key={spec.field} spec={spec} />)}
      {/* P8-02: only a server that has the setting sends it. */}
      {data.status === 'ready' && data.response?.settings.transcriptRetention && (
        <PageSection spec={TRANSCRIPT_RETENTION} />
      )}
      {data.status === 'ready' &&
        LATER_SECTIONS.map((spec) => <PageSection key={spec.field} spec={spec} />)}
      {/* P9-03: the IDE Open in IDE uses; only a server that has the setting sends it. */}
      {data.status === 'ready' && data.response?.settings.deliverables && (
        <PageSection spec={IDE} />
      )}

      {/* P7-03: this browser's own tier, local — shown even without a settings endpoint. */}
      <DeviceQuality />

      <section className="set-section" aria-label="Notifications">
        <div className="set-head">
          <h2 className="set-title">Notifications</h2>
        </div>
        {/* P25-07's per-browser toggles. Not in the first-run wizard: the browser's permission
            prompt needs a click, and the toggles are this browser's, not the server's. */}
        <NotificationSettings heading={false} />
      </section>

      {/* P7-04: this device's push subscription and its switches (stored with it, server side). */}
      <section className="set-section" aria-label="Push notifications">
        <div className="set-head">
          <h2 className="set-title">Push notifications</h2>
        </div>
        <PushSettings token={token} />
      </section>

      {/* P8-03: the backup files, "Back up now" and the map export (Mac only). */}
      <Backups token={token} />

      <AccessToken
        token={token}
        {...(data.response?.remote ? { remote: data.response.remote } : {})}
      />
    </main>
  );
}

function PageSection({ spec }: { spec: AnySectionSpec }) {
  const state = useSection(spec);
  return <SectionFrame state={state} footer={<SaveButton state={state} />} />;
}
