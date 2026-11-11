import type { Id, Panel, PanelLayout } from '@galactic/protocol';

/** One panel's place in an arrange draft; the draft is kept in `layout.order` order. */
export interface Placement {
  panelId: Id;
  layout: PanelLayout;
}

export const MAX_W = 4;
export const MAX_H = 3;

/** Renumbers `order` from 0 without gaps, keeping the sequence of the list. */
function renumber(list: Placement[]): Placement[] {
  return list.map((p, order) => ({ panelId: p.panelId, layout: { ...p.layout, order } }));
}

function byOrder(list: Placement[]): Placement[] {
  return [...list].sort((a, b) => a.layout.order - b.layout.order);
}

/** The draft a panel list starts from: every panel (hidden ones too) in dashboard order. */
export function draftOf(panels: readonly Panel[]): Placement[] {
  return renumber(byOrder(panels.map((p) => ({ panelId: p.id, layout: p.layout }))));
}

/**
 * Brings a draft in line with the panels that exist now: a panel that is gone is dropped, one
 * that appeared (the Waykeeper added it) goes at the end; the rest keep their pending order.
 * Returns the same array when nothing differs.
 */
export function reconcile(draft: Placement[], panels: readonly Panel[]): Placement[] {
  const live = new Map(panels.map((p) => [p.id, p]));
  const kept = draft.filter((d) => live.has(d.panelId));
  const known = new Set(kept.map((d) => d.panelId));
  const added = byOrder(
    panels.filter((p) => !known.has(p.id)).map((p) => ({ panelId: p.id, layout: p.layout })),
  );
  if (kept.length === draft.length && added.length === 0) return draft;
  return renumber([...kept, ...added]);
}

/** Moves a panel to `toIndex` of the list (clamped); the others keep their sequence. */
export function move(layouts: Placement[], panelId: Id, toIndex: number): Placement[] {
  const list = byOrder(layouts);
  const from = list.findIndex((p) => p.panelId === panelId);
  if (from < 0) return layouts;
  const [item] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, item!);
  return renumber(list);
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/** Sets a panel's size, clamped to 1–4 columns and 1–3 rows. */
export function resize(layouts: Placement[], panelId: Id, w: number, h: number): Placement[] {
  return layouts.map((p) =>
    p.panelId === panelId
      ? {
          panelId,
          layout: {
            ...p.layout,
            w: clamp(w, 1, MAX_W) as PanelLayout['w'],
            h: clamp(h, 1, MAX_H) as PanelLayout['h'],
          },
        }
      : p,
  );
}

/** Hides a panel; it keeps its place in the order. */
export function hide(layouts: Placement[], panelId: Id): Placement[] {
  return layouts.map((p) =>
    p.panelId === panelId ? { panelId, layout: { ...p.layout, hidden: true } } : p,
  );
}

/** Shows a hidden panel again, in the place it kept. */
export function show(layouts: Placement[], panelId: Id): Placement[] {
  return layouts.map((p) => {
    if (p.panelId !== panelId) return p;
    const { hidden: _hidden, ...layout } = p.layout;
    return { panelId, layout };
  });
}
