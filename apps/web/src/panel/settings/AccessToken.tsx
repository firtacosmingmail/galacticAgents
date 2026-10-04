import { useState } from 'react';

/**
 * The token as shown by default: its last four characters only — or nothing of it when it is
 * shorter than 12 characters (four would then give away too much of it).
 */
export function maskToken(token: string): string {
  return `${'•'.repeat(12)}${token.length < 12 ? '' : token.slice(-4)}`;
}

/**
 * The access token (P25-08) and the place where Phase 7 puts the phone's QR code. The token is
 * shown masked unless revealed, copied only on a click, and never put in a URL or a log; the QR
 * code is a placeholder until remote access exists (TECHNOLOGY §8).
 */
export function AccessToken({ token }: { token: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'no'>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  };
  return (
    <section className="set-section" aria-label="Access">
      <div className="set-head">
        <h2 className="set-title">Access</h2>
      </div>
      <p className="set-intro">
        This browser connects with the token <code>galactic start</code> printed. Anyone with it can
        drive your agents: keep it private.
      </p>
      <div className="set-field set-inline">
        <span>Token</span>
        {/* Named by the visible "Token" before it; a `<code>` takes no ARIA name. */}
        <code className="set-token">
          {revealed ? token : maskToken(token)}
        </code>
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
      <div className="set-qr" role="img" aria-label="QR code placeholder">
        <span>QR</span>
        <p className="set-muted">
          Connect your phone (coming with remote access): a QR code here will carry this address and
          the token, so you will not have to type them.
        </p>
      </div>
    </section>
  );
}
