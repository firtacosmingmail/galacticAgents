import type { PanelData } from '@galactic/protocol';
import { plainNumber } from '../format.js';
import { SERIES_COLORS } from './LineChart.js';

type Series = NonNullable<PanelData['series']>;

const W = 300;
const H = 90;
const LABEL = 14;

/** One bar per series: its latest value. */
const latest = (series: Series) =>
  series
    .filter((s) => s.points.length > 0)
    .map((s) => ({ name: s.name, value: s.points[s.points.length - 1]!.value }));

/** Plain-SVG bar chart (e.g. cost per platform): the latest value of each series. */
export function BarChart({ title, series }: { title: string; series: Series }) {
  const bars = latest(series);
  if (bars.length === 0) return null;
  const max = Math.max(...bars.map((b) => Math.abs(b.value)), 1e-9);
  const slot = W / bars.length;
  const barW = Math.min(slot * 0.6, 60);
  const alt = `${title}: ${bars.map((b) => `${b.name} ${plainNumber(b.value)}`).join(', ')}`;
  return (
    <svg className="dash-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={alt}>
      {bars.map((b, i) => {
        const h = (Math.abs(b.value) / max) * (H - LABEL - 4);
        const x = slot * i + (slot - barW) / 2;
        return (
          <g key={b.name}>
            <rect
              x={x}
              y={H - LABEL - h}
              width={barW}
              height={h}
              rx="2"
              fill={SERIES_COLORS[i % SERIES_COLORS.length]}
            />
            <text x={x + barW / 2} y={H - 3} fontSize="9" textAnchor="middle" fill="currentColor">
              {b.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
