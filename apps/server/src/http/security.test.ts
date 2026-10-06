import { describe, expect, it } from 'vitest';
import {
  hostnameOf,
  isAllowedHost,
  isAllowedOrigin,
  isLoopback,
  isLoopbackOrigin,
  isAuthorized,
  isRemoteRequest,
  tailscaleIdentityOf,
  tokenMatches,
} from './security.js';

const allowed = ['localhost', '127.0.0.1', '[::1]', '*.ts.net'];

describe('security helpers', () => {
  it('extracts host names', () => {
    expect(hostnameOf('localhost:4321')).toBe('localhost');
    expect(hostnameOf('[::1]:4321')).toBe('[::1]');
    expect(hostnameOf('MyMac.tail.ts.net')).toBe('mymac.tail.ts.net');
    expect(hostnameOf(undefined)).toBeUndefined();
  });

  it('checks the Host allow-list with wildcards', () => {
    expect(isAllowedHost('localhost:4321', allowed)).toBe(true);
    expect(isAllowedHost('127.0.0.1', allowed)).toBe(true);
    expect(isAllowedHost('mymac.tail1234.ts.net', allowed)).toBe(true);
    expect(isAllowedHost('evil.example.com', allowed)).toBe(false);
    expect(isAllowedHost('ts.net', allowed)).toBe(false);
    expect(isAllowedHost(undefined, allowed)).toBe(false);
  });

  it('checks Origin: absent is fine, foreign is not', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', allowed)).toBe(true);
    expect(isAllowedOrigin('https://mymac.tail1234.ts.net', allowed)).toBe(true);
    expect(isAllowedOrigin('http://evil.example.com', allowed)).toBe(false);
    expect(isAllowedOrigin('null', allowed)).toBe(false);
    expect(isAllowedOrigin('file:///tmp/x.html', allowed)).toBe(false);
    expect(isAllowedOrigin('not a url', allowed)).toBe(false);
  });

  it('recognises loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('100.64.0.1')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });

  it('recognises a loopback Origin, never an allowed remote one (P0-16)', () => {
    expect(isLoopbackOrigin(undefined)).toBe(true);
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:4321')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:4321')).toBe(true);
    expect(isLoopbackOrigin('https://mymac.tail1234.ts.net')).toBe(false);
    expect(isLoopbackOrigin('null')).toBe(false);
    expect(isLoopbackOrigin('file:///x')).toBe(false);
  });

  it('compares tokens', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });

  it('tells a remote client from the local page (P2-04)', () => {
    const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) => ({
      socket: { remoteAddress },
      headers,
    });
    expect(isRemoteRequest(req('127.0.0.1'))).toBe(false);
    expect(isRemoteRequest(req('::1', { origin: 'http://localhost:5173' }))).toBe(false);
    // Tailscale Serve connects from loopback but carries the remote page's Origin or identity.
    expect(isRemoteRequest(req('127.0.0.1', { origin: 'https://mymac.tail1234.ts.net' }))).toBe(
      true,
    );
    expect(isRemoteRequest(req('127.0.0.1', { 'tailscale-user-login': 'me@example.com' }))).toBe(
      true,
    );
    expect(isRemoteRequest(req('100.101.102.103'))).toBe(true);
    expect(isRemoteRequest(req(undefined))).toBe(true); // A loopback proxy without Origin or identity still says where the request came from
    // (wave-3 review): forwarding headers or a non-loopback Host make it remote.
    expect(isRemoteRequest(req('127.0.0.1', { 'x-forwarded-for': '100.64.1.2' }))).toBe(true);
    expect(isRemoteRequest(req('127.0.0.1', { forwarded: 'for=100.64.1.2' }))).toBe(true);
    expect(isRemoteRequest(req('127.0.0.1', { host: 'mymac.tail1234.ts.net' }))).toBe(true);
    expect(isRemoteRequest(req('127.0.0.1', { host: '127.0.0.1:7777' }))).toBe(false);
    expect(isRemoteRequest(req('::1', { host: '[::1]:7777' }))).toBe(false);
    expect(isRemoteRequest(req('127.0.0.1', { host: 'localhost:7777' }))).toBe(false);
  });

  it('counts any proxy header family as remote (P7-02)', () => {
    const req = (headers: Record<string, string>) => ({
      socket: { remoteAddress: '127.0.0.1' },
      headers,
    });
    for (const h of ['tailscale-app-capabilities', 'tailscale-headers-info', 'x-forwarded-port']) {
      expect(isRemoteRequest(req({ [h]: 'x' })), h).toBe(true);
    }
    expect(isRemoteRequest(req({ via: '1.1 tailscale' }))).toBe(true);
    expect(isRemoteRequest(req({ 'x-real-ip': '100.64.1.2' }))).toBe(true);
    expect(isRemoteRequest(req({ host: 'localhost:4321', 'user-agent': 'x' }))).toBe(false);
  });
});

