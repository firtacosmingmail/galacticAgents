import { describe, expect, it } from 'vitest';
import type { PanelLayout } from '@galactic/protocol';
import { draftOf, hide, move, reconcile, resize, show, type Placement } from './arrange-model.js';
import { domain as fx } from '@galactic/protocol/fixtures';

const place = (panelId: string, order: number, over: Partial<PanelLayout> = {}): Placement => ({
  panelId,
  layout: { order, w: 1, h: 1, ...over },
});
const ids = (l: Placement[]) => l.map((p) => p.panelId);
const orders = (l: Placement[]) => l.map((p) => p.layout.order);

describe('arrange model', () => {
  const three = [place('a', 0), place('b', 1), place('c', 2)];

  it('move renumbers order from 0 with no gaps', () => {
    const moved = move([place('a', 3), place('b', 7), place('c', 9)], 'a', 2);
    expect(ids(moved)).toEqual(['b', 'c', 'a']);
    expect(orders(moved)).toEqual([0, 1, 2]);
  });

  it('move clamps the target index and ignores an unknown panel', () => {
    expect(ids(move(three, 'a', 99))).toEqual(['b', 'c', 'a']);
    expect(ids(move(three, 'c', -4))).toEqual(['c', 'a', 'b']);
    expect(move(three, 'zz', 1)).toBe(three);
  });

  it('resize clamps to w 1-4 and h 1-3', () => {
    const big = resize(three, 'b', 9, 9).find((p) => p.panelId === 'b')!;
    expect(big.layout).toMatchObject({ w: 4, h: 3 });
    const small = resize(three, 'b', 0, -2).find((p) => p.panelId === 'b')!;
    expect(small.layout).toMatchObject({ w: 1, h: 1 });
    expect(resize(three, 'b', 2, 2)[0]).toBe(three[0]);
  });

  it('hide keeps the place; show clears the flag', () => {
    const hidden = hide(three, 'b');
    expect(hidden[1]!.layout).toEqual({ order: 1, w: 1, h: 1, hidden: true });
    expect(show(hidden, 'b')[1]!.layout).toEqual({ order: 1, w: 1, h: 1 });
  });

  it('reconcile appends a new panel and drops a removed one, keeping the pending order', () => {
    const draft = [place('c', 0), place('a', 1), place('b', 2)];
    const panels = [
      { ...fx.panel, id: 'a', layout: { order: 0, w: 1, h: 1 } },
      { ...fx.panel, id: 'c', layout: { order: 2, w: 1, h: 1 } },
      { ...fx.panel, id: 'n', layout: { order: 5, w: 2, h: 1 } },
    ];
    const next = reconcile(draft, panels as never);
    expect(ids(next)).toEqual(['c', 'a', 'n']);
    expect(orders(next)).toEqual([0, 1, 2]);
    expect(reconcile(next, panels as never)).toBe(next);
  });

  it('draftOf sorts by order and includes hidden panels', () => {
    const panels = [
      { ...fx.panel, id: 'x', layout: { order: 4, w: 1, h: 1, hidden: true } },
      { ...fx.panel, id: 'y', layout: { order: 2, w: 1, h: 1 } },
    ];
    const d = draftOf(panels as never);
    expect(ids(d)).toEqual(['y', 'x']);
    expect(d[1]!.layout.hidden).toBe(true);
  });
});
