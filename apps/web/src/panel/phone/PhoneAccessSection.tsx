import { useState } from 'react';
import { REMOTE_REASON_SHORT, RemoteActionResponse, type RemoteStatus } from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import { isLoopbackHostname } from '../../scene/device.js';
import { desktopShell } from '../../desktop-shell.js';
import { phoneIndicator, publishPhoneStatus, usePhoneStatus } from './use-phone-status.js';

/** The page runs on the Mac itself (its own browser or the desktop app), not on the phone. */
export function onTheMac(): boolean {
  return isLoopbackHostname(globalThis.location?.hostname) || desktopShell() !== undefined;
}

/** What to do about each reason, in a sentence (the server's message says it in full). */
const NEXT_STEP: Partial<Record<NonNullable<RemoteStatus['reason']>, string>> = {
  not_installed: 'Install Tailscale on the Mac and on the phone, and sign both in.',
  not_running: 'Open the Tailscale app on the Mac and connect.',
  needs_login: 'Open the Tailscale app on the Mac and sign in.',
  no_magicdns:
    'In the Tailscale admin console (DNS page), turn on MagicDNS and HTTPS certificates.',
  restart_needed: 'Restart Mission Control (or quit and reopen the desktop app) to finish.',
};

/**
 * Settings → Access, "Phone access" (P9-16; SPEC decision 137): whether the phone can reach
 * Mission Control through Tailscale Serve, its address, how many phones are connected, and — on
 * the Mac only — "Turn on phone access" / "Turn off phone access". The phone sees the status
 * only (the server refuses a remote start or stop whatever `autoApproveRemote` says). When off,
 * the reason and what to do. Updated every 10 s while the page is visible.
 */
export function PhoneAccessSection() {
  const phone = usePhoneStatus();
  const [busy, setBusy] = useState<'start' | 'stop'>();
  const [note, setNote] = useState<{ text: string; error: boolean }>();
  if (!phone || phone.unavailable) return null;
  const { status, api } = phone;
  const mac = onTheMac();

  const act = async (action: 'start' | 'stop') => {
    setBusy(action);
    setNote(undefined);
    try {
      const res = action === 'start' ? await api.remoteStart() : await api.remoteStop();
      publishPhoneStatus(api, res.status);
      if (res.message) setNote({ text: res.message, error: false });
    } catch (error) {
      const parsed =
        error instanceof ApiError ? RemoteActionResponse.safeParse(error.body) : undefined;
      if (parsed?.success) publishPhoneStatus(api, parsed.data.status);
      setNote({
        text:
          (parsed?.success ? parsed.data.message : undefined) ??
          (error as Error).message ??
          'The request failed.',
        error: true,
      });
    } finally {
      setBusy(undefined);
    }
  };

  const view = status ? phoneIndicator(status) : undefined;
  const reason = status?.reason;
  const canTurnOff = !!status && status.serve === 'forwarding_to_us' && status.serveOwned;
  const canTurnOn =
    !!status &&
    !status.ready &&
    status.tailscale === 'running' &&
    !!status.name &&
    (status.serve === 'absent' ||
      (status.serve === 'forwarding_to_us' && status.remoteHost.state === 'missing'));

  return (
    <div className="set-phone" aria-label="Phone access" role="group">
      <h3 className="set-subtitle">Phone access</h3>
      {!status && !phone.error && <p className="set-muted">Checking phone access…</p>}
      {phone.error && !status && (
        <p className="set-error" role="alert">
          Could not read phone access: {phone.error}
        </p>
      )}
      {status && view && (
        <>
          <p className={`set-phone-state set-phone-${view.kind}`} role="status">
            <span className="pnl-phone-dot" aria-hidden="true" />{' '}
            {view.kind === 'online'
              ? 'On: the phone can reach Mission Control'
              : view.kind === 'restart'
                ? 'Almost on: restart needed'
                : `Off — ${REMOTE_REASON_SHORT[reason ?? 'error']}`}
          </p>
          {status.url && (
            <p className="set-muted">
              Address: <code>{status.url}</code>
              {status.ready && (
                <>
                  {' '}
                  ·{' '}
                  {status.remoteClients.connected === 1
                    ? '1 phone connected'
                    : `${status.remoteClients.connected} phones connected`}
                </>
              )}
            </p>
          )}
          {!status.ready && status.message && <p className="set-note">{status.message}</p>}
          {!status.ready && reason && NEXT_STEP[reason] && (
            <p className="set-muted">{NEXT_STEP[reason]}</p>
          )}
          {mac ? (
            <div className="set-inline">
              {canTurnOn && (
                <button type="button" disabled={!!busy} onClick={() => void act('start')}>
                  {busy === 'start' ? 'Turning on…' : 'Turn on phone access'}
                </button>
              )}
              {canTurnOff && (
                <button
                  type="button"
                  className="set-secondary"
                  disabled={!!busy}
                  onClick={() => void act('stop')}
                >
                  {busy === 'stop' ? 'Turning off…' : 'Turn off phone access'}
                </button>
              )}
              {status.serve === 'forwarding_to_us' && !status.serveOwned && (
                <span className="set-muted">
                  Tailscale Serve was set up outside GalacticAgents; turn it off with{' '}
                  <code>tailscale serve --https=443 off</code>.
                </span>
              )}
            </div>
          ) : (
            <p className="set-muted">Phone access is turned on and off on the Mac.</p>
          )}
          {note && (
            <p className={note.error ? 'set-error' : 'set-muted'} role="status">
              {note.text}
            </p>
          )}
        </>
      )}
    </div>
  );
}
