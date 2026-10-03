// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGEND_STATES,
  SATELLITE_LOOK,
  STATE_LOOK,
  satelliteTint,
  WAITING_AMBER,
} from '../satellites/look.js';
import { LEGEND_OPEN_KEY, legendColors, readLegendOpen, SatelliteLegend } from './Legend.js';

function stacked(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches, addEventListener() {}, removeEventListener() {} })),
  );
}

beforeEach(() => {
  localStorage.clear();
  stacked(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the satellite legend (P4-02)', () => {
  it('explains every state with the satellites’ own colours and pulses', () => {
    const { container } = render(<SatelliteLegend />);
    const rows = container.querySelectorAll('li[data-state]');
    expect([...rows].map((r) => r.getAttribute('data-state'))).toEqual([...LEGEND_STATES]);
    for (const state of LEGEND_STATES) {
      const row = container.querySelector(`li[data-state="${state}"]`)!;
      expect(row.textContent).toContain(STATE_LOOK[state].label);
      const dots = [...row.querySelectorAll('.scene-legend-dot')];
      expect(dots.map((d) => d.getAttribute('data-color'))).toEqual(legendColors(state));
      for (const dot of dots) expect(dot.className).toContain(`pulse-${STATE_LOOK[state].pulse}`);
    }
    // The working row shows both role colours; waiting is the amber, first and largest.
    expect(legendColors('working')).toEqual([
      satelliteTint({ role: 'waykeeper', state: 'working' }),
      satelliteTint({ role: 'steward', state: 'working' }),
    ]);
    expect(LEGEND_STATES[0]).toBe('waiting_for_input');
    const waiting = container.querySelector<HTMLElement>(
      'li[data-state="waiting_for_input"] .scene-legend-dot',
    )!;
    expect(waiting.getAttribute('data-color')).toBe(WAITING_AMBER);
    expect(waiting.style.getPropertyValue('--legend-scale')).toBe(
      String(STATE_LOOK.waiting_for_input.scale),
    );
    expect(container.querySelector('li[data-role="harmonizer"]')?.textContent).toContain(
      'Harmonizer HQ',
    );
    expect(
      container
        .querySelector('li[data-role="roles"] .scene-legend-dot')
        ?.getAttribute('data-color'),
    ).toBe(SATELLITE_LOOK.waykeeper.color);
  });

  it('collapses to a button and opens again, remembered per browser', () => {
    render(<SatelliteLegend />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide legend' }));
    expect(screen.queryByRole('list', { name: 'satellite legend' })).toBeNull();
    expect(localStorage.getItem(LEGEND_OPEN_KEY)).toBe('0');
    cleanup();
    render(<SatelliteLegend />);
    const open = screen.getByRole('button', { name: /Legend/ });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(open);
    expect(screen.getByRole('list', { name: 'satellite legend' })).toBeTruthy();
    expect(localStorage.getItem(LEGEND_OPEN_KEY)).toBe('1');
  });

  it('starts open on wide layouts and closed on stacked (phone) ones, until chosen', () => {
    expect(readLegendOpen()).toBe(true);
    stacked(true);
    expect(readLegendOpen()).toBe(false);
    localStorage.setItem(LEGEND_OPEN_KEY, '1');
    expect(readLegendOpen()).toBe(true);
  });
});
