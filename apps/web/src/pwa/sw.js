/*
 * GalacticAgents service worker (P7-01, TECHNOLOGY §2.4): a versioned, network-first cache of the
 * app shell — nothing else.
 *
 * - Page navigations go to the network first; the cached shell (`/`) is the fallback only when the
 *   network fails, so a new deploy is picked up on the next load and no stale shell is served
 *   while the server answers.
 * - Hashed build assets (`/assets/*`) never change under their name: served from the cache when
 *   present, else fetched and kept.
 * - The other shell files (manifest, icons) are network-first like the page.
 * - Everything else is not touched at all — the API (`/api`), the socket (`/ws`), `/health`, the
 *   development routes (`/dev`), the ops console (`/debug`), any request with credentials, any
 *   non-GET and anything cross-origin: the browser handles them as if there were no worker.
 *
 * The build (`build-plugin.ts`) fills BUILD — the version (a hash of the build's file names and
 * page) and the shell to precache — so every deploy is a byte-different `sw.js` and the browser
 * installs it. A new worker waits until the page asks it to take over (the "new version" banner,
 * `register.ts`); activating deletes the caches of older versions.
 */

const BUILD = /*BUILD*/ { version: 'dev', precache: ['/'] }; /*END*/
const PREFIX = 'galactic-shell-';
const CACHE = PREFIX + BUILD.version;
const SHELL = '/';
const BYPASS = ['/api', '/ws', '/health', '/dev', '/debug'];

/** True when the worker must leave the request to the network untouched. */
function bypassed(request, url) {
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true;
  if (request.headers.has('authorization') || request.headers.has('range')) return true;
  return BYPASS.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'));
}

/**
 * Whether a response may be kept under `key`: a plain same-origin 200; HTML for the shell and only
 * for the shell (a missing file answered with the single-page fallback must not be kept as it).
 */
function keepable(response, key) {
  if (!response.ok || response.type !== 'basic' || response.redirected) return false;
  const html = (response.headers.get('content-type') || '').startsWith('text/html');
  return key === SHELL ? html : !html;
}

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (keepable(response, key)) await cache.put(key, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (keepable(response, request.url)) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(BUILD.precache.map((u) => new Request(u, { cache: 'reload' }))),
      ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  // The page asks a waiting worker what it would serve: when the page already runs that build
  // (loaded from the network after the deploy), the update is applied without a banner.
  if (data.type === 'GET_BUILD' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: BUILD.version, precache: BUILD.precache });
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (bypassed(request, url)) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
  } else if (BUILD.precache.includes(url.pathname)) {
    event.respondWith(networkFirst(request, url.pathname));
  }
});
