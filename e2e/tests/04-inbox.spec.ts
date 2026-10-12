import type { HistoryWorkDetail, Project } from '@galactic/protocol';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.js';
import {
  askUser,
  clearHarness,
  probeList,
  questionOnServer,
  seedScenario,
  stamp,
} from '../support/world.js';

/**
 * The inbox's answer flow end to end (SPEC §4.2.15–19): a fake Steward asks the user, the question
 * reaches the page live, the user answers inline, the server records the answer as the user's,
 * the card leaves the waiting list and the agent goes back to work.
 */
const inbox = (page: Page) => page.getByRole('region', { name: 'question inbox' });

test('a clarification question is answered from the inbox', async ({ page, api, openApp }) => {
  const world = await seedScenario(api, { stewards: 1, asteroid: false });
  const steward = world.stewardIds[0]!;
  await openApp();

  const text = `Which colour for the button ${stamp()}?`;
  const questionId = await askUser(api, steward, 'clarification', text);
  const card = inbox(page).getByRole('article', { name: `clarification question ${text}` });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-question-id', questionId);
  await expect(card).toContainText('held by you');
  // The scene has the question's beacon; the top bar counts it.
  await expect(page.getByText(/[1-9]\d* open questions?/)).toBeVisible();

  await card.getByRole('textbox', { name: 'answer' }).fill('Teal, please');
  await card.getByRole('button', { name: 'Answer' }).click();

  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await questionOnServer(api, text))?.status).toBe('answered');
  const answered = await questionOnServer(api, text);
  expect(answered?.answer).toBe('Teal, please');
  expect(answered?.answeredBy).toEqual(expect.objectContaining({ type: 'user' }));
  // The Steward's satellite is drawn (the scene may still be loading when the answer is sent).
  await expect.poll(() => probeList(page, 'satellites')).toContain(steward);
});

test('a clarification is dismissed from the inbox (P9-14)', async ({ page, api, openApp }) => {
  const world = await seedScenario(api, { stewards: 1, asteroid: false });
  const steward = world.stewardIds[0]!;
  await openApp();

  const text = `Which font for the title ${stamp()}?`;
  const questionId = await askUser(api, steward, 'clarification', text);
  const card = inbox(page).locator(`article[data-question-id="${questionId}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: `Dismiss the question, no reply: ${text}` }).click();

  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await questionOnServer(api, text))?.status).toBe('cancelled');
  const dismissed = await questionOnServer(api, text);
  expect(dismissed?.meta).toMatchObject({
    cancelledBy: { type: 'user' },
    cancelReason: 'dismissed by the user',
  });
});

test('a permission question is allowed from the inbox', async ({ page, api, openApp }) => {
  const world = await seedScenario(api, { stewards: 1, asteroid: false });
  const steward = world.stewardIds[0]!;
  await openApp();

  const text = `May I run the migration ${stamp()}?`;
  const questionId = await askUser(api, steward, 'permission', text);
  const card = inbox(page).locator(`article[data-question-id="${questionId}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-label', /^permission question /);
  // A project Steward's request: "Allow once" beside "Allow similar for …" (P9-17).
  await card.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(card).toHaveCount(0);
  // Permissions are the user's or the policy's, never an LLM's: recorded as the user's "allow".
  await expect.poll(async () => (await questionOnServer(api, text))?.status).toBe('answered');
  const answered = await questionOnServer(api, text);
  expect(answered?.id).toBe(questionId);
  expect(answered?.answer).toBe('allow');
  expect(answered?.answeredBy).toEqual(expect.objectContaining({ type: 'user' }));
});

test('a permission question allows similar actions for its project (P9-17)', async ({
  page,
  api,
  openApp,
}) => {
  const world = await seedScenario(api, { stewards: 1, asteroid: false });
  const steward = world.stewardIds[0]!;
  await openApp();

  const text = `May I clean the build ${stamp()}?`;
  const questionId = await askUser(api, steward, 'permission', text);
  const card = inbox(page).locator(`article[data-question-id="${questionId}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /^Allow similar for / }).click();
  const chooser = card.getByRole('group', { name: /^Allow from now on in / });
  // The server's previews of what each scope would match.
  await expect(chooser).toContainText('Exactly the command `rm -rf build`');
  await expect(chooser).toContainText('destructive actions');
  await chooser.getByRole('radio', { name: /Exactly this/ }).check();
  await chooser.getByRole('button', { name: 'Allow and remember' }).click();

  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await questionOnServer(api, text))?.status).toBe('answered');
  expect((await questionOnServer(api, text))?.answer).toBe('allow');
  const detail = await api.get<HistoryWorkDetail>(`/api/history/work/project/${world.projectId}`);
  expect((detail.work.item as Project).permissionRules).toEqual([
    expect.objectContaining({
      scope: 'exact',
      match: { kind: 'text', text: 'rm -rf build' },
      categories: ['destructive'],
      createdBy: { type: 'user' },
      origin: 'local',
      questionId,
    }),
  ]);

  // Archiving the project removes its rules (and frees its planet for the next tests).
  await clearHarness(api);
  const after = await api.get<HistoryWorkDetail>(`/api/history/work/project/${world.projectId}`);
  expect((after.work.item as Project).state).toBe('archived');
  expect((after.work.item as Project).permissionRules).toBeUndefined();
});
