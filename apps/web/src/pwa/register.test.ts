// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INSTALL_DISMISSED_KEY,
  registerPwa,
  usePwa,
  UPDATE_CHECK_MS,
  type InstallPromptEvent,
} from './register.js';

/**
 * The page side of the installable app (P7-01): production-only registration, the update flow
 * (silent when the page already runs the new build, else the "new version" notice and a reload
 * once the new worker has control), and the install offer on touch devices.
 */

const ENTRY = '/assets/index-current.js';

class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  messages: unknown[] = [];
  constructor(
    state: ServiceWorkerState,
    private precache: string[] | undefined,
  ) {
    super();
    this.state = state;
  }
  postMessage(message: { type: string }, transfer?: MessagePort[]) {
    this.messages.push(message);
    if (message.type === 'GET_BUILD' && this.precache) {
      transfer?.[0]?.postMessage({ version: 'x', precache: this.precache });
    }
  }
  setState(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(async () => undefined);
  unregister = vi.fn(async () => true);
}

class FakeContainer extends EventTarget {
  controller: object | null = null;
  registration = new FakeRegistration();
  register = vi.fn(async () => this.registration);
  getRegistrations = vi.fn(async () => [this.registration]);
}

let container: FakeContainer;
let reload: ReturnType<typeof vi.fn>;
let teardown: (() => void) | undefined;
let coarse = false;

function fakeNavigator(extra: Partial<Navigator> = {}): Navigator {
  return {
    serviceWorker: container,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140',
    platform: 'Linux',
    maxTouchPoints: 5,
    ...extra,
  } as unknown as Navigator;
}

function fakeWindow(): Window {
  // The real jsdom window for events and the document; reload and media queries stubbed.
  return new Proxy(window, {
    get(target, prop) {
      if (prop === 'location') return { reload };
      if (prop === 'matchMedia')
        return (q: string) => ({ matches: q === '(pointer: coarse)' && coarse });
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function start(prod = true, nav = fakeNavigator()) {
  teardown = registerPwa({ prod, win: fakeWindow(), nav });
}

beforeEach(() => {
  container = new FakeContainer();
  reload = vi.fn();
  coarse = false;
  localStorage.clear();
  usePwa.setState({ update: undefined, install: undefined, iosHint: false });
  document.head.innerHTML = `<script type="module" src="${ENTRY}"></script>`;
});
afterEach(() => {
  teardown?.();
  teardown = undefined;
  vi.useRealTimers();
});

describe('service worker registration (P7-01)', () => {
  it('registers nothing in development and removes a leftover worker', async () => {
    start(false);
    await settle();
    expect(container.register).not.toHaveBeenCalled();
    expect(container.registration.unregister).toHaveBeenCalled();
  });

  it('registers /sw.js for the whole app in production, bypassing the HTTP cache', async () => {
    start();
    await settle();
    expect(container.register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  });

  it('works without service workers at all', () => {
    expect(() => start(true, { userAgent: '' } as Navigator)).not.toThrow();
  });

  it('says nothing about the first install', async () => {
    container.registration.installing = new FakeWorker('installing', ['/']);
    start();
    await settle();
    container.registration.installing.setState('installed');
    await settle();
    expect(usePwa.getState().update).toBeUndefined();
    container.dispatchEvent(new Event('controllerchange')); // clients.claim()
    expect(reload).not.toHaveBeenCalled();
  });

  it('takes a new build the page already runs silently', async () => {
    container.controller = {};
    const waiting = new FakeWorker('installed', ['/', ENTRY]);
    container.registration.waiting = waiting;
    start();
    await settle();
    expect(waiting.messages).toContainEqual({ type: 'SKIP_WAITING' });
    expect(usePwa.getState().update).toBeUndefined();
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('offers a reload for a deploy found while the page runs, and reloads once in control', async () => {
    container.controller = {};
    start();
    await settle();
    const next = new FakeWorker('installing', ['/', '/assets/index-next.js']);
    container.registration.installing = next;
    container.registration.dispatchEvent(new Event('updatefound'));
    next.setState('installed');
    await settle();
    const update = usePwa.getState().update;
    expect(update).toBeTypeOf('function');
    expect(next.messages).not.toContainEqual({ type: 'SKIP_WAITING' });

    update!();
    expect(usePwa.getState().update).toBeUndefined();
    expect(next.messages).toContainEqual({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offers the reload when the new worker does not say what it serves', async () => {
    container.controller = {};
    container.registration.waiting = new FakeWorker('installed', undefined);
    start();
    await new Promise((r) => setTimeout(r, 1700));
    expect(usePwa.getState().update).toBeTypeOf('function');
  });

  it('reloads straight away when the offered worker is gone', async () => {
    container.controller = {};
    const waiting = new FakeWorker('installed', ['/other']);
    container.registration.waiting = waiting;
    start();
    await settle();
    waiting.state = 'redundant';
    usePwa.getState().update!();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('checks for a new deploy on returning to the app and every 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    start();
    await settle();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(container.registration.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UPDATE_CHECK_MS);
    expect(container.registration.update).toHaveBeenCalledTimes(2);
  });
});

function installEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const e = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
  const prompt = vi.fn(async () => undefined);
  Object.assign(e, { prompt, userChoice: Promise.resolve({ outcome }) });
  return { e, prompt };
}

describe('the install offer (P7-01)', () => {
  it('on a touch device, keeps the browser offer for the notice', async () => {
    coarse = true;
    start();
    const { e, prompt } = installEvent();
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(usePwa.getState().install).toBe(e);
    await usePwa.getState().runInstall();
    expect(prompt).toHaveBeenCalled();
    expect(usePwa.getState().install).toBeUndefined();
    expect(localStorage.getItem(INSTALL_DISMISSED_KEY)).toBeNull();
  });

  it('remembers a refused install in this browser', async () => {
    coarse = true;
    start();
    window.dispatchEvent(installEvent('dismissed').e);
    await usePwa.getState().runInstall();
    expect(localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe('1');
    teardown!();
    start();
    const again = installEvent().e;
    window.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
    expect(usePwa.getState().install).toBeUndefined();
  });

  it('leaves the desktop to the browser', () => {
    start();
    const { e } = installEvent();
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(usePwa.getState().install).toBeUndefined();
  });

  it('explains Add to Home Screen on iOS, not once installed or dismissed', () => {
    coarse = true;
    const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' };
    start(true, fakeNavigator(iphone));
    expect(usePwa.getState().iosHint).toBe(true);
    usePwa.getState().dismissInstall();
    expect(usePwa.getState().iosHint).toBe(false);
    teardown!();
    start(true, fakeNavigator(iphone));
    expect(usePwa.getState().iosHint).toBe(false);

    localStorage.clear();
    teardown!();
    start(true, fakeNavigator({ ...iphone, standalone: true } as Partial<Navigator>));
    expect(usePwa.getState().iosHint).toBe(false);
  });

  it('forgets the offer once the app is installed', () => {
    coarse = true;
    start();
    window.dispatchEvent(installEvent().e);
    window.dispatchEvent(new Event('appinstalled'));
    expect(usePwa.getState().install).toBeUndefined();
  });
});
