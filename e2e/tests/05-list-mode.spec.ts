import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.js';
import { askUser, questionOnServer, seedScenario, stamp } from '../support/world.js';

/**
 * The panel without the scene (decision 62; P5-05's "with and without the scene"): in list mode no
 * canvas and no WebGL context exist, and the panel still does the work — navigation, a project's
 * Waykeeper, a Steward's view, the inbox. A browser with no WebGL at all falls back to list mode
 * on its own and says why.
 */
async function webglContexts(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __webgl?: number }).__webgl ?? 0);
}

/** Counts the WebGL contexts the page asks for (before any of its scripts run). */
async function countWebgl(page: Page, refuse: boolean): Promise<void> {
  await page.addInitScript((refuseIt) => {
    const w = window as unknown as { __webgl?: number };
    w.__webgl = 0;
    const original = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error -- the overloads of getContext are not expressible here
    HTMLCanvasElement.prototype.getContext = function (kind: string, ...rest: unknown[]) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') {
        if (refuseIt) return null;
        w.__webgl = (w.__webgl ?? 0) + 1;
      }
      return (original as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    };
  }, refuse);
}

test('list mode: no canvas, no WebGL, and the panel does the work', async ({
  page,
  api,
  openApp,
}) => {
  const world = await seedScenario(api, { stewards: 1, asteroid: false });
  await countWebgl(page, false);
  await openApp({ listMode: true });

  await expect(page.getByRole('button', { name: 'Show scene' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'solar system' })).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(await webglContexts(page)).toBe(0);

  // Navigation → the project's Waykeeper → the Steward's view (SPEC §4.2.2, §4.2.6).
  const nav = page.getByRole('navigation', { name: 'navigation' });
  const project = nav.getByText(/^Harness project \d+$/).last();
  const title = (await project.textContent())!;
  await project.click();
  await expect(page.getByText(`Waykeeper · ${title}`).first()).toBeVisible();

  // The inbox answers in list mode too.
  const text = `List mode question ${stamp()}?`;
  await askUser(api, world.stewardIds[0]!, 'clarification', text);
  const card = page
    .getByRole('region', { name: 'question inbox' })
    .getByRole('article', { name: `clarification question ${text}` });
  await card.getByRole('textbox', { name: 'answer' }).fill('from the list');
  await card.getByRole('button', { name: 'Answer' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await questionOnServer(api, text))?.answer).toBe('from the list');
  expect(await webglContexts(page)).toBe(0);
});

test('without WebGL the panel falls back to list mode and says why', async ({ page, openApp }) => {
  await countWebgl(page, true);
  await openApp();
  // The top bar says so, the reason in its title; no Retry (it cannot help without WebGL).
  const note = page.getByRole('note').filter({ hasText: '3D scene unavailable — list mode' });
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('title', 'WebGL is not available in this browser');
  await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'solar system' })).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'navigation' });
  await expect(nav.getByText('Harmonizer', { exact: true })).toBeVisible();
});
