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

/** What the security helpers read of a request: Fastify's and Node's `IncomingMessage` both fit. */
export interface RequestLike {
  socket: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Whether a request comes from a remote client (P2-04, P7-02; TECHNOLOGY §8 "Remote clients"). It
 * is local only when all of these hold: the connection is from loopback, `Host` is a loopback
 * name (or absent), `Origin` is absent or a loopback origin, and no proxy header is present — no
 * `Forwarded`, `X-Real-IP`, `Via`, no `X-Forwarded-*` and no `Tailscale-*` header of any name.
 * Tailscale Serve connects from loopback, but it keeps the phone's `Host` (the `*.ts.net` name)
 * and adds `X-Forwarded-For` / `-Host` / `-Proto`, plus the identity headers for a tailnet user,
 * so any one of them gives it away. Headers can only make a request look more remote, so a
 * forged header never gains anything; fails towards "remote", where the stricter rules apply.
 */
export function isRemoteRequest(req: RequestLike): boolean {
  const origin = req.headers['origin'];
  if (Array.isArray(origin)) return true;
  // A proxy on this machine (Tailscale Serve, Funnel, a dev proxy) connects from loopback but
  // says where the request came from.
  for (const name of Object.keys(req.headers)) {
    const h = name.toLowerCase();
    if (FORWARDING_HEADERS.has(h) || h.startsWith('x-forwarded-') || h.startsWith('tailscale-')) {
      return true;
    }
  }
  const host = req.headers['host'];
  if (Array.isArray(host) || (host !== undefined && !isLoopbackHost(host))) return true;
  return !(isLoopback(req.socket.remoteAddress) && isLoopbackOrigin(origin));
}

/**
 * Whether a request is a browser fetching from its own page (`Sec-Fetch-Site: same-origin`) or a
 * user's own navigation (`none`): what `/health` requires before handing out the token (P7-02
 * review). Browsers set this header and no page script can change it, so a cross-site page never
 * passes; a plain `curl` or an agent's script does not send it by default. Any local process can
 * still send it on purpose: a speed bump, not a boundary (docs/REMOTE_ACCESS.md §4).
 */
export function isSameOriginFetch(req: RequestLike): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === 'same-origin' || site === 'none';
}

/** What `tailscaleIdentityOf` and the guards need of the server config (P7-02). */
export interface RemoteAuthConfig {
  token: string;
  remoteHost?: string | undefined;
  tailscaleIdentityLogins?: readonly string[] | undefined;
}

/**
 * The Tailscale login a request carries as its credential (P7-02), or `undefined`. Only when the
 * opt-in is configured (`tailscaleIdentityLogins` with a `remoteHost`) and the request looks
 * exactly like Tailscale Serve forwarding a tailnet user's request:
 *
 * - the TCP connection is from loopback (Serve runs on this machine; a tailnet peer reaching the
 *   port directly cannot, since the server binds 127.0.0.1 only);
 * - `Host` names `remoteHost` exactly (any port) — Serve keeps the phone's `Host`, while a page in
 *   a local browser can never forge `Host`, so no website can use this path;
 * - `Origin`, if present, is `https://<remoteHost>`;
 * - no `Tailscale-Funnel-Request` (Funnel traffic is the public internet);
 * - exactly one `Tailscale-User-Login`, equal (case-insensitively) to a configured login.
 *
 * Serve deletes any `Tailscale-User-*` header the client sent before setting its own, and sets
 * none for a tagged node or a Funnel request (`ipn/ipnlocal/serve.go`,
 * `addTailscaleIdentityHeaders`), so a tailnet device cannot forge it through Serve. A process on
 * this machine can still connect to loopback and send all of the above — but it can already ask
 * `/health` for the token, so the opt-in adds no new local exposure: every local process is
 * trusted either way (the trust model in `docs/REMOTE_ACCESS.md` §4).
 */
export function tailscaleIdentityOf(
  req: RequestLike,
  config: RemoteAuthConfig,
): string | undefined {
  const logins = config.tailscaleIdentityLogins;
  const remoteHost = config.remoteHost;
  if (!logins || logins.length === 0 || !remoteHost) return undefined;
  if (!isLoopback(req.socket.remoteAddress)) return undefined;
  const host = req.headers['host'];
  if (typeof host !== 'string' || hostnameOf(host) !== remoteHost) return undefined;
  const origin = req.headers['origin'];
  if (origin !== undefined) {
    if (typeof origin !== 'string') return undefined;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' || url.hostname !== remoteHost) return undefined;
  }
  // A Funnel request comes from the public internet: Serve sets no identity for it, ever.
  if (req.headers['tailscale-funnel-request'] !== undefined) return undefined;
  const login = req.headers['tailscale-user-login'];
  // Node joins a repeated header into one comma-separated string, which matches no login.
  if (typeof login !== 'string') return undefined;
  const normalized = login.trim().toLowerCase();
  return logins.includes(normalized) ? normalized : undefined;
}

/** A request's credential: the bearer token, or an accepted Tailscale identity (P7-02). */
export function isAuthorized(
  req: RequestLike & { headers: { authorization?: string | string[] | undefined } },
  config: RemoteAuthConfig,
): boolean {
  const header = req.headers.authorization;
  const presented =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
  return tokenMatches(presented, config.token) || tailscaleIdentityOf(req, config) !== undefined;
}

/**
 * A request's origin as the command surface takes it (P2-21): what the routes pass to every
 * policy-writing command and record on a user's `message.sent`, so a brain acting on that message
 * writes with the same origin.
 */
export function originOf(req: RequestLike): RequestOrigin {
  return isRemoteRequest(req) ? 'remote' : 'local';
}

/** Proxy headers besides the `X-Forwarded-*` and `Tailscale-*` families. */
const FORWARDING_HEADERS = new Set(['forwarded', 'x-real-ip', 'via']);

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

/**
 * An `onRequest` hook that refuses a request without `Authorization: Bearer <token>` (P1-28) or an
 * accepted Tailscale identity (P7-02, `tailscaleIdentityOf`). Added inside an encapsulated plugin,
 * so it runs for exactly the routes registered there — matched on the decoded route, never on the
 * raw URL (`/%61pi/…` once skipped a URL-prefix check).
 */
export function bearerGuard(config: RemoteAuthConfig) {
  return async (
    req: RequestLike & { headers: { authorization?: string | string[] | undefined } },
    reply: { code(n: number): { send(body: unknown): unknown } },
  ) => {
    if (!isAuthorized(req, config)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

/** Constant-time token comparison. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
