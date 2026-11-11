import type { PanelData } from '@galactic/protocol';
import { plainNumber } from '../format.js';
import { SERIES_COLORS } from './LineChart.js';

type Series = NonNullable<PanelData['series']>;

const W = 300;
const H = 90;
/** The series names under the bars. */
const LABEL = 14;
/** Room for a value label above a positive bar (and below a negative one). */
const VALUE = 11;

/** One bar per series: its latest value. */
const latest = (series: Series) =>
  series
    .filter((s) => s.points.length > 0)
    .map((s) => ({ name: s.name, value: s.points[s.points.length - 1]!.value }));

/**
 * Plain-SVG bar chart (e.g. cost per platform): the latest value of each series, labelled with
 * that value. Bars grow from a zero line: up for a positive value, down for a negative one.
 */
export function BarChart({ title, series }: { title: string; series: Series }) {
  const bars = latest(series);
  if (bars.length === 0) return null;
  const hi = Math.max(0, ...bars.map((b) => b.value));
  const lo = Math.min(0, ...bars.map((b) => b.value));
  const top = VALUE;
  const bottom = H - LABEL - (lo < 0 ? VALUE : 0);
  const scale = (bottom - top) / Math.max(hi - lo, 1e-9);
  const zero = top + hi * scale;
  const slot = W / bars.length;
  const barW = Math.min(slot * 0.6, 60);
  const alt = `${title}: ${bars.map((b) => `${b.name} ${plainNumber(b.value)}`).join(', ')}`;
  return (
    <svg className="dash-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={alt}>
      <line
        className="dash-zero"
        x1="0"
        x2={W}
        y1={zero}
        y2={zero}
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="1"
      />
      {bars.map((b, i) => {
        const h = Math.abs(b.value) * scale;
        const x = slot * i + (slot - barW) / 2;
        const y = b.value < 0 ? zero : zero - h;
        const labelY = b.value < 0 ? zero + h + VALUE - 2 : zero - h - 3;
        return (
          <g key={b.name}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx="2"
              fill={SERIES_COLORS[i % SERIES_COLORS.length]}
            />
            <text
              className="dash-bar-value"
              x={x + barW / 2}
              y={labelY}
              fontSize="9"
              textAnchor="middle"
              fill="currentColor"
            >
              {plainNumber(b.value)}
            </text>
            <text x={x + barW / 2} y={H - 3} fontSize="9" textAnchor="middle" fill="currentColor">
              {b.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
