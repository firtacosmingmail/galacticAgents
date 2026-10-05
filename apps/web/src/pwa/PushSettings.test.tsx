// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axeFindings, blocking, type AxeFinding } from '../a11y/a11y-fixtures.js';
import { PushSettings } from './PushSettings.js';
import { pushDeviceId, rememberedDevice } from './push.js';
import {
  FakeSubscription,
  SERVER_KEY,
  device,
  fakeApi,
  fakeBrowser,
  keyBytes,
} from './push-fakes.js';

/**
 * The settings' push block (P7-04): turning push on only from the click, per-device switches, the
 * test push, turning off, other devices (removable from the Mac only), the iOS caveat, and no
 * serious or critical axe findings (P5-04's bar).
 */

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

async function noBlockingFindings(name: string) {
  expect(blocking(await axeFindings()), name).toEqual<AxeFinding[]>([]);
}

/** Waits until a control is enabled again (the previous action settled). */
const enabled = (el: HTMLElement) => waitFor(() => expect(el.matches(':disabled')).toBe(false));

describe('PushSettings (P7-04)', () => {
  it('on an iPhone in Safari, explains the Home Screen install', async () => {
    const { api } = fakeApi();
    render(
      <PushSettings
        token="t"
        env={fakeBrowser({ ua: IPHONE_SAFARI, pushManager: false }).env}
        api={api}
      />,
    );
    expect(await screen.findByText(/Add to Home Screen/)).toBeTruthy();
    expect(api.status).not.toHaveBeenCalled();
    await noBlockingFindings('ios');
  });

  it('without a service worker (development), says where push works', async () => {
    const { api } = fakeApi();
    render(<PushSettings token="t" env={fakeBrowser({ registration: false }).env} api={api} />);
    expect(await screen.findByText(/service worker/)).toBeTruthy();
  });

  it('asks the browser only on the click, then subscribes with the server key', async () => {
    const browser = fakeBrowser();
    const { api } = fakeApi();
    render(<PushSettings token="t" env={browser.env} api={api} />);
    const button = await screen.findByRole('button', { name: 'Turn on push notifications' });
    expect(browser.subscribe).not.toHaveBeenCalled();
    // The switches wait until push is on.
    expect(screen.getByRole('checkbox', { name: /permission request/ }).matches(':disabled')).toBe(
      true,
    );
    await noBlockingFindings('off');

    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Turn off' });
    expect(browser.subscribe).toHaveBeenCalledTimes(1);
    const opts = browser.subscribe.mock.calls[0]![0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(opts.userVisibleOnly).toBe(true);
    expect([...opts.applicationServerKey]).toEqual([...keyBytes(SERVER_KEY)]);
    expect(api.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Android · Chrome',
        details: false,
        kinds: { permission: true, question: true, project_completed: true, project_failed: true },
      }),
    );
    expect(rememberedDevice()).toMatchObject({ details: false });
    expect(screen.getByRole('status').textContent).toMatch(/on for this device/);
    await noBlockingFindings('on');
  });

  it('switches a kind and the details per device, tests, and turns off', async () => {
    const held = new FakeSubscription('https://fcm.googleapis.com/fcm/send/mine');
    const browser = fakeBrowser({ held, permission: 'granted' });
    const mine = device(await pushDeviceId(held.endpoint), { label: 'Android · Chrome' });
    const { api } = fakeApi({ devices: [mine] });
    render(<PushSettings token="t" env={browser.env} api={api} />);
    await screen.findByText(/On for this device \(Android · Chrome\)/);

    fireEvent.click(screen.getByRole('checkbox', { name: /A project finished/ }));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledTimes(1));
    expect(api.subscribe.mock.calls[0]![0]).toMatchObject({
      kinds: { project_completed: false, question: true },
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', { name: /A project finished/ }) as HTMLInputElement).checked,
      ).toBe(false),
    );

    await enabled(screen.getByRole('checkbox', { name: /lock screen/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /lock screen/ }));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledTimes(2));
    expect(api.subscribe.mock.calls[1]![0]).toMatchObject({
      details: true,
      kinds: { project_completed: false },
    });

    // Each save leaves the controls disabled until it settles: a click before that is lost.
    await enabled(screen.getByRole('button', { name: 'Send a test push' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send a test push' }));
    await screen.findByText(/Test push sent/);
    expect(api.test).toHaveBeenCalledWith(held.endpoint);

    await enabled(screen.getByRole('button', { name: 'Turn off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await screen.findByRole('button', { name: 'Turn on push notifications' });
    expect(api.unsubscribe).toHaveBeenCalledWith(held.endpoint);
    expect(held.unsubscribed).toBe(true);
    expect(rememberedDevice()).toBeUndefined();
  });

  it('lists other devices; only a local client may remove them', async () => {
    const phone = device('0'.repeat(32), { label: 'iPhone · Safari (Home Screen)' });
    const local = fakeApi({ devices: [phone], canRemoveOthers: true });
    render(<PushSettings token="t" env={fakeBrowser().env} api={local.api} />);
    const remove = await screen.findByRole('button', {
      name: 'Remove push notifications from iPhone · Safari (Home Screen)',
    });
    await noBlockingFindings('others');
    fireEvent.click(remove);
    await waitFor(() => expect(local.api.remove).toHaveBeenCalledWith(phone.id));
    await waitFor(() => expect(screen.queryByText('iPhone · Safari (Home Screen)')).toBeNull());
    cleanup();

    const remote = fakeApi({ devices: [phone], canRemoveOthers: false });
    render(<PushSettings token="t" env={fakeBrowser().env} api={remote.api} />);
    await screen.findByText('iPhone · Safari (Home Screen)');
    expect(screen.queryByRole('button', { name: /Remove push/ })).toBeNull();
  });

  it('a blocked permission is explained; a failed call is announced', async () => {
    const { api } = fakeApi();
    render(<PushSettings token="t" env={fakeBrowser({ permission: 'denied' }).env} api={api} />);
    expect(await screen.findByText(/blocked for this site/)).toBeTruthy();
    cleanup();

    const failing = fakeApi();
    failing.api.subscribe.mockRejectedValueOnce(new Error('invalid_endpoint'));
    render(<PushSettings token="t" env={fakeBrowser().env} api={failing.api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on push notifications' }));
    expect((await screen.findByRole('alert')).textContent).toContain('invalid_endpoint');
  });

  it('a server it cannot read offers to try again', async () => {
    const { api } = fakeApi();
    api.status.mockRejectedValueOnce(new Error('offline'));
    render(<PushSettings token="t" env={fakeBrowser().env} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Turn on push notifications' })).toBeTruthy();
  });
});
