import { vi } from 'vitest';
import type { PushDevice, PushStatusResponse } from '@galactic/protocol';
import type { PushApi, PushEnv } from './push.js';

/**
 * Test doubles for Web Push on the page (P7-04): a browser with a service worker registration and
 * a PushManager, and the `/api/push*` client.
 */

// A real P-256 public key (65 bytes, base64url), as the server's VAPID key would be.
export const SERVER_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

export class FakeSubscription {
  unsubscribed = false;
  constructor(
    readonly endpoint: string,
    readonly key: Uint8Array = keyBytes(SERVER_KEY),
  ) {}
  get options() {
    return { applicationServerKey: this.key.buffer, userVisibleOnly: true };
  }
  toJSON() {
    return {
      endpoint: this.endpoint,
      expirationTime: null,
      keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
    };
  }
  unsubscribe = vi.fn(async () => {
    this.unsubscribed = true;
    return true;
  });
}

export function keyBytes(publicKey: string): Uint8Array {
  const b64 = publicKey.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export interface FakeBrowser {
  env: PushEnv;
  held: FakeSubscription | undefined;
  subscribe: ReturnType<typeof vi.fn>;
  permission: NotificationPermission;
}

export function fakeBrowser(
  over: {
    ua?: string;
    standalone?: boolean;
    pushManager?: boolean;
    registration?: boolean;
    secure?: boolean;
    held?: FakeSubscription;
    permission?: NotificationPermission;
  } = {},
): FakeBrowser {
  const browser: FakeBrowser = {
    held: over.held,
    permission: over.permission ?? 'default',
    subscribe: vi.fn(),
    env: undefined as unknown as PushEnv,
  };
  browser.subscribe = vi.fn(
    async (opts: { applicationServerKey: Uint8Array; userVisibleOnly: boolean }) => {
      browser.permission = 'granted';
      browser.held = new FakeSubscription(
        'https://fcm.googleapis.com/fcm/send/new-device',
        opts.applicationServerKey,
      );
      return browser.held;
    },
  );
  const reg = {
    pushManager: {
      getSubscription: async () => browser.held ?? null,
      subscribe: browser.subscribe,
    },
  };
  const win = {
    isSecureContext: over.secure ?? true,
    matchMedia: (q: string) => ({ matches: q.includes('standalone') && over.standalone === true }),
    ...(over.pushManager === false ? {} : { PushManager: function PushManager() {} }),
    ...(over.pushManager === false
      ? {}
      : {
          Notification: {
            get permission() {
              return browser.permission;
            },
          },
        }),
  } as unknown as Window;
  const nav = {
    userAgent:
      over.ua ??
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
    ...(over.standalone ? { standalone: true } : {}),
    ...(over.pushManager === false && over.registration === undefined
      ? {}
      : {
          serviceWorker: {
            getRegistration: async () => (over.registration === false ? undefined : reg),
          },
        }),
  } as unknown as Navigator;
  browser.env = { win, nav };
  return browser;
}

export const device = (id: string, over: Partial<PushDevice> = {}): PushDevice => ({
  id,
  label: 'Android · Chrome',
  kinds: { permission: true, question: true, project_completed: true, project_failed: true },
  details: false,
  origin: 'remote',
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-05T10:00:00.000Z',
  ...over,
});

export function fakeApi(status: Partial<PushStatusResponse> = {}) {
  const state: PushStatusResponse = {
    publicKey: SERVER_KEY,
    devices: [],
    canRemoveOthers: true,
    ...status,
  };
  const api = {
    status: vi.fn(async () => structuredClone(state)),
    subscribe: vi.fn(async (body: Parameters<PushApi['subscribe']>[0]): Promise<PushDevice> =>
      device(await idOf(body.subscription.endpoint), {
        label: body.label ?? 'A browser',
        ...(body.kinds ? { kinds: body.kinds } : {}),
        ...(body.details !== undefined ? { details: body.details } : {}),
      }),
    ),
    unsubscribe: vi.fn(async () => ({ ok: true, removed: true })),
    test: vi.fn(async () => ({ ok: true, result: 'sent' })),
    remove: vi.fn(async () => ({ ok: true })),
  };
  return { api: api as unknown as PushApi & typeof api, state };
}

async function idOf(endpoint: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
