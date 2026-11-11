import type { Panel, PanelData } from '@galactic/protocol';
import { PanelFrame } from './PanelFrame.js';

/**
 * The Mac's grid: four columns, dense, each panel spanning its layout's `w` columns and `h` rows
 * in the dashboard's order; hidden panels are skipped. `panels` arrive sorted by `layout.order`.
 * Arrange mode (P15-07) and the phone's cards (P15-08) wrap or replace this component.
 */
export function PanelGrid({
  panels,
  data,
  now,
}: {
  panels: Panel[];
  data: Record<string, PanelData>;
  now: Date;
}) {
  return (
    <div className="dash-grid">
      {panels.map((p) => (
        <PanelFrame key={p.id} panel={p} data={data[p.id]} now={now} />
      ))}
    </div>
  );
}
