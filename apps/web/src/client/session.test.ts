import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverToken,
  IDENTITY_TOKEN,
  saveToken,
  takeTokenFromFragment,
  TOKEN_KEY,
} from './session.js';
import { phoneUrl } from '../panel/settings/AccessToken.js';
import { qrModules } from '../panel/settings/QrCode.js';

/** The token hand-over of P7-02: QR fragment, Tailscale identity, never a query string. */
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('takeTokenFromFragment', () => {
  it('saves the token and removes it from the address, keeping the rest of the URL', () => {
    window.history.replaceState(null, '', '/settings?tab=a#token=abc%2B123&other=1');
    expect(takeTokenFromFragment()).toBe('abc+123');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('abc+123');
    expect(window.location.pathname).toBe('/settings');
    expect(window.location.search).toBe('?tab=a');
    expect(window.location.hash).toBe('#other=1');
    expect(window.location.href).not.toContain('abc');
  });

  it('does nothing without the key, and strips an empty one', () => {
    window.history.replaceState(null, '', '/#other=1');
    expect(takeTokenFromFragment()).toBeUndefined();
    expect(window.location.hash).toBe('#other=1');
    window.history.replaceState(null, '', '/#token=');
    expect(takeTokenFromFragment()).toBeUndefined();
    expect(window.location.hash).toBe('');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('pairs with the QR code: the phone address carries the token in the fragment only', () => {
    const url = new URL(phoneUrl('mymac.tail1234.ts.net', 'a/b+c=d'));
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('mymac.tail1234.ts.net');
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/');
    window.history.replaceState(null, '', `/${url.hash}`);
    expect(takeTokenFromFragment()).toBe('a/b+c=d');
    const { size, path } = qrModules(url.href);
    expect(size).toBeGreaterThanOrEqual(21);
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('discoverToken with a Tailscale identity', () => {
  const health = (body: object) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );

  it('stands in for the token when the server accepts the identity, and never stores it', async () => {
    health({ ok: true, origin: 'remote', identity: 'me@example.com' });
    expect(await discoverToken()).toBe(IDENTITY_TOKEN);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    saveToken(IDENTITY_TOKEN);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('finds nothing on a remote device without a token or an identity', async () => {
    health({ ok: true, origin: 'remote' });
    expect(await discoverToken()).toBeUndefined();
  });
});
