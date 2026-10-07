// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY } from '../panel/use-media-query.js';
import { SCENE_VISIBLE_KEY } from '../scene/visibility.js';
import {
  axeFindings,
  blocking,
  openApp,
  quietFetch,
  stubMedia,
  type AxeFinding,
} from './a11y-fixtures.js';

/**
 * P5-04: axe-core over every main view of the panel, in jsdom (no colour contrast: no layout, no
 * CSS). Zero serious or critical findings, violations and "needs review" alike. Set
 * `A11Y_REPORT=<file>` to append every finding, minor and moderate included, to a file (the
 * summary in `docs/tasks/notes/P5-04-a11y.md` was made that way).
 */

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', quietFetch());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function check(name: string) {
  const all = await axeFindings();
  const report = process.env['A11Y_REPORT'];
  if (report) appendFileSync(report, `${name}\t${JSON.stringify(all)}\n`);
  expect(blocking(all), name).toEqual<AxeFinding[]>([]);
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
  await flush();
};
const main = () => screen.getByRole('main');

describe('axe-core over the main views (P5-04)', () => {
  it('the Harmonizer selected: chat, then status', async () => {
    await openApp('/');
    await check('harmonizer-chat');
    await click(within(main()).getByRole('button', { name: 'Status' }));
    await check('harmonizer-status');
  });

  it('a Waykeeper selected: chat, status, the "More" menu and a confirmation', async () => {
    await openApp('/waykeeper/a-waykeeper-1');
    await check('waykeeper-chat');
    await click(within(main()).getByRole('button', { name: 'Status' }));
    await check('waykeeper-status');
    await click(within(main()).getByRole('button', { name: 'More' }));
    await check('waykeeper-more-menu');
    const menu = within(main()).getByRole('group', { name: 'more controls' });
    await click(within(menu).getAllByRole('button', { name: 'Stop' })[0]!);
    await check('waykeeper-confirm');
  });

  it('a Steward selected, with its clarification box', async () => {
    await openApp('/steward/a-steward-1');
    // The Steward's view itself, not a loading state: its open questions and the answer box.
    const view = await screen.findByRole('region', { name: /^view of / });
    await within(view).findByRole('heading', { name: /^Open question/ });
    within(view).getByRole('form', { name: 'answer the clarification' });
    await check('steward');
  });

  it('the inbox with every kind of card, a card being edited, a row’s "⋯" open', async () => {
    await openApp('/');
    const inbox = screen.getByRole('region', { name: 'question inbox' });
    await click(within(inbox).getAllByRole('button', { name: 'Edit' })[0]!);
    await check('inbox-edit');
    const nav = screen.getByRole('navigation', { name: 'navigation' });
    await click(within(nav).getByRole('button', { name: 'Actions for Auth refactor' }));
    await check('nav-row-actions');
  });

  it('the notifications popover', async () => {
    await openApp('/');
    await click(screen.getByRole('button', { name: /^Notifications: / }));
    await check('notifications-popover');
  });

  it('the history page, with the inspector open', async () => {
    await openApp('/history');
    await check('history');
    await click(await screen.findByRole('button', { name: 'Inspect Fix the flaky date test' }));
    await screen.findByRole('region', { name: /details of Fix the flaky date test/ });
    await check('history-inspector');
  });

  it('the settings page', async () => {
    await openApp('/settings');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await check('settings');
  });

  it('the first-run wizard', async () => {
    vi.stubGlobal('fetch', quietFetch(undefined, { setupDone: false }));
    await openApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Welcome to GalacticAgents' });
    await check('wizard');
  });

  it('list mode (the scene hidden by choice)', async () => {
    localStorage.setItem(SCENE_VISIBLE_KEY, '0');
    await openApp('/waykeeper/a-waykeeper-1');
    await check('list-mode');
  });

  it('phone width with the menu open', async () => {
    stubMedia([COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY]);
    await openApp('/');
    await click(screen.getByRole('button', { name: 'Menu' }));
    await check('phone-menu');
  });

  it('phone width with the navigation sheet closed, then open (P8-15)', async () => {
    stubMedia([COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY]);
    await openApp('/waykeeper/a-waykeeper-1');
    await check('phone-nav-sheet-closed');
    await click(screen.getByRole('button', { name: /^Agents/ }));
    expect(screen.getByRole('dialog', { name: 'Agents' })).toBeTruthy();
    await check('phone-nav-sheet-open');
  });
});
