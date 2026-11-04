import type { Locator, Page } from '@playwright/test';
import type { Event, TranscriptResponse } from '@galactic/protocol';
import { expect, test, type Api } from '../support/fixtures.js';
import {
  advanceUsageLimits,
  callBrainTool,
  questionOnServer,
  sceneProbe,
  scriptSteward,
  stamp,
  startBrainWaykeeper,
} from '../support/world.js';

/**
 * More AI providers (P11-10, SPEC decisions 146–148), end to end, through the dev harness: a
 * Waykeeper's plan has an image task on Gemini and a publishing task on ChatGPT — both chips show
 * on the plan card, and once it is approved the Gemini Steward's satellite carries the Gemini
 * mark; the ChatGPT Steward asks to publish, the user edits the text and approves, and the
 * Steward hears "approved" with the edited text; the Gemini Steward stops at its usage limit and
 * the user gets one card, with no ChatGPT among its options (it cannot make images), picks "Wait
 * until it resets", and moving the harness clock past the reset retries it. On a phone (390 and
 * 320 px wide) the publish and limit cards stay usable.
 *
 * Neither CLI runs: in development mode the server registers fakes under the `codex` and `agy`
 * runtimes (ruling R4) with the model lists, usage and publish ability the real adapters report,
 * and the Stewards follow the test's script (`/dev/harness/tasks/:id/steward-script`).
 */
const nav = (page: Page) => page.getByRole('navigation', { name: 'navigation' });
const inbox = (page: Page) => page.locator('#pnl-inbox');

interface PlannedProject {
  name: string;
  waykeeperId: string;
  proposalId: string;
  imageTaskId: string;
  publishTaskId: string;
  imageTask: string;
  publishTask: string;
}

/** A project whose Waykeeper plans an image task on Gemini and a publishing task on ChatGPT. */
async function plannedProject(api: Api, s: string): Promise<PlannedProject> {
  const name = `Providers ${s}`;
  const { waykeeperId } = await startBrainWaykeeper(api, name);
  const imageTask = `Make the cover image ${s}`;
  const publishTask = `Post the announcement ${s}`;
  const plan = (await callBrainTool(api, waykeeperId, 'plan_tasks', {
    summary: `Launch post ${s}`,
    tasks: [
      { description: imageTask, provider: 'gemini', makesImages: true },
      { description: publishTask, provider: 'chatgpt', publishes: true },
    ],
  })) as { proposalId: string; tasks: { taskId: string; description: string }[] };
  const idOf = (description: string) =>
    plan.tasks.find((t) => t.description === description)!.taskId;
  return {
    name,
    waykeeperId,
    proposalId: plan.proposalId,
    imageTaskId: idOf(imageTask),
    publishTaskId: idOf(publishTask),
    imageTask,
    publishTask,
  };
}

async function eventsSince(api: Api, since: number): Promise<Event[]> {
  const { events } = await api.get<{ events: { event: Event }[] }>(`/dev/events?since=${since}`);
  return events.map((e) => e.event);
}

const approveByRest = (api: Api, proposalId: string) =>
  api.post(`/api/proposals/${proposalId}/decide`, { decision: 'approve' });

/** Both Stewards, as the Waykeeper starts them once the plan is approved. */
async function startStewards(
  api: Api,
  p: PlannedProject,
  scripts: {
    publish: Parameters<typeof scriptSteward>[2];
    image: Parameters<typeof scriptSteward>[2];
  },
): Promise<{ imageStewardId: string; publishStewardId: string }> {
  await scriptSteward(api, p.imageTaskId, scripts.image);
  await scriptSteward(api, p.publishTaskId, scripts.publish);
  const spawn = async (taskId: string) =>
    (
      (await callBrainTool(api, p.waykeeperId, 'spawn_steward', {
        taskId,
        instructions: 'Do the step and report.',
      })) as { stewardId: string }
    ).stewardId;
  return {
    imageStewardId: await spawn(p.imageTaskId),
    publishStewardId: await spawn(p.publishTaskId),
  };
}

