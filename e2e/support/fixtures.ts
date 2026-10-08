import { test as base, expect, type Page } from '@playwright/test';

/**
 * The smoke tests' fixtures (P8-05): the server's address and token (from `global-setup.ts`), a
 * REST helper for the server's API and its development harness (the token as a bearer, as the
 * ops console sends it), and `openApp`, which loads the panel the way a user's browser does.
 */
export interface Api {
  get: <T = unknown>(path: string) => Promise<T>;
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>;
}

export interface OpenOptions {
  /** The per-browser "scene hidden" preference (decision 62): list mode, no WebGL context. */
  listMode?: boolean;
  /** More per-browser preferences (`localStorage` entries) to set before the page loads. */
  storage?: Record<string, string>;
}

interface Fixtures {
  token: string;
  api: Api;
  openApp: (options?: OpenOptions) => Promise<void>;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run the suite through playwright.config.ts`);
  return value;
}

export const test = base.extend<Fixtures>({
  // The server picked its port at startup, after the config was read: the tests take it here.
  baseURL: async ({}, use) => {
    await use(env('E2E_BASE_URL'));
  },
  token: async ({}, use) => {
    await use(env('E2E_TOKEN'));
  },
  api: async ({ token }, use) => {
    const base = env('E2E_BASE_URL');
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
      return (text ? JSON.parse(text) : {}) as T;
    };
    await use({
      get: (path) => call('GET', path),
      post: (path, body) => call('POST', path, body ?? {}),
    });
  },
  openApp: async ({ page, token }, use) => {
    // The page's Content-Security-Policy (wave-3 review B1) must never refuse the app's own
    // scripts, workers, styles, images or socket: every test that opens the app checks it.
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (/Content Security Policy|Content-Security-Policy/i.test(msg.text())) {
        violations.push(msg.text());
      }
    });
    await use(async (options = {}) => {
      // Per-browser preferences before the first script runs: the scene shown or hidden, the
      // quality tier pinned (the settings say `balanced` too; this browser's choice wins).
      await page.addInitScript(
        ({ visible, storage }) => {
          try {
            localStorage.setItem('galactic.scene.visible', visible ? '1' : '0');
            localStorage.setItem('galactic.scene.tier', 'balanced');
            for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
          } catch {
            /* storage blocked: the defaults apply */
          }
        },
        { visible: !options.listMode, storage: options.storage ?? {} },
      );
      // The token as the settings page's QR code hands it over: in the fragment (P7-02).
      await page.goto(`/#token=${encodeURIComponent(token)}`);
      await expectLive(page);
    });
    expect(violations, 'CSP violations').toEqual([]);
  },
});

/** The panel's connection indicator says the session is live (snapshot received, caught up). */
export async function expectLive(page: Page): Promise<void> {
  await expect(page.locator('.pnl-conn-live')).toBeVisible();
}

export { expect };
