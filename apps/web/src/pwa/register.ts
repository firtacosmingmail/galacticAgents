import { create } from 'zustand';

/**
 * The installable app's page side (P7-01, TECHNOLOGY §2.4): registers the service worker in
 * production builds, turns a new deploy into a "new version available — reload" notice, and keeps
 * the browser's install offer for the notice that proposes installing.
 *
 * Update flow: the browser checks `/sw.js` on every load (the server sends it `no-cache`) and the
 * page asks again when it comes back to the foreground and every 30 minutes. A new worker installs
 * and waits. If the page already runs that build (it loaded its shell from the network after the
 * deploy — navigations are network-first), the worker takes over silently; otherwise the notice
 * offers a reload: the waiting worker takes over, and the page reloads once control has passed.
 * Development (`vite`) registers nothing and removes any worker a production build left behind
 * on the same origin, so Vite's hot reload is never served from a cache.
 */

/** Chrome's install offer (not in the DOM typings). */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const INSTALL_DISMISSED_KEY = 'galactic.pwa.installDismissed';
export const UPDATE_CHECK_MS = 30 * 60 * 1000;
const ASK_TIMEOUT_MS = 1500;

interface PwaState {
  /** A new build waits; applying it reloads the page. */
  update: (() => void) | undefined;
  /** The browser's deferred install offer (Chrome, Edge, Android). */
  install: InstallPromptEvent | undefined;
  /** iOS has no install offer: the notice explains Share → "Add to Home Screen". */
  iosHint: boolean;
  dismissUpdate(): void;
  dismissInstall(): void;
  runInstall(): Promise<void>;
}

export const usePwa = create<PwaState>((set, get) => ({
  update: undefined,
  install: undefined,
  iosHint: false,
  dismissUpdate: () => set({ update: undefined }),
  dismissInstall: () => {
    rememberInstallDismissed();
    set({ install: undefined, iosHint: false });
  },
  runInstall: async () => {
    const offer = get().install;
    if (!offer) return;
    set({ install: undefined });
    await offer.prompt();
    const choice = await offer.userChoice;
    if (choice.outcome === 'dismissed') rememberInstallDismissed();
  },
}));

function rememberInstallDismissed() {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
  } catch {
    // Storage blocked: the notice comes back on the next load, nothing worse.
  }
}

function installDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** The page's own entry script (`/assets/index-<hash>.js`): which build this page runs. */
export function currentEntry(doc: Document = document): string | undefined {
  const script = doc.querySelector<HTMLScriptElement>('script[type="module"][src]');
  if (!script) return undefined;
  try {
    return new URL(script.src, doc.baseURI).pathname;
  } catch {
    return undefined;
  }
}

/** Asks a worker for its build; undefined when it does not answer in time. */
function askBuild(worker: ServiceWorker): Promise<{ precache: string[] } | undefined> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(undefined), ASK_TIMEOUT_MS);
    channel.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      const data = e.data as { precache?: unknown } | undefined;
      resolve(Array.isArray(data?.precache) ? { precache: data.precache as string[] } : undefined);
    };
    worker.postMessage({ type: 'GET_BUILD' }, [channel.port2]);
  });
}

export interface RegisterEnv {
  prod: boolean;
  win: Window;
  nav: Navigator;
}

/**
 * Wires the service worker and the install offer; returns a teardown (tests). Call once, at load.
 */