describe('Tailscale identity (P7-02)', () => {
  const HOST = 'mymac.tail1234.ts.net';
  const config = {
    token: 'tok-0123456789abcdef',
    remoteHost: HOST,
    tailscaleIdentityLogins: ['me@example.com'],
  };
  const req = (
    headers: Record<string, string | string[] | undefined>,
    remoteAddress: string | undefined = '127.0.0.1',
  ) => ({ socket: { remoteAddress }, headers });
  const serve = { host: HOST, 'tailscale-user-login': 'me@example.com' };

  it('accepts a listed login forwarded by Serve under the Serve name', () => {
    expect(tailscaleIdentityOf(req(serve), config)).toBe('me@example.com');
    expect(tailscaleIdentityOf(req({ ...serve, host: `${HOST}:8443` }), config)).toBe(
      'me@example.com',
    );
    expect(tailscaleIdentityOf(req({ ...serve, origin: `https://${HOST}` }), config)).toBe(
      'me@example.com',
    );
    expect(tailscaleIdentityOf(req(serve, '::ffff:127.0.0.1'), config)).toBe('me@example.com');
  });

  it('is off without the opt-in or without remoteHost', () => {
    expect(tailscaleIdentityOf(req(serve), { token: config.token })).toBeUndefined();
    expect(
      tailscaleIdentityOf(req(serve), { token: config.token, remoteHost: HOST }),
    ).toBeUndefined();
    expect(
      tailscaleIdentityOf(req(serve), { ...config, tailscaleIdentityLogins: [] }),
    ).toBeUndefined();
    expect(
      tailscaleIdentityOf(req(serve), {
        token: config.token,
        tailscaleIdentityLogins: ['me@example.com'],
      }),
    ).toBeUndefined();
  });

  it('refuses anything that does not look exactly like Serve', () => {
    const refused: [Record<string, string | string[] | undefined>, string?][] = [
      [{ ...serve, 'tailscale-user-login': 'other@example.com' }],
      [{ ...serve, host: 'localhost' }],
      [{ ...serve, host: 'other.tail1234.ts.net' }],
      [{ ...serve, host: undefined }],
      [{ ...serve, origin: 'https://evil.example.com' }],
      [{ ...serve, origin: `http://${HOST}` }],
      [{ ...serve, origin: 'null' }],
      [{ ...serve, origin: [`https://${HOST}`, `https://${HOST}`] }],
      [{ ...serve, 'tailscale-user-login': ['me@example.com', 'me@example.com'] }],
      [{ ...serve, 'tailscale-user-login': 'me@example.com, other@example.com' }],
      [{ host: HOST }],
      [{ ...serve, 'tailscale-funnel-request': '?1' }],
      [serve, '100.101.102.103'],
      [serve, ''],
    ];
    for (const [headers, address] of refused) {
      expect(
        tailscaleIdentityOf(req(headers, address), config),
        JSON.stringify([headers, address]),
      ).toBeUndefined();
    }
  });

  it('authorizes by token or accepted identity', () => {
    expect(isAuthorized(req({ authorization: 'Bearer tok-0123456789abcdef' }), config)).toBe(true);
    expect(isAuthorized(req({ authorization: 'Bearer wrong' }), config)).toBe(false);
    expect(isAuthorized(req({ authorization: 'tok-0123456789abcdef' }), config)).toBe(false);
    expect(isAuthorized(req(serve), config)).toBe(true);
    expect(isAuthorized(req(serve), { token: config.token })).toBe(false);
  });
});
