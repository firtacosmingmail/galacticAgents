// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServiceWorker } from './build-plugin.js';

/**
 * The service worker's push handlers (P7-04), run against a fake ServiceWorkerGlobalScope like
 * `sw.test.ts`: a push shows one notification (never two for one id), a bad payload still shows
 * something generic, and a tap focuses an open window or opens one at `#focus=`.
 */

const ORIGIN = 'https://mac.tailnet.ts.net';
const TEMPLATE = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

type Listener = (event: unknown) => void;
interface Shown {
  title: string;
  options: {
    body?: string;
    tag: string;
    renotify?: boolean;
    data: { id: string; target?: unknown };
  };
}
interface FakeClient {
  url: string;
  focused: boolean;
  visibilityState: 'visible' | 'hidden';
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

let listeners: Record<string, Listener>;
let shown: Shown[];
let windows: FakeClient[];
let opened: string[];
let showCalls: number;

function load() {
  listeners = {};
  shown = [];
  showCalls = 0;
  opened = [];
  windows = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: vi.fn(),
    registration: {
      getNotifications: async ({ tag }: { tag: string }) =>
        shown
          .filter((n) => n.options.tag === tag)
          .map((n) => ({ title: n.title, body: n.options.body, data: n.options.data })),
      showNotification: async (title: string, options: Shown['options']) => {
        showCalls++;
        shown = shown.filter((n) => n.options.tag !== options.tag);
        shown.push({ title, options });
      },
    },
    clients: {
      claim: vi.fn(),
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  const source = renderServiceWorker(TEMPLATE, { version: 'v1', precache: ['/'] });
  new Function('self', 'caches', 'fetch', 'Request', source)(self, {}, vi.fn(), Request);
}

async function push(data: unknown) {
  let work: Promise<unknown> = Promise.resolve();
  const raw = typeof data === 'string' ? data : JSON.stringify(data);
  listeners['push']!({
    data: data === undefined ? null : { json: () => JSON.parse(raw) as unknown },
    waitUntil: (p: Promise<unknown>) => (work = p),
  });
  await work;
}

async function click(data: unknown) {
  let work: Promise<unknown> = Promise.resolve();
  const close = vi.fn();
  listeners['notificationclick']!({
    notification: { data, close },
    waitUntil: (p: Promise<unknown>) => (work = p),
  });
  await work;
  return close;
}

const client = (over: Partial<FakeClient> = {}): FakeClient => ({
  url: `${ORIGIN}/`,
  focused: false,
  visibilityState: 'hidden',
  focus: vi.fn(async () => undefined),
  postMessage: vi.fn(),
  ...over,
});

const question = {
  v: 1,
  id: 'question:q1',
  kind: 'question',
  title: 'A question for you',
  target: { kind: 'question', id: 'q1' },
  at: '2026-10-05T10:00:00.000Z',
};

beforeEach(load);

describe('the service worker’s push handlers (P7-04)', () => {
  it('shows a push with its id as the tag and a generic body when none was sent', async () => {
    await push(question);
    expect(shown).toEqual([
      {
        title: 'A question for you',
        options: expect.objectContaining({
          tag: 'question:q1',
          body: 'Open GalacticAgents to see it.',
          data: { id: 'question:q1', target: { kind: 'question', id: 'q1' } },
        }),
      },
    ]);
  });

  it('shows the body a detailed device was sent', async () => {
    await push({ ...question, body: 'Which format?' });
    expect(shown[0]!.options.body).toBe('Which format?');
  });

  it('one notification per id: a push for a tag already on screen replaces it in place', async () => {
    // Never skipped: Safari on iOS revokes a subscription whose pushes do not call showNotification.
    shown.push({
      title: 'from the page',
      options: { tag: 'question:q1', body: 'Which format?', data: { id: 'x' } },
    });
    await push(question);
    expect(showCalls).toBe(1);
    expect(shown).toHaveLength(1);
    // The page's text (it may carry details the push leaves out) is kept.
    expect(shown[0]!.title).toBe('from the page');
    expect(shown[0]!.options).toMatchObject({
      tag: 'question:q1',
      body: 'Which format?',
      renotify: false,
      data: { id: 'x' },
    });
  });

  it('every push calls showNotification, even a repeat of what is on screen', async () => {
    await push(question);
    await push(question);
    await push(undefined);
    await push(undefined);
    expect(showCalls).toBe(4);
    expect(shown.map((n) => n.options.tag)).toEqual(['question:q1', 'galactic:push']);
  });

  it('a missing or foreign payload still shows a generic notification (never a silent push)', async () => {
    await push(undefined);
    await push({ v: 2, id: 'x', title: 'y' });
    expect(shown.map((n) => [n.title, n.options.tag])).toEqual([
      ['GalacticAgents', 'galactic:push'],
    ]);
    load();
    await push('{not json');
    expect(shown).toHaveLength(1);
  });

  it('drops a target it does not know and clips long fields', async () => {
    await push({ ...question, id: 'q:' + 'x'.repeat(500), target: { kind: 'evil', id: '1' } });
    expect(shown[0]!.options.tag).toHaveLength(200);
    expect(shown[0]!.options.data.target).toBeUndefined();
  });

  it('a tap focuses the focused window first and tells it what to select', async () => {
    const hidden = client();
    const front = client({ focused: true, visibilityState: 'visible' });
    windows = [hidden, front];
    const close = await click({ id: 'question:q1', target: { kind: 'question', id: 'q1' } });
    expect(close).toHaveBeenCalled();
    expect(front.focus).toHaveBeenCalled();
    expect(front.postMessage).toHaveBeenCalledWith({
      type: 'NOTIFICATION_CLICK',
      target: { kind: 'question', id: 'q1' },
    });
    expect(hidden.postMessage).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('a tap with no window open opens the app at #focus= (no credential in the URL)', async () => {
    windows = [client({ url: 'https://other.example.com/' })];
    await click({ id: 'project:p1:completed:9', target: { kind: 'project', id: 'p 1' } });
    await click({ id: 'galactic:test' });
    expect(opened).toEqual(['/#focus=project%3Ap%201', '/#focus=inbox']);
    for (const url of opened) expect(url).not.toMatch(/token/);
  });

  it('a window that refuses focus still gets the message', async () => {
    const w = client({ focus: vi.fn(async () => Promise.reject(new Error('no'))) });
    windows = [w];
    await click({ id: 'galactic:test' });
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'NOTIFICATION_CLICK', target: null });
  });
});
