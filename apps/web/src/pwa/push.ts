import {
  PushDeviceResponse,
  PushKinds,
  PushStatusResponse,
  allPushKindsOn,
  type PushDevice,
  type PushSubscribeRequest,
} from '@galactic/protocol';
import { ApiError } from '../console/api.js';
import { isIos, isStandalone } from './register.js';

/**
 * Web Push on the page side (P7-04): whether this browser can receive push, this device's id and
 * name, and the calls to `/api/push*`. A device is one browser install; its toggles live on the
 * server (the server decides what to send while the page is closed) and are mirrored in this
 * browser's storage only so a rotated subscription can be handed over again (`syncPush`).
 */

/** What this browser can do about push. */
export type PushSupport =
  /** Service worker, PushManager and notifications: push can be turned on. */
  | 'supported'
  /** iPhone/iPad in Safari: push exists only for the app added to the Home Screen. */
  | 'ios-install'
  /** Not a secure page (plain http to another machine): browsers allow push only over HTTPS. */
  | 'insecure'
  | 'unsupported';

export interface PushEnv {
  win: Window;
  nav: Navigator;
}

const defaultEnv = (): PushEnv => ({ win: window, nav: navigator });

export function pushSupport(env: PushEnv = defaultEnv()): PushSupport {
  const { win, nav } = env;
  const hasApis =
    'serviceWorker' in nav &&
    typeof (win as Window & { PushManager?: unknown }).PushManager !== 'undefined' &&
    typeof (win as Window & { Notification?: unknown }).Notification !== 'undefined';
  if (hasApis) return win.isSecureContext === false ? 'insecure' : 'supported';
  if (isIos(nav) && !isStandalone(win, nav)) return 'ios-install';
  if (win.isSecureContext === false) return 'insecure';
  return 'unsupported';
}

