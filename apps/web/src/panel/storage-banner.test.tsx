// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_ERROR, STORAGE_OK, type StorageHealth } from '@galactic/protocol';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAnswerQueue } from '../client/answer-queue.js';
import { useAppStore } from '../state/store.js';
import { axeFindings, blocking, fullSnapshot, openApp, quietFetch } from '../a11y/a11y-fixtures.js';
import { storageBannerText } from './StorageBanner.js';

/**
 * P8-09: the storage banner — "Disk full — N agent events waiting to be saved; your actions are
 * refused until there is space", a distinct message for a database that cannot be written at
 * all, the announcements (assertive in, polite out, never the moving count), the banner clearing
 * when the held events are written, and a refused action saying the disk is full on its control.
 */

const full: StorageHealth = {
  condition: 'full',
  held: 42,
  dropped: 0,
  since: '2026-10-06T10:42:00.000Z',
  error: 'database or disk is full',
};

const refusal = (condition: 'full' | 'unwritable') =>
  new Response(
    JSON.stringify({
      error: STORAGE_ERROR[condition].code,
      message: STORAGE_ERROR[condition].message,
    }),
    { status: STORAGE_ERROR[condition].status },
  );

let reply: ((url: string, init?: RequestInit) => Response | undefined) | undefined;

beforeEach(() => {
  reply = undefined;
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  useAppStore.getState().reset();
  useAnswerQueue.setState({ scope: undefined, entries: {}, announcement: undefined });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    quietFetch((url, init) => reply?.(url, init)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const socket = () => FakeWebSocket.instances.at(-1)!;
const banner = () => screen.queryByRole('region', { name: 'Storage problem' });
const alertText = () =>
  Array.from(document.querySelectorAll('.pnl-visually-hidden[role="alert"]'))
    .map((n) => n.textContent)
    .join(' | ');
const politeText = () =>
  Array.from(document.querySelectorAll('[role="status"][aria-live="polite"]'))
    .map((n) => n.textContent)
    .join(' | ');
/** What the server sends when the storage changes: the whole record set, replacing, plus it. */
const storageMessage = (storage: StorageHealth) =>
  act(async () =>
    socket().serverSends({
      type: 'status',
      statuses: Object.values(useAppStore.getState().world.statuses),
      replace: true,
      storage,
    }),
  );
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
};

describe('storage banner words (P8-09)', () => {
  it('says the disk is full and how many agent events wait, or that the file cannot be written', () => {
    expect(storageBannerText(STORAGE_OK)).toBeUndefined();
    expect(storageBannerText(full)?.title).toBe(
      'Disk full — 42 agent events waiting to be saved; your actions are refused until there is space.',
    );
    expect(storageBannerText({ ...full, held: 1 })?.title).toMatch(/— 1 agent event waiting/);
    expect(storageBannerText({ ...full, held: 0 })?.title).toBe(
      'Disk full — your actions are refused until there is space.',
    );
    expect(storageBannerText({ ...full, dropped: 3 })?.detail).toMatch(
      /3 older tool calls and progress lines were not kept/,
    );
    const ro = storageBannerText({ ...full, condition: 'unwritable' })!;
    expect(ro.title).toMatch(
      /^The database cannot be written \(the file is read-only or missing\)/,
    );
    expect(ro.title).toMatch(/refused until it is fixed\.$/);
    expect(ro.detail).toMatch(/does not pass by itself/);
    expect(storageBannerText({ ...full, condition: 'unavailable' })?.title).toMatch(
      /^The database cannot be written just now/,
    );
  });
});

describe('the storage banner in the panel (P8-09)', () => {
  it('shows nothing while the storage is ok', async () => {
    await openApp('/');
    expect(banner()).toBeNull();
    expect(alertText()).toBe('');
  });

  it('appears when the disk fills, follows the count quietly, and clears when the events are written', async () => {
    await openApp('/');
    await storageMessage(full);
    expect(banner()?.textContent).toMatch(
      /^Disk full — 42 agent events waiting to be saved; your actions are refused until there is space\./,
    );
    expect(banner()?.getAttribute('data-condition')).toBe('full');
    expect(alertText()).toBe('Disk full: your actions are refused until there is space.');
    expect(blocking(await axeFindings())).toEqual([]);

    // The count moves: the band follows, the announcement does not repeat it.
    await storageMessage({ ...full, held: 97 });
    expect(banner()?.textContent).toMatch(/97 agent events waiting/);
    expect(alertText()).toBe('Disk full: your actions are refused until there is space.');
    // The replacing set kept the status records.
    expect(Object.keys(useAppStore.getState().world.statuses)).toHaveLength(5);

    await storageMessage(STORAGE_OK);
    expect(banner()).toBeNull();
    expect(alertText()).toBe('');
    expect(politeText()).toMatch(/The database takes writes again/);
  });

  it('a page opened on a full disk shows the banner from the snapshot', async () => {
    await openApp('/', fullSnapshot({ storage: full }));
    expect(banner()?.textContent).toMatch(/^Disk full — 42 agent events waiting/);
    expect(alertText()).toMatch(/Disk full/);
  });

  it('a database that cannot be written has its own words', async () => {
    await openApp('/', fullSnapshot({ storage: { ...full, condition: 'unwritable', held: 0 } }));
    expect(banner()?.textContent).toMatch(
      /^The database cannot be written \(the file is read-only or missing\) — your actions are refused until it is fixed\./,
    );
    expect(alertText()).toMatch(/until the file is fixed/);
    expect(blocking(await axeFindings())).toEqual([]);
  });

  it('a refused control says the disk is full, on the control', async () => {
    reply = (url) => (url === '/api/control' ? refusal('full') : undefined);
    await openApp('/waykeeper/a-waykeeper-1', fullSnapshot({ storage: full }));
    const main = screen.getByRole('main');
    await click(within(main).getByRole('button', { name: 'Pause the project' }));
    // Under the strip that sent it.
    const strip = within(main).getByRole('group', { name: /^controls of / });
    await vi.waitFor(() =>
      expect(
        within(strip.parentElement!)
          .getAllByRole('alert')
          .map((a) => a.textContent),
      ).toContain(STORAGE_ERROR.full.message),
    );
  });

  it('an answer refused for a full disk is shown on its card, not queued (decision 99)', async () => {
    reply = (url) => (url.endsWith('/answer') ? refusal('full') : undefined);
    await openApp('/', fullSnapshot({ storage: full }));
    const inbox = screen.getByRole('region', { name: 'question inbox' });
    const card = within(inbox).getByRole('article', {
      name: 'clarification question Keep the legacy cookie name?',
    });
    await click(within(card).getByRole('button', { name: 'yes' }));
    expect(within(card).queryByRole('group', { name: 'queued answer' })).toBeNull();
    expect(within(card).getByRole('alert').textContent).toMatch(/^The disk is full/);
    expect(useAnswerQueue.getState().entries).toEqual({});
    // Still answerable once there is room.
    expect(within(card).getByRole('button', { name: 'yes' })).toBeTruthy();
  });
});
