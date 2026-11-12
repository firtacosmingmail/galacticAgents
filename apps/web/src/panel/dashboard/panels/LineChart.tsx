import type { PanelData } from '@galactic/protocol';
import { plainNumber } from '../format.js';

type Series = NonNullable<PanelData['series']>;

const W = 300;
const H = 90;
const PAD = 6;
export const SERIES_COLORS = [
  'var(--pnl-here)',
  'var(--pnl-beacon)',
  'var(--pnl-interrupted)',
  'var(--pnl-stalled)',
];

/** What a screen reader gets in place of the picture: latest value and range, per series. */
export function lineAlt(title: string, series: Series): string {
  const parts = series
    .filter((s) => s.points.length > 0)
    .map((s) => {
      const values = s.points.map((p) => p.value);
      const label = series.length > 1 ? `${s.name} ` : '';
      return `${label}latest ${plainNumber(values[values.length - 1]!)}, range ${plainNumber(
        Math.min(...values),
      )} to ${plainNumber(Math.max(...values))}`;
    });
  return `${title}: ${parts.join('; ') || 'no points'}`;
}

/** Plain-SVG line chart: one polyline per series over a shared time and value scale. */
export function LineChart({ title, series }: { title: string; series: Series }) {
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return null;
  const times = all.map((p) => Date.parse(p.at));
  const values = all.map((p) => p.value);
  const [t0, t1] = [Math.min(...times), Math.max(...times)];
  const [v0, v1] = [Math.min(...values), Math.max(...values)];
  const x = (at: string) =>
    t1 === t0 ? W / 2 : PAD + ((Date.parse(at) - t0) / (t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => (v1 === v0 ? H / 2 : H - PAD - ((v - v0) / (v1 - v0)) * (H - 2 * PAD));
  return (
    <svg
      className="dash-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={lineAlt(title, series)}
      preserveAspectRatio="none"
    >
      {series.map((s, i) => {
        const color = SERIES_COLORS[i % SERIES_COLORS.length]!;
        const last = s.points[s.points.length - 1];
        return (
          <g key={s.name}>
            <polyline
              fill="none"
              stroke={color}
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              points={s.points.map((p) => `${x(p.at)},${y(p.value)}`).join(' ')}
            />
            {last && <circle cx={x(last.at)} cy={y(last.value)} r="3" fill={color} />}
          </g>
        );
      })}
    </svg>
  );
}
