import { isIP } from 'node:net';
import type { RequestOrigin } from '@galactic/protocol';

/** `host:port` → `host` (IPv6 literals keep their brackets, matching the allow-list format). */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? undefined : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

function matches(hostname: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".ts.net"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === p;
}

/** DNS-rebinding guard: the `Host` header must name one of the allowed hosts. */
export function isAllowedHost(
  hostHeader: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  return allowedHosts.some((p) => matches(hostname, p));
}

/**
 * Cross-origin guard for WebSocket upgrades. A missing `Origin` means a non-browser client
 * (CLI, tests) which the bearer token alone protects; a present one must be an allowed host.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  if (origin === undefined) return true;
  if (origin === 'null' || origin === '') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isAllowedHost(url.host, allowedHosts);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether an `Origin`, if present, names this machine itself. Used for handing the token to the
 * local page: a reverse proxy (Tailscale Serve, Phase 7) connects from loopback too, but carries
 * the remote page's `Origin`, which is an allowed host and still must not get the token.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const hostname = hostnameOf(url.host);
  return hostname !== undefined && LOOPBACK_HOSTS.has(hostname);
}

/** True for connections coming from the same machine. */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const a = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
  if (isIP(a) === 4) return a.startsWith('127.');
  return a === '::1';
}

/**
 * Whether a request comes from a remote client (P2-04; TECHNOLOGY §8): anything but a loopback
 * connection whose `Origin`, if any, is this machine and that carries no Tailscale identity. A
 * reverse proxy (Tailscale Serve, Phase 7) connects from loopback, so its `Origin` or identity
 * headers are what give it away. Fails towards "remote": the stricter rules then apply.
 */
export function isRemoteRequest(req: {
  socket: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const origin = req.headers['origin'];
  if (Array.isArray(origin)) return true;
  if (req.headers['tailscale-user-login'] !== undefined) return true;
  // A proxy on this machine (Tailscale Serve, Funnel, a dev proxy) connects from loopback but
  // says where the request came from; headers can only make a request look more remote.
  for (const h of FORWARDING_HEADERS) if (req.headers[h] !== undefined) return true;
  const host = req.headers['host'];
  if (Array.isArray(host) || (host !== undefined && !isLoopbackHost(host))) return true;
  return !(isLoopback(req.socket.remoteAddress) && isLoopbackOrigin(origin));
}

/**
 * A request's origin as the command surface takes it (P2-21): what the routes pass to every
 * policy-writing command and record on a user's `message.sent`, so a brain acting on that message
 * writes with the same origin.
 */
export function originOf(req: Parameters<typeof isRemoteRequest>[0]): RequestOrigin {
  return isRemoteRequest(req) ? 'remote' : 'local';
}

const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
];

/** A `Host` header naming this machine: localhost, 127.x or [::1], with or without a port. */
function isLoopbackHost(host: string): boolean {
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(name) || (isIP(name) === 4 && name.startsWith('127.'));
}

/** Constant-time token comparison. */
/**
 * An `onRequest` hook that refuses a request without `Authorization: Bearer <token>` (P1-28).
 * Added inside an encapsulated plugin, so it runs for exactly the routes registered there —
 * matched on the decoded route, never on the raw URL (`/%61pi/…` once skipped a URL-prefix
 * check).
 */
export function bearerGuard(config: { token: string }) {
  return async (
    req: { headers: { authorization?: string | undefined } },
    reply: { code(n: number): { send(body: unknown): unknown } },
  ) => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!tokenMatches(presented, config.token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
