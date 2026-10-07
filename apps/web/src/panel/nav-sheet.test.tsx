// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { REDUCED_MOTION_QUERY } from '../scene/motion.js';
import { SCENE_VISIBLE_KEY } from '../scene/visibility.js';
import { openApp, quietFetch, stubMedia } from '../a11y/a11y-fixtures.js';
import { COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY } from './use-media-query.js';
import {
  EDGE_ZONE,
  isSwipe,
  NAV_SHEET_BUTTON_ID,
  NAV_SHEET_ID,
  SWIPE_DISTANCE,
} from './nav-sheet.js';

/**
 * P8-15: on a phone the navigation is a sheet that slides in from the left. Hidden by default;
 * opened by the top bar's "Agents" button or a swipe from the left edge; closed by a selection,
 * the scrim, Escape, its close button, a swipe to the left or Back; a modal dialog while open
 * (focus in, trapped, back to the button — or to the new page's title after a selection). Wider
 * screens keep the navigation where it was.
 */

const PHONE = [COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY];

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  // List mode: no WebGL in jsdom, and the phone's default anyway (decision 94).
  localStorage.setItem(SCENE_VISIBLE_KEY, '0');
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', quietFetch());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const button = () => document.getElementById(NAV_SHEET_BUTTON_ID) as HTMLButtonElement;
const dialog = () => document.getElementById(NAV_SHEET_ID)!;
const sheet = () => dialog().parentElement!;
const isOpen = () => {
  const open = sheet().classList.contains('is-open');
  // The two states are complete: open is modal and reachable, closed is hidden and inert.
  expect(button().getAttribute('aria-expanded')).toBe(String(open));
  expect(sheet().hasAttribute('inert')).toBe(!open);
  expect(sheet().getAttribute('aria-hidden')).toBe(open ? null : 'true');
  expect(dialog().getAttribute('aria-modal')).toBe(open ? 'true' : null);
  return open;
};
const nav = () => within(dialog()).getByRole('navigation', { name: 'navigation' });
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** jsdom runs a history traversal (`back()`) as a task, then fires `popstate`. */
const settleHistory = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const back = async () => {
  await act(async () => {
    window.history.back();
  });
  await settleHistory();
};
const sheetEntry = () => (window.history.state as { navSheet?: boolean } | null)?.navSheet === true;

async function openSheet() {
  await act(async () => {
    fireEvent.click(button());
  });
  await flush();
  expect(isOpen()).toBe(true);
}

/** A touch event with its touch points (jsdom has no `Touch`: plain points on a plain event). */
function touch(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend',
  points: { x: number; y: number }[],
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = points.map((p, i) => ({ identifier: i, clientX: p.x, clientY: p.y, target }));
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  act(() => {
    target.dispatchEvent(event);
  });
}

function swipe(target: EventTarget, from: { x: number; y: number }, to: { x: number; y: number }) {
  touch(target, 'touchstart', [from]);
  touch(target, 'touchmove', [{ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }]);
  touch(target, 'touchmove', [to]);
  touch(target, 'touchend', [to]);
}

