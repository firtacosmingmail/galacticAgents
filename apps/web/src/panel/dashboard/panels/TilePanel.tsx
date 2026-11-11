import type { PanelData, PanelDisplay } from '@galactic/protocol';
import { formatValue, plainNumber } from '../format.js';

/** A big number with its change since the week or month before (or the run before). */
export function TilePanel({
  tile,
  display,
}: {
  tile: NonNullable<PanelData['tile']>;
  display: PanelDisplay;
}) {
  const { changePct, changeAbs } = tile;
  const change = changePct ?? changeAbs;
  const up = change !== undefined && change > 0;
  const vs = display.compare ? `vs last ${display.compare}` : 'vs the run before';
  const abs =
    changeAbs === undefined
      ? undefined
      : display.format === 'percent'
        ? `${plainNumber(Math.abs(changeAbs))} pt`
        : formatValue(Math.abs(changeAbs), display);
  const pct = changePct === undefined ? undefined : `${plainNumber(Math.abs(changePct))}%`;
  return (
    <div className="dash-tile">
      <div className="dash-big">{formatValue(tile.value, display)}</div>
      {change !== undefined && change !== 0 && (
        <div className="dash-change">
          <span aria-hidden="true">{up ? '▲' : '▼'}</span>
          <span className="pnl-visually-hidden">{up ? 'up ' : 'down '}</span>
          {[abs, abs !== undefined && pct !== undefined ? `(${pct})` : pct]
            .filter(Boolean)
            .join(' ')}{' '}
          {vs}
        </div>
      )}
    </div>
  );
}
