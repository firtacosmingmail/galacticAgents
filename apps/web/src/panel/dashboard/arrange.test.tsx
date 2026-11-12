import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyWorld, type Panel, type Project } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { useAppStore } from '../../state/store.js';
import { stubMedia } from '../../a11y/a11y-fixtures.js';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { COMPACT_TOP_BAR_QUERY } from '../use-media-query.js';
import { DashboardPane } from './DashboardPane.js';

/**
 * P15-07 — arrange mode: a local draft of every panel's layout, sent once by "Done arranging".
 * Mouse (drag ⠿, drag ◢, ✕), keyboard (arrows, Shift+arrows, Delete) and the hidden list; not
 * offered on the phone.
 */

vi.mock('../inbox-reveal.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  revealQuestion: vi.fn(),
  revealInbox: vi.fn(),
}));

const shop: Project = {
  ...fx.project,
  id: 'p-shop',
  name: 'Shop',
  bodyId: 'b-saturn',
  longTerm: true,
  purpose: 'Sell lamps',
  goals: [],
};
const panel = (id: string, order: number, over: Partial<Panel> = {}): Panel =>
  ({
    ...fx.panel,
    id,
    projectId: 'p-shop',
    type: 'text',
    title: `Panel ${id}`,
    source: { kind: 'tasks' },
    layout: { order, w: 1, h: 1 },
    ...over,
  }) as Panel;

const api = {
  dashboard: vi.fn(async () => ({ panels: [] })),
  arrangePanels: vi.fn(async (_projectId: string, _layouts: unknown) => ({})),
  refreshJob: vi.fn(),
  clearPanelHistory: vi.fn(),
};
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function setPanels(list: Panel[]) {
  useAppStore.setState({
    world: {
      ...emptyWorld(),
      projects: { 'p-shop': shop },
      panels: Object.fromEntries(list.map((p) => [p.id, p])),
    },
  });
}

async function renderPane(list: Panel[]) {
  setPanels(list);
  render(
    createElement(
      ApiContext.Provider,
      { value: api as unknown as Api },
      createElement(DashboardPane, { projectId: 'p-shop' }),
    ),
  );
  await settle();
}

const titles = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label') ?? '');
const sent = () => api.arrangePanels.mock.calls[0]![1] as { panelId: string; layout: unknown }[];
const startArranging = () => fireEvent.click(screen.getByRole('button', { name: 'Arrange' }));
const done = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Done arranging' }));
  await settle();
};
const handle = (id: string) => screen.getByRole('button', { name: `Move Panel ${id}` });

