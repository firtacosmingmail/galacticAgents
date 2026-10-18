// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { SCENE_VISIBLE_KEY } from '../scene/visibility.js';
import {
  axeFindings,
  clarification,
  fullSnapshot,
  openApp,
  quietFetch,
  stubMedia,
} from '../a11y/a11y-fixtures.js';
import { INBOX_VISIBLE_KEY } from './inbox-visibility.js';
import { MANAGED_AGENTS_VISIBLE_KEY } from './managed-agents-visibility.js';
import { revealQuestion } from './inbox-reveal.js';
import { focusTarget } from './notifications/focus.js';
import { NAV_SHEET_BUTTON_ID } from './nav-sheet.js';
import { COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY } from './use-media-query.js';

/**
 * P8-18 (SPEC decision 140): on a phone the panel shows one main screen at a time. The chat fills
 * the screen; the top bar's Inbox and Managed-agents buttons open those full screen, closed with ✕
 * or Back; nothing typed is lost. With the scene shown the docked chat stays as before. Tablets and
 * desktops keep the side column.
 */

const PHONE = [COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY];

// The three.js scene never loads in jsdom: a stub stands in, and WebGL is "available".
vi.mock('../scene/SolarScene.js', () => ({
  default: function StubScene() {
    return <div data-testid="solar-scene" />;
  },
}));
vi.mock('../scene/webgl.js', () => ({ webglAvailable: () => true }));

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  // List mode: the phone's default (decision 94), and jsdom has no WebGL.
  localStorage.setItem(SCENE_VISIBLE_KEY, '0');
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', quietFetch());
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

/** jsdom runs a history traversal (`back()`) as a task, then fires `popstate`; frames too. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));
const top = () => document.querySelector<HTMLElement>('header.pnl-top')!;
const inboxButton = () => within(top()).getByRole('button', { name: /^Inbox/ });
const agentsButton = () => within(top()).getByRole('button', { name: 'Managed agents' });
const view = () => document.getElementById('pnl-phone-view');
const grid = () => document.querySelector<HTMLElement>('.pnl-grid')!;
const composer = () =>
  screen.getByRole('textbox', { name: 'message to Harmonizer' }) as HTMLTextAreaElement;
const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle();
};
const back = async () => {
  await act(async () => {
    window.history.back();
  });
  await settle();
};

describe('one screen at a time on a phone (P8-18)', () => {
  beforeEach(() => stubMedia(PHONE));

  it('list mode: the chat fills the screen, with no inbox, agent cards or dock handle', async () => {
    await openApp('/');
    expect(document.getElementById('pnl-inbox')).toBeNull();
    expect(document.querySelector('article.agc')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Minimise the conversation' })).toBeNull();
    expect(grid().classList.contains('pnl-grid-dock-fills')).toBe(true);
    expect(composer()).toBeTruthy();
  });

  it('the Inbox button shows the inbox full screen and ✕ goes back to the chat', async () => {
    await openApp('/');
    await click(inboxButton());
    expect(view()).not.toBeNull();
    expect(within(view()!).getByRole('heading', { level: 2, name: 'Inbox' })).toBeTruthy();
    expect(view()!.getAttribute('aria-labelledby')).toBeTruthy();
    expect(within(view()!).getByRole('region', { name: 'inbox' })).toBeTruthy();
    expect(grid().hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(within(view()!).getByRole('heading', { level: 2 }));
    await click(within(view()!).getByRole('button', { name: 'Close the inbox' }));
    expect(view()).toBeNull();
    expect(grid().hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(inboxButton());
  });

  it('Escape closes the full view', async () => {
    await openApp('/');
    await click(agentsButton());
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    });
    await settle();
    expect(view()).toBeNull();
  });

  it('keeps what was typed in the chat across the inbox, Back and a rotation', async () => {
    const width = { phone: true };
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return width.phone && PHONE.includes(query);
      },
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await openApp('/');
    fireEvent.change(composer(), { target: { value: 'Also make sure the tests' } });
    await click(inboxButton());
    await back();
    expect(view()).toBeNull();
    expect(composer().value).toBe('Also make sure the tests');
    expect(window.location.pathname).toBe('/');
  });

  it('answering the last question in the inbox view keeps the focus in the view', async () => {
    await openApp('/', fullSnapshot({ questions: [clarification], proposals: [] }));
    await click(inboxButton());
    const card = within(view()!).getByRole('article');
    act(() => card.focus());
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    await act(async () => {
      socket.serverSends({
        seq: 11,
        event: {
          type: 'question.answered',
          questionId: clarification.id,
          answer: 'yes',
          answeredBy: { type: 'user' },
          version: clarification.version + 1,
        },
      });
    });
    await settle();
    expect(view()!.contains(document.activeElement)).toBe(true);
  });

  it('the managed-agents view lists the cards', async () => {
    await openApp('/');
    await click(agentsButton());
    expect(within(view()!).getByRole('heading', { level: 2, name: 'Managed agents' })).toBeTruthy();
    expect(view()!.querySelector('article.agc')).not.toBeNull();
    expect(within(view()!).queryByRole('region', { name: 'inbox' })).toBeNull();
  });

  it('opens the inbox and the agents even when this browser hid them on a wide screen', async () => {
    localStorage.setItem(INBOX_VISIBLE_KEY, '0');
    localStorage.setItem(MANAGED_AGENTS_VISIBLE_KEY, '0');
    await openApp('/');
    await click(inboxButton());
    expect(within(view()!).getByRole('region', { name: 'inbox' })).toBeTruthy();
    await click(agentsButton());
    expect(view()!.querySelector('article.agc')).not.toBeNull();
  });

  it('the navigation sheet and a full view exclude each other', async () => {
    await openApp('/');
    await click(inboxButton());
    await click(document.getElementById(NAV_SHEET_BUTTON_ID)!);
    expect(view()).toBeNull();
    await click(inboxButton());
    expect(view()).not.toBeNull();
    expect(document.getElementById(NAV_SHEET_BUTTON_ID)!.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('a question beacon opens the inbox view and focuses the card', async () => {
    await openApp('/');
    act(() => void revealQuestion(clarification.id));
    await settle();
    expect(view()).not.toBeNull();
    expect(document.activeElement?.getAttribute('data-question-id')).toBe(clarification.id);
  });

  it("a notification's click for a question opens the inbox view", async () => {
    await openApp('/');
    act(() => focusTarget({ kind: 'question', id: clarification.id }));
    await settle();
    expect(view()).not.toBeNull();
  });

  it('with the scene shown, the dock stays as before and the stack holds no inbox', async () => {
    localStorage.setItem(SCENE_VISIBLE_KEY, '1');
    await openApp('/');
    expect(screen.getByTestId('solar-scene')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Minimise the conversation' })).toBeTruthy();
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(document.getElementById('pnl-inbox')).toBeNull();
    await click(inboxButton());
    expect(view()).not.toBeNull();
  });

  it('is axe clean with the view closed and open', async () => {
    await openApp('/');
    expect(await axeFindings()).toEqual([]);
    await click(inboxButton());
    expect(await axeFindings()).toEqual([]);
  });
});

describe('tablets and desktops (P8-18 leaves them alone)', () => {
  it('a tablet keeps the side column in the stack and no full-view buttons', async () => {
    stubMedia([STACKED_LAYOUT_QUERY]);
    await openApp('/');
    expect(document.getElementById('pnl-inbox')).not.toBeNull();
    expect(within(top()).queryByRole('button', { name: 'Managed agents' })).toBeNull();
  });
});
