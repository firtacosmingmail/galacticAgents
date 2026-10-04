// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollBehavior } from '../panel/inbox-reveal.js';
import { REDUCED_MOTION_QUERY } from '../scene/motion.js';

/**
 * P5-04: the reduced-motion preference is respected by every panel animation. The panel's
 * stylesheet turns off every animation and transition under `.pnl` with one rule, and each
 * stylesheet that animates something says so for itself too (the scene's labels and legend sit
 * outside the panel's rule in tests and the ops console); smooth scrolling in code follows the
 * preference.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

/** The declarations that move something: an animation or a transition (not `animation: none`). */
const MOVES = /^\s*(animation|animation-name|transition|transition-property)\s*:\s*(?!none\b)/m;

describe('reduced motion (P5-04)', () => {
  it('turns off every animation and transition in the panel with one rule', () => {
    const css = readFileSync(join(SRC, 'panel/panel.css'), 'utf8');
    const block = /@media \(prefers-reduced-motion: reduce\) \{\s*\.pnl \*,[^}]*\}/.exec(css)?.[0];
    expect(block).toBeDefined();
    expect(block).toMatch(/animation-duration: 0\.01ms !important/);
    expect(block).toMatch(/animation-iteration-count: 1 !important/);
    expect(block).toMatch(/transition-duration: 0\.01ms !important/);
    expect(block).toMatch(/scroll-behavior: auto !important/);
  });

  it('every stylesheet that animates has its own reduced-motion block', () => {
    const files = cssFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    const moving = files.filter((f) => MOVES.test(readFileSync(f, 'utf8')));
    expect(moving.length).toBeGreaterThan(0);
    const missing = moving.filter(
      (f) => !readFileSync(f, 'utf8').includes('@media (prefers-reduced-motion: reduce)'),
    );
    expect(missing.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  describe('scrolling to the inbox or a card', () => {
    afterEach(() => vi.unstubAllGlobals());
    /** A window whose `matchMedia` answers the reduced-motion query (this file runs in node). */
    const prefer = (reduce: boolean) =>
      vi.stubGlobal('window', {
        matchMedia: (query: string) => ({
          matches: reduce && query === REDUCED_MOTION_QUERY,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      });

    it('is smooth by default and jumps with reduced motion', () => {
      prefer(false);
      expect(scrollBehavior()).toBe('smooth');
      prefer(true);
      expect(scrollBehavior()).toBe('auto');
    });
  });
});
