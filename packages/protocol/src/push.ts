import { z } from 'zod';
import { Timestamp } from './primitives.js';
import { NotificationTarget, type NotificationKind } from './panel.js';

// ---------------------------------------------------------------------------
// Web Push (P7-04; SPEC §4.5, decision 59; TECHNOLOGY §2.4): the phone (or any browser) hands
// Mission Control a push subscription, and the server sends it a push for the SPEC §4.5 triggers
// that matter away from the desk. Bearer-guarded like every `/api` route. Subscriptions are per
// device (one per browser install); a device's toggles live with its subscription on the server,
// because the server decides what to send while the page is closed.
// ---------------------------------------------------------------------------

/**
 * The notification kinds a push is sent for — a subset of `NotificationKind` (decision 59's
 * triggers): a question or permission held by the user, a project finished or failed. Tasks,
 * interrupted work and "no free body" stay on the open page's desktop notifications.
 */
export const PushKind = z.enum(['permission', 'question', 'project_completed', 'project_failed']);
export type PushKind = z.infer<typeof PushKind>;

/** Compile-time check that every push kind is a notification kind. */
export const PUSH_KINDS: readonly (PushKind & NotificationKind)[] = PushKind.options;

export const isPushKind = (kind: string): kind is PushKind =>
  (PushKind.options as readonly string[]).includes(kind);

/** One switch per push kind; all on by default. */
export const PushKinds = z.object({
  permission: z.boolean(),
  question: z.boolean(),
  project_completed: z.boolean(),
  project_failed: z.boolean(),
});
export type PushKinds = z.infer<typeof PushKinds>;

export const allPushKindsOn = (): PushKinds => ({
  permission: true,
  question: true,
  project_completed: true,
  project_failed: true,
});

/** base64url without padding, as browsers encode subscription keys. */
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'base64url expected');

/** `PushSubscription.toJSON()` as the browser gives it. */
export const PushSubscriptionJson = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: Base64Url.min(80).max(100),
    auth: Base64Url.min(16).max(32),
  }),
});
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionJson>;

/** A device's name in the list, e.g. "iPhone · Safari (Home Screen)". Display only. */
const DeviceLabel = z.string().trim().min(1).max(80);

/**
 * `PUT /api/push/subscription`: subscribe this device, or update its toggles (upsert by the
 * endpoint). Whoever holds the subscription (its endpoint) owns it.
 */
export const PushSubscribeRequest = z.object({
  subscription: PushSubscriptionJson,
  kinds: PushKinds.optional(),
  /**
   * Put names and question text in the notification (the lock screen shows them). Off by
   * default: the notification then says only what kind of thing happened.
   */
  details: z.boolean().optional(),
  label: DeviceLabel.optional(),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>;

/** `POST /api/push/unsubscribe`, `POST /api/push/test`: this device, named by its endpoint. */
export const PushEndpointRequest = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
});
export type PushEndpointRequest = z.infer<typeof PushEndpointRequest>;

/**
 * One subscribed device as the server lists it — never its endpoint or keys. `id` is the first
 * 32 hex digits of the SHA-256 of the endpoint, so a page finds its own device in the list.
 */
export const PushDevice = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  label: z.string(),
  kinds: PushKinds,
  details: z.boolean(),
  /** Where it subscribed from (decision 90): the Mac's own browser or a remote one. */
  origin: z.enum(['local', 'remote']),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastSentAt: Timestamp.optional(),
  /** The last failed send (an HTTP status or `network`), cleared by the next success. */
  lastError: z.string().optional(),
});
export type PushDevice = z.infer<typeof PushDevice>;

/** `GET /api/push`: the server's public VAPID key and the subscribed devices. */
export const PushStatusResponse = z.object({
  /** The VAPID application server key (base64url), for `pushManager.subscribe`. */
  publicKey: z.string().min(1),
  devices: z.array(PushDevice),
  /** Whether this client may remove another device (a local client; decision 90). */
  canRemoveOthers: z.boolean(),
});
export type PushStatusResponse = z.infer<typeof PushStatusResponse>;

export const PushDeviceResponse = z.object({ device: PushDevice });
export type PushDeviceResponse = z.infer<typeof PushDeviceResponse>;

/**
 * What a push carries to the service worker (encrypted end to end; only the device reads it).
 * Minimal on purpose: what the lock screen may show, the notification id (the page's
 * notifications use the same id as their tag, so the device shows one, not two) and what a tap
 * opens. Never a token, never a URL with a credential.
 */
export const PushPayload = z.object({
  v: z.literal(1),
  /** `notificationOf`'s id (`question:<id>`, `project:<id>:completed:<seq>`), or `galactic:test`. */
  id: z.string().min(1).max(200),
  kind: z.union([PushKind, z.literal('test')]),
  title: z.string().min(1).max(120),
  /** Only on a device that chose details (names, question text). */
  body: z.string().max(200).optional(),
  target: NotificationTarget.optional(),
  at: Timestamp,
});
export type PushPayload = z.infer<typeof PushPayload>;

/** The fragment a tapped notification opens the app with, when no window is open: `#focus=…`. */
export const PUSH_FOCUS_FRAGMENT = 'focus';