/** A device's id: the first 32 hex digits of SHA-256(endpoint), as the server computes it. */
export async function pushDeviceId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** "iPhone · Safari (Home Screen)", "Mac · Chrome": how the device list names this browser. */
export function deviceLabel(env: PushEnv = defaultEnv()): string {
  const ua = env.nav.userAgent;
  const platform = isIos(env.nav)
    ? /iPad/.test(ua) || env.nav.platform === 'MacIntel'
      ? 'iPad'
      : 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${platform} · ${browser}${isStandalone(env.win, env.nav) ? ' (Home Screen)' : ''}`;
}

/** The VAPID key as `pushManager.subscribe` wants it. */
export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = (publicKey + '='.repeat((4 - (publicKey.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Whether an existing subscription was made with this server's key (else it must be renewed). */
export function sameServerKey(sub: PushSubscription, publicKey: string): boolean {
  const key = sub.options?.applicationServerKey;
  if (!key) return true; // the browser does not say: assume it is ours
  const a = new Uint8Array(key);
  const b = applicationServerKey(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** This browser's registration, if a service worker is registered (production builds only). */
export async function pushRegistration(
  env: PushEnv = defaultEnv(),
): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in env.nav)) return undefined;
  try {
    return (await env.nav.serviceWorker.getRegistration()) ?? undefined;
  } catch {
    return undefined;
  }
}

// --- the server ---------------------------------------------------------------------------------

export function createPushApi(token: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchImpl(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!res.ok) {
      const message =
        (data['message'] as string | undefined) ??
        (data['error'] as string | undefined) ??
        `${res.status}`;
      throw new ApiError(res.status, message, data['error'] as string | undefined, data);
    }
    return data;
  };
  return {
    status: async () => PushStatusResponse.parse(await call('GET', '/api/push')),
    subscribe: async (body: PushSubscribeRequest): Promise<PushDevice> =>
      PushDeviceResponse.parse(await call('PUT', '/api/push/subscription', body)).device,
    unsubscribe: (endpoint: string) => call('POST', '/api/push/unsubscribe', { endpoint }),
    test: (endpoint: string) => call('POST', '/api/push/test', { endpoint }),
    remove: (id: string) => call('DELETE', `/api/push/devices/${encodeURIComponent(id)}`),
  };
}
export type PushApi = ReturnType<typeof createPushApi>;

/** The subscription as the server's schema wants it. */
export function subscriptionJson(sub: PushSubscription): PushSubscribeRequest['subscription'] {
  const json = sub.toJSON() as {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: Record<string, string>;
  };
  return {
    endpoint: json.endpoint ?? sub.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys?.['p256dh'] ?? '', auth: json.keys?.['auth'] ?? '' },
  };
}

// --- this browser's memory of its choice ---------------------------------------------------------

export const PUSH_DEVICE_KEY = 'galactic.push.device';

interface RememberedDevice {
  /**
   * The device id (the endpoint's SHA-256 prefix, not the endpoint) of the subscription this
   * browser handed over last: how `syncPush` tells a rotated subscription (a new id) from one the
   * server forgot on purpose (the same id: the device was removed).
   */
  id?: string | undefined;
  kinds: PushKinds;
  details: boolean;
}

export function rememberDevice(device: RememberedDevice | undefined): void {
  try {
    if (device) {
      localStorage.setItem(
        PUSH_DEVICE_KEY,
        JSON.stringify({
          ...(device.id ? { id: device.id } : {}),
          kinds: device.kinds,
          details: device.details,
        }),
      );
    } else localStorage.removeItem(PUSH_DEVICE_KEY);
  } catch {
    // Blocked storage: a rotated subscription is then not handed over until the settings open.
  }
}

export function rememberedDevice(): RememberedDevice | undefined {
  try {
    const raw = localStorage.getItem(PUSH_DEVICE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { id?: unknown; kinds?: unknown; details?: unknown };
    const kinds = PushKinds.safeParse(parsed.kinds);
    return {
      ...(typeof parsed.id === 'string' && parsed.id ? { id: parsed.id } : {}),
      kinds: kinds.success ? kinds.data : allPushKindsOn(),
      details: parsed.details === true,
    };
  } catch {
    return undefined;
  }
}

/**
 * On a session start: when push was turned on in this browser and the browser now holds a
 * subscription the server does not know, decide why from the device id this browser remembers:
 *
 * - **Another id** (the push service rotated the subscription): hand the new one over with the
 *   toggles this browser remembers (`synced`).
 * - **The same id** (or none remembered): the server forgot this very subscription — the device
 *   was removed (from the Mac's "Remove device", or after the push service said it was gone). The
 *   removal is respected: this browser forgets its choice, drops the local subscription, and push
 *   stays off until the user turns it on again in the settings (`removed`).
 *
 * Best effort and silent: it never asks for a permission and never subscribes anew. Removing a
 * device is not a revocation: a lost phone that still holds a valid token can turn push on again
 * itself; cutting it off needs a token reset (SPEC decision 90).
 */
export async function syncPush(
  token: string,
  env: PushEnv = defaultEnv(),
  api: PushApi = createPushApi(token),
): Promise<'synced' | 'unchanged' | 'removed' | 'off'> {
  const remembered = rememberedDevice();
  if (!remembered || pushSupport(env) !== 'supported') return 'off';
  try {
    const reg = await pushRegistration(env);
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return 'off';
    const status = await api.status();
    if (!sameServerKey(sub, status.publicKey)) return 'off';
    const id = await pushDeviceId(sub.endpoint);
    if (status.devices.some((d) => d.id === id)) {
      if (remembered.id !== id) rememberDevice({ ...remembered, id });
      return 'unchanged';
    }
    if (!remembered.id || remembered.id === id) {
      rememberDevice(undefined);
      await sub.unsubscribe().catch(() => false);
      return 'removed';
    }
    const saved = await api.subscribe({
      subscription: subscriptionJson(sub),
      kinds: remembered.kinds,
      details: remembered.details,
      label: deviceLabel(env),
    });
    rememberDevice(saved);
    return 'synced';
  } catch {
    return 'off';
  }
}
