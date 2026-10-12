import { useState } from 'react';
import type { SettingsResponse } from '@galactic/protocol';
import { IDENTITY_TOKEN } from '../../client/session.js';
import { QrCode } from './QrCode.js';
import { ACCESS_SECTION_ID } from '../phone/PhoneIndicator.js';
import { PhoneAccessSection } from '../phone/PhoneAccessSection.js';

type SettingsRemote = NonNullable<SettingsResponse['remote']>;

/**
 * The token as shown by default: its last four characters only — or nothing of it when it is
 * shorter than 12 characters (four would then give away too much of it).
 */
export function maskToken(token: string): string {
  return `${'•'.repeat(12)}${token.length < 12 ? '' : token.slice(-4)}`;
}

/**
 * The address a phone opens to connect (P7-02): the Tailscale Serve name over HTTPS, with the
 * token in the fragment — which the browser never sends to a server, so it reaches no log — for
 * the page to take and strip from the address bar (`takeTokenFromFragment`).
 */
export function phoneUrl(host: string, token: string): string {
  return `https://${host}/#token=${encodeURIComponent(token)}`;
}

/**
 * The access token (P25-08) and the phone's QR code (P7-02). The token is shown masked unless
 * revealed, copied only on a click, and never put in a log; the QR code, which carries it in the
 * phone address's fragment, is drawn only after its own reveal and only in this browser
 * (TECHNOLOGY §8, `docs/REMOTE_ACCESS.md`).
 */
export function AccessToken({ token, remote }: { token: string; remote?: SettingsRemote }) {
  const [revealed, setRevealed] = useState(false);
  const [qrShown, setQrShown] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'no'>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  };
  if (token === IDENTITY_TOKEN) {
    return (
      <section className="set-section" aria-label="Access" id={ACCESS_SECTION_ID}>
        <div className="set-head">
          <h2 className="set-title" tabIndex={-1}>
            Access
          </h2>
        </div>
        <p className="set-intro">
          This device is signed in by its Tailscale identity: Mission Control accepts it through
          Tailscale Serve, and no token is stored here. The token and the phone QR code are shown on
          the Mac itself.
        </p>
      </section>
    );
  }
  const host = remote?.host;
  return (
    <section className="set-section" aria-label="Access" id={ACCESS_SECTION_ID}>
      <div className="set-head">
        {/* Focusable by script only: the phone indicator moves focus here (revealAccessSection). */}
        <h2 className="set-title" tabIndex={-1}>
          Access
        </h2>
      </div>
      <p className="set-intro">
        This browser connects with the token <code>galactic start</code> printed. Anyone with it can
        drive your agents: keep it private.
      </p>
      <div className="set-field set-inline">
        <span>Token</span>
        {/* Named by the visible "Token" before it; a `<code>` takes no ARIA name. */}
        <code className="set-token">{revealed ? token : maskToken(token)}</code>
        <button type="button" className="set-secondary" onClick={() => setRevealed(!revealed)}>
          {revealed ? 'Hide' : 'Reveal'}
        </button>
        <button type="button" className="set-secondary" onClick={() => void copy()}>
          Copy
        </button>
        {copied === 'yes' && (
          <span className="set-muted" role="status">
            copied
          </span>
        )}
        {copied === 'no' && (
          <span className="set-error" role="status">
            the browser refused the clipboard
          </span>
        )}
      </div>
      {/* P9-16: whether the phone can reach Mission Control, and the Mac's switch. */}
      <PhoneAccessSection />
      {host ? (
        <div className="set-qr">
          <p className="set-muted">
            Connect your phone: with Tailscale on, scan this code to open{' '}
            <code>https://{host}</code> already signed in. The code carries the token — show it only
            where no one else can see or photograph it.
          </p>
          <button type="button" className="set-secondary" onClick={() => setQrShown(!qrShown)}>
            {qrShown ? 'Hide the phone QR code' : 'Show the phone QR code'}
          </button>
          {qrShown && (
            <QrCode
              text={phoneUrl(host, token)}
              label={`QR code: the address https://${host} with the token`}
            />
          )}
        </div>
      ) : (
        <p className="set-muted set-qr-note">
          Phone access is not set up: put this Mac&apos;s Tailscale name in <code>remoteHost</code>{' '}
          (<code>~/.galactic/config.json</code>) and restart — see{' '}
          <code>docs/REMOTE_ACCESS.md</code>. The phone QR code appears here then.
        </p>
      )}
      {remote?.tailscaleIdentity && (
        <p className="set-muted">
          Tailscale identity headers are accepted too: the listed Tailscale users connect through
          Tailscale Serve without the token.
        </p>
      )}
    </section>
  );
}
