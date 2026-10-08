// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const focusTarget = vi.fn();
vi.mock('../panel/notifications/focus.js', () => ({ focusTarget }));

const { takeFocusFromFragment, wireNotificationClicks } = await import('./notification-clicks.js');
const { useAppStore } = await import('../state/store.js');

/**
 * Taps on notifications shown by the service worker (P7-04): `#focus=` on a window the worker
 * opened, and `NOTIFICATION_CLICK` messages to a window already open — both select the item once
 * the world has arrived.
 */

class FakeContainer extends EventTarget {}

beforeEach(() => {
  focusTarget.mockClear();
  useAppStore.setState({ snapshots: 0 });
  window.history.replaceState(null, '', '/');
});
let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
});

describe('notification taps (P7-04)', () => {
  it('reads #focus= and removes it from the address bar, keeping other keys', () => {
    window.history.replaceState(null, '', '/settings?x=1#focus=question%3Aq1&other=2');
    expect(takeFocusFromFragment()).toEqual({ kind: 'question', id: 'q1' });
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/settings?x=1#other=2',
    );
    window.history.replaceState(null, '', '/#focus=inbox');
    expect(takeFocusFromFragment()).toBe('inbox');
    window.history.replaceState(null, '', '/#focus=evil%3Ax');
    expect(takeFocusFromFragment()).toBeUndefined();
    expect(window.location.hash).toBe('');
    window.history.replaceState(null, '', '/#token=abc');
    expect(takeFocusFromFragment()).toBeUndefined();
    expect(window.location.hash).toBe('#token=abc'); // the token's own handling is P7-02's
  });

  it('an app opened by a tap selects the item after the first snapshot', () => {
    window.history.replaceState(null, '', '/#focus=project%3Ap1');
    teardown = wireNotificationClicks(window, {} as Navigator);
    expect(focusTarget).not.toHaveBeenCalled();
    useAppStore.setState({ snapshots: 1 });
    expect(focusTarget).toHaveBeenCalledWith({ kind: 'project', id: 'p1' });
    useAppStore.setState({ snapshots: 2 });
    expect(focusTarget).toHaveBeenCalledTimes(1);
  });

  it('an open window selects what the worker says; junk opens the inbox; others are ignored', () => {
    useAppStore.setState({ snapshots: 1 });
    const container = new FakeContainer();
    teardown = wireNotificationClicks(window, { serviceWorker: container } as unknown as Navigator);
    const send = (data: unknown) =>
      container.dispatchEvent(Object.assign(new Event('message'), { data }));
    send({ type: 'NOTIFICATION_CLICK', target: { kind: 'question', id: 'q1' } });
    send({ type: 'NOTIFICATION_CLICK', target: null });
    send({ type: 'NOTIFICATION_CLICK', target: { kind: 'evil', id: 'x' } });
    send({ type: 'SOMETHING_ELSE' });
    expect(focusTarget.mock.calls).toEqual([
      [{ kind: 'question', id: 'q1' }],
      [undefined],
      [undefined],
    ]);
  });

  it('a #focus= set on an open page (the desktop menu bar, P9-15) selects the item', () => {
    useAppStore.setState({ snapshots: 1 });
    teardown = wireNotificationClicks(window, {} as Navigator);
    window.history.replaceState(null, '', '/#focus=question%3Aq9');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(focusTarget).toHaveBeenCalledWith({ kind: 'question', id: 'q9' });
    expect(window.location.hash).toBe('');
    window.history.replaceState(null, '', '/#other=1');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(focusTarget).toHaveBeenCalledTimes(1);
  });

  it('taps before the world arrives keep one waiting focus, the latest (wave-6 review)', () => {
    teardown = wireNotificationClicks(window, {} as Navigator);
    for (const id of ['q1', 'q2', 'q3']) {
      window.history.replaceState(null, '', `/#focus=question%3A${id}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
    useAppStore.setState({ snapshots: 1 });
    expect(focusTarget.mock.calls).toEqual([[{ kind: 'question', id: 'q3' }]]);
  });
});
