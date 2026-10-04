// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event, Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { SatelliteLegend } from '../scene/legend/Legend.js';
import { openApp, quietFetch } from './a11y-fixtures.js';

/** P5-04: the panel with the keyboard only — lists, focus moves and focus restored. */

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

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
  await flush();
}
async function key(el: Element, k: string) {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    await Promise.resolve();
  });
  await flush();
}
let seq = 10;
async function stream(event: Event) {
  seq += 1;
  await act(async () => {
    FakeWebSocket.instances[0]!.serverSends({ type: 'event', seq, at: fx.NOW, event });
  });
  await flush();
}
const focused = () => document.activeElement as HTMLElement;
const nav = () => screen.getByRole('navigation', { name: 'navigation' });
const inbox = () => screen.getByRole('region', { name: 'question inbox' });
const main = () => screen.getByRole('main');

describe('skip link and page changes', () => {
  it('starts with a skip link that puts the focus on the main area’s heading', async () => {
    await openApp('/');
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    // The first focusable element of the page.
    expect(document.querySelector('a[href], button, input, select, textarea, [tabindex]')).toBe(
      skip,
    );
    await click(skip);
    expect(focused()).toBe(within(main()).getByRole('heading', { level: 1 }));
  });

  it('moves the focus to the new page’s heading: settings, history, back to the panel', async () => {
    await openApp('/');
    const settings = screen.getByRole('link', { name: 'Settings' });
    settings.focus();
    await click(settings);
    await vi.waitFor(() =>
      expect(focused()).toBe(screen.getByRole('heading', { level: 1, name: 'Settings' })),
    );
    const history = screen.getByRole('link', { name: 'History' });
    history.focus();
    await click(history);
    expect(focused()).toBe(screen.getByRole('heading', { level: 1, name: 'History' }));
    const back = screen.getByRole('link', { name: '← Back to the panel' });
    back.focus();
    await click(back);
    await vi.waitFor(() =>
      expect(focused()).toBe(within(main()).getByRole('heading', { level: 1, name: 'Harmonizer' })),
    );
  });
});