export function registerPwa(
  env: RegisterEnv = { prod: import.meta.env.PROD, win: window, nav: navigator },
): () => void {
  const { win, nav } = env;
  const cleanups: (() => void)[] = [];
  watchInstallOffer(win, nav, cleanups);

  const sw = 'serviceWorker' in nav ? nav.serviceWorker : undefined;
  if (!sw) return () => cleanups.forEach((c) => c());
  if (!env.prod) {
    void sw
      .getRegistrations()
      .then((all) => Promise.all(all.map((r) => r.unregister())))
      .catch(() => undefined);
    return () => cleanups.forEach((c) => c());
  }

  // Reload only for an update the user asked for: the first install's `clients.claim()` and a
  // silent takeover change the controller too.
  let applying = false;
  const reloadOnce = () => {
    if (!applying) return;
    applying = false;
    win.location.reload();
  };
  sw.addEventListener('controllerchange', reloadOnce);
  cleanups.push(() => sw.removeEventListener('controllerchange', reloadOnce));

  const offer = async (worker: ServiceWorker, reg: ServiceWorkerRegistration) => {
    // No active worker: the first install, nothing to update. A page without a controller but
    // with an active worker (a hard reload, or before `clients.claim()` lands) still gets the
    // offer (P7-01 review).
    if (!reg.active) return;
    const entry = currentEntry(win.document);
    const build = await askBuild(worker);
    if (entry && build?.precache.includes(entry)) {
      worker.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
    usePwa.setState({
      update: () => {
        usePwa.setState({ update: undefined });
        // No longer waiting: another tab applied it (it is active) or it was replaced. A plain
        // reload loads whatever now serves the page (P7-01 review: two tabs).
        if (worker.state !== 'installed') {
          win.location.reload();
          return;
        }
        applying = true;
        // `controllerchange` reloads; a page no worker controls gets none, so the new worker
        // reaching `activated` does too — whichever comes first.
        const onActivated = () => {
          if (worker.state === 'activated' || worker.state === 'redundant') {
            worker.removeEventListener('statechange', onActivated);
          }
          if (worker.state === 'activated') reloadOnce();
        };
        worker.addEventListener('statechange', onActivated);
        worker.postMessage({ type: 'SKIP_WAITING' });
      },
    });
  };
  const track = (worker: ServiceWorker | null, reg: ServiceWorkerRegistration) => {
    if (!worker) return;
    warnIfDiscarded(worker);
    if (worker.state === 'installed') {
      void offer(worker, reg);
      return;
    }
    const onState = () => {
      if (worker.state === 'installed') void offer(worker, reg);
      if (worker.state === 'installed' || worker.state === 'redundant') {
        worker.removeEventListener('statechange', onState);
      }
    };
    worker.addEventListener('statechange', onState);
  };

  let cancelled = false;
  // After the page has loaded: the worker's precache must not compete with the first paint.
  const start = () =>
    sw
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        if (cancelled) return;
        track(reg.waiting, reg);
        track(reg.installing, reg);
        const onFound = () => track(reg.installing, reg);
        reg.addEventListener('updatefound', onFound);
        const check = () => void reg.update().catch(() => undefined);
        const onVisible = () => {
          if (win.document.visibilityState === 'visible') check();
        };
        win.document.addEventListener('visibilitychange', onVisible);
        const timer = win.setInterval(check, UPDATE_CHECK_MS);
        cleanups.push(() => {
          reg.removeEventListener('updatefound', onFound);
          win.document.removeEventListener('visibilitychange', onVisible);
          win.clearInterval(timer);
        });
      })
      .catch(() => undefined); // no worker (blocked, insecure origin): the app works without one
  if (win.document.readyState === 'complete') void start();
  else {
    const onLoad = () => void start();
    win.addEventListener('load', onLoad, { once: true });
    cleanups.push(() => win.removeEventListener('load', onLoad));
  }
  return () => {
    cancelled = true;
    cleanups.forEach((c) => c());
  };
}

/**
 * Logs a new worker that goes redundant without ever activating (P7-01 review): its install failed
 * — most often a precache file the server does not have, such as a build made while the server
 * kept serving the old one — or a newer worker replaced it. Either way the page keeps the old
 * build without a word, so the console says so.
 */
function warnIfDiscarded(worker: ServiceWorker) {
  let activated = false;
  const onState = () => {
    if (worker.state === 'activating' || worker.state === 'activated') activated = true;
    if (worker.state !== 'redundant' && !activated) return;
    worker.removeEventListener('statechange', onState);
    if (worker.state === 'redundant' && !activated) {
      console.warn(
        '[pwa] A new service worker was discarded before it activated (its install failed, or a ' +
          'newer one replaced it). The page keeps its current version.',
      );
    }
  };
  worker.addEventListener('statechange', onState);
}

/** Running as the installed app (Home Screen, standalone window). */
export function isStandalone(win: Window, nav: Navigator): boolean {
  return (
    win.matchMedia?.('(display-mode: standalone)').matches === true ||
    (nav as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone, iPad (also the iPad that reports itself as a Mac), iPod. */
export function isIos(nav: Navigator): boolean {
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  );
}

/**
 * The install offer is proposed on touch devices only (phones, tablets) — the desktop keeps the
 * browser's own install button — while not installed and not dismissed in this browser.
 */
function watchInstallOffer(win: Window, nav: Navigator, cleanups: (() => void)[]) {
  const touch = win.matchMedia?.('(pointer: coarse)').matches === true;
  if (!touch || isStandalone(win, nav) || installDismissed()) return;
  if (isIos(nav)) usePwa.setState({ iosHint: true });
  const onOffer = (e: Event) => {
    e.preventDefault(); // the notice proposes it instead of the browser's mini-infobar
    usePwa.setState({ install: e as InstallPromptEvent });
  };
  const onInstalled = () => usePwa.setState({ install: undefined, iosHint: false });
  win.addEventListener('beforeinstallprompt', onOffer);
  win.addEventListener('appinstalled', onInstalled);
  cleanups.push(() => {
    win.removeEventListener('beforeinstallprompt', onOffer);
    win.removeEventListener('appinstalled', onInstalled);
  });
}
