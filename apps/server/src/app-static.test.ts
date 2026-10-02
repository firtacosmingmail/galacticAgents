import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
