// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServiceWorker } from './build-plugin.js';

/**
 * The service worker itself (P7-01), run against a fake ServiceWorkerGlobalScope: what it caches,
 * what it never touches, network-first for the page, cache-first for hashed assets, versioned
 * caches, and the messages the update flow sends it.
 */

const ORIGIN = 'https://mac.tailnet.ts.net';
const TEMPLATE = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
const PRECACHE = ['/', '/assets/index-new.js', '/assets/index-new.css', '/manifest.webmanifest'];

type Listener = (event: unknown) => void;

/** A same-origin response as the browser gives the worker (`type: 'basic'`). */
function basic(body: string, contentType: string, status = 200): Response {
  const res = new Response(body, { status, headers: { 'content-type': contentType } });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

class FakeCaches {
  stores = new Map<string, Map<string, Response>>();
  private key(k: RequestInfo | URL): string {
    return typeof k === 'string' ? new URL(k, ORIGIN).href : k instanceof URL ? k.href : k.url;
  }
  async open(name: string) {
    let store = this.stores.get(name);
    if (!store) this.stores.set(name, (store = new Map()));
    const s = store;
    return {
      put: async (k: RequestInfo, res: Response) => void s.set(this.key(k), res),
      match: async (k: RequestInfo) => s.get(this.key(k))?.clone(),
      addAll: async (reqs: Request[]) => {
        for (const r of reqs) s.set(r.url, await fetchImpl(r));
      },
    };
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

let fetchImpl: (r: Request) => Promise<Response>;
let listeners: Record<string, Listener>;
let caches: FakeCaches;
let scope: { skipWaiting: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn> };

function load(version = 'v2') {
  listeners = {};
  caches = new FakeCaches();
  scope = { skipWaiting: vi.fn(), claim: vi.fn(async () => undefined) };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: scope.skipWaiting,
    clients: { claim: scope.claim },
  };
  // A worker resolves relative URLs against its own location.
  const SwRequest = class extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
    }
  };
  const source = renderServiceWorker(TEMPLATE, { version, precache: PRECACHE });
  new Function('self', 'caches', 'fetch', 'Request', source)(
    self,
    caches,
    (r: Request) => fetchImpl(r),
    SwRequest,
  );
}

/** Dispatches an event with `waitUntil`; resolves when the work it was given is done. */
async function lifecycle(type: 'install' | 'activate') {
  let work: Promise<unknown> = Promise.resolve();
  listeners[type]!({ waitUntil: (p: Promise<unknown>) => (work = p) });
  await work;
}

