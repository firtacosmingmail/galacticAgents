import { useState } from 'react';
import { PHONE_OPEN_CARDS, type Panel, type PanelData } from '@galactic/protocol';
import { useDockView } from '../status/dock-view.js';
import { NeedsALook } from './NeedsALook.js';
import { PanelFrame } from './PanelFrame.js';

/**
 * The dashboard on a phone (P15-08; SPEC decision 156), in the Mac's order: "Needs a look", then
 * the number tiles as a swipeable strip, then every other panel as a full-width card — the first
 * `PHONE_OPEN_CARDS` open, the rest folded to a title line a tap opens. `panels` are the visible
 * ones, sorted by `layout.order`. Panels are the same `PanelFrame`s as on the Mac.
 */
export function PhoneDashboard({
  panels,
  data,
  now,
}: {
  panels: Panel[];
  data: Record<string, PanelData>;
  now: Date;
}) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  // A panel asked for by the job map opens if it is folded.
  const wanted = useDockView((s) => s.focusPanelId);
  const [seen, setSeen] = useState<string>();
  if (wanted && wanted !== seen) {
    setSeen(wanted);
    setUnfolded((s) => new Set(s).add(wanted));
  }
  const tiles = panels.filter((p) => p.type === 'tile');
  const cards = panels.filter((p) => p.type !== 'tile');
  return (
    <>
      <NeedsALook panels={panels} data={data} />
      {tiles.length > 0 && (
        <div className="dash-strip" role="group" aria-label="Tiles">
          {tiles.map((p) => (
            <PanelFrame key={p.id} panel={p} data={data[p.id]} now={now} />
          ))}
        </div>
      )}
      {cards.length > 0 && (
        <section className="dash-cards" aria-label="Panels">
          {cards.map((p, i) =>
            i < PHONE_OPEN_CARDS || unfolded.has(p.id) ? (
              <PanelFrame key={p.id} panel={p} data={data[p.id]} now={now} />
            ) : (
              <button
                key={p.id}
                type="button"
                className="dash-fold"
                aria-expanded={false}
                onClick={() => setUnfolded((s) => new Set(s).add(p.id))}
              >
                {p.title} <span aria-hidden="true">›</span>
              </button>
            ),
          )}
        </section>
      )}
    </>
  );
}
