// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applicationServerKey,
  deviceLabel,
  pushDeviceId,
  pushSupport,
  rememberDevice,
  rememberedDevice,
  sameServerKey,
  syncPush,
  PUSH_DEVICE_KEY,
} from './push.js';
import {
  FakeSubscription,
  SERVER_KEY,
  device,
  fakeApi,
  fakeBrowser,
  keyBytes,
} from './push-fakes.js';

/** Web Push on the page (P7-04): support, the device's id and name, keys, and the re-sync. */

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

beforeEach(() => localStorage.clear());

describe('push on the page (P7-04)', () => {
  it('tells an iPhone in Safari to add the app to the Home Screen', () => {
    expect(pushSupport(fakeBrowser().env)).toBe('supported');
    expect(pushSupport(fakeBrowser({ ua: IPHONE_SAFARI, pushManager: false }).env)).toBe(
      'ios-install',
    );
    expect(
      pushSupport(fakeBrowser({ ua: IPHONE_SAFARI, standalone: true, pushManager: false }).env),
    ).toBe('unsupported');
    expect(pushSupport(fakeBrowser({ secure: false }).env)).toBe('insecure');
    expect(pushSupport(fakeBrowser({ pushManager: false }).env)).toBe('unsupported');
  });

  it('computes the device id the server computes (SHA-256 prefix of the endpoint)', async () => {
    const endpoint = 'https://web.push.apple.com/QGxyz';
    expect(await pushDeviceId(endpoint)).toBe(
      createHash('sha256').update(endpoint).digest('hex').slice(0, 32),
    );
  });

  it('names the device by platform, browser and Home Screen', () => {
    expect(deviceLabel(fakeBrowser().env)).toBe('Android · Chrome');
    expect(deviceLabel(fakeBrowser({ ua: IPHONE_SAFARI, standalone: true }).env)).toBe(
      'iPhone · Safari (Home Screen)',
    );
  });

  it('decodes the server key and recognises a subscription made with another key', () => {
    expect(applicationServerKey(SERVER_KEY)).toEqual(keyBytes(SERVER_KEY));
    expect(applicationServerKey(SERVER_KEY)).toHaveLength(65);
    const ours = new FakeSubscription('https://fcm.googleapis.com/x');
    const theirs = new FakeSubscription('https://fcm.googleapis.com/y', new Uint8Array(65));
    expect(sameServerKey(ours as unknown as PushSubscription, SERVER_KEY)).toBe(true);
    expect(sameServerKey(theirs as unknown as PushSubscription, SERVER_KEY)).toBe(false);
  });

  it('remembers this device’s switches in this browser only', () => {
    expect(rememberedDevice()).toBeUndefined();
    rememberDevice(device('x', { details: true }));
    expect(rememberedDevice()).toMatchObject({ details: true });
    expect(localStorage.getItem(PUSH_DEVICE_KEY)).not.toMatch(/endpoint|token/);
    rememberDevice(undefined);
    expect(rememberedDevice()).toBeUndefined();
  });

  it('re-sends a rotated subscription the server does not know, silently', async () => {
    const held = new FakeSubscription('https://fcm.googleapis.com/fcm/send/rotated');
    const browser = fakeBrowser({ held, permission: 'granted' });
    const { api } = fakeApi();
    // Push never turned on in this browser: nothing is sent.
    expect(await syncPush('t', browser.env, api)).toBe('off');
    expect(api.status).not.toHaveBeenCalled();

    // Turned on with the subscription before the rotation (another id).
    rememberDevice(device('old', { details: true }));
    expect(await syncPush('t', browser.env, api)).toBe('synced');
    expect(api.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: expect.objectContaining({ endpoint: held.endpoint }),
        details: true,
        label: 'Android · Chrome',
      }),
    );
    expect(browser.subscribe).not.toHaveBeenCalled(); // never subscribes anew
    expect(rememberedDevice()?.id).toBe(await pushDeviceId(held.endpoint));
    expect(localStorage.getItem(PUSH_DEVICE_KEY)).not.toMatch(/fcm|endpoint|token/);

    const known = fakeApi({ devices: [device(await pushDeviceId(held.endpoint))] });
    expect(await syncPush('t', browser.env, known.api)).toBe('unchanged');
    expect(known.api.subscribe).not.toHaveBeenCalled();
  });

  it('respects a removal: the same subscription the server forgot is not handed over again', async () => {
    const held = new FakeSubscription('https://fcm.googleapis.com/fcm/send/phone');
    const browser = fakeBrowser({ held, permission: 'granted' });
    rememberDevice(device(await pushDeviceId(held.endpoint)));
    // The Mac removed this device: the server no longer lists it.
    const { api } = fakeApi();
    expect(await syncPush('t', browser.env, api)).toBe('removed');
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(held.unsubscribed).toBe(true);
    expect(rememberedDevice()).toBeUndefined(); // the settings show push off
    // The next session start does nothing more.
    expect(await syncPush('t', browser.env, api)).toBe('off');
    expect(api.subscribe).not.toHaveBeenCalled();
  });

  it('a remembered choice without a device id (older build) is treated as removed', async () => {
    const held = new FakeSubscription('https://fcm.googleapis.com/fcm/send/phone');
    localStorage.setItem(PUSH_DEVICE_KEY, JSON.stringify({ kinds: {}, details: false }));
    const { api } = fakeApi();
    expect(await syncPush('t', fakeBrowser({ held }).env, api)).toBe('removed');
    expect(api.subscribe).not.toHaveBeenCalled();
  });

  it('learns the device id of a known subscription remembered without one', async () => {
    const held = new FakeSubscription('https://fcm.googleapis.com/fcm/send/phone');
    const id = await pushDeviceId(held.endpoint);
    localStorage.setItem(PUSH_DEVICE_KEY, JSON.stringify({ kinds: {}, details: true }));
    const { api } = fakeApi({ devices: [device(id)] });
    expect(await syncPush('t', fakeBrowser({ held }).env, api)).toBe('unchanged');
    expect(rememberedDevice()).toMatchObject({ id, details: true });
  });

  it('a subscription bound to another server key is not re-sent', async () => {
    rememberDevice(device('old'));
    const held = new FakeSubscription('https://fcm.googleapis.com/x', new Uint8Array(65));
    const { api } = fakeApi();
    expect(await syncPush('t', fakeBrowser({ held }).env, api)).toBe('off');
    expect(api.subscribe).not.toHaveBeenCalled();
  });
});
