// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildVersion,
  renderServiceWorker,
  serviceWorkerPlugin,
  shellAssets,
  STATIC_SHELL,
} from './build-plugin.js';

const TEMPLATE = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
const PAGE = `<!doctype html><html><head>
<link rel="manifest" href="/manifest.webmanifest" />
<script type="module" crossorigin src="/assets/index-CAVAy7ID.js"></script>
<link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-hePW80VL.js">
<link rel="stylesheet" crossorigin href="/assets/index-H1BJkRb9.css">
</head><body><div id="root"></div></body></html>`;

describe('the service worker build step (P7-01)', () => {
  it('finds the assets the built page loads directly', () => {
    expect(shellAssets(PAGE)).toEqual([
      '/assets/index-CAVAy7ID.js',
      '/assets/index-H1BJkRb9.css',
      '/assets/rolldown-runtime-hePW80VL.js',
    ]);
  });

  it('versions a build by its files and page: same build same version, new build new one', () => {
    const files = ['index.html', 'assets/index-CAVAy7ID.js', 'assets/index-H1BJkRb9.css'];
    const v = buildVersion(files, PAGE, TEMPLATE);
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(buildVersion([...files].reverse(), PAGE, TEMPLATE)).toBe(v);
    const next = files.map((f) => f.replace('CAVAy7ID', 'Zz9xQw12'));
    expect(buildVersion(next, PAGE.replace('CAVAy7ID', 'Zz9xQw12'), TEMPLATE)).not.toBe(v);
  });

  it('fills the BUILD slot and leaves a script that parses', () => {
    const out = renderServiceWorker(TEMPLATE, { version: 'abc', precache: ['/', '/a$&.js'] });
    expect(out).toContain('const BUILD = {"version":"abc","precache":["/","/a$&.js"]};');
    expect(out).not.toContain('/*BUILD*/');
    expect(() => new Function(out)).not.toThrow();
    expect(() => renderServiceWorker('no slot', { version: 'x', precache: [] })).toThrow(/slot/);
  });

  it('is a build-only plugin', () => {
    expect(serviceWorkerPlugin().apply).toBe('build');
  });

  it('precaches only files that exist in public/', () => {
    for (const path of STATIC_SHELL) {
      expect(
        () => readFileSync(new URL(`../../public${path}`, import.meta.url)),
        path,
      ).not.toThrow();
    }
  });
});
