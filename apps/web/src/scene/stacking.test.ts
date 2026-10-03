import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The scene area's stacking order and the labels' pointer handling, read from the stylesheets
 * (jsdom applies no CSS): canvas < domain labels < scene chrome < hover label < popover, and the
 * labels never take the pointer (P3-07).
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
