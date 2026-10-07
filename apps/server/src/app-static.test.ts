import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './test/harness.js';

// The panel's deep links (P25-02): every page URL loads the single-page app; API paths stay 404.
let t: Awaited<ReturnType<typeof startTestApp>>;
let webDir: string;

beforeEach(async () => {
  webDir = mkdtempSync(join(tmpdir(), 'galactic-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>panel</title>');
  writeFileSync(join(webDir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(webDir, 'manifest.webmanifest'), '{"name":"GalacticAgents"}');
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'assets', 'index-abc123.js'), 'console.log(1);');
  mkdirSync(join(webDir, 'icons'));
  writeFileSync(join(webDir, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  t = await startTestApp({ webDir });
});
afterEach(async () => {
  await t.stop();
  rmSync(webDir, { recursive: true, force: true });
});

describe('static serving with deep links', () => {
  it('serves the page for the panel and console routes', async () => {
    for (const path of ['/', '/waykeeper/a-1', '/steward/a-2', '/debug']) {
      const res = await fetch(`${t.baseUrl}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('<title>panel</title>');
    }
  });

  it('keeps unknown API paths a 404', async () => {
    const res = await fetch(`${t.baseUrl}/api/nope`);
    expect(res.status).toBe(404);
  });
});

// The installable app (P7-01): the worker and the page are revalidated on every load, so a deploy
// is picked up at once; hashed build files are immutable; a missing build file is never the page.
describe('PWA files', () => {
  it('serves sw.js, the page and the manifest uncached, with their types', async () => {
    const sw = await fetch(`${t.baseUrl}/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    expect(sw.headers.get('content-type')).toMatch(/javascript/);

    for (const path of ['/', '/index.html', '/steward/a-2']) {
      const page = await fetch(`${t.baseUrl}${path}`);
      expect(page.headers.get('cache-control'), path).toBe('no-cache');
    }

    const manifest = await fetch(`${t.baseUrl}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
    expect(manifest.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
  });

  it('caches hashed assets for a year and icons for an hour', async () => {
    const asset = await fetch(`${t.baseUrl}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const icon = await fetch(`${t.baseUrl}/icons/icon-192.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('serves a build made after the server started, without a restart (P7-01 review)', async () => {
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>rebuilt</title>');
    writeFileSync(join(webDir, 'assets', 'index-new456.js'), 'console.log(2);');
    const asset = await fetch(`${t.baseUrl}/assets/index-new456.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toBe('console.log(2);');
    expect(await (await fetch(`${t.baseUrl}/steward/a-2`)).text()).toContain('rebuilt');
  });

  it('never serves a dotfile', async () => {
    writeFileSync(join(webDir, '.env'), 'SECRET=1');
    const res = await fetch(`${t.baseUrl}/.env`);
    expect(await res.text()).not.toContain('SECRET');
  });

  it('answers a missing build file with a 404, not the page', async () => {
    for (const path of ['/assets/index-old.js', '/icons/nope.png']) {
      const res = await fetch(`${t.baseUrl}${path}`);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("the page's Content-Security-Policy (wave-3 review B1)", () => {
  it('sends a strict policy with the page, for every deep link', async () => {
    for (const path of ['/', '/index.html', '/steward/a-2']) {
      const csp = (await fetch(`${t.baseUrl}${path}`)).headers.get('content-security-policy');
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).toContain("object-src 'none'");
      expect(csp, path).toContain("base-uri 'none'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).not.toMatch(/script-src[^;]*unsafe/);
      expect(csp, path).toMatch(/connect-src 'self' ws:\/\/[^ ;]+ wss:\/\/[^ ;]+/);
    }
    const asset = await fetch(`${t.baseUrl}/assets/index-abc123.js`);
    expect(asset.headers.get('content-security-policy')).toBeNull();
  });
});
