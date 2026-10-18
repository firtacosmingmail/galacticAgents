import type { Locator, Page } from '@playwright/test';
import type { Event, TranscriptResponse } from '@galactic/protocol';
import { expect, expectLive, test, type Api, type OpenOptions } from '../support/fixtures.js';
import { callBrainTool, questionOnServer, stamp, startBrainWaykeeper } from '../support/world.js';

/**
 * Several questions as one card (P8-19–P8-21, SPEC decision 141), end to end: a real Waykeeper
 * brain on the fake runtime asks three questions with `ask_questions`; the Harmonizer (its
 * supervisor, asked first) answers the first with `answer_question_set`, which passes the other
 * two up to the user in the same call. The user sees one card "Waykeeper · <title>" "via
 * Harmonizer" with two pages, answers one, reloads the page (the draft is kept on the server),
 * skips the other and sends. The Waykeeper's next turn carries both answers at once — the fake
 * brain echoes its turn prompt into its transcript, which the test reads.
 *
 * The brains' tool calls come through the harness (`/dev/harness/brains/*`): the fake runtime
 * does not choose tools itself, so the test calls them as the model would.
 */
const chat = (page: Page) => page.getByRole('log', { name: 'conversation with Harmonizer' });

async function waykeeperSaid(api: Api, agentId: string): Promise<string[]> {
  const page = await api.get<TranscriptResponse>(`/api/agents/${agentId}/transcript?limit=200`);
  return page.chunks.map((c) => c.text);
}

/** The last draft the server logged for a question (an open row is not in the history yet). */
async function lastDraft(api: Api, since: number, questionId: string): Promise<unknown> {
  const { events } = await api.get<{ events: { event: Event }[] }>(`/dev/events?since=${since}`);
  const drafts = events
    .map((e) => e.event)
    .filter((e) => e.type === 'question.drafted' && e.questionId === questionId);
  return drafts.length > 0 ? (drafts.at(-1) as { draft: unknown }).draft : undefined;
}