beforeEach(() => {
  useAppStore.getState().reset();
  api.arrangePanels.mockClear();
  api.arrangePanels.mockImplementation(async () => ({}));
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('arrange mode', () => {
  const three = () => [panel('a', 0), panel('b', 1), panel('c', 2)];

  it('makes the panels inert while arranging: their buttons cannot be reached by Tab', async () => {
    await renderPane(three());
    const menus = () => screen.getAllByRole('button', { name: 'More actions' });
    expect(menus()[0]!.closest('[inert]')).toBeNull();
    startArranging();
    expect(menus()).toHaveLength(3);
    for (const button of menus()) expect(button.closest('[inert]')).not.toBeNull();
    // The arranging controls stay reachable.
    expect(handle('a').closest('[inert]')).toBeNull();
  });

  it('is not offered on the phone layout', async () => {
    stubMedia([COMPACT_TOP_BAR_QUERY]);
    await renderPane(three());
    expect(screen.queryByRole('button', { name: 'Arrange' })).toBeNull();
  });

  it('ArrowRight on the second panel swaps it with the third; Done sends one request', async () => {
    await renderPane(three());
    startArranging();
    handle('b').focus();
    fireEvent.keyDown(handle('b'), { key: 'ArrowRight' });
    expect(titles()).toEqual(['Panel a', 'Panel c', 'Panel b']);
    expect(api.arrangePanels).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Panel b moved to position 3');
    await done();
    expect(api.arrangePanels).toHaveBeenCalledTimes(1);
    expect(api.arrangePanels.mock.calls[0]![0]).toBe('p-shop');
    expect(sent()).toEqual([
      { panelId: 'a', layout: { order: 0, w: 1, h: 1 } },
      { panelId: 'c', layout: { order: 1, w: 1, h: 1 } },
      { panelId: 'b', layout: { order: 2, w: 1, h: 1 } },
    ]);
    expect(screen.queryByRole('button', { name: 'Done arranging' })).toBeNull();
  });

  it('Shift+arrows resize, clamped, and announce', async () => {
    await renderPane(three());
    startArranging();
    fireEvent.keyDown(handle('a'), { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByRole('status').textContent).toBe('Panel a now 2 columns wide');
    fireEvent.keyDown(handle('a'), { key: 'ArrowDown', shiftKey: true });
    expect(screen.getByRole('status').textContent).toBe('Panel a now 2 rows tall');
    fireEvent.keyDown(handle('a'), { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(handle('a'), { key: 'ArrowLeft', shiftKey: true });
    await done();
    expect(sent()[0]!.layout).toEqual({ order: 0, w: 1, h: 2 });
  });

  it('Delete and ✕ hide a panel into "Hidden panels"; Show brings it back; hidden ones are sent', async () => {
    await renderPane(three());
    startArranging();
    fireEvent.keyDown(handle('b'), { key: 'Delete' });
    expect(titles()).toEqual(['Panel a', 'Panel c']);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Panel c' }));
    const hidden = screen.getByRole('region', { name: 'Hidden panels' });
    expect(within(hidden).getByText('Panel b')).toBeTruthy();
    fireEvent.click(within(hidden).getByRole('button', { name: 'Show Panel b' }));
    expect(titles()).toEqual(['Panel a', 'Panel b']);
    await done();
    expect(sent()).toEqual([
      { panelId: 'a', layout: { order: 0, w: 1, h: 1 } },
      { panelId: 'b', layout: { order: 1, w: 1, h: 1 } },
      { panelId: 'c', layout: { order: 2, w: 1, h: 1, hidden: true } },
    ]);
  });

  it('a panel created while arranging goes at the end and the pending order is kept', async () => {
    await renderPane(three());
    startArranging();
    fireEvent.keyDown(handle('a'), { key: 'ArrowRight' });
    expect(titles()).toEqual(['Panel b', 'Panel a', 'Panel c']);
    act(() => setPanels([...three(), panel('n', 3)]));
    expect(titles()).toEqual(['Panel b', 'Panel a', 'Panel c', 'Panel n']);
    await done();
    expect(sent().map((p) => p.panelId)).toEqual(['b', 'a', 'c', 'n']);
  });

  it('a panel removed while arranging leaves the draft', async () => {
    await renderPane(three());
    startArranging();
    act(() => setPanels([panel('a', 0), panel('c', 2)]));
    expect(titles()).toEqual(['Panel a', 'Panel c']);
    await done();
    expect(sent().map((p) => p.panelId)).toEqual(['a', 'c']);
  });

  it('Cancel discards the draft and sends nothing', async () => {
    await renderPane(three());
    startArranging();
    fireEvent.keyDown(handle('a'), { key: 'Delete' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.arrangePanels).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Panel a', 'Panel b', 'Panel c']);
  });

  it('a failed request keeps arrange mode open with the draft and shows the error', async () => {
    api.arrangePanels.mockImplementation(async () => {
      throw new Error('panel set changed');
    });
    await renderPane(three());
    startArranging();
    fireEvent.keyDown(handle('a'), { key: 'ArrowRight' });
    await done();
    expect(screen.getByRole('alert').textContent).toContain('panel set changed');
    expect(screen.getByRole('button', { name: 'Done arranging' })).toBeTruthy();
    expect(titles()).toEqual(['Panel b', 'Panel a', 'Panel c']);
  });

  it('dragging the handle over another panel moves it there', async () => {
    await renderPane(three());
    startArranging();
    const target = document.querySelector('[data-panel-id="c"]')!;
    document.elementFromPoint = vi.fn(() => target);
    fireEvent.pointerDown(handle('a'), { clientX: 5, clientY: 5, button: 0 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 5 });
    fireEvent.pointerUp(window);
    expect(titles()).toEqual(['Panel b', 'Panel c', 'Panel a']);
  });

  it('dragging ◢ resizes by whole columns and rows', async () => {
    await renderPane(three());
    startArranging();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 100,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 100,
      toJSON: () => ({}),
    });
    const grip = screen.getByRole('button', { name: 'Resize Panel a' });
    fireEvent.pointerDown(grip, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(window);
    await done();
    expect(sent()[0]!.layout).toEqual({ order: 0, w: 3, h: 2 });
  });
});
