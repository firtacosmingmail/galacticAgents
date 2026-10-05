import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * The service worker's build step (P7-01, TECHNOLOGY §2.4): production builds only, after the
 * bundle is written, `src/pwa/sw.js` is copied to `dist/sw.js` with its BUILD filled in — a
 * version that changes with every different build (so the browser installs the new worker) and
 * the app shell to precache (the page, its entry script and stylesheet, the manifest, the icons).
 * Development (`vite`) never sees a worker: the plugin applies to `build` and the page registers
 * one only in production (`register.ts`).
 */

/** The manifest and icons in `public/`, precached with the page. */
export const STATIC_SHELL = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
  '/icons/apple-touch-icon.png',
];

/** The same-origin `/assets/…` files the built page loads directly (entry script, CSS, preloads). */
export function shellAssets(indexHtml: string): string[] {
  const found = new Set<string>();
  for (const m of indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

/** A short version for the build: its file names (content-hashed) and its page. */
export function buildVersion(fileNames: string[], indexHtml: string, template: string): string {
  const hash = createHash('sha256');
  for (const name of [...fileNames].sort()) hash.update(name + '\n');
  hash.update(indexHtml);
  hash.update(template);
  return hash.digest('hex').slice(0, 12);
}

const BUILD_SLOT = /\/\*BUILD\*\/[\s\S]*?(?:;\s*)?\/\*END\*\/;?/;

/** The worker's source with its BUILD slot filled in. */
export function renderServiceWorker(
  template: string,
  build: { version: string; precache: string[] },
): string {
  if (!BUILD_SLOT.test(template)) throw new Error('sw.js: the /*BUILD*/ … /*END*/ slot is missing');
  return template.replace(BUILD_SLOT, () => `${JSON.stringify(build)};`);
}

export function serviceWorkerPlugin(): Plugin {
  const templatePath = new URL('./sw.js', import.meta.url);
  return {
    name: 'galactic-service-worker',
    apply: 'build',
    writeBundle(options, bundle) {
      const page = bundle['index.html'];
      if (!page || page.type !== 'asset') return;
      const indexHtml = typeof page.source === 'string' ? page.source : page.source.toString();
      const template = readFileSync(templatePath, 'utf8');
      const precache = ['/', ...shellAssets(indexHtml), ...STATIC_SHELL];
      const version = buildVersion(Object.keys(bundle), indexHtml, template);
      const dir = options.dir ?? 'dist';
      writeFileSync(join(dir, 'sw.js'), renderServiceWorker(template, { version, precache }));
    },
  };
}
