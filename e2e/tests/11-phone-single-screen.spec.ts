import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.js';
import { askUser, clearHarness, questionOnServer, seedScenario, stamp } from '../support/world.js';

/**
 * One screen at a time on a phone (P8-18, SPEC decision 140): the chat fills the screen; the top
 * bar's Inbox button (a dot while something waits) and Managed-agents button open those full
 * screen, closed with ✕ or Back; what was typed in the chat survives; a wide screen keeps the
 * inbox in the side column.
 */
const composer = (page: Page) => page.getByRole('textbox', { name: 'message to Harmonizer' });
const inboxButton = (page: Page) => page.getByRole('button', { name: /^Inbox/ });
const fullView = (page: Page, name: string) => page.getByRole('dialog', { name });

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the inbox opens full screen, answers there, and the draft survives Back', async ({
    page,
    api,
    openApp,
  }) => {
    const world = await seedScenario(api, { stewards: 1, asteroid: false });
    await openApp({ listMode: true });
    // The chat has the screen: no inbox under it.
    await expect(composer(page)).toBeVisible();
    await expect(page.locator('#pnl-inbox')).toHaveCount(0);
    await expect(inboxButton(page).locator('.pnl-inbox-count')).toHaveCount(0);

    const question = `Which font for the docs ${stamp()}?`;
    await askUser(api, world.stewardIds[0]!, 'clarification', question);
    await expect(inboxButton(page).locator('.pnl-inbox-count')).toBeVisible();

    await composer(page).fill('Also make sure the tests run');
    await inboxButton(page).tap();
    const view = fullView(page, 'Inbox');
    await expect(view).toBeVisible();
    const card = view.getByRole('article', { name: `clarification question ${question}` });
    await card.getByLabel('answer').fill('Inter');
    await card.getByRole('button', { name: 'Answer' }).tap();
    await expect.poll(async () => (await questionOnServer(api, question))?.status).toBe('answered');
    await expect(inboxButton(page).locator('.pnl-inbox-count')).toHaveCount(0);

    await page.goBack();
    await expect(view).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(composer(page)).toHaveValue('Also make sure the tests run');
    await clearHarness(api);
  });

  test('the managed agents open full screen and close with ✕', async ({ page, api, openApp }) => {
    await seedScenario(api, { stewards: 1, asteroid: false });
    await openApp({ listMode: true });
    await page.getByRole('button', { name: 'Managed agents', exact: true }).tap();
    const view = fullView(page, 'Managed agents');
    await expect(view).toBeVisible();
    await expect(view.locator('article.agc').first()).toBeVisible();
    await view.getByRole('button', { name: 'Close managed agents' }).tap();
    await expect(view).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
    await clearHarness(api);
  });
});

test('a wide screen keeps the inbox in the side column', async ({ page, openApp }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp({ listMode: true });
  await expect(page.locator('aside.pnl-side #pnl-inbox')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Managed agents', exact: true })).toHaveCount(0);
});
