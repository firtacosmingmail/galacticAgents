import { expect, expectLive, test } from '../support/fixtures.js';

/**
 * The app loads from the production build, authenticates with the token from the server's config,
 * and renders the snapshot: the panel goes live and shows the Harmonizer (the fake one, which
 * greets on its first turn) and its chat.
 */
test('loads, authenticates with the config token and renders the snapshot', async ({
  page,
  token,
  openApp,
}) => {
  await openApp();
  // The fragment's token went live, so the page kept it (P7-02) and took it out of the address.
  expect(await page.evaluate(() => localStorage.getItem('galactic.token'))).toBe(token);
  expect(new URL(page.url()).hash).toBe('');
  // The snapshot: the Harmonizer in the navigation and as the dock's conversation (SPEC §4.2.1).
  const nav = page.getByRole('navigation', { name: 'navigation' });
  await expect(nav.getByText('Harmonizer', { exact: true })).toBeVisible();
  await expect(page.getByText('Talking to')).toBeVisible();
  // The fake Harmonizer's first turn, from the event log.
  await expect(page.getByText('hello from the fake agent').first()).toBeVisible();
  // The scene is shown (WebGL on SwiftShader) and drew the catalogue's bodies.
  await expect(page.getByRole('region', { name: 'solar system' })).toBeVisible();
  await expect(page.getByTestId('scene-probe')).toHaveAttribute('data-bodies', /\bb-earth\b/);
});

test('a wrong token in the link is refused and never kept', async ({ page, token }) => {
  await page.goto('/#token=not-the-token');
  // Refused, the page falls back to what the server hands a page on its own machine (`/health`,
  // P3-08): it goes live with the real token and never stored the wrong one.
  await expectLive(page);
  expect(await page.evaluate(() => localStorage.getItem('galactic.token'))).toBe(token);
});