/** Dispatches a fetch; undefined when the worker left it to the network. */
async function dispatch(
  path: string,
  init: RequestInit & { mode?: RequestMode; navigate?: boolean } = {},
): Promise<Response | undefined> {
  const request = new Request(path.startsWith('http') ? path : `${ORIGIN}${path}`, init);
  if (init.navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
  let answer: Promise<Response> | undefined;
  listeners['fetch']!({ request, respondWith: (p: Promise<Response>) => (answer = p) });
  return answer ? await answer : undefined;
}

beforeEach(() => {
  fetchImpl = vi.fn(async (r: Request) => {
    const path = new URL(r.url).pathname;
    if (path === '/' || !path.includes('.')) return basic('<!doctype html>new shell', 'text/html');
    return basic(`file ${path}`, path.endsWith('.css') ? 'text/css' : 'text/javascript');
  });
  load();
});

describe('the service worker (P7-01)', () => {
  it('precaches the shell of its build into its versioned cache', async () => {
    await lifecycle('install');
    const store = caches.stores.get('galactic-shell-v2')!;
    expect([...store.keys()].map((u) => new URL(u).pathname).sort()).toEqual([...PRECACHE].sort());
  });

  it('never touches the API, the socket, health, dev routes, the ops console or others', async () => {
    await lifecycle('install');
    for (const path of [
      '/api/settings',
      '/api',
      '/ws',
      '/health',
      '/dev/seed',
      '/debug',
      '/debug/anything',
    ]) {
      expect(await dispatch(path), path).toBeUndefined();
      expect(await dispatch(path, { navigate: true }), `${path} (navigation)`).toBeUndefined();
    }
    expect(await dispatch('/assets/index-new.js', { method: 'POST', body: 'x' })).toBeUndefined();
    expect(await dispatch('https://cdn.example.com/assets/x.js')).toBeUndefined();
    expect(
      await dispatch('/assets/index-new.js', { headers: { authorization: 'Bearer tok' } }),
    ).toBeUndefined();
    // A file outside the shell (not an asset, not precached) is left alone too.
    expect(await dispatch('/robots.txt')).toBeUndefined();
  });

  it('serves page loads from the network first and keeps the latest shell', async () => {
    await lifecycle('install');
    fetchImpl = vi.fn(async () => basic('<!doctype html>newer shell', 'text/html'));
    const res = await dispatch('/waykeeper/a-1', { navigate: true });
    expect(await res!.text()).toBe('<!doctype html>newer shell');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Offline: the last shell the network gave, for any page path.
    fetchImpl = vi.fn(async () => Promise.reject(new TypeError('offline')));
    const offline = await dispatch('/settings', { navigate: true });
    expect(await offline!.text()).toBe('<!doctype html>newer shell');
  });

  it('does not keep a page response that is not HTML as the shell', async () => {
    await lifecycle('install');
    fetchImpl = vi.fn(async () => basic('{"x":1}', 'application/json'));
    await dispatch('/some-json', { navigate: true });
    fetchImpl = vi.fn(async () => Promise.reject(new TypeError('offline')));
    const offline = await dispatch('/', { navigate: true });
    expect(await offline!.text()).toBe('<!doctype html>new shell');
  });

  it('fails like the network when offline with nothing cached', async () => {
    fetchImpl = vi.fn(async () => Promise.reject(new TypeError('offline')));
    await expect(dispatch('/', { navigate: true })).rejects.toThrow('offline');
  });

  it('serves hashed assets from the cache, fetching and keeping the ones it lacks', async () => {
    await lifecycle('install');
    const calls = vi.mocked(fetchImpl).mock.calls.length;
    const precached = await dispatch('/assets/index-new.js');
    expect(await precached!.text()).toBe('file /assets/index-new.js');
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(calls);

    const lazy = await dispatch('/assets/SolarScene-abc.js');
    expect(await lazy!.text()).toBe('file /assets/SolarScene-abc.js');
    fetchImpl = vi.fn(async () => Promise.reject(new TypeError('offline')));
    const again = await dispatch('/assets/SolarScene-abc.js');
    expect(await again!.text()).toBe('file /assets/SolarScene-abc.js');
  });

  it('never keeps the single-page fallback (HTML) under an asset name', async () => {
    fetchImpl = vi.fn(async () => basic('<!doctype html>fallback', 'text/html'));
    await dispatch('/assets/gone-old.js');
    expect(caches.stores.get('galactic-shell-v2')!.size).toBe(0);
  });

  it('serves the manifest network-first, falling back to the cached one', async () => {
    await lifecycle('install');
    fetchImpl = vi.fn(async () => basic('{"name":"fresh"}', 'application/manifest+json'));
    expect(await (await dispatch('/manifest.webmanifest'))!.text()).toBe('{"name":"fresh"}');
    fetchImpl = vi.fn(async () => Promise.reject(new TypeError('offline')));
    expect(await (await dispatch('/manifest.webmanifest'))!.text()).toBe('{"name":"fresh"}');
  });

  it('on activation deletes older versions only, and claims the open pages', async () => {
    await caches.open('galactic-shell-v1');
    await caches.open('someone-else');
    await lifecycle('install');
    await lifecycle('activate');
    expect((await caches.keys()).sort()).toEqual(['galactic-shell-v2', 'someone-else']);
    expect(scope.claim).toHaveBeenCalled();
  });

  it('waits until the page asks it to take over, and tells the page its build', async () => {
    await lifecycle('install');
    expect(scope.skipWaiting).not.toHaveBeenCalled();
    listeners['message']!({ data: { type: 'SKIP_WAITING' } });
    expect(scope.skipWaiting).toHaveBeenCalledTimes(1);

    const port = { postMessage: vi.fn() };
    listeners['message']!({ data: { type: 'GET_BUILD' }, ports: [port] });
    expect(port.postMessage).toHaveBeenCalledWith({ version: 'v2', precache: PRECACHE });
    listeners['message']!({ data: 'junk' });
  });
});
