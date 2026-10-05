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

/*
 * Web Push (P7-04, SPEC §4.5): the server sends a push for a question or permission held by the
 * user and for a project that finished or failed. The payload is minimal (title, an optional body
 * the device chose to receive, the notification id and what a tap opens) and never carries a
 * credential. One notification per device: the page's own desktop notifications use the same id
 * as their tag, so a push for something the page already showed replaces it in place (same tag,
 * `renotify: false`: no second alert) rather than stacking a copy. A push always calls
 * `showNotification` — even when that tag is already on screen: Safari on iOS counts a push that
 * does not call it as a silent push and revokes the subscription after a few, and browsers
 * penalise a push that shows nothing. The conservative answer to the SPEC §8 question
 * (2026-10-03) is that notifications show even while the app is in front.
 */

const PUSH_ICON = '/icons/icon-192.png';
const PUSH_DEFAULT_BODY = 'Open GalacticAgents to see it.';
const PUSH_TARGET_KINDS = ['question', 'task', 'project', 'agent', 'proposal'];

/** The push's notification, or undefined when the payload is missing or not ours. */
function pushNotification(event) {
  let data;
  try {
    data = event.data ? event.data.json() : undefined;
  } catch {
    data = undefined;
  }
  if (!data || typeof data !== 'object' || data.v !== 1) return undefined;
  if (typeof data.id !== 'string' || !data.id || typeof data.title !== 'string' || !data.title) {
    return undefined;
  }
  const t = data.target;
  const target =
    t && PUSH_TARGET_KINDS.includes(t.kind) && typeof t.id === 'string' && t.id
      ? { kind: t.kind, id: t.id }
      : undefined;
  return {
    id: data.id.slice(0, 200),
    title: data.title.slice(0, 120),
    body: typeof data.body === 'string' && data.body ? data.body.slice(0, 200) : undefined,
    target,
  };
}

async function showPush(n) {
  const shown = n || { id: 'galactic:push', title: 'GalacticAgents', target: undefined };
  // Always shown, never skipped (iOS revokes a subscription whose pushes show nothing): when the
  // page or an earlier copy of this push already showed it, the same tag replaces it in place
  // without alerting again, keeping its text (the page's carries details a push may leave out).
  let existing = [];
  try {
    existing = await self.registration.getNotifications({ tag: shown.id });
  } catch {
    existing = [];
  }
  const prior = existing[0];
  await self.registration.showNotification(prior ? prior.title : shown.title, {
    body: prior && prior.body ? prior.body : shown.body || PUSH_DEFAULT_BODY,
    tag: shown.id,
    renotify: false,
    icon: PUSH_ICON,
    badge: PUSH_ICON,
    data: prior && prior.data ? prior.data : { id: shown.id, target: shown.target },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(showPush(pushNotification(event)));
});

/** Where a tap opens the app when no window is open: the page reads `#focus=` (no credential). */
function focusUrl(target) {
  return '/#focus=' + (target ? encodeURIComponent(target.kind + ':' + target.id) : 'inbox');
}

/** A tap focuses an open window and tells it what to select, else opens one at the target. */
async function openNotification(data) {
  const target = data && data.target ? data.target : undefined;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const ours = windows.filter((c) => {
    try {
      return new URL(c.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  const client =
    ours.find((c) => c.focused) || ours.find((c) => c.visibilityState === 'visible') || ours[0];
  if (client) {
    try {
      await client.focus();
    } catch {
      // Not allowed (no user activation passed on): the message still selects the item.
    }
    client.postMessage({ type: 'NOTIFICATION_CLICK', target: target || null });
    return;
  }
  await self.clients.openWindow(focusUrl(target));
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openNotification(event.notification.data));
});
