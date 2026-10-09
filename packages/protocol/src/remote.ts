import { z } from 'zod';

/**
 * Phone access (P9-16; SPEC decision 137, `docs/REMOTE_ACCESS.md`, TECHNOLOGY §2.4): whether the
 * phone can reach this Mission Control through HTTP-mode Tailscale Serve, and the Mac's switch to
 * turn it on and off. `GET /api/remote/status` (every client, read-only), `POST /api/remote/start`
 * and `POST /api/remote/stop` (the Mac only, even with `autoApproveRemote`).
 */

/** Tailscale on this Mac: `running` (connected), `stopped`, `needs_login`, `not_installed`. */
export const TailscaleState = z.enum(['running', 'stopped', 'needs_login', 'not_installed']);
export type TailscaleState = z.infer<typeof TailscaleState>;

/**
 * `remoteHost` against this Mac's Tailscale name: `matches`, `mismatch` (it names another
 * machine), `missing` (not set), `configured` (set, but there is no name to compare it with).
 */
export const RemoteHostState = z.enum(['matches', 'mismatch', 'missing', 'configured']);
export type RemoteHostState = z.infer<typeof RemoteHostState>;

/**
 * Tailscale Serve's port 443: `forwarding_to_us` (HTTP mode, to this server's port and nothing
 * else), `absent` (nothing served on 443), `taken_by_other` (443 serves something else, or in TCP
 * mode), `funnel_on` (Funnel is on: never used), `unknown` (Tailscale is not running).
 */
export const ServeState = z.enum([
  'forwarding_to_us',
  'absent',
  'taken_by_other',
  'funnel_on',
  'unknown',
]);
export type ServeState = z.infer<typeof ServeState>;

/** Why the phone cannot reach Mission Control (or why a start / stop was refused). */
export const RemoteReason = z.enum([
  'not_installed',
  'not_running',
  'needs_login',
  'no_magicdns',
  'remote_host_mismatch',
  'funnel_on',
  'port_443_taken',
  'serve_off',
  'restart_needed',
  'not_owned',
  'error',
]);
export type RemoteReason = z.infer<typeof RemoteReason>;

export const RemoteStatus = z.object({
  tailscale: TailscaleState,
  /** This Mac's MagicDNS name (`mymac.tail1234.ts.net`), when it has one. */
  name: z.string().optional(),
  /** `https://<name>`: what the phone opens (the QR code adds the token). */
  url: z.string().optional(),
  remoteHost: z.object({ state: RemoteHostState, value: z.string().optional() }),
  serve: ServeState,
  /** Serve forwards to us and Mission Control (or the desktop app through it) started it. */
  serveOwned: z.boolean(),
  /** The phone can reach Mission Control now. */
  ready: z.boolean(),
  /** `remoteHost` was added after this server started: a restart finishes turning it on. */
  restartNeeded: z.boolean(),
  /** Why it is not ready (absent when ready). */
  reason: RemoteReason.optional(),
  /** The reason in words, with what to do. */
  message: z.string().optional(),
  /** Remote sockets connected now, and when one was last seen (ISO time). */
  remoteClients: z.object({
    connected: z.number().int().nonnegative(),
    lastSeenAt: z.string().optional(),
  }),
  checkedAt: z.string(),
});
export type RemoteStatus = z.infer<typeof RemoteStatus>;

/**
 * `POST /api/remote/start` / `stop`: 200 `{ok: true, status}`; a refusal is 409
 * `{error: 'remote_refused', ok: false, reason, message, status}`.
 */
export const RemoteActionResponse = z.object({
  ok: z.boolean(),
  status: RemoteStatus,
  reason: RemoteReason.optional(),
  message: z.string().optional(),
  error: z.literal('remote_refused').optional(),
});
export type RemoteActionResponse = z.infer<typeof RemoteActionResponse>;

/** A reason in a few words: the desktop menu bar's "Phone: off — …", the top bar's indicator. */
export const REMOTE_REASON_SHORT: Record<RemoteReason, string> = {
  not_installed: 'Tailscale not installed',
  not_running: 'Tailscale not running',
  needs_login: 'Tailscale not signed in',
  no_magicdns: 'no MagicDNS name',
  remote_host_mismatch: 'remoteHost names another Mac',
  funnel_on: 'Tailscale Funnel is on',
  port_443_taken: 'port 443 is taken',
  serve_off: 'turned off',
  restart_needed: 'restart needed',
  not_owned: 'Serve was set up elsewhere',
  error: 'Tailscale could not be read',
};
