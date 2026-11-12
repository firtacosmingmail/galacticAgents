import type { Panel, PanelData } from '@galactic/protocol';
import { shownVerdict, verdictArrow, verdictWord } from './format.js';

/** The panels with a verdict (very bad or very good), as a short list above the grid. */
export function NeedsALook({ panels, data }: { panels: Panel[]; data: Record<string, PanelData> }) {
  const items = panels.flatMap((p) => {
    const verdict = shownVerdict(data[p.id]);
    return verdict ? [{ panel: p, verdict }] : [];
  });
  if (items.length === 0) return null;
  return (
    <section className="dash-look" aria-label="Needs a look">
      <h2 className="pnl-eyebrow">Needs a look</h2>
      <ul>
        {items.map(({ panel, verdict }) => (
          <li key={panel.id} className={`is-${verdict.kind.replace('_', '-')}`}>
            <button
              type="button"
              className="dash-link"
              onClick={() =>
                document.getElementById(`dash-panel-${panel.id}`)?.scrollIntoView?.({
                  block: 'nearest',
                })
              }
            >
              {panel.title}
            </button>{' '}
            <span className="dash-verdict">
              {verdictWord(verdict.kind)}{' '}
              <span aria-hidden="true">{verdictArrow(verdict.arrow)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
