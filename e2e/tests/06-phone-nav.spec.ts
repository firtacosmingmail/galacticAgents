import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.js';
import { seedScenario } from '../support/world.js';

/**
 * The phone's navigation sheet (P8-15, `docs/tasks/notes/P8-15-nav-sheet.md`): on a phone-sized
 * touch screen the navigation is hidden, the top bar's "Agents" button opens it as a sheet from
 * the left, a selection closes it and the dock shows what was chosen; a swipe in from the left
 * edge opens it too, and a swipe to the left closes it; Back closes it without changing the
 * selection, and Back after a selection goes to the previous one (P8-15 review).
 */
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

/** A one-finger swipe through the browser's touch input (Playwright's touchscreen only taps). */
async function swipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 6,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: point(from.x, from.y),
  });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('phone: the navigation sheet opens from the button and closes on a selection', async ({
  page,
  api,
  openApp,
}) => {
  await seedScenario(api, { stewards: 1, asteroid: false });
  await openApp({ listMode: true });

  const button = page.getByRole('button', { name: /^Agents/ });
  const sheet = page.getByRole('dialog', { name: 'Agents' });
  const nav = page.getByRole('navigation', { name: 'navigation' });
  // Hidden on load: no navigation on screen, the button closed.
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();

  await button.tap();
  await expect(sheet).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  // The focus is in the sheet, on the selected row (the Harmonizer).
  await expect(nav.locator('a[aria-current="page"]')).toBeFocused();

  const project = nav.getByText(/^Harness project \d+$/).last();
  const title = (await project.textContent())!;
  await project.tap();
  await expect(sheet).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('main')).toHaveAttribute(
    'aria-label',
    `Conversation with Waykeeper · ${title}`,
  );
  // A page change: the focus is on the new page's title (decision 81).
  await expect(page.getByRole('main').locator('h1')).toBeFocused();

  // A tap on the scrim beside the sheet closes it too.
  await button.tap();
  await expect(sheet).toBeVisible();
  await page.touchscreen.tap(370, 400);
  await expect(sheet).toBeHidden();
});

test('phone: a swipe from the left edge opens the sheet, a swipe to the left closes it', async ({
  page,
  openApp,
}) => {
  // Nothing to seed: the sheet is there whatever the world holds (the harness has seven planets,
  // and the next test seeds the last free one).
  await openApp({ listMode: true });
  const sheet = page.getByRole('dialog', { name: 'Agents' });
  await expect(page.getByRole('button', { name: /^Agents/ })).toBeVisible();
  await expect(sheet).toBeHidden();

  // A swipe that starts away from the edge is not the sheet's.
  await swipe(page, { x: 150, y: 420 }, { x: 330, y: 420 });
  await expect(sheet).toBeHidden();

  await swipe(page, { x: 6, y: 420 }, { x: 200, y: 430 });
  await expect(sheet).toBeVisible();

  await swipe(page, { x: 250, y: 420 }, { x: 40, y: 430 });
  await expect(sheet).toBeHidden();
});

test('phone: Back closes the sheet and keeps the selection, with and without reduced motion', async ({
  page,
  api,
  openApp,
}) => {
  await seedScenario(api, { stewards: 1, asteroid: false });
  await openApp({ listMode: true });
  const button = page.getByRole('button', { name: /^Agents/ });
  const sheet = page.getByRole('dialog', { name: 'Agents' });
  const nav = page.getByRole('navigation', { name: 'navigation' });
  const main = page.getByRole('main');
  const harmonizerUrl = page.url();
  const harmonizerLabel = (await main.getAttribute('aria-label'))!;

  for (const motion of ['no-preference', 'reduce'] as const) {
    await page.emulateMedia({ reducedMotion: motion });
    await button.tap();
    await expect(sheet).toBeVisible();
    // The focus survives the (reduced-motion) reveal: on the selected row.
    await expect(nav.locator('a[aria-current="page"]')).toBeFocused();
    // Back — the system's gesture on Android, the browser's button — closes it, nothing else.
    await page.goBack();
    await expect(sheet).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(page.url()).toBe(harmonizerUrl);
    await expect(main).toHaveAttribute('aria-label', harmonizerLabel);

    // A selection, then Back: the previous selection, not the sheet again.
    await button.tap();
    await expect(sheet).toBeVisible();
    const project = nav.getByText(/^Harness project \d+$/).last();
    const title = (await project.textContent())!;
    await project.tap();
    await expect(sheet).toBeHidden();
    await expect(main).toHaveAttribute('aria-label', `Conversation with Waykeeper · ${title}`);
    await expect(main.locator('h1')).toBeFocused();
    await page.goBack();
    await expect(main).toHaveAttribute('aria-label', harmonizerLabel);
    expect(page.url()).toBe(harmonizerUrl);
    await expect(sheet).toBeHidden();
  }
});
