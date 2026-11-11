import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Id, Panel, PanelData } from '@galactic/protocol';
import { useApi } from '../../console/hierarchy/shared.js';
import { hide, move, reconcile, resize, show, draftOf, type Placement } from './arrange-model.js';
import { PanelFrame } from './PanelFrame.js';

/** Height of a grid row in pixels, as in dashboard.css (`grid-auto-rows`), plus the gap. */
const FALLBACK_ROW = 120;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Runs `onMove` for every pointer move until the pointer is released. */
function trackPointer(onMove: (x: number, y: number) => void) {
  const moved = (e: globalThis.PointerEvent) => onMove(e.clientX, e.clientY);
  const stop = () => {
    window.removeEventListener('pointermove', moved);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  };
  window.addEventListener('pointermove', moved);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

/**
 * Arrange mode (P15-07): the dashboard's panels with a handle ⠿ (drag, or arrow keys, to move;
 * Shift+arrows to resize; Delete to hide), a ◢ grip to resize and a ✕ to hide. Hidden panels wait
 * under "Hidden panels". Everything happens on a local draft; "Done arranging" sends one request
 * with every panel's layout, "Cancel" drops the draft. A panel the Waykeeper adds meanwhile goes
 * at the end, and one that is removed leaves the draft.
 */
export function ArrangeMode({
  projectId,
  panels,
  data,
  now,
  onClose,
}: {
  projectId: Id;
  /** Every panel of the project, hidden ones included. */
  panels: Panel[];
  data: Record<string, PanelData>;
  now: Date;
  onClose: () => void;
}) {
  const api = useApi();
  const [pending, setPending] = useState<Placement[]>(() => draftOf(panels));
  const draft = useMemo(() => reconcile(pending, panels), [pending, panels]);
  const byId = useMemo(() => new Map(panels.map((p) => [p.id, p])), [panels]);
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const gridRef = useRef<HTMLDivElement>(null);
  const refocus = useRef<Id | undefined>(undefined);

  const titleOf = (id: Id) => byId.get(id)?.title ?? '';
  const visible = draft.filter((p) => !p.layout.hidden);
  const hidden = draft.filter((p) => p.layout.hidden);

  // A keyboard move re-orders the DOM, which can drop focus; give it back to the handle.
  useEffect(() => {
    const id = refocus.current;
    if (id === undefined) return;
    refocus.current = undefined;
    document.querySelector<HTMLElement>(`[data-handle="${CSS.escape(id)}"]`)?.focus();
  }, [draft]);

  const moveBy = (id: Id, step: -1 | 1) => {
    const at = visible.findIndex((p) => p.panelId === id);
    const neighbour = visible[at + step];
    if (at < 0 || !neighbour) return;
    const to = draft.findIndex((p) => p.panelId === neighbour.panelId);
    const next = move(draft, id, to);
    refocus.current = id;
    setPending(next);
    const position = next.filter((p) => !p.layout.hidden).findIndex((p) => p.panelId === id) + 1;
    setAnnouncement(`${titleOf(id)} moved to position ${position}`);
  };

  const resizeBy = (id: Id, dw: number, dh: number) => {
    const current = draft.find((p) => p.panelId === id);
    if (!current) return;
    const w = Math.max(1, Math.min(4, current.layout.w + dw));
    const h = Math.max(1, Math.min(3, current.layout.h + dh));
    setPending(resize(draft, id, w, h));
    setAnnouncement(
      dw !== 0
        ? `${titleOf(id)} now ${plural(w, 'column', 'columns')} wide`
        : `${titleOf(id)} now ${plural(h, 'row', 'rows')} tall`,
    );
  };

  const hidePanel = (id: Id) => {
    setPending(hide(draft, id));
    setAnnouncement(`${titleOf(id)} hidden`);
  };
  const showPanel = (id: Id) => {
    setPending(show(draft, id));
    setAnnouncement(`${titleOf(id)} shown`);
  };

  const onKey = (id: Id, e: KeyboardEvent) => {
    const arrows: Record<string, [number, number]> = {
      ArrowRight: [1, 0],
      ArrowLeft: [-1, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
    };
    const arrow = arrows[e.key];
    if (arrow) {
      e.preventDefault();
      if (e.shiftKey) resizeBy(id, arrow[0], arrow[1]);
      else moveBy(id, arrow[0] + arrow[1] > 0 ? 1 : -1);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      hidePanel(id);
    }
  };

  const dragMove = (id: Id, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let current = draft;
    trackPointer((x, y) => {
      const over = document.elementFromPoint?.(x, y)?.closest<HTMLElement>('[data-panel-id]');
      const overId = over?.dataset.panelId;
      if (!overId || overId === id) return;
      const to = current.findIndex((p) => p.panelId === overId);
      if (to < 0) return;
      current = move(current, id, to);
      setPending(current);
    });
  };

  const dragResize = (id: Id, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = draft.find((p) => p.panelId === id);
    const grid = gridRef.current;
    const cell = grid?.querySelector(`[data-panel-id="${CSS.escape(id)}"]`);
    if (!start || !grid) return;
    const column = grid.getBoundingClientRect().width / 4;
    const row = cell ? cell.getBoundingClientRect().height / start.layout.h : FALLBACK_ROW;
    const x0 = e.clientX;
    const y0 = e.clientY;
    trackPointer((x, y) => {
      if (!(column > 0) || !(row > 0)) return;
      setPending((d) =>
        resize(
          reconcile(d, panels),
          id,
          start.layout.w + (x - x0) / column,
          start.layout.h + (y - y0) / row,
        ),
      );
    });
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.arrangePanels(projectId, draft);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="dash-arrange">
      <div className="dash-arrange-bar">
        <p className="muted">
          Drag ⠿ to move, ◢ to resize, ✕ to hide. With ⠿ focused: arrows move, Shift+arrows resize,
          Delete hides.
        </p>
        <span className="dash-arrange-actions">
          <button type="button" className="secondary" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={() => void save()}>
            Done arranging
          </button>
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          Could not save the arrangement: {error}
        </p>
      )}
      <p className="pnl-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="dash-grid is-arranging" ref={gridRef}>
        {visible.map(({ panelId, layout }) => {
          const panel = byId.get(panelId);
          if (!panel) return null;
          return (
            <div
              key={panelId}
              className="dash-arrange-cell"
              data-panel-id={panelId}
              style={{ gridColumn: `span ${layout.w}`, gridRow: `span ${layout.h}` }}
            >
              <div className="dash-arrange-tools">
                <button
                  type="button"
                  className="dash-handle"
                  data-handle={panelId}
                  aria-label={`Move ${panel.title}`}
                  onPointerDown={(e) => dragMove(panelId, e)}
                  onKeyDown={(e) => onKey(panelId, e)}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
                <button
                  type="button"
                  className="dash-icon"
                  aria-label={`Hide ${panel.title}`}
                  onClick={() => hidePanel(panelId)}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
              <PanelFrame panel={{ ...panel, layout }} data={data[panelId]} now={now} />
              <button
                type="button"
                className="dash-grip"
                aria-label={`Resize ${panel.title}`}
                onPointerDown={(e) => dragResize(panelId, e)}
              >
                <span aria-hidden="true">◢</span>
              </button>
            </div>
          );
        })}
      </div>
      {hidden.length > 0 && (
        <section className="dash-hidden" aria-label="Hidden panels">
          <h3 className="pnl-eyebrow">Hidden panels</h3>
          <ul>
            {hidden.map(({ panelId }) => (
              <li key={panelId}>
                <span>{titleOf(panelId)}</span>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Show ${titleOf(panelId)}`}
                  onClick={() => showPanel(panelId)}
                >
                  Show
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