describe('the navigation’s arrow keys', () => {
  /** What each row puts the focus on: its link, or (no agent yet) its first button. */
  const rows = () =>
    Array.from(nav().querySelectorAll<HTMLElement>('.pnl-nav-hq, .pnl-row-line')).map((r) =>
      r.matches('a')
        ? r
        : (r.querySelector<HTMLElement>(':scope > a.pnl-link') ?? r.querySelector('button')!),
    );
  const disclose = (name: string) =>
    within(nav()).getByRole('button', { name: new RegExp(`the work in ${name}$`) });

  it('Down / Up / Home / End move between rows; Tab stops are unchanged', async () => {
    await openApp('/');
    const all = rows();
    expect(all.length).toBeGreaterThan(3);
    all[0]!.focus();
    await key(focused(), 'ArrowDown');
    expect(focused()).toBe(rows()[1]);
    await key(focused(), 'ArrowDown');
    expect(focused()).toBe(rows()[2]);
    await key(focused(), 'ArrowUp');
    expect(focused()).toBe(rows()[1]);
    await key(focused(), 'End');
    expect(focused()).toBe(rows().at(-1));
    await key(focused(), 'Home');
    expect(focused()).toBe(rows()[0]);
    // From a row's "⋯" button, Down goes to the next row's link.
    const more = within(nav()).getByRole('button', { name: 'Actions for Auth refactor' });
    more.focus();
    await key(more, 'ArrowDown');
    const authRow = more.closest('.pnl-row-line')!;
    const index = rows().findIndex((r) => authRow.contains(r));
    expect(focused()).toBe(rows()[index + 1]);
    // Links stay links (no roving tabindex): every row's link or button is a Tab stop.
    expect(rows().every((r) => !r.hasAttribute('tabindex'))).toBe(true);
  });

  it('Right opens a row and enters it; Left goes back up and closes it', async () => {
    await openApp('/');
    const project = within(nav()).getByRole('link', { name: /Auth refactor/ });
    project.focus();
    // When its Steward is blocked on the user the row opens on its own; close it first.
    if (disclose('Auth refactor').getAttribute('aria-expanded') === 'true')
      await key(project, 'ArrowLeft');
    expect(disclose('Auth refactor').getAttribute('aria-expanded')).toBe('false');
    expect(focused()).toBe(project);
    await key(project, 'ArrowRight');
    expect(disclose('Auth refactor').getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toBe(project);
    await key(project, 'ArrowRight');
    const task = within(nav()).getByRole('link', { name: /Replace the session middleware/ });
    expect(focused()).toBe(task);
    await key(task, 'ArrowLeft');
    expect(focused()).toBe(project);
    await key(project, 'ArrowLeft');
    expect(disclose('Auth refactor').getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves the arrows to the fields and to the row’s open actions', async () => {
    await openApp('/');
    const more = within(nav()).getByRole('button', { name: 'Actions for Auth refactor' });
    await click(more);
    const actions = within(nav()).getByRole('group', { name: 'actions for Auth refactor' });
    const first = within(actions).getAllByRole('button')[0]!;
    first.focus();
    await key(first, 'ArrowDown');
    expect(focused()).toBe(first);
    // Escape closes them and gives the focus back to "⋯".
    await key(first, 'Escape');
    expect(focused()).toBe(more);
  });
});

describe('arrow keys through the cards', () => {
  it('moves between the inbox’s cards, and not out of a text field', async () => {
    await openApp('/');
    const cards = () => Array.from(inbox().querySelectorAll<HTMLElement>('article.card'));
    expect(cards().length).toBeGreaterThan(2);
    const button = within(cards()[0]!).getAllByRole('button')[0]!;
    button.focus();
    await key(button, 'ArrowDown');
    expect(focused()).toBe(cards()[1]);
    expect(focused().getAttribute('tabindex')).toBe('-1');
    await key(focused(), 'End');
    expect(focused()).toBe(cards().at(-1));
    await key(focused(), 'Home');
    expect(focused()).toBe(cards()[0]);
    const field = inbox().querySelector<HTMLElement>('input, textarea')!;
    field.focus();
    await key(field, 'ArrowDown');
    expect(focused()).toBe(field);
  });

  it('moves between the managed agents’ cards', async () => {
    await openApp('/');
    const section = screen.getByRole('region', { name: 'managed agents' });
    const cards = () => Array.from(section.querySelectorAll<HTMLElement>('article.agc'));
    expect(cards().length).toBeGreaterThan(1);
    within(cards()[0]!).getAllByRole('link')[0]!.focus();
    await key(focused(), 'ArrowDown');
    expect(focused()).toBe(cards()[1]);
    await key(focused(), 'ArrowUp');
    expect(focused()).toBe(cards()[0]);
  });

  it('moves between the history’s rows; Escape closes the inspector and returns the focus', async () => {
    await openApp('/history');
    const inspect = await screen.findByRole('button', { name: 'Inspect Fix the flaky date test' });
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('li.his-row'));
    await vi.waitFor(() => expect(rows().length).toBe(2));
    inspect.focus();
    await key(inspect, 'ArrowDown');
    expect(focused()).toBe(rows()[1]);
    inspect.focus();
    await click(inspect);
    const heading = await screen.findByRole('heading', {
      level: 2,
      name: /Fix the flaky date test/,
    });
    expect(focused()).toBe(heading);
    await key(heading, 'Escape');
    expect(screen.queryByRole('region', { name: /details of/ })).toBeNull();
    expect(focused()).toBe(inspect);
  });
});

describe('focus into and back from what opens', () => {
  it('the notifications popover: focus in, Escape back to its button', async () => {
    await openApp('/');
    const toggle = screen.getByRole('button', { name: /^Notifications: / });
    toggle.focus();
    await click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'notification settings' });
    expect(dialog.contains(focused())).toBe(true);
    await key(focused(), 'Escape');
    expect(screen.queryByRole('dialog', { name: 'notification settings' })).toBeNull();
    expect(focused()).toBe(toggle);
  });

  it('a confirmation takes the focus on "Keep"; Escape keeps and returns it', async () => {
    await openApp('/waykeeper/a-waykeeper-1');
    const more = within(main()).getByRole('button', { name: 'More' });
    more.focus();
    await click(more);
    const menu = within(main()).getByRole('group', { name: 'more controls' });
    const stop = within(menu).getAllByRole('button', { name: 'Stop' })[0]!;
    stop.focus();
    await click(stop);
    const confirm = within(main()).getByRole('group', { name: 'confirm' });
    expect(focused()).toBe(within(confirm).getByRole('button', { name: 'Keep' }));
    await key(focused(), 'Escape');
    expect(within(main()).queryByRole('group', { name: 'confirm' })).toBeNull();
    // "Stop" went with the closed menu: "More" has the focus back.
    expect(focused()).toBe(more);
  });

  it('a card’s edit form takes the focus on its first field', async () => {
    await openApp('/');
    const edit = within(inbox()).getAllByRole('button', { name: 'Edit' })[0]!;
    await click(edit);
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    const form = within(inbox()).getByRole('form', { name: 'edit card' });
    expect(form.contains(focused())).toBe(true);
  });

  it('hiding the inbox puts the focus on "Show inbox" in the top bar', async () => {
    await openApp('/');
    const hide = within(inbox()).getByRole('button', { name: 'Hide inbox' });
    hide.focus();
    await click(hide);
    await vi.waitFor(() =>
      expect(focused()).toBe(screen.getByRole('button', { name: 'Show inbox' })),
    );
  });

  it('the legend’s toggle keeps the focus as it opens and closes', async () => {
    render(<SatelliteLegend />);
    const toggle = () => document.querySelector<HTMLButtonElement>('.scene-legend-toggle')!;
    toggle().focus();
    await click(toggle());
    expect(focused()).toBe(toggle());
    await click(toggle());
    expect(focused()).toBe(toggle());
  });
});

describe('focus kept when an item goes away, and the waiting count announced', () => {
  it('a card answered elsewhere: the focus moves to the card now in its place', async () => {
    seq = 10;
    await openApp('/');
    const card = within(within(inbox()).getByRole('region', { name: 'Waiting for you' })).getByRole(
      'article',
      { name: /^clarification question/ },
    );
    within(card).getAllByRole('button')[0]!.focus();
    await stream({
      type: 'question.answered',
      questionId: 'q-1',
      answer: 'yes',
      answeredBy: { type: 'user' },
      version: 4,
    });
    expect(card.isConnected).toBe(false);
    expect(inbox().contains(focused())).toBe(true);
    expect(focused().matches('article.card')).toBe(true);
  });

  it('announces a change of the "waiting for you" count, politely and not on load', async () => {
    seq = 10;
    await openApp('/');
    const live = () =>
      Array.from(document.querySelectorAll('[role="status"][aria-live="polite"]')).find((el) =>
        el.classList.contains('pnl-visually-hidden'),
      )!;
    expect(live().textContent).toBe('');
    const another: Question = {
      ...fx.question,
      id: 'q-new',
      holder: { type: 'user' },
      context: { ...fx.question.context, text: 'One more?' },
    };
    await stream({ type: 'question.opened', question: another });
    expect(live().textContent).toMatch(/^New in the inbox: \d+ waiting for you\.$/);
  });
});