async function walkThrough(
  page: Page,
  api: Api,
  openApp: (o?: OpenOptions) => Promise<void>,
  press: (l: Locator) => Promise<void>,
): Promise<void> {
  const s = stamp();
  const brains = await startBrainWaykeeper(api, `Question sets ${s}`);
  await openApp({ listMode: true });

  const title = `Export settings ${s}`;
  const texts = [
    `Which date format should the export use (${s})?`,
    `Which columns should it include (${s})?`,
    `Anything else I should know (${s})?`,
  ] as const;
  const asked = (await callBrainTool(api, brains.waykeeperId, 'ask_questions', {
    title,
    questions: [
      { text: texts[0], options: ['ISO 8601', 'US', 'EU'] },
      { text: texts[1], options: ['date', 'amount', 'note'], multiSelect: true },
      { text: texts[2] },
    ],
  })) as { setId: string; questionIds: string[]; holder: { type: string; id?: string } };
  expect(asked.holder).toEqual({ type: 'agent', id: brains.harmonizerId });
  const { setId, questionIds: ids } = asked;

  const passed = (await callBrainTool(api, brains.harmonizerId, 'answer_question_set', {
    setId,
    answers: [{ questionId: ids[0], answer: 'ISO 8601, as the plan says' }],
  })) as { answered: string[]; passedUpTo: { type: string } | null };
  expect(passed.answered).toEqual([ids[0]]);
  expect(passed.passedUpTo).toEqual({ type: 'user' });

  // One card for the two questions the user holds, in the Harmonizer's chat (decision 55).
  const card = chat(page).getByRole('article', { name: `question set ${title}, 2 questions` });
  await expect(card).toBeVisible();
  await expect(card.locator('.qset-asker')).toContainText(`Waykeeper`);
  await expect(card.locator('.qset-asker')).toContainText(title);
  await expect(card.locator('.qset-via')).toHaveText('via Harmonizer');
  await expect(card.locator('.qset-pill')).toHaveText('1 of 2');
  await expect(card.locator('.qset-dots li')).toHaveCount(2);

  // Page 1: the columns (multi-select).
  await expect(card.locator('.qset-text')).toHaveText(texts[1]);
  await press(card.getByRole('button', { name: 'date', exact: true }));
  await press(card.getByRole('button', { name: 'amount', exact: true }));
  await press(card.getByRole('button', { name: /^Next/ }));
  await expect(card.locator('.qset-pill')).toHaveText('2 of 2');
  // The draft is the server's, not this page's: its last `question.drafted` for the row.
  await expect
    .poll(() => lastDraft(api, brains.seq, ids[1]!))
    .toEqual(expect.objectContaining({ choices: ['date', 'amount'] }));

  // Mid-way: the page reloads. The card comes back on the unanswered question, the draft kept.
  await page.reload();
  await expectLive(page);
  await expect(card.locator('.qset-pill')).toHaveText('2 of 2');
  await expect(card.locator('.qset-text')).toHaveText(texts[2]);
  await press(card.getByRole('button', { name: /Back$/ }));
  await expect(card.locator('.qset-text')).toHaveText(texts[1]);
  await expect(card.getByRole('button', { name: 'date', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(card.getByRole('button', { name: 'amount', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await press(card.getByRole('button', { name: /^Next/ }));

  // Page 2: skipped. The review shows all three, the Harmonizer's read-only.
  await expect(card.locator('.qset-text')).toHaveText(texts[2]);
  await press(card.getByRole('button', { name: 'Skip', exact: true }));
  await expect(card.locator('.qset-pill')).toHaveText('Review');
  const review = card.getByRole('list', { name: 'your answers' });
  await expect(review).toContainText(`answered by Harmonizer: “ISO 8601, as the plan says”`);
  await expect(review).toContainText('→ date, amount');
  await expect(review).toContainText('skipped');
  await press(card.getByRole('button', { name: 'Send 1 answer' }));

  // Both rows answered on the server, by the user, in one send.
  await expect.poll(async () => (await questionOnServer(api, texts[1]))?.status).toBe('answered');
  const columns = await questionOnServer(api, texts[1]);
  const extra = await questionOnServer(api, texts[2]);
  expect(columns?.answer).toBe('date, amount');
  expect(columns?.answeredBy).toEqual({ type: 'user' });
  expect(extra?.answer).toBe('(skipped by the user)');
  expect(extra?.answeredBy).toEqual({ type: 'user' });
  // The card stays in the thread as a read-only summary of all three.
  const summary = chat(page).getByRole('article', { name: `question set ${title}, 3 questions` });
  await expect(summary.locator('.qset-pill')).toHaveText('Answered');
  await expect(card).toHaveCount(0);

  // The Waykeeper heard the Harmonizer's answer in an earlier turn, and both of the user's in
  // one turn (the fake brain echoes each turn's prompt).
  const line = (i: number) => `answered ${ids[i]} (question ${i + 1} of 3 in set ${setId})`;
  await expect
    .poll(async () => {
      const said = await waykeeperSaid(api, brains.waykeeperId);
      return {
        harmonizer: said.some((t) =>
          t.includes(`agent ${brains.harmonizerId} ${line(0)}: "ISO 8601, as the plan says"`),
        ),
        userInOneTurn: said.some(
          (t) =>
            t.includes(`user ${line(1)}: "date, amount"`) &&
            t.includes(`user ${line(2)}: "(skipped by the user)"`),
        ),
      };
    })
    .toEqual({ harmonizer: true, userInOneTurn: true });
}

test('a Waykeeper’s three questions: one from the Harmonizer, two on one card', async ({
  page,
  api,
  openApp,
}) => {
  await walkThrough(page, api, openApp, (l) => l.click());
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the same set, answered with taps', async ({ page, api, openApp }) => {
    await walkThrough(page, api, openApp, (l) => l.tap());
  });
});
