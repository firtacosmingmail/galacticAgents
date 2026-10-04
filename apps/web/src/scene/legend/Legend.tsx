import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentState } from '@galactic/protocol';
import { STACKED_LAYOUT_QUERY } from '../../panel/use-media-query.js';
import {
  LEGEND_STATES,
  ROLE_COLOR,
  SATELLITE_LOOK,
  STATE_LOOK,
  type Pulse,
} from '../satellites/look.js';
import './legend.css';

/**
 * The scene's legend (P4-02): what a satellite's colour, pulse and size mean, drawn with the same
 * table the satellites use (`satellites/look.ts`) as small CSS swatches that pulse the same way
 * (and stand still under reduced motion, like the satellites). Top-right over the canvas, clear of
 * the breadcrumb (bottom-left), the scale toggle (bottom-right) and the fps meter (top-left); in
 * the scene chrome's stacking layer. Collapsible to a small "Legend" button; open or closed is
 * remembered per browser (a device preference), and starts closed on narrow (stacked) layouts.
 * In the panel's chunk: no three.js.
 */
export const LEGEND_OPEN_KEY = 'galactic.scene.legend.open';

export function readLegendOpen(): boolean {
  try {
    const stored = localStorage.getItem(LEGEND_OPEN_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // no storage: fall through to the layout's default
  }
  try {
    return !window.matchMedia(STACKED_LAYOUT_QUERY).matches;
  } catch {
    return true;
  }
}

export function writeLegendOpen(open: boolean): void {
  try {
    localStorage.setItem(LEGEND_OPEN_KEY, open ? '1' : '0');
  } catch {
    // No storage (private mode): the choice lasts for this page only.
  }
}

/** The swatch colours of a state: the role colours for a state drawn in its role's colour. */
export function legendColors(state: AgentState): string[] {
  const color = STATE_LOOK[state].color;
  return color === ROLE_COLOR
    ? [SATELLITE_LOOK.waykeeper.color, SATELLITE_LOOK.steward.color]
    : [color];
}

function Swatch({ color, pulse, scale }: { color: string; pulse: Pulse; scale: number }) {
  const style = { '--legend-dot': color, '--legend-scale': scale } as CSSProperties;
  return <span className={`scene-legend-dot pulse-${pulse}`} style={style} data-color={color} />;
}

export function SatelliteLegend() {
  const [open, setOpenState] = useState(readLegendOpen);
  // P5-04: the toggle is a different button open and closed; the focus follows it across.
  const root = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const setOpen = useCallback((next: boolean) => {
    writeLegendOpen(next);
    refocus.current = true;
    setOpenState(next);
  }, []);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    root.current?.querySelector<HTMLButtonElement>('.scene-legend-toggle')?.focus();
  }, [open]);
  if (!open) {
    return (
      <div className="scene-legend is-closed" ref={root}>
        <button
          type="button"
          className="scene-legend-toggle"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <span className="scene-legend-mini" aria-hidden="true">
            {LEGEND_STATES.slice(0, 3).map((s) => (
              <Swatch key={s} color={legendColors(s)[0]!} pulse="steady" scale={1} />
            ))}
          </span>
          Legend
        </button>
      </div>
    );
  }
  return (
    <div className="scene-legend" ref={root}>
      <div className="scene-legend-head">
        <span className="scene-legend-title">Satellites</span>
        <button
          type="button"
          className="scene-legend-toggle"
          aria-expanded={true}
          aria-controls="scene-legend-body"
          aria-label="Hide legend"
          onClick={() => setOpen(false)}
        >
          Hide
        </button>
      </div>
      <ul id="scene-legend-body" className="scene-legend-body" aria-label="satellite legend">
        {LEGEND_STATES.map((state) => {
          const look = STATE_LOOK[state];
          return (
            <li key={state} data-state={state}>
              <span className="scene-legend-swatch">
                {legendColors(state).map((c) => (
                  <Swatch key={c} color={c} pulse={look.pulse} scale={look.scale} />
                ))}
              </span>
              <span className="scene-legend-text">
                <b>{look.label}</b> <span className="scene-legend-hint">{look.hint}</span>
              </span>
            </li>
          );
        })}
        <li className="scene-legend-roles" data-role="roles">
          <span className="scene-legend-swatch">
            <Swatch color={SATELLITE_LOOK.waykeeper.color} pulse="steady" scale={1.25} />
            <Swatch color={SATELLITE_LOOK.steward.color} pulse="steady" scale={0.85} />
          </span>
          <span className="scene-legend-text">
            <b>Waykeeper</b> larger, warm · <b>Steward</b> smaller, blue
          </span>
        </li>
        <li data-role="harmonizer">
          <span className="scene-legend-swatch">
            <span className="scene-legend-hq" aria-hidden="true" />
          </span>
          <span className="scene-legend-text">
            <b>Harmonizer HQ</b>{' '}
            <span className="scene-legend-hint">
              the station by Earth; its ring spins fast while it thinks
            </span>
          </span>
        </li>
        <li data-role="beacon">
          <span className="scene-legend-swatch">
            <span className="scene-legend-beacon" aria-hidden="true">
              ?
            </span>
          </span>
          <span className="scene-legend-text">
            <b>Question beacon</b>{' '}
            <span className="scene-legend-hint">
              a pillar above a body: a question waits for you, one per question (a padlock: a
              permission); click it to go to the agent asking and open it in the inbox
            </span>
          </span>
        </li>
      </ul>
    </div>
  );
}
