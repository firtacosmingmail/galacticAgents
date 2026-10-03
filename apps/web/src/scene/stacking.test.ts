import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The scene area's stacking order and the labels' pointer handling, read from the stylesheets
 * (jsdom applies no CSS): canvas < domain labels < scene chrome < hover label < popover, and the
 * labels never take the pointer (P3-07); a finished label's text stays readable.
 */
const css = (file: string) => readFileSync(resolve(import.meta.dirname, file), 'utf8');
const sheets = [
  'scene.css',
  'bodies/scale-toggle.css',
  'picking/picking.css',
  'labels/labels.css',
].map(css);

/** The declarations of the rule whose selector is exactly `selector` (comments stripped). */
function rule(selector: string): Record<string, string> {
  for (const sheet of sheets) {
    const text = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (match[1]!.trim() !== selector) continue;
      return Object.fromEntries(
        match[2]!
          .split(';')
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => {
            const i = d.indexOf(':');
            return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
          }),
      );
    }
  }
  throw new Error(`no rule for ${selector}`);
}

/** A layer's z-index, resolved through the scene area's custom properties. */
function z(selector: string): number {
  const value = rule(selector)['z-index'];
  if (value === undefined) throw new Error(`${selector} has no z-index`);
  const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return Number(name ? rule('.pnl-scene')[name] : value);
}

describe('scene stacking order', () => {
  it('canvas < labels < chrome (fps, breadcrumb, scale toggle) < hover label < popover', () => {
    const labels = z('.scene-labels');
    expect(labels).toBeGreaterThan(0);
    for (const chrome of ['.pnl-scene-fps', '.pnl-scene-crumbs', '.pnl-scene-scale'])
      expect(z(chrome)).toBeGreaterThan(labels);
    expect(z('.pick-hover')).toBeGreaterThan(z('.pnl-scene-crumbs'));
    expect(z('.pick-popover')).toBeGreaterThan(z('.pick-hover'));
  });

  it('the labels never take the pointer: wheel, drag and click reach the canvas', () => {
    expect(rule('.scene-labels')['pointer-events']).toBe('none');
    expect(rule('.scene-label')['pointer-events']).toBe('none');
    const anyAuto = sheets[3]!.match(/pointer-events:\s*(?!none)\w+/g);
    expect(anyAuto).toBeNull();
  });
});

type Rgb = [number, number, number];

function color(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([\da-f]{6})$/i.exec(value)?.[1];
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb, alpha: 1 };
  const rgba = /^rgba\(([^)]+)\)$/.exec(value)?.[1];
  if (!rgba) throw new Error(`unparsed colour ${value}`);
  const [r, g, b, a] = rgba.split(',').map(Number);
  return { rgb: [r!, g!, b!], alpha: a! };
}

const over = (top: string, under: Rgb): Rgb => {
  const { rgb, alpha } = color(top);
  return rgb.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as Rgb;
};

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('finished labels: dimmer, still readable (WCAG AA, 4.5:1)', () => {
  // The label's background over the scene's own background.
  const scene = color(rule('.pnl-scene').background!).rgb;
  const label = over(rule('.scene-label').background!, scene);

  it('no opacity on a finished label (it would dim the text below AA)', () => {
    expect(rule('.scene-label.tone-done').opacity).toBeUndefined();
  });

  it('title, state pill and "part of" line keep at least 4.5:1', () => {
    const title = color(rule('.scene-label.tone-done').color!).rgb;
    expect(contrast(title, label)).toBeGreaterThanOrEqual(4.5);
    const pill = rule('.scene-label.tone-done .scene-label-state');
    expect(contrast(color(pill.color!).rgb, over(pill.background!, label))).toBeGreaterThanOrEqual(
      4.5,
    );
    const part = color(rule('.scene-label-part').color!).rgb;
    expect(contrast(part, label)).toBeGreaterThanOrEqual(4.5);
  });

  it('and still dimmer than an open label', () => {
    const open = color(rule('.scene-label').color!).rgb;
    const done = color(rule('.scene-label.tone-done').color!).rgb;
    expect(luminance(done)).toBeLessThan(luminance(open));
  });
});
