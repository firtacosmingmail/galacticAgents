import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyWorld, type Job, type Panel, type PanelData, type Project } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { useAppStore } from '../../state/store.js';
import { stubMedia } from '../../a11y/a11y-fixtures.js';
import { COMPACT_TOP_BAR_QUERY } from '../use-media-query.js';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { DashboardPane } from './DashboardPane.js';

/** P15-08 (SPEC decision 156): the phone follows the Mac's order — tiles in a strip, cards below. */

const shop: Project = {
  ...fx.project,
  id: 'p-shop',
  name: 'Shop',
  bodyId: 'b-saturn',
  longTerm: true,
  purpose: 'Sell lamps',
  goals: [],
};
const job: Job = { ...fx.job, id: 'j-1', projectId: 'p-shop', name: 'Count churn' };
const panel = (id: string, type: Panel['type'], order: number, over: Partial<Panel> = {}): Panel =>
  ({
    ...fx.panel,
    id,
    projectId: 'p-shop',
    type,
    title: `Panel ${id}`,
    source: { kind: 'job', jobId: 'j-1', values: ['x'] },
    layout: { order, w: 1, h: 1 },
    ...over,
  }) as Panel;

const panels = [
  panel('t1', 'tile', 0),
  panel('c1', 'text', 1),
  panel('t2', 'tile', 2),
  panel('c2', 'text', 3),
  panel('hid', 'text', 4, { layout: { order: 4, w: 1, h: 1, hidden: true } }),
  panel('c3', 'text', 5),
  panel('c4', 'text', 6),
  panel('c5', 'text', 7),
];
const datas: PanelData[] = panels.map((p) => ({
  panelId: p.id,
  status: 'ok',
  sourceLine: 'from job',
  ...(p.type === 'tile' ? { tile: { value: 4 } } : { text: `body of ${p.id}` }),
}));
const api = { dashboard: vi.fn(async () => ({ panels: datas })) };

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(async () => {
  stubMedia([COMPACT_TOP_BAR_QUERY]);
  useAppStore.getState().reset();
  useAppStore.setState({
    world: {
      ...emptyWorld(),
      projects: { 'p-shop': shop },
      jobs: { 'j-1': job },
      panels: Object.fromEntries(panels.map((p) => [p.id, p])),
    },
  });
  render(
    createElement(
      ApiContext.Provider,
      { value: api as unknown as Api },
      createElement(DashboardPane, { projectId: 'p-shop' }),
    ),
  );
  await settle();
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.unstubAllGlobals();
});

describe('the phone dashboard', () => {
  it('shows 2 tiles in the strip, 3 open cards and 2 folded ones; a hidden panel appears nowhere', () => {
    const strip = screen.getByRole('group', { name: 'Tiles' });
    expect(
      within(strip)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label')),
    ).toEqual(['Panel t1', 'Panel t2']);
    const cards = screen.getByRole('region', { name: 'Panels' });
    expect(
      within(cards)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label')),
    ).toEqual(['Panel c1', 'Panel c2', 'Panel c3']);
    const folded = within(cards).getAllByRole('button', { name: /^Panel c\d$/, expanded: false });
    expect(folded.map((b) => b.textContent)).toEqual(['Panel c4 ›', 'Panel c5 ›']);
    expect(screen.queryByText(/Panel hid/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Arrange' })).toBeNull();
  });

  it('tapping a folded card opens it', () => {
    fireEvent.click(screen.getByRole('button', { name: /Panel c4/ }));
    const cards = screen.getByRole('region', { name: 'Panels' });
    within(cards).getByRole('article', { name: 'Panel c4' });
    expect(
      within(cards).getAllByRole('button', { name: /^Panel c\d$/, expanded: false }),
    ).toHaveLength(1);
  });
});
