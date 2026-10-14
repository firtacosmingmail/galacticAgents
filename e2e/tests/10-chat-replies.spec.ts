import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.js';
import { askUser, clearHarness, questionOnServer, seedScenario, stamp } from '../support/world.js';

/**
 * Replies in the Harmonizer's chat (P8-17, SPEC decision 139): the user replies to a line or a
 * card of the thread; the sent message shows the quote above it, the quote jumps back to the
 * original, and the fake Harmonizer (which echoes its turn prompt) shows that the prompt carried
 * the quoted context. A reply to an open clarification answers it; to a permission request it
 * does not decide it.
 */
const chat = (page: Page) => page.getByRole('log', { name: 'conversation with Harmonizer' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'message to Harmonizer' });

test('replies to the Harmonizer’s line; the quote jumps back to it', async ({ page, openApp }) => {
  await openApp({ listMode: true });
  const greeting = chat(page).locator('.pnl-line-brain', { hasText: 'hello from the fake agent' });
  await expect(greeting.first()).toBeVisible();
  const original = greeting.first();
  await original.hover();
  await original.getByRole('button', { name: /^Reply to Harmonizer: / }).click();
  const bar = page.getByRole('group', { name: 'replying to' });
  await expect(bar).toContainText('Replying to Harmonizer');
  await expect(bar).toContainText('hello from the fake agent');

  const text = `Tell me more ${stamp()}`;
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(bar).toHaveCount(0);
  const mine = chat(page).locator('.pnl-line-user', { hasText: text });
  const quote = mine.getByRole('button', { name: /^Quoted Harmonizer: hello from the fake agent/ });
  await expect(quote).toBeVisible();
  // The fake Harmonizer echoes its turn prompt: it carried the quoted line.
  await expect(
    chat(page)
      .locator('.pnl-line-brain', { hasText: `replying to your reply: "hello from the fake agent` })
      .first(),
  ).toBeVisible();

  await quote.click();
  await expect(original).toHaveClass(/is-highlighted/);
  await expect(original).toBeFocused();
});

test('a reply to a clarification card answers it', async ({ page, api, openApp }) => {
  const world = await seedScenario(api, { stewards: 1, asteroid: false });
  await openApp({ listMode: true });
  const question = `Which colour for the header ${stamp()}?`;
  await askUser(api, world.stewardIds[0]!, 'clarification', question);
  // A project's clarification held by the user shows in the Harmonizer's chat (decision 55).
  const card = chat(page).locator('.thread-card', {
    has: page.getByRole('article', { name: `clarification question ${question}` }),
  });
  await expect(card).toBeVisible();
  await card.hover();
  await card.getByRole('button', { name: `Reply to the question: ${question}` }).click();
  await expect(page.getByRole('group', { name: 'replying to' })).toContainText(
    'Your reply answers this question.',
  );
  await composer(page).fill('Teal, please');
  await composer(page).press('Enter');

  await expect.poll(async () => (await questionOnServer(api, question))?.status).toBe('answered');
  const answered = await questionOnServer(api, question);
  expect(answered?.answer).toBe('Teal, please');
  expect(answered?.answeredBy).toEqual(expect.objectContaining({ type: 'user' }));
  const mine = chat(page).locator('.pnl-line-user', { hasText: 'Teal, please' });
  await expect(
    mine.getByRole('button', { name: /^Quoted .*· question: Which colour/ }),
  ).toContainText('answered');
  // One line in the Harmonizer's next turn says the user answered it by replying.
  await expect(
    chat(page)
      .locator('.pnl-line-brain', { hasText: `the user answered ${answered!.id}` })
      .first(),
  ).toBeVisible();
  await clearHarness(api);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a reply to a permission card quotes it without deciding it', async ({
    page,
    api,
    openApp,
  }) => {
    const world = await seedScenario(api, { stewards: 0, asteroid: true });
    await openApp({ listMode: true });
    const request = `May I push to main ${stamp()}?`;
    await askUser(api, world.asteroidStewardId!, 'permission', request);
    const card = chat(page).locator('.thread-card', {
      has: page.getByRole('article', { name: `permission question ${request}` }),
    });
    await expect(card).toBeVisible();
    const action = card.getByRole('button', { name: `Reply to the question: ${request}` });
    // Always shown on a touch screen, finger-sized.
    await expect(action).toBeVisible();
    const box = (await action.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await action.tap();
    await expect(page.getByRole('group', { name: 'replying to' })).toContainText(
      "A reply does not decide it: use the card's buttons.",
    );
    await composer(page).fill('What does it push?');
    await page.getByRole('button', { name: 'Send' }).tap();

    const mine = chat(page).locator('.pnl-line-user', { hasText: 'What does it push?' });
    await expect(
      mine.getByRole('button', { name: /^Quoted .*· question: May I push/ }),
    ).toBeVisible();
    // Still open: only the card's buttons decide a permission request (decision 7).
    expect((await questionOnServer(api, request))?.status ?? 'open').toBe('open');
    await expect(card.getByRole('button', { name: /^Allow/ }).first()).toBeVisible();
    await clearHarness(api);
  });
});
