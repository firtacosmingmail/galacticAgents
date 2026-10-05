// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNotification } from './fake-notification.js';
import { showNotification } from './notifier.js';

/**
 * P7-04: with a service worker registered, the page's desktop notifications are shown through it,
 * so they share their tag with Web Push — the device shows one notification for one id, whichever
 * arrives first — and a tap goes through the worker. Without one, the page's own `Notification`.
 */

interface Shown {
  title: string;
  options: NotificationOptions & { tag: string };
}
let shown: Shown[];
let registration: Partial<ServiceWorkerRegistration> | undefined;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  shown = [];
  FakeNotification.reset('granted');
  vi.stubGlobal('Notification', FakeNotification);
  registration = {
    getNotifications: vi.fn(async (filter?: GetNotificationOptions) =>
      shown.filter((s) => s.options.tag === filter?.tag),
    ) as unknown as ServiceWorkerRegistration['getNotifications'],
    showNotification: vi.fn(async (title: string, options?: NotificationOptions) => {
      shown.push({ title, options: options as Shown['options'] });
    }),
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => registration },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('desktop notifications through the service worker (P7-04)', () => {
  it('are shown by the worker with the notification id as tag and the target as data', async () => {
    showNotification({
      id: 'question:q1',
      title: 'A question for you',
      body: 'Which format?',
      target: { kind: 'question', id: 'q1' },
    });
    await flush();
    expect(shown).toEqual([
      {
        title: 'A question for you',
        options: expect.objectContaining({
          tag: 'question:q1',
          body: 'Which format?',
          data: { id: 'question:q1', target: { kind: 'question', id: 'q1' } },
        }),
      },
    ]);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('are not shown again when a push already put the same id on screen', async () => {
    shown.push({ title: 'push', options: { tag: 'question:q1' } });
    showNotification({ id: 'question:q1', title: 'A question for you' });
    await flush();
    expect(shown).toHaveLength(1);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('fall back to the page’s Notification without a registration, or when the worker fails', async () => {
    registration = undefined;
    showNotification({ id: 'a', title: 'one' });
    await flush();
    registration = {
      getNotifications: vi.fn(async () => []),
      showNotification: vi.fn(async () => Promise.reject(new TypeError('no'))),
    } as unknown as ServiceWorkerRegistration;
    showNotification({ id: 'b', title: 'two' });
    await flush();
    expect(FakeNotification.instances.map((n) => n.title)).toEqual(['one', 'two']);
  });
});
