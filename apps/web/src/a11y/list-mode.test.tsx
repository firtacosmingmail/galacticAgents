// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { SCENE_VISIBLE_KEY } from '../scene/visibility.js';
import { openApp, quietFetch } from './a11y-fixtures.js';

/**
 * P5-04, SPEC §4.2 "the panel must work with the 3D scene hidden": with the scene hidden by choice
 * (decision 62's list mode, not a WebGL failure), everything of §4.2–4.3 is done from the panel —
 * status, selection both ways from lists, answers and decisions in the inbox (where the beacons'
 * questions are), controls, and history — and no scene is mounted.
 */

let fetchMock: ReturnType<typeof quietFetch>;
beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  localStorage.setItem(SCENE_VISIBLE_KEY, '0');
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  fetchMock = quietFetch();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
  await flush();
}
const posts = (path: string) =>
  fetchMock.mock.calls.filter(([url, init]) => url === path && init?.method === 'POST');
const main = () => screen.getByRole('main');
const nav = () => screen.getByRole('navigation', { name: 'navigation' });
const inbox = () => screen.getByRole('region', { name: 'question inbox' });

describe('list mode: the panel without the scene (P5-04)', () => {
  it('mounts no scene and offers to show it', async () => {
    await openApp('/');
    expect(screen.getByRole('button', { name: 'Show scene' })).toBeTruthy();
    expect(screen.queryByRole('application', { name: 'solar system' })).toBeNull();
    expect(document.querySelector('.pnl-scene, canvas')).toBeNull();
    // The conversation takes the centre and does not minimise.
    expect(within(main()).queryByRole('button', { name: /Minimise/ })).toBeNull();
  });

  it('shows the status of the system, a project and a task without the scene', async () => {
    await openApp('/');
    await click(within(main()).getByRole('button', { name: 'Status' }));
    expect(within(main()).getByRole('region', { name: 'system status' })).toBeTruthy();
    await click(within(nav()).getByRole('link', { name: /Auth refactor/ }));
    expect(within(main()).getByRole('region', { name: 'status of Auth refactor' })).toBeTruthy();
    await click(within(nav()).getByRole('link', { name: /Fix the flaky date test/ }));
    expect(main().dataset['selection']).toBe('steward:a-steward-2');
    expect(within(main()).getByRole('region', { name: /^view of / })).toBeTruthy();
  });

  it('selects from every list: navigation, managed-agents cards, and back to the Harmonizer', async () => {
    await openApp('/');
    const cards = screen.getByRole('region', { name: 'managed agents' });
    const card = cards.querySelector<HTMLElement>('article.agc')!;
    await click(within(card).getAllByRole('link')[0]!);
    expect(useAppStore.getState().selection.kind).not.toBe('harmonizer');
    await click(within(nav()).getByRole('link', { name: /^Harmonizer/ }));
    expect(useAppStore.getState().selection).toEqual({ kind: 'harmonizer' });
    const open = within(nav()).queryByRole('button', { name: 'Show the work in Auth refactor' });
    if (open) await click(open);
    await click(within(nav()).getByRole('link', { name: /Replace the session middleware/ }));
    expect(useAppStore.getState().selection).toEqual({ kind: 'steward', id: 'a-steward-1' });
    expect(within(main()).getByRole('region', { name: /^view of / })).toBeTruthy();
  });

  it('answers a question and decides a card from the inbox', async () => {
    await openApp('/');
    const waiting = within(inbox()).getByRole('region', { name: 'Waiting for you' });
    const permission = within(waiting).getByRole('article', { name: /^permission question/ });
    await click(within(permission).getByRole('button', { name: 'Allow' }));
    expect(posts('/api/questions/q-2/answer')).toHaveLength(1);
    const proposal = within(waiting).getByRole('article', { name: /^proposal / });
    await click(within(proposal).getByRole('button', { name: 'Approve' }));
    expect(posts('/api/proposals/pr-1/decide')).toHaveLength(1);
  });

  it('opens the inbox from "N waiting for you", the beacons’ way in list mode', async () => {
    await openApp('/history');
    await click(screen.getByRole('button', { name: /waiting for you/ }));
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('pnl-inbox'));
    expect(useAppStore.getState().route).toBe('panel');
  });

  it('reaches the history and inspects archived work', async () => {
    await openApp('/');
    await click(screen.getByRole('link', { name: 'History' }));
    await click(await screen.findByRole('button', { name: 'Inspect Fix the flaky date test' }));
    expect(
      await screen.findByRole('region', { name: /details of Fix the flaky date test/ }),
    ).toBeTruthy();
  });

  it('keeps the controls: a Waykeeper’s strip with its confirmation', async () => {
    await openApp('/waykeeper/a-waykeeper-1');
    await click(within(main()).getByRole('button', { name: 'More' }));
    const menu = within(main()).getByRole('group', { name: 'more controls' });
    await click(within(menu).getAllByRole('button', { name: 'Stop' })[0]!);
    await click(within(main()).getByRole('button', { name: /^Yes, stop/ }));
    expect(posts('/api/control')).toHaveLength(1);
  });
});
