// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BarChart } from './BarChart.js';

/** P15-06 (final review M2): a bar chart draws negatives below a zero line and labels each bar. */

const AT = '2026-11-11T10:00:00.000Z';
const series = (values: Record<string, number>) =>
  Object.entries(values).map(([name, value]) => ({ name, points: [{ at: AT, value }] }));

afterEach(cleanup);

describe('BarChart', () => {
  it('draws a negative value below the zero line and a positive one above it', () => {
    render(<BarChart title="Profit" series={series({ Shop: 4, Ads: -2 })} />);
    const svg = screen.getByRole('img', { name: /Profit.*Shop 4.*Ads -2/ });
    const zero = Number(svg.querySelector('line.dash-zero')!.getAttribute('y1'));
    const [shop, ads] = [...svg.querySelectorAll('rect')].map((r) => ({
      y: Number(r.getAttribute('y')),
      h: Number(r.getAttribute('height')),
    }));
    expect(shop!.h).toBeGreaterThan(0);
    expect(shop!.y + shop!.h).toBeCloseTo(zero);
    expect(ads!.h).toBeGreaterThan(0);
    expect(ads!.y).toBeCloseTo(zero);
    // Twice the value, twice the bar.
    expect(shop!.h).toBeCloseTo(2 * ads!.h);
  });

  it('labels each bar with its value', () => {
    render(<BarChart title="Cost" series={series({ Meta: 4, Google: 1234.5 })} />);
    const labels = [...document.querySelectorAll('text.dash-bar-value')].map((t) => t.textContent);
    expect(labels).toEqual(['4', '1,234.5']);
  });
});