/** No horizontal scroll, and the element's buttons and fields stay inside the viewport. */
async function expectUsable(page: Page, card: Locator, width: number): Promise<void> {
  const widths = await card.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.scroll, `${width} px: card scrollWidth`).toBeLessThanOrEqual(widths.client);
  expect(widths.page, `${width} px: page scrollWidth`).toBeLessThanOrEqual(widths.viewport);
  for (const control of await card.locator('button, textarea').all()) {
    await control.scrollIntoViewIfNeeded();
    const box = (await control.boundingBox())!;
    expect(box.x, `${width} px`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${width} px`).toBeLessThanOrEqual(width);
    expect(box.height, `${width} px`).toBeGreaterThan(0);
  }
}

test('a plan on Gemini and ChatGPT, an edited publish, a usage limit waited out', async ({
  page,
  api,
  openApp,
}) => {
  const s = stamp();
  await openApp();
  const project = await plannedProject(api, s);

  // The plan card, in the Waykeeper's chat: each task with its provider and its flags.
  await nav(page).getByText(project.name, { exact: true }).click();
  const card = page
    .getByRole('region', { name: /^chat with Waykeeper/ })
    .getByRole('article', { name: /^plan / })
    .filter({ hasText: project.imageTask });
  const image = card.getByRole('listitem').filter({ hasText: project.imageTask });
  await expect(image.locator('.provider-chip')).toHaveText('Gemini');
  await expect(image.locator('.provider-tag')).toHaveText('images');
  const publish = card.getByRole('listitem').filter({ hasText: project.publishTask });
  await expect(publish.locator('.provider-chip')).toHaveText('ChatGPT');
  await expect(publish.locator('.provider-tag')).toHaveText('publishes');
  const since = (await api.get<{ seq: number }>('/dev/events?since=999999999')).seq;
  await card.getByRole('button', { name: 'Approve plan' }).click();
  await expect
    .poll(async () =>
      (await eventsSince(api, since)).some(
        (e) => e.type === 'proposal.approved' && e.proposalId === project.proposalId,
      ),
    )
    .toBe(true);

  // The Gemini Steward stops at its limit (it resets in an hour); the ChatGPT one asks to publish.
  const text = `Launch day! Our app is out (${s}).`;
  const { imageStewardId, publishStewardId } = await startStewards(api, project, {
    image: { limit: { resetsInMs: 3_600_000 } },
    publish: { publish: { platform: `Instagram ${s}`, account: '@galactic', text } },
  });
  // Their satellites carry their provider's mark.
  await expect
    .poll(() => sceneProbe(page).getAttribute('data-satellite-providers'))
    .toContain(`${imageStewardId}:gemini`);
  await expect
    .poll(() => sceneProbe(page).getAttribute('data-satellite-providers'))
    .toContain(`${publishStewardId}:chatgpt`);

  // The publish card: the post with its text box; edited, then approved.
  const publishCard = inbox(page)
    .getByRole('article', { name: /^publish question/ })
    .filter({ hasText: `Instagram ${s}` });
  await expect(publishCard).toContainText('@galactic');
  const box = publishCard.getByRole('textbox', { name: 'text to post' });
  await expect(box).toHaveValue(text);
  const edited = `${text} Join us at 6pm.`;
  await box.fill(edited);
  await publishCard.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(publishCard).toHaveCount(0);
  // The Steward hears "approved", and the edited text to publish.
  await expect
    .poll(async () => {
      const t = await api.get<TranscriptResponse>(`/api/agents/${publishStewardId}/transcript`);
      return t.chunks.map((c) => c.text).join('\n');
    })
    .toContain(
      `Publish approval for Instagram ${s}: approved. Publish exactly this text:\n${edited}`,
    );

  // One limit card, a Gemini one: the switch options never hold ChatGPT (it cannot make images)
  // nor Gemini's own model, and `Wait until it resets` is there.
  const limit = inbox(page)
    .getByRole('article', { name: /usage limit reached/ })
    .filter({ hasText: project.imageTask });
  await expect(limit).toHaveCount(1);
  await expect(limit).toContainText('Gemini');
  const options = await limit.locator('.controls button').allTextContents();
  expect(options).toEqual([
    'Switch to Claude Sonnet 5 through Antigravity',
    'Wait until it resets',
  ]);
  expect(options.join(' ')).not.toMatch(/ChatGPT|Switch to Gemini/);
  const limitText = ((await limit.getAttribute('aria-label')) ?? '').replace(
    /^clarification question /,
    '',
  );
  await limit.getByRole('button', { name: 'Wait until it resets' }).click();
  await expect(limit).toHaveCount(0);
  const asked = (await questionOnServer(api, limitText))!;
  expect(asked.answer).toBe('Wait until it resets');
  expect(asked.meta?.['retriedAt']).toBeUndefined();

  // Not yet reset: an hour has not passed. Past the reset the next check retries it.
  await advanceUsageLimits(api, 30 * 60_000);
  expect((await questionOnServer(api, asked.context.text))!.meta?.['retriedAt']).toBeUndefined();
  await advanceUsageLimits(api, 2 * 3_600_000);
  await expect
    .poll(async () => (await questionOnServer(api, asked.context.text))!.meta?.['retriedAt'])
    .toBeDefined();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the publish and limit cards are usable at 390 and 320 px', async ({
    page,
    api,
    openApp,
  }) => {
    const s = stamp();
    const project = await plannedProject(api, s);
    await approveByRest(api, project.proposalId);
    await startStewards(api, project, {
      image: { limit: { resetsInMs: 3_600_000 } },
      publish: {
        publish: {
          platform: `Instagram ${s}`,
          account: '@galactic',
          text: 'A post with a fairly long text so the box has something to wrap. '.repeat(3),
        },
      },
    });
    await openApp({ listMode: true });
    await page.getByRole('button', { name: /^Inbox/ }).tap();
    const view = page.getByRole('dialog', { name: 'Inbox' });
    await expect(view).toBeVisible();
    const publishCard = view
      .getByRole('article', { name: /^publish question/ })
      .filter({ hasText: `Instagram ${s}` });
    const limitCard = view
      .getByRole('article', { name: /usage limit reached/ })
      .filter({ hasText: project.imageTask });
    await expect(publishCard).toBeVisible();
    await expect(limitCard).toBeVisible();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      await expectUsable(page, publishCard, width);
      await expectUsable(page, limitCard, width);
    }
  });
});