describe('the phone navigation sheet (P8-15)', () => {
  it('is hidden on load: the navigation is out of the stack, the button closed', async () => {
    stubMedia(PHONE);
    await openApp('/');
    expect(isOpen()).toBe(false);
    // Only one navigation, the sheet's; none in the stacked column.
    expect(document.querySelectorAll('nav.pnl-nav')).toHaveLength(1);
    expect(document.querySelector('.pnl-stack > .pnl-nav')).toBeNull();
    expect(dialog().contains(document.querySelector('nav.pnl-nav'))).toBe(true);
    // The button is in the top bar, before the brand, named and announced as opening a dialog.
    const bar = document.querySelector('header.pnl-top-compact')!;
    expect(bar.contains(button())).toBe(true);
    expect(
      button().compareDocumentPosition(within(bar as HTMLElement).getByText('GalacticAgents')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(button().getAttribute('aria-haspopup')).toBe('dialog');
    expect(button().hasAttribute('aria-controls')).toBe(false);
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(dialog().getAttribute('aria-label')).toBe('Agents');
    // The dock and the inbox are there as before.
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'question inbox' })).toBeTruthy();
  });

  it('names the waiting count on the button, with a dot', async () => {
    stubMedia(PHONE);
    await openApp('/');
    // The fixture holds two questions for the user.
    expect(button().textContent).toBe('Agents, 2 waiting for you');
    expect(button().querySelector('.pnl-nav-button-dot')).not.toBeNull();
  });

  it('opens from the button as a modal dialog: focus in, the page inert, Tab trapped', async () => {
    stubMedia(PHONE);
    await openApp('/');
    button().focus();
    await openSheet();
    expect(button().getAttribute('aria-controls')).toBe(NAV_SHEET_ID);
    // The focus goes to the selected row (the Harmonizer).
    const current = within(nav()).getByRole('link', { current: 'page' });
    expect(current.textContent).toMatch(/Harmonizer/);
    expect(document.activeElement).toBe(current);
    // Everything else is inert: the top bar, the stack, the dock.
    expect(document.querySelector('header.pnl-top')!.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.pnl-stack')!.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('main', { hidden: true }).hasAttribute('inert')).toBe(true);

    // Tab from the last stop wraps to the first (the close button), Shift+Tab back to the last.
    const stops = Array.from(
      dialog().querySelectorAll<HTMLElement>('a[href], button, input'),
    ).filter((el) => !el.closest('[hidden]'));
    const first = stops[0]!;
    const last = stops.at(-1)!;
    expect(first.getAttribute('aria-label')).toBe('Close the agents list');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    // A focus that escapes (no `inert` in old browsers) comes back.
    act(() => {
      (document.querySelector('.pnl-brand') as HTMLElement).focus();
    });
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it('closes on a selection, the focus on the new page’s title and the page live again', async () => {
    stubMedia(PHONE);
    await openApp('/');
    await openSheet();
    await act(async () => {
      fireEvent.click(within(nav()).getByRole('link', { name: /Auth refactor/ }));
    });
    await flush();
    expect(useAppStore.getState().selection).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-1' });
    expect(isOpen()).toBe(false);
    // Decision 81: a page change puts the focus on the new page's title (review N4).
    const title = screen.getByRole('main').querySelector('h1')!;
    expect(title.textContent).toMatch(/Auth refactor/);
    expect(document.activeElement).toBe(title);
    expect(document.querySelector('header.pnl-top')!.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('.pnl-stack')!.hasAttribute('inert')).toBe(false);
    // The dock shows the selection.
    expect(screen.getByRole('main').getAttribute('aria-label')).toMatch(
      /Waykeeper · Auth refactor/,
    );

    // Selecting the row that is already selected closes it too (no navigation then).
    await openSheet();
    await act(async () => {
      fireEvent.click(within(nav()).getByRole('link', { current: 'page' }));
    });
    await flush();
    expect(isOpen()).toBe(false);
  });

  it('closes on Escape, the scrim, its close button — and Escape in a row’s actions is theirs', async () => {
    stubMedia(PHONE);
    await openApp('/');
    await openSheet();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await flush();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button());

    await openSheet();
    await act(async () => {
      fireEvent.click(sheet().querySelector('.pnl-nav-scrim')!);
    });
    await flush();
    expect(isOpen()).toBe(false);

    await openSheet();
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close the agents list' }));
    });
    await flush();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button());

    // A row's "⋯" actions take the first Escape; the sheet the next.
    await openSheet();
    const more = within(nav()).getByRole('button', { name: 'Actions for Auth refactor' });
    await act(async () => {
      fireEvent.click(more);
    });
    const actions = within(nav()).getByRole('group', { name: 'actions for Auth refactor' });
    const action = within(actions).getAllByRole('button')[0]!;
    action.focus();
    fireEvent.keyDown(action, { key: 'Escape' });
    await flush();
    expect(within(nav()).queryByRole('group', { name: 'actions for Auth refactor' })).toBeNull();
    expect(isOpen()).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await flush();
    expect(isOpen()).toBe(false);
  });

  it('opens on a swipe from the left edge only, and closes on a swipe to the left', async () => {
    stubMedia(PHONE);
    await openApp('/');
    const page = document.querySelector('.pnl-stack')!;
    // From the middle of the screen: not the sheet's.
    swipe(page, { x: 120, y: 300 }, { x: 260, y: 300 });
    await flush();
    expect(isOpen()).toBe(false);
    // From the edge but mostly vertical (a scroll): not the sheet's.
    swipe(page, { x: 4, y: 200 }, { x: 60, y: 400 });
    await flush();
    expect(isOpen()).toBe(false);
    // From the edge but too short.
    swipe(page, { x: 4, y: 300 }, { x: 4 + SWIPE_DISTANCE - 10, y: 300 });
    await flush();
    expect(isOpen()).toBe(false);
    // Two fingers (a pinch) never open it.
    touch(page, 'touchstart', [
      { x: 4, y: 300 },
      { x: 200, y: 300 },
    ]);
    touch(page, 'touchmove', [
      { x: 120, y: 300 },
      { x: 220, y: 300 },
    ]);
    touch(page, 'touchend', []);
    await flush();
    expect(isOpen()).toBe(false);
    // From the edge, sideways, far enough: it opens.
    swipe(page, { x: EDGE_ZONE - 4, y: 300 }, { x: EDGE_ZONE + 80, y: 310 });
    await flush();
    expect(isOpen()).toBe(true);
    // A swipe to the right on the sheet does nothing; to the left closes it.
    swipe(dialog(), { x: 60, y: 300 }, { x: 200, y: 300 });
    await flush();
    expect(isOpen()).toBe(true);
    swipe(dialog(), { x: 200, y: 300 }, { x: 60, y: 320 });
    await flush();
    expect(isOpen()).toBe(false);
  });

  it('keeps an edge touch on the scene’s canvas from the scene', async () => {
    stubMedia(PHONE);
    await openApp('/');
    // A stand-in canvas: jsdom has no WebGL, the listener only looks at the element.
    const canvas = document.createElement('canvas');
    document.querySelector('.pnl-stack')!.appendChild(canvas);
    const seen = vi.fn();
    canvas.addEventListener('pointerdown', seen);
    const down = (x: number, pointerType = 'touch') => {
      const e = new Event('pointerdown', { bubbles: true });
      Object.assign(e, { clientX: x, clientY: 200, pointerType });
      canvas.dispatchEvent(e);
    };
    down(EDGE_ZONE - 2);
    expect(seen).not.toHaveBeenCalled();
    down(EDGE_ZONE + 40);
    down(4, 'mouse');
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('slides unless the system asks for reduced motion', async () => {
    stubMedia(PHONE);
    await openApp('/');
    expect(sheet().classList.contains('is-still')).toBe(false);
    cleanup();
    stubMedia([...PHONE, REDUCED_MOTION_QUERY]);
    await openApp('/');
    expect(sheet().classList.contains('is-still')).toBe(true);
    // The stylesheet: no transition while still, and under the media query whatever the class.
    const css = readFileSync(resolve(import.meta.dirname, 'panel.css'), 'utf8');
    expect(css).toMatch(
      /\.pnl-nav-sheet\.is-still > \.pnl-nav-scrim,\s*\.pnl-nav-sheet\.is-still > \.pnl-nav-sheet-panel \{\s*transition: none;/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.pnl-nav-scrim,\s*\.pnl-nav-sheet-panel \{\s*transition: none;/,
    );
    // The rows' own transitions are off only under reduced motion (review N3): inside that block.
    const block =
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.pnl-nav-scrim,[\s\S]*?\n\}/.exec(css)![0];
    expect(block).toMatch(/\.pnl-nav-sheet-panel \* \{\s*transition: none;/);
    expect(css.replace(block, '')).not.toMatch(/\.pnl-nav-sheet-panel \* \{/);
  });

  it('Back closes it without changing the selection; closed otherwise, its history entry goes (review S2)', async () => {
    stubMedia(PHONE);
    await openApp('/');
    const url = window.location.href;
    const selection = useAppStore.getState().selection;
    await openSheet();
    // An entry of its own, same URL.
    expect(sheetEntry()).toBe(true);
    expect(window.location.href).toBe(url);

    // Back (Android's edge gesture, the browser's button): the sheet closes, nothing else moves.
    await back();
    expect(isOpen()).toBe(false);
    expect(sheetEntry()).toBe(false);
    expect(window.location.href).toBe(url);
    expect(useAppStore.getState().selection).toEqual(selection);
    expect(document.activeElement).toBe(button());

    // Closed by its close button: it takes its entry back (no "sheet open" entry left behind).
    await openSheet();
    expect(sheetEntry()).toBe(true);
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close the agents list' }));
    });
    await settleHistory();
    expect(isOpen()).toBe(false);
    expect(sheetEntry()).toBe(false);
    expect(window.location.href).toBe(url);
    // Opening again works and pushes a fresh entry (no loop of backs).
    await openSheet();
    expect(sheetEntry()).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await settleHistory();
    expect(isOpen()).toBe(false);
    expect(sheetEntry()).toBe(false);
    expect(useAppStore.getState().selection).toEqual(selection);
  });

  it('a selection replaces the sheet’s entry: Back then goes to the previous selection (review S2)', async () => {
    stubMedia(PHONE);
    await openApp('/');
    const before = useAppStore.getState().selection;
    const beforePath = window.location.pathname;
    await openSheet();
    await act(async () => {
      fireEvent.click(within(nav()).getByRole('link', { name: /Auth refactor/ }));
    });
    await settleHistory();
    expect(isOpen()).toBe(false);
    expect(useAppStore.getState().selection).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-1' });
    expect(window.location.pathname).not.toBe(beforePath);
    expect(sheetEntry()).toBe(false);
    // One Back: the previous selection, not a dangling "sheet open" step.
    await back();
    expect(window.location.pathname).toBe(beforePath);
    expect(useAppStore.getState().selection).toEqual(before);
    expect(isOpen()).toBe(false);

    // The row already selected: no navigation, the sheet's entry is taken back.
    await openSheet();
    await act(async () => {
      fireEvent.click(within(nav()).getByRole('link', { current: 'page' }));
    });
    await settleHistory();
    expect(isOpen()).toBe(false);
    expect(sheetEntry()).toBe(false);
    expect(window.location.pathname).toBe(beforePath);
  });

  it('keeps what appears beside the page while open inert too (review N5)', async () => {
    stubMedia(PHONE);
    await openApp('/');
    await openSheet();
    const notice = document.createElement('div');
    notice.innerHTML = '<button type="button">Reload</button>';
    await act(async () => {
      document.body.appendChild(notice);
    });
    await flush();
    expect(notice.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await settleHistory();
    expect(notice.hasAttribute('inert')).toBe(false);
    notice.remove();
  });

  it('Tab skips what CSS hides in the sheet (review N6)', async () => {
    stubMedia(PHONE);
    // Layout as a browser has it: everything has a box except what is `display: none`.
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      return (this.closest('.css-hidden') ? [] : [{}]) as unknown as DOMRectList;
    });
    await openApp('/');
    await openSheet();
    const hidden = document.createElement('button');
    hidden.className = 'css-hidden';
    hidden.textContent = 'hidden by CSS';
    dialog().appendChild(hidden);
    const stops = Array.from(
      dialog().querySelectorAll<HTMLElement>('a[href], button, input'),
    ).filter((el) => !el.closest('[hidden]') && el !== hidden);
    const first = stops[0]!;
    const last = stops.at(-1)!;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    hidden.remove();
    vi.restoreAllMocks();
  });

  it('leaves an edge swipe that starts on a sideways-scrolling element to it (review N7)', async () => {
    stubMedia(PHONE);
    await openApp('/');
    const strip = document.createElement('div');
    strip.style.overflowX = 'auto';
    Object.defineProperty(strip, 'scrollWidth', { value: 800 });
    Object.defineProperty(strip, 'clientWidth', { value: 300 });
    const chip = document.createElement('span');
    strip.appendChild(chip);
    document.querySelector('.pnl-stack')!.appendChild(strip);
    swipe(chip, { x: 4, y: 300 }, { x: 120, y: 300 });
    await flush();
    expect(isOpen()).toBe(false);
    // The same swipe elsewhere at the edge opens it.
    swipe(document.querySelector('.pnl-stack')!, { x: 4, y: 300 }, { x: 120, y: 300 });
    await flush();
    expect(isOpen()).toBe(true);
    strip.remove();
  });

  it('is not remembered: a reload starts with it hidden', async () => {
    stubMedia(PHONE);
    await openApp('/');
    await openSheet();
    expect(Object.keys(localStorage).filter((k) => /sheet/i.test(k))).toEqual([]);
    cleanup();
    FakeWebSocket.instances = [];
    useAppStore.getState().reset();
    await openApp('/');
    expect(isOpen()).toBe(false);
  });

  it('leaves tablets and desktops as they were', async () => {
    // Stacked (≤1100 px) but not a phone: the navigation stays in the stack, no button.
    stubMedia([STACKED_LAYOUT_QUERY]);
    await openApp('/');
    expect(document.getElementById(NAV_SHEET_BUTTON_ID)).toBeNull();
    expect(document.getElementById(NAV_SHEET_ID)).toBeNull();
    expect(document.querySelector('.pnl-stack > nav.pnl-nav')).not.toBeNull();
    cleanup();
    // Wide: three columns.
    stubMedia([]);
    await openApp('/');
    expect(document.getElementById(NAV_SHEET_ID)).toBeNull();
    expect(document.querySelector('.pnl-grid > nav.pnl-nav')).not.toBeNull();
  });

  it('a phone in list mode with the side column hidden lets the dock fill the screen', async () => {
    stubMedia(PHONE);
    localStorage.setItem('galactic.panel.managedAgents.visible', '0');
    localStorage.setItem('galactic.panel.inbox.visible', '0');
    await openApp('/');
    expect(document.querySelector('.pnl-grid')!.classList.contains('pnl-grid-dock-fills')).toBe(
      true,
    );
  });
});

describe('isSwipe', () => {
  it('needs the distance, the direction and a mostly sideways move', () => {
    expect(isSwipe(SWIPE_DISTANCE, 0, 1)).toBe(true);
    expect(isSwipe(SWIPE_DISTANCE - 1, 0, 1)).toBe(false);
    expect(isSwipe(-SWIPE_DISTANCE, 0, 1)).toBe(false);
    expect(isSwipe(-SWIPE_DISTANCE, 10, -1)).toBe(true);
    expect(isSwipe(60, 50, 1)).toBe(false);
  });
});
